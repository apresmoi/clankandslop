import { compositionArtifactSchema } from './composition-contract.mjs';
import { articleFilingSchema } from '../../ops/article-format.mjs';
import { createInterface } from 'node:readline';
import { composeEdition, fileArticle, fileDesk, qualifySignal, recordAssignment, recordDissent, reviewArticle, stageRelease } from './production-newsroom.mjs';
import { deskDocumentKeys } from '../../ops/desk-contract.mjs';

// Closed sets mirrored from production-newsroom.mjs's own validation (`desks`,
// the verdict list in reviewArticle, and the epistemic values used across
// published editions in content/editions/*/articles/*.json). Keep these in
// sync with that file rather than re-deriving them at runtime, so a tool
// call fails fast on a malformed shape instead of round-tripping to disk.
const DESKS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];
const VERDICTS = ['PASS', 'REVISION_REQUEST', 'HOLD', 'SPIKE'];
const STANCES = ['dissent', 'concur'];
const ART_KINDS = ['map', 'ascii'];
const EPISTEMIC = ['fact', 'forecast', 'inference'];
const COMPONENT_PATTERN = '^[a-z0-9][a-z0-9-]{0,127}$';
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
const DESK_NAMES_BY_AGENT = { ledger: ['ledger.settlements', 'ledger.worlddesk'], caslon: ['caslon.chrome', 'caslon.weather'] };
const role = process.env.CLANK_NEWSROOM_AGENT;
const DESK_NAMES = DESK_NAMES_BY_AGENT[role] ?? Object.values(DESK_NAMES_BY_AGENT).flat();
// Rendered from ops/desk-contract.mjs, the same module the gate applies, so
// what the agent is told and what it is held to cannot drift apart.
const DESK_SHAPE_LINE = DESK_NAMES.map((name) => `${name} {${deskDocumentKeys(name).join(', ')}}`).join('; ');

const edition = { type: 'string', pattern: DATE_PATTERN, description: 'Edition date, YYYY-MM-DD.' };
const eventKey = { type: 'string', minLength: 8, maxLength: 1024, description: 'The actual wake id; several different articles or desk documents may share it. An accepted operation is idempotent by wake, role and artifact. Changed accepted input needs a new wake. When Daimon binds a wake id (DAIMON_WAKE_ID), this must equal that wake id exactly.' };
const componentId = (description) => ({ type: 'string', pattern: COMPONENT_PATTERN, description });

const assignmentItem = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'owner', 'brief', 'evidence_refs'],
  properties: {
    id: componentId('Immutable story id this assignment will file under. Lowercase letters, digits, hyphens.'),
    owner: { type: 'string', enum: DESKS, description: 'Reporter agent this story is assigned to.' },
    brief: { type: 'string', minLength: 20, description: 'What to report, at least 20 characters.' },
    evidence_refs: { type: 'array', items: { type: 'string' }, description: 'source_url or source_id values the filed article must carry in evidence_box.' },
    slot: { type: 'string', enum: ['forecast'], description: 'Optional, at most one item in the lineup: this is the day\'s forecast. file_article then requires epistemic "forecast", a dated next_update_utc and confidence.value in [0,1] from its owner.' },
    dissenter: { type: 'string', enum: DESKS, description: 'Optional, only beside slot "forecast" and never the owner: the colleague who holds the dissent and will record it with record_dissent.' }
  }
};

const article = articleFilingSchema;

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
    description: 'File one assignment-bound complete sourced article revision. A successful result only saves the filing and sends no Moltnet message: you must then use moltnet_send on clank-newsroom room:filing with the current edition, article id, revision, and @spike; forecast filings mention @spike and the dissenter in the same message. The assignment is looked up by (edition, your own agent identity) — you do not need to know or supply assignment_event_key or the exact assigned id.',
    required: ['edition', 'event_key', 'article'],
    optional: ['assignment_event_key'],
    properties: {
      edition, event_key: eventKey,
      assignment_event_key: { type: 'string', description: 'Optional. Only needed to disambiguate if you somehow hold more than one assignment for this edition; never required otherwise.' },
      article
    },
    execute: fileArticle
  },
  record_dissent: {
    description: "Record your own dissent, or your concurrence, against a colleague's filed revision. You are identified by the agent this MCP server runs as — no name is read from the arguments, and nobody else can sign as you. This is the only route a dissent reaches the page: file_article refuses an author-typed one.",
    required: ['edition', 'event_key', 'article_id', 'revision', 'stance', 'argument'],
    optional: ['p'],
    properties: {
      edition, event_key: eventKey,
      article_id: componentId("Story id from the owner's announcement in room:filing."),
      revision: { type: 'integer', minimum: 1, description: 'The revision you actually read, from that same announcement.' },
      stance: { type: 'string', enum: STANCES, description: '"dissent" when you hold a counter-call; "concur" when you read it and nothing crossed the line — an honest outcome, not a failure.' },
      argument: { type: 'string', minLength: 20, maxLength: 2000, description: 'For "dissent", 80-2000 characters of reasoning a reader can weigh. For "concur", 20+ characters saying why nothing crossed the line.' },
      p: { type: 'number', minimum: 0, maximum: 1, description: 'Required for "dissent" and refused for "concur": your own probability for the call.' }
    },
    execute: recordDissent
  },
  review_article: {
    description: "Record Spike's verdict for one immutable filing revision. A successful result only saves notes and mentions; it does not deliver them. For REVISION_REQUEST and HOLD, use moltnet_send on clank-newsroom room:filing with the current edition, article id, revision, @owner, and actionable notes; for SPIKE, notify the owner and @brass if a replacement is required. PASS continues from the fresh INDEX: review other filings one at a time, then when passed>=5 and the Ledger desk rows are missing, send @ledger in room:release.",
    required: ['edition', 'event_key', 'article_id', 'revision', 'filing_digest', 'verdict', 'notes'],
    properties: {
      edition, event_key: eventKey,
      article_id: componentId('Story id of the filing being reviewed.'),
      revision: { type: 'integer', minimum: 1 },
      filing_digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', description: 'Digest of the exact filing you read, from its INDEX F row or filing receipt. A changed draft must be read again.' },
      verdict: { type: 'string', enum: VERDICTS },
      notes: { type: 'string', maxLength: 8000 }
    },
    execute: reviewArticle
  },
  file_desk: {
    description: `File one Ledger- or Caslon-owned desk document. Each name carries exactly its own keys and no others: ${DESK_SHAPE_LINE}. The document is checked against that shape here, so a rejection is something to fix and file again, not a filing that half landed.`,
    required: ['edition', 'event_key', 'name', 'document'],
    properties: {
      edition, event_key: eventKey,
      name: { type: 'string', enum: DESK_NAMES, description: 'Only the names your own agent owns are accepted.' },
      // The keys are enumerated in the tool description rather than as a
      // schema per name, because one call files one of four different shapes.
      document: { type: 'object', additionalProperties: true, description: `The whole document, carrying exactly the keys listed for this name: ${DESK_SHAPE_LINE}.` }
    },
    execute: fileDesk
  },
  compose_edition: {
    description: 'Compose the exact immutable layout returned by lay_pages using layout_sha256. Re-run the canonical assembler and verify the complete PASS edition tree. Never retype page JSON.',
    required: ['edition', 'event_key'],
    oneOf: [{ required: ['layout_sha256'], not: { anyOf: [{ required: ['pages'] }, { required: ['maps'] }, { required: ['artifacts'] }] } }, { required: ['pages'], not: { required: ['layout_sha256'] } }],
    properties: {
      edition, event_key: eventKey,
      layout_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'The exact digest returned by lay_pages for this edition. The tool loads and authenticates those bytes; do not retype the layout.' },
      pages: {
        type: 'array', minItems: 2, maxItems: 2,
        items: { type: 'object', additionalProperties: false, required: ['name', 'document'], properties: { name: { type: 'string', enum: ['front', 'tape'] }, document: { type: 'object', additionalProperties: true } } },
        description: 'Exactly one "front" and one "tape" page document.'
      },
      artifacts: { type: 'array', items: compositionArtifactSchema, description: 'Immutable Caslon-generated map/glyph registrations returned by the private artwork tools.' },
      maps: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['name', 'document'], properties: { name: componentId('Map name; supplied maps plus selected map artifacts must match all article and page map references.'), document: { type: 'object', additionalProperties: true } } }
      }
    },
    execute: composeEdition
  },
  stage_release: {
    description: 'Copy the complete edition into local staging, validate content, and build the site.',
    required: ['edition', 'event_key'],
    properties: { edition, event_key: eventKey },
    execute: stageRelease
  }
};
// A dissent is a reporter's act, so the six desks carry record_dissent and
// nobody else does — the tool set is the boundary, exactly as it is for
// review_article and compose_edition.
const roleTools={klaxon:['qualify_signal'],brass:['record_assignment'],cogsworth:['file_article','record_dissent'],sprockett:['file_article','record_dissent'],foreman:['file_article','record_dissent'],graves:['file_article','record_dissent'],tinkerton:['file_article','record_dissent'],vesta:['file_article','record_dissent'],spike:['review_article'],ledger:['file_desk'],caslon:['file_desk','compose_edition'],pressman:['stage_release']};
if(process.env.CLANK_STATE_OFFLINE_FIXTURE!=='1'){const definition=definitions.compose_edition;definition.required=['edition','event_key','layout_sha256'];delete definition.oneOf;definition.properties=Object.fromEntries(definition.required.map(key=>[key,definition.properties[key]]));}
const tools=roleTools[role]??[];
const schema=definition=>({type:'object',additionalProperties:false,required:definition.required,properties:definition.properties,...(definition.oneOf?{oneOf:definition.oneOf}:{})});
// The stdio transport, and what it means for the peer to go away.
//
// This is one process per agent, speaking JSON-RPC over a pipe daimon opens and
// closes. When the host closes its end — a startup probe that hangs up after
// the handshake, a wake that ends, the container stopping — the read end of our
// stdout is gone and the next write raises EPIPE. Node has no default handler
// for a stream 'error', so it becomes an uncaught exception: a stack trace and
// exit 1. On 2026-09-06 that happened to `graves` during daimon startup on one
// start in three and took the whole org container down with it.
//
// A peer that closed its own end is not a failure. There is nobody left to
// answer and nothing left to record, so we leave quietly, with the exit code of
// a process that finished its work.
//
// Everything else on the transport still exits non-zero with the reason on
// stderr. That distinction is the point: a blanket try/catch around the write
// would also swallow a genuinely broken pipe, and an agent whose tool server
// has silently died — accepting calls, answering nothing — is worse than one
// that visibly fails and can be restarted.
const PEER_CLOSED=new Set(['EPIPE','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END']);
const onTransportError=name=>error=>{
  if(PEER_CLOSED.has(error?.code))process.exit(0);
  try{process.stderr.write(`clank-newsroom-${role}: ${name} transport failed (${error?.code??'unknown'}): ${error?.message??error}\n`);}catch{}
  process.exit(70);
};
process.stdout.on('error',onTransportError('stdout'));
process.stdin.on('error',onTransportError('stdin'));
// stderr is the only thing left to report a failure with; a broken one is not
// worth a second failure on top of the first.
process.stderr.on('error',()=>process.exit(70));
// Fault injection for the regression test, the same shape as
// CLANK_RELEASE_CRASH_BEFORE_SWITCH: emits one synthetic stream error so both
// branches above are exercised against this handler rather than a copy of it.
if(process.env.CLANK_MCP_INJECT_STREAM_ERROR)process.nextTick(()=>process.stdout.emit('error',Object.assign(new Error('injected stream error'),{code:process.env.CLANK_MCP_INJECT_STREAM_ERROR})));
const reply=(id,result,error)=>process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id,...(error?{error:{code:-32000,message:error}}:{result})})}\n`);
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){let request;try{request=JSON.parse(line);if(request.method==='initialize')reply(request.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:`clank-newsroom-${role}`,version:'1.0.0'}});else if(request.method==='notifications/initialized'){}else if(request.method==='tools/list')reply(request.id,{tools:tools.map(name=>({name,description:definitions[name].description,inputSchema:schema(definitions[name])}))});else if(request.method==='tools/call'){const name=request.params?.name;if(!tools.includes(name))throw new Error('tool exceeds agent authority');const value=await definitions[name].execute(request.params.arguments);reply(request.id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});}else if(request.id!==undefined)reply(request.id,undefined,'unsupported method');}catch(error){reply(request?.id??null,undefined,error instanceof Error?error.message:'newsroom tool failed');}}
