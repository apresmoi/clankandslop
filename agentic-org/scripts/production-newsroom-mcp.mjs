import { createInterface } from 'node:readline';
import { composeEdition, fileArticle, fileDesk, pushEdition, qualifySignal, recordAssignment, reviewArticle, stageRelease } from './production-newsroom.mjs';

// Closed sets mirrored from production-newsroom.mjs's own validation (`desks`,
// the verdict list in reviewArticle, and the epistemic values used across
// published editions in content/editions/*/articles/*.json). Keep these in
// sync with that file rather than re-deriving them at runtime, so a tool
// call fails fast on a malformed shape instead of round-tripping to disk.
const DESKS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];
const VERDICTS = ['PASS', 'REVISION_REQUEST', 'HOLD', 'SPIKE'];
const EPISTEMIC = ['fact', 'forecast', 'inference'];
const COMPONENT_PATTERN = '^[a-z0-9][a-z0-9-]{0,127}$';
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
const DESK_NAMES_BY_AGENT = { ledger: ['ledger.settlements', 'ledger.worlddesk'], caslon: ['caslon.chrome', 'caslon.weather'] };
const role = process.env.CLANK_NEWSROOM_AGENT;

const edition = { type: 'string', pattern: DATE_PATTERN, description: 'Edition date, YYYY-MM-DD.' };
const eventKey = { type: 'string', minLength: 8, maxLength: 1024, description: 'Causal idempotency key for this call. When Daimon binds a wake id (DAIMON_WAKE_ID), this must equal that wake id exactly.' };
const componentId = (description) => ({ type: 'string', pattern: COMPONENT_PATTERN, description });

const assignmentItem = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'owner', 'brief', 'evidence_refs'],
  properties: {
    id: componentId('Immutable story id this assignment will file under. Lowercase letters, digits, hyphens.'),
    owner: { type: 'string', enum: DESKS, description: 'Reporter agent this story is assigned to.' },
    brief: { type: 'string', minLength: 20, description: 'What to report, at least 20 characters.' },
    evidence_refs: { type: 'array', items: { type: 'string' }, description: 'source_url or source_id values the filed article must carry in evidence_box.' }
  }
};

const article = {
  type: 'object',
  additionalProperties: true,
  required: ['edition_date', 'section', 'kicker', 'headline', 'deck', 'epistemic', 'byline', 'timestamp', 'revision', 'next_update_utc', 'topics', 'body', 'key_numbers', 'evidence_box', 'refs'],
  properties: {
    id: componentId('Story id. Optional to supply — if it does not match your one assignment for this edition, the server uses the assigned id and reports the correction rather than rejecting the filing.'),
    edition_date: edition,
    section: { type: 'string', description: 'Section slug, e.g. world, markets, technology, policy, culture.' },
    kicker: { type: 'string' },
    headline: { type: 'string' },
    deck: { type: 'string' },
    epistemic: { type: 'string', enum: EPISTEMIC, description: 'Epistemic status of the article.' },
    byline: {
      type: 'object', additionalProperties: true, required: ['desk', 'agents'],
      properties: { desk: { type: 'string' }, agents: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'agents[0] must equal your own agent name (case-insensitively).' } }
    },
    timestamp: { type: 'string', description: 'Publish time, e.g. "12:00 UTC".' },
    revision: { type: 'integer', minimum: 1 },
    next_update_utc: { type: 'string', description: '"HH:MM" — required for forecast/dissent floor checks.' },
    topics: { type: 'array', items: { type: 'string' } },
    body: { type: 'array', items: { type: 'string' }, minItems: 4, description: 'At least 4 paragraphs.' },
    key_numbers: { type: 'array' },
    evidence_box: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: true,
        properties: {
          source: { type: 'string' }, fragment: { type: 'string' }, as_of: { type: 'string' },
          source_note: {
            type: 'object', additionalProperties: true,
            properties: { source_id: { type: 'string' }, source_kind: { type: 'string' }, used_by_agent: { type: 'string' }, source_url: { type: 'string' }, retrieved_at: { type: 'string' } }
          }
        }
      },
      description: 'Must include every evidence_refs value from your assignment, as a source_url or source_id.'
    },
    refs: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Non-empty; source-note ids like "E1" cited in body.' },
    dissent: { type: 'object', additionalProperties: true, required: ['agent', 'argument'], properties: { agent: { type: 'string' }, p: { type: 'number' }, argument: { type: 'string' } } },
    art: { type: 'object', additionalProperties: true, properties: { hero_map: { type: 'string' } } }
  }
};

const definitions = {
  qualify_signal: {
    description: 'Durably qualify one sensor event and return the selected desks to mention.',
    required: ['edition', 'event_key', 'summary', 'selected_desks', 'evidence_refs'],
    properties: {
      edition, event_key: eventKey,
      summary: { type: 'string', minLength: 20, maxLength: 8000 },
      selected_desks: { type: 'array', items: { type: 'string', enum: DESKS }, minItems: 1, uniqueItems: true },
      evidence_refs: { type: 'array', items: { type: 'string', maxLength: 1024 } }
    },
    execute: qualifySignal
  },
  record_assignment: {
    description: 'Durably record the chief-approved lineup before sending natural-language assignments.',
    required: ['edition', 'event_key', 'assignments'],
    properties: { edition, event_key: eventKey, assignments: { type: 'array', minItems: 5, items: assignmentItem, description: 'At least 5 items; ids must be unique.' } },
    execute: recordAssignment
  },
  file_article: {
    description: 'File one assignment-bound complete sourced article revision. The assignment is looked up by (edition, your own agent identity) — you do not need to know or supply assignment_event_key or the exact assigned id.',
    required: ['edition', 'event_key', 'article'],
    optional: ['assignment_event_key'],
    properties: {
      edition, event_key: eventKey,
      assignment_event_key: { type: 'string', description: 'Optional. Only needed to disambiguate if you somehow hold more than one assignment for this edition; never required otherwise.' },
      article
    },
    execute: fileArticle
  },
  review_article: {
    description: "Record Spike's verdict for one immutable filing revision.",
    required: ['edition', 'event_key', 'article_id', 'revision', 'verdict', 'notes'],
    properties: {
      edition, event_key: eventKey,
      article_id: componentId('Story id of the filing being reviewed.'),
      revision: { type: 'integer', minimum: 1 },
      verdict: { type: 'string', enum: VERDICTS },
      notes: { type: 'string', maxLength: 8000 }
    },
    execute: reviewArticle
  },
  file_desk: {
    description: 'File one Ledger- or Caslon-owned desk document.',
    required: ['edition', 'event_key', 'name', 'document'],
    properties: {
      edition, event_key: eventKey,
      name: { type: 'string', enum: DESK_NAMES_BY_AGENT[role] ?? ['ledger.settlements', 'ledger.worlddesk', 'caslon.chrome', 'caslon.weather'], description: 'Only the names your own agent owns are accepted.' },
      document: { type: 'object', additionalProperties: true }
    },
    execute: fileDesk
  },
  compose_edition: {
    description: 'Compose the two page documents and verify the complete PASS edition tree.',
    required: ['edition', 'event_key', 'pages'],
    optional: ['maps'],
    properties: {
      edition, event_key: eventKey,
      pages: {
        type: 'array', minItems: 2, maxItems: 2,
        items: { type: 'object', additionalProperties: false, required: ['name', 'document'], properties: { name: { type: 'string', enum: ['front', 'tape'] }, document: { type: 'object', additionalProperties: true } } },
        description: 'Exactly one "front" and one "tape" page document.'
      },
      maps: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['name', 'document'], properties: { name: componentId('Map name; must match an article art.hero_map value.'), document: { type: 'object', additionalProperties: true } } }
      }
    },
    execute: composeEdition
  },
  stage_release: {
    description: 'Copy the complete edition into local staging, validate content, and build the site.',
    required: ['edition', 'event_key'],
    properties: { edition, event_key: eventKey },
    execute: stageRelease
  },
  push_edition: {
    description: 'Push the staged edition to the public repository on one branch, edition/<date>, for a human to open the pull request from. Never reaches main, never force-pushes, never merges, and never publishes.',
    required: ['edition', 'event_key'],
    properties: { edition, event_key: eventKey },
    execute: pushEdition
  }
};
const roleTools={klaxon:['qualify_signal'],brass:['record_assignment'],cogsworth:['file_article'],sprockett:['file_article'],foreman:['file_article'],graves:['file_article'],tinkerton:['file_article'],vesta:['file_article'],spike:['review_article'],ledger:['file_desk'],caslon:['file_desk','compose_edition'],pressman:['stage_release','push_edition']};
const tools=roleTools[role]??[];
const schema=definition=>({type:'object',additionalProperties:false,required:definition.required,properties:definition.properties});
const reply=(id,result,error)=>process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id,...(error?{error:{code:-32000,message:error}}:{result})})}\n`);
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){let request;try{request=JSON.parse(line);if(request.method==='initialize')reply(request.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:`clank-newsroom-${role}`,version:'1.0.0'}});else if(request.method==='notifications/initialized'){}else if(request.method==='tools/list')reply(request.id,{tools:tools.map(name=>({name,description:definitions[name].description,inputSchema:schema(definitions[name])}))});else if(request.method==='tools/call'){const name=request.params?.name;if(!tools.includes(name))throw new Error('tool exceeds agent authority');const value=await definitions[name].execute(request.params.arguments);reply(request.id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});}else if(request.id!==undefined)reply(request.id,undefined,'unsupported method');}catch(error){reply(request?.id??null,undefined,error instanceof Error?error.message:'newsroom tool failed');}}
