import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, link, lstat, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCompositionArtifact } from './composition-contract.mjs';
import { assertCompositionCoverage, compositionCoverage, composeGateLine, composeGateStatus, hasNamedDissent, isDatedForecast } from './compose-gate.mjs';
import { CITATION_GATE_NAMES, advisoryFilingWarnings, armedHardLintNames, describeLintFlag, hardLintFlags, knownTopicSlugs, lintFiling, writeEditionIndex } from './edition-index.mjs';
import { deskDocumentFindings } from '../../ops/desk-contract.mjs';
import { articleFormatFindings } from '../../ops/article-format.mjs';
import { glyphSelectionFindings } from '../../ops/glyph-format.mjs';
import { archiveIndex } from '../../ops/lay-page.mjs';
import { authenticateWorldDeskFiling } from './worlddesk-filing.mjs';
import { saveSignalDisposition, signalKey } from './signal-disposition.mjs';

const date=/^\d{4}-\d{2}-\d{2}$/;const component=/^[a-z0-9][a-z0-9-]{0,127}$/;const desks=new Set(['cogsworth','sprockett','foreman','graves','tinkerton','vesta']);
const sha=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const object=value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('object required');return value;};
const exact=(value,required,optional=[])=>{object(value);const keys=Object.keys(value);const missing=required.filter(key=>!(key in value)),unexpected=keys.filter(key=>!required.includes(key)&&!optional.includes(key));if(missing.length||unexpected.length)throw new Error(`invalid fields — missing: [${missing.join(', ')}], unexpected: [${unexpected.join(', ')}]; required: [${required.join(', ')}]${optional.length?`, optional: [${optional.join(', ')}]`:''}`);return value;};
const identity=args=>{object(args);if(!date.test(args.edition))throw new Error(`edition must be an ISO date "YYYY-MM-DD", got ${JSON.stringify(args.edition)}`);const wakeId=process.env.DAIMON_WAKE_ID;if(wakeId!==undefined){if(args.event_key!==wakeId)throw new Error(`event_key must equal the current wake id "${wakeId}", got ${JSON.stringify(args.event_key)}`);return args;}if(typeof args.event_key!=='string'||args.event_key.length<8||args.event_key.length>1024)throw new Error(`event_key must be a string between 8 and 1024 characters, got ${JSON.stringify(args.event_key)}`);return args;};
const root=()=>{const value=process.env.CLANK_EDITION_STATE_ROOT;if(!value?.startsWith('/'))throw new Error('edition state root unavailable');return path.resolve(value);};
const within=(base,...parts)=>{const value=path.resolve(base,...parts);if(value!==base&&!value.startsWith(`${base}${path.sep}`))throw new Error('path escaped authority');return value;};
const adapters=new Map();
async function adapter(environment,methods){const file=process.env[environment];if(!file?.startsWith('/'))throw new Error(`${environment} must name the installed private automation adapter`);if(!adapters.has(file))adapters.set(file,import(pathToFileURL(file).href));const module=await adapters.get(file);for(const method of methods)if(typeof module[method]!=='function')throw new Error(`${environment} adapter is missing ${method}`);return module;}
const stateAdapter=()=>adapter('CLANK_NEWSROOM_STATE_ADAPTER',['runEditionOperation','readJson','writeJson','removeJson','jsonNames']);
const converge=async(file,value)=>(await stateAdapter()).writeJson(file,value);
const supersede=async(file,value)=>(await stateAdapter()).writeJson(file,value,{replace:true});
const supersedeIndexed=async(edition,file,value)=>supersede(file,value);
const convergeIndexed=async(edition,file,value)=>converge(file,value);
const location=(edition,kind,name)=>within(root(),'editions',edition,kind,`${name}.json`);
const receipt=async(args,kind,data)=>{const artifact=args.name??(args.article_id?`${args.article_id}/${args.revision}`:data.id?`${data.id}/${data.revision}`:kind);const operation=sha(JSON.stringify([process.env.CLANK_NEWSROOM_AGENT??null,args.event_key,artifact])).slice(7,39);return converge(location(args.edition,'receipts',`${kind}-${operation}`),{version:'clank.newsroom-receipt.v1',kind,edition:args.edition,event_key:args.event_key,artifact,digest:sha(JSON.stringify(data))});};
async function composedResult(args,composition){const digest=sha(JSON.stringify(composition)),name=`composed-${digest.slice(7)}`,existing=await readJson(location(args.edition,'receipts',name)).catch(error=>error.code==='ENOENT'?undefined:Promise.reject(error));const value=existing??{version:'clank.newsroom-receipt.v1',kind:'composed',edition:args.edition,event_key:args.event_key,digest,composition};if(value.digest!==digest||JSON.stringify(value.composition)!==JSON.stringify(composition))throw new Error('composition receipt authentication failed');await converge(location(args.edition,'receipts',name),value);await supersede(location(args.edition,'composition','current'),{receipt:name,digest});return{...composition,next:compositionNoticeInstruction(args.edition,digest),receipt:value};}
const readJson=async file=>(await stateAdapter()).readJson(file);
const describeAssignment=item=>`"${item.id}": ${item.brief}`;
async function assignmentsForEdition(edition){const files=await jsonNames(edition,'assignments'),records=[];for(const name of files)records.push(await readJson(location(edition,'assignments',name)));return records;}
async function resolveAssignment(args,article,owner){
  const records=await assignmentsForEdition(args.edition),mine=[];
  for(const record of records)for(const item of record.assignments)if(item.owner===owner)mine.push({item,event_key:record.event_key});
  if(mine.length===0)throw new Error(`you have no assignment for edition ${args.edition} — a lead is not a commission; wait for Brass to record one for "${owner}" before filing. Only an explicit commission that lacks its promised row warrants one request for repair`);
  const seen=new Map();for(const entry of mine)if(!seen.has(entry.item.id))seen.set(entry.item.id,entry);
  const unique=[...seen.values()];
  if(unique.length===1){const only=unique[0];return{assignment:only.item,event_key:only.event_key,corrected:article.id!==only.item.id};}
  const byEventKey=args.assignment_event_key!==undefined?unique.filter(entry=>entry.event_key===args.assignment_event_key):[];
  const byArticleId=unique.filter(entry=>entry.item.id===article.id);
  const chosen=byEventKey.length===1?byEventKey[0]:byArticleId.length===1?byArticleId[0]:undefined;
  if(!chosen)throw new Error(`multiple assignments exist for "${owner}" in edition ${args.edition}: ${unique.map(entry=>describeAssignment(entry.item)).join('; ')} — file with the matching article.id (or assignment_event_key) to select one`);
  return{assignment:chosen.item,event_key:chosen.event_key,corrected:article.id!==chosen.item.id};
}

const filingNoticeInstruction=(edition,articleId,revision,dissenter)=>dissenter
  ?`Filing saved only; no Moltnet message was sent. Use moltnet_send on network clank-newsroom to target room:filing now: in one message include edition ${edition}, article ${articleId} revision ${revision}, and mention both @spike and @${dissenter} so Spike sees the filing and the dissenter can record before compose at 16:00`
  :`Filing saved only; no Moltnet message was sent. Use moltnet_send on network clank-newsroom to target room:filing now: include edition ${edition}, article ${articleId} revision ${revision}, and mention @spike so the editor sees the filing`;
const reviewNoticeInstruction=(args,owner)=>args.verdict==='PASS'
  ?`PASS was saved. Continue from the fresh state/edition/editions/${args.edition}/INDEX: review other unreviewed filings one at a time; when the INDEX shows passed>=5 and no D ledger.settlements or D ledger.worlddesk rows, use moltnet_send on network clank-newsroom to target room:release mentioning @ledger.`
  :args.verdict==='SPIKE'
    ?`The ${args.verdict} notes were saved only; mentions inside notes were not delivered. Use moltnet_send on network clank-newsroom to target room:filing now: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, include your actionable notes, and mention @brass if a replacement is required.`
    :`The ${args.verdict} notes were saved only; mentions inside notes were not delivered. Use moltnet_send on network clank-newsroom to target room:filing now: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, and include your actionable notes.`;
const compositionNoticeInstruction=(edition,digest)=>`Composition saved only; no Moltnet message was sent. Use moltnet_send on network clank-newsroom to target room:release now: include edition ${edition}, composition digest ${digest}, mention @pressman, and ask Pressman to run prepare_release validation/build and stage_release. Then end the turn.`;
const walkValues=(value,key,out=[])=>{if(Array.isArray(value))for(const item of value)walkValues(item,key,out);else if(value&&typeof value==='object')for(const[name,item]of Object.entries(value)){if(name===key&&typeof item==='string')out.push(item);walkValues(item,key,out);}return out;};
const publicArticleRefs=(value,out=new Set())=>{if(Array.isArray(value)){for(const item of value)publicArticleRefs(item,out);return out;}if(!value||typeof value!=='object')return out;for(const[key,item]of Object.entries(value)){if(['article','lead','splitWith'].includes(key)&&typeof item==='string')out.add(item);else if(['rail','articles'].includes(key)){if(typeof item==='string')out.add(item);if(Array.isArray(item))for(const id of item)if(typeof id==='string')out.add(id);}publicArticleRefs(item,out);}return out;};
export const collectPublicArticleReferences=(value)=>[...publicArticleRefs(value)].sort();
export { isDatedForecast } from './compose-gate.mjs';
const visualCount=value=>JSON.stringify(value).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu)?.length??0;
const leadArtError=hero=>{const art=hero?.props?.art;if(hero?.props?.variant!=='lead-only')return'new compositions require a lead-only Hero that renders lead art';if(hero?.props?.withArt!==true||!art||!['MapGlyph','GlyphArt'].includes(art.block))return'new compositions require Hero.props.art from Caslon-owned lead art';if(!art.props||typeof art.props!=='object'||Array.isArray(art.props))return'Hero.props.art.props must be an object';if(art.block==='MapGlyph'){if(!component.test(art.props.map??''))return'Hero.props.art MapGlyph requires a valid map name';if(art.props.interactive!==false)return'Hero.props.art MapGlyph must be print mode with interactive:false';}if(art.block==='GlyphArt'){if(!['glyph','shape','roll'].some(key=>art.props[key]!==undefined))return'Hero.props.art GlyphArt must name a glyph or known shape/roll';const errors=glyphSelectionFindings(art.props);if(errors.length)return`Hero.props.art GlyphArt invalid: ${errors.join('; ')}`;}return'';};
async function editionTree(edition){const articles=await jsonNames(edition,'articles'),reviews=await jsonNames(edition,'reviews'),desk=await jsonNames(edition,'desk'),pages=await jsonNames(edition,'pages'),maps=await jsonNames(edition,'maps');return{articles,desk,pages,maps,reviews};}
async function digests(edition,kind,names){return Object.fromEntries(await Promise.all(names.map(async name=>[name,sha(JSON.stringify(await readJson(location(edition,kind,name))))])));}
async function directoryDigest(directory){const hash=createHash('sha256');async function visit(base,relative=''){for(const name of(await readdir(base)).sort()){const file=path.join(base,name),next=path.posix.join(relative,name),stat=await lstat(file);if(stat.isSymbolicLink())throw new Error('release artifact contains symlink');hash.update(`${stat.isDirectory()?'d':'f'}\0${next}\0`);if(stat.isDirectory())await visit(file,next);else if(stat.isFile())hash.update(await readFile(file));else throw new Error('release artifact contains unsupported node');}}await visit(directory);return`sha256:${hash.digest('hex')}`;}
export async function authenticatedCurrentComposition(edition){
  const pointer=await readJson(location(edition,'composition','current')).catch(error=>error.code==='ENOENT'?undefined:Promise.reject(error));
  const names=pointer?[pointer.receipt]:(await jsonNames(edition,'receipts')).filter(name=>name.startsWith('composed-'));
  if(names.length===0)throw new Error('a current composition receipt is required');
  const current={articles:await jsonNames(edition,'articles'),desk:await jsonNames(edition,'desk'),pages:await jsonNames(edition,'pages'),maps:await jsonNames(edition,'maps'),glyphs:await jsonNames(edition,'glyphs')},matches=[];
  let failure='composition tree changed after receipt';
  for(const name of names){
    if(typeof name!=='string'||!/^composed-[a-f0-9]+$/u.test(name))throw new Error('composition receipt authentication failed');
    const value=await readJson(location(edition,'receipts',name)),composition=value.composition;
    if(!composition||!composition.tree||value.kind!=='composed'||value.edition!==edition||value.digest!==sha(JSON.stringify(composition))||composition.tree_digest!==sha(JSON.stringify(composition.tree))||(pointer&&pointer.digest!==value.digest))throw new Error('composition receipt authentication failed');
    const tree=composition.tree;let matchesTree=true;
    for(const kind of ['articles','desk','pages','maps','glyphs']){
      const expected=tree[kind]??[];if(current[kind].join()!==expected.join()){matchesTree=false;break;}
      const digestKey={articles:'article_digests',desk:'desk_digests',pages:'page_digests',maps:'map_digests',glyphs:'glyph_digests'}[kind];
      if(JSON.stringify(await digests(edition,kind,expected))!==JSON.stringify(tree[digestKey]??{})){failure=`composed ${kind} digest changed`;matchesTree=false;break;}
    }
    if(matchesTree)matches.push(value);
  }
  if(matches.length===0)throw new Error(failure);
  if(new Set(matches.map(value=>value.digest)).size!==1)throw new Error('ambiguous current composition receipts');
  return matches[0];
}
async function promoteCandidate(temporary,target){const digest=await directoryDigest(temporary);try{await rename(temporary,target);}catch(error){if(error.code!=='EEXIST'&&error.code!=='ENOTEMPTY')throw error;const existing=await directoryDigest(target);if(existing!==digest)throw new Error('existing release target digest conflict');await rm(temporary,{recursive:true,force:true});}return digest;}

async function qualifySignalAction(args){
  identity(args);
  return saveSignalDisposition(args,{
    read: id=>readJson(location(args.edition,'candidates',id)).catch(error=>error.code==='ENOENT'?undefined:Promise.reject(error)),
    write: (id,value,options)=>options.replace?supersede(location(args.edition,'candidates',id),value):converge(location(args.edition,'candidates',id),value),
    receipt: value=>receipt(args,'qualified',value)
  });
}
async function recordAssignmentAction(args){
  identity(args);exact(args,['edition','event_key','assignments']);
  if(!Array.isArray(args.assignments))throw new Error('assignments must be an array of {id, owner, brief, evidence_refs} objects');
  if(args.assignments.length<5)throw new Error(`assignments must include at least 5 items, got ${args.assignments.length}`);
  args.assignments.forEach((item,index)=>{
    try{exact(item,['id','owner','brief','evidence_refs'],['slot','dissenter']);}catch(error){throw new Error(`assignments[${index}] ${error.message}`);}
    if(!component.test(item.id))throw new Error(`assignments[${index}].id ${JSON.stringify(item.id)} must be 1-128 lowercase alphanumeric/hyphen characters, starting with a letter or digit`);
    if(!desks.has(item.owner))throw new Error(`assignments[${index}].owner ${JSON.stringify(item.owner)} must be one of: ${[...desks].join(', ')}`);
    if(typeof item.brief!=='string'||item.brief.length<20)throw new Error(`assignments[${index}].brief must be a string of at least 20 characters, got ${typeof item.brief==='string'?`${item.brief.length} characters`:typeof item.brief}`);
    if(!Array.isArray(item.evidence_refs))throw new Error(`assignments[${index}].evidence_refs must be an array of strings`);
    if(item.slot!==undefined&&item.slot!=='forecast')throw new Error(`assignments[${index}].slot ${JSON.stringify(item.slot)} must be "forecast" — it is the only slot the lineup names`);
    if(item.dissenter!==undefined){
      if(item.slot!=='forecast')throw new Error(`assignments[${index}].dissenter is only meaningful beside slot "forecast" — a dissent is held against a dated call, so name the slot too or drop the dissenter`);
      if(!desks.has(item.dissenter))throw new Error(`assignments[${index}].dissenter ${JSON.stringify(item.dissenter)} must be one of: ${[...desks].join(', ')}`);
      if(item.dissenter===item.owner)throw new Error(`assignments[${index}].dissenter ${JSON.stringify(item.dissenter)} is the owner of the piece — nobody dissents from their own byline, name a different desk`);
    }
  });
  const ids=args.assignments.map(item=>item.id),duplicates=ids.filter((id,index)=>ids.indexOf(id)!==index);
  if(duplicates.length>0)throw new Error(`assignments[].id must be unique, got duplicates: ${[...new Set(duplicates)].join(', ')}`);
  const slotted=args.assignments.filter(item=>item.slot==='forecast');
  if(slotted.length>1)throw new Error(`at most one assignment may carry slot "forecast", got ${slotted.length}: ${slotted.map(item=>item.id).join(', ')}`);
  if(slotted.length!==1)throw new Error(`exactly one assignment must carry slot "forecast", got ${slotted.length}`);
  if(slotted[0].dissenter===undefined)throw new Error(`assignments[${args.assignments.indexOf(slotted[0])}].dissenter is required for the forecast slot and must name a different desk`);
  await convergeIndexed(args.edition,location(args.edition,'assignments',sha(args.event_key).slice(7,39)),{version:'clank.assignments.v1',...args});
  const forecast={id:slotted[0].id,owner:slotted[0].owner,dissenter:slotted[0].dissenter};
  return{recorded:args.assignments.length,forecast,receipt:await receipt(args,'assigned',args.assignments)};
}
const subdirNames=async(edition,kind)=>{try{return(await readdir(within(root(),'editions',edition,kind),{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();}catch(error){if(error.code==='ENOENT')return[];throw error;}};
const revisionNames=async(edition,kind,id)=>{try{return(await readdir(within(root(),'editions',edition,kind,id))).filter(name=>name.endsWith('.json')).map(name=>Number(name.slice(0,-5))).filter(value=>Number.isSafeInteger(value)&&value>=1).sort((left,right)=>left-right);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
async function latestFilings(edition){const out=[];for(const id of await subdirNames(edition,'filings')){const revisions=await revisionNames(edition,'filings',id);const revision=revisions[revisions.length-1];if(revision===undefined)continue;out.push({id,revision,value:await readJson(location(edition,'filings',`${id}/${revision}`))});}return out;}

const personaRoot=path.resolve(import.meta.dirname,'..','..','content','agents');
const displayNames=new Map();
async function personaName(agent){
  if(displayNames.has(agent))return displayNames.get(agent);
  const value=await readJson(path.join(personaRoot,`${agent}.json`)).catch(()=>undefined);
  const name=typeof value?.name==='string'&&value.name.length>0?value.name:agent[0].toUpperCase()+agent.slice(1);
  displayNames.set(agent,name);
  return name;
}

let archivedMapNames;
const archivedMaps=()=>{archivedMapNames??=new Set(archiveIndex().keys());return archivedMapNames;};
const normalizeSpots=spots=>JSON.stringify((Array.isArray(spots)?spots:[]).map(spot=>({name:spot?.name,lat:spot?.lat,lon:spot?.lon})).sort((left,right)=>String(left.name).localeCompare(String(right.name))));
const ART_TAIL='name a region ops/ASSETS.md lists, or file without art';
async function checkArticleArt(edition,id,article){
  const art=article.art;
  if(art===undefined)return;
  if(art===null||typeof art!=='object'||Array.isArray(art))throw new Error(`article.art must be an object {kind, …}, got ${Array.isArray(art)?'an array':typeof art} — ${ART_TAIL}`);
  if(art.kind!=='map'&&art.kind!=='ascii')throw new Error(`article.art.kind must be "map" (a baked region) or "ascii" (a glyph the compositor picks), got ${JSON.stringify(art.kind)} — ${ART_TAIL}`);
  if(art.kind!=='map')return;
  const archive=archivedMaps(),supplied=new Set(await jsonNames(edition,'maps'));
  const listed=name=>archive.has(name)||supplied.has(name);
  if(typeof art.map!=='string'||art.map.length===0)throw new Error(`article.art.kind is "map" but art.map is ${JSON.stringify(art.map)} — art.map is the wide region the story page and the OG card draw, and it is required: ${ART_TAIL}`);
  if(!listed(art.map))throw new Error(`article.art.map "${art.map}" is in neither this edition's maps/ nor the committed archive under content/editions/*/maps/, and nothing in this container can bake a new region: ${ART_TAIL}`);
  if(art.hero_map!==undefined){
    if(typeof art.hero_map!=='string'||art.hero_map.length===0)throw new Error(`article.art.hero_map must be a region name when present — the front panel's narrower re-crop, usually "${art.map}-hero" — or left out entirely, got ${JSON.stringify(art.hero_map)}: ${ART_TAIL}`);
    if(!listed(art.hero_map))throw new Error(`article.art.hero_map "${art.hero_map}" is in neither this edition's maps/ nor the committed archive under content/editions/*/maps/: ${ART_TAIL}`);
  }
  if(art.spots!==undefined){
    if(!Array.isArray(art.spots))throw new Error(`article.art.spots must be an array of {name, lat, lon} places, got ${typeof art.spots} — ${ART_TAIL}`);
    art.spots.forEach((spot,index)=>{
      if(!spot||typeof spot!=='object'||Array.isArray(spot))throw new Error(`article.art.spots[${index}] must be an object {name, lat, lon}`);
      if(typeof spot.name!=='string'||spot.name.length===0)throw new Error(`article.art.spots[${index}].name must be a non-empty place name`);
      for(const key of ['lat','lon'])if(typeof spot[key]!=='number'||!Number.isFinite(spot[key]))throw new Error(`article.art.spots[${index}].${key} must be a number — the marker on the map and the place in your copy are one place`);
    });
  }
  const mine=normalizeSpots(art.spots),names=new Set([art.map,art.hero_map].filter(Boolean));
  for(const filing of await latestFilings(edition)){
    if(filing.id===id)continue;
    const other=filing.value.art;
    if(other?.kind!=='map')continue;
    for(const name of [other.map,other.hero_map].filter(Boolean)){
      if(!names.has(name)||normalizeSpots(other.spots)===mine)continue;
      throw new Error(`"${filing.id}" already names map "${name}" with different art.spots, and one region cannot carry two sets — the content validator matches a page MapGlyph's spots against the article art for that name. Use exactly the spots "${filing.id}" filed, or ${ART_TAIL}`);
    }
  }
}

async function fileArticleAction(args){
  identity(args);exact(args,['edition','event_key','article'],['assignment_event_key']);
  if(args.assignment_event_key!==undefined&&typeof args.assignment_event_key!=='string')throw new Error(`assignment_event_key must be a string when supplied, got ${typeof args.assignment_event_key}`);
  const article=object(args.article);
  if('dissent' in article)throw new Error('article.dissent is not yours to write — a dissent is recorded by the colleague who holds it, with record_dissent, under their own name, never typed into your filing. Remove article.dissent and file again.');
  const owner=process.env.CLANK_NEWSROOM_AGENT;
  const{assignment,event_key:assignmentEventKey,corrected}=await resolveAssignment(args,article,owner);
  const resolvedArticle=corrected?{...article,id:assignment.id}:article;
  const topics=await knownTopicSlugs(),previousArticles=new Set();
  for(const prior of Array.isArray(resolvedArticle.previous_coverage)?resolvedArticle.previous_coverage:[])if(date.test(prior?.date??'')&&component.test(prior?.slug??'')&&await lstat(path.join(personaRoot,'..','editions',prior.date,'articles',`${prior.slug}.json`)).then(stat=>stat.isFile(),()=>false))previousArticles.add(`${prior.date}/${prior.slug}`);
  const format=articleFormatFindings(resolvedArticle,{profile:'filing',editionDate:args.edition,articleId:assignment.id,owner,topicSlugs:topics,previousArticles,forecastRequired:assignment.slot==='forecast'});
  if(format.errors.length)throw new Error(`article format rejected — nothing was recorded; fix these fields and file again: ${format.errors.map(item=>`${item.path} [${item.code}] ${item.message}`).join('; ')}`);
  const evidence=new Set(resolvedArticle.evidence_box.flatMap(item=>[item?.source_note?.source_url,item?.source_note?.source_id]).filter(Boolean));
  const missingEvidence=assignment.evidence_refs.filter(ref=>!evidence.has(ref));
  if(missingEvidence.length>0)throw new Error(`article.evidence_box does not preserve assignment lineage — your assignment ${describeAssignment(assignment)} carries evidence_refs that your evidence_box does not: ${missingEvidence.join(', ')}. Each one must appear as an entry in article.evidence_box whose source_note.source_id or source_note.source_url is exactly that string — carry the note across from the research the assignment points at, never invent one to clear this check. Then cite each of those entries in article.body by its position, [E1] for the first evidence_box entry through [En] for the nth: an entry added only to satisfy this check and never cited is flagged cite_unused and the editor returns it for revision.`);
  const revision=resolvedArticle.revision;
  const verdictAt=async offset=>readJson(location(args.edition,'verdicts',`${assignment.id}/${offset}`)).catch(()=>undefined);
  const filingPath=location(args.edition,'filings',`${assignment.id}/${revision}`);
  const priorFiling=await readJson(filingPath).catch(()=>undefined);
  const ruled=await verdictAt(revision);
  if(ruled)throw new Error(`revision ${revision} of "${assignment.id}" has already been reviewed — the editor recorded "${ruled.verdict}" against it and a reviewed revision cannot be rewritten. ${['REVISION_REQUEST','HOLD'].includes(ruled.verdict)?`File your corrected piece as revision ${revision+1}.`:'Wait for the editor rather than re-filing this one.'}`);
  if(revision>1){
    const prior=await verdictAt(revision-1);
    if(!prior){
      const priorExists=await readJson(location(args.edition,'filings',`${assignment.id}/${revision-1}`)).then(()=>true,()=>false);
      throw new Error(priorExists
        ?`revision ${revision-1} of "${assignment.id}" is filed and still with the editor — you do not raise your own revision number. Wait for the verdict, or file revision ${revision-1} again if you need to correct it before the editor reads it.`
        :`you have never filed revision ${revision-1} of "${assignment.id}", so there is no revision ${revision} to file. A refused filing is not a filing — nothing was recorded — so file revision ${revision-1} again with the problem fixed, rather than raising the number.`);
    }
    if(!['REVISION_REQUEST','HOLD'].includes(prior.verdict))throw new Error(`revision ${revision} requires revision ${revision-1} to carry a REVISION_REQUEST or HOLD verdict, got "${prior.verdict}"`);
  }
  await checkArticleArt(args.edition,assignment.id,resolvedArticle);
  const flags=lintFiling(resolvedArticle,topics);
  const refused=[...new Set([...hardLintFlags(flags,CITATION_GATE_NAMES),...hardLintFlags(flags,armedHardLintNames())])];
  if(refused.length>0)throw new Error(`filing rejected on ${refused.length} mechanical check${refused.length===1?'':'s'} — fix and file again in this wake, as revision ${revision}, because nothing was recorded: ${refused.map(flag=>`${flag} — ${describeLintFlag(flag)}`).join('; ')}`);
  const {flags:warningFlags,warnings}=advisoryFilingWarnings(resolvedArticle,topics,refused);
  const filing={...resolvedArticle,assignment_ref:{event_key:assignmentEventKey,id:assignment.id},...(warnings.length>0?{lint:{flags:warningFlags,warnings}}:{})};
  await supersedeIndexed(args.edition,filingPath,filing);
  const result={article_id:assignment.id,revision,digest:sha(JSON.stringify(filing)),warnings,receipt:await receipt(args,'filed',filing,supersede)};
  if(priorFiling)result.replaced=`this replaces your earlier revision ${revision} of "${assignment.id}", which the editor had not yet reviewed`;
  if(corrected)result.note=`your assignment today is ${describeAssignment(assignment)} — filed under that id instead of the supplied ${JSON.stringify(article.id)}`;
  result.next=filingNoticeInstruction(args.edition,assignment.id,revision,assignment.slot==='forecast'?assignment.dissenter:undefined);
  if(assignment.slot==='forecast')result.forecast={dissenter:assignment.dissenter??null};
  return result;
}
async function recordDissentAction(args){
  identity(args);exact(args,['edition','event_key','article_id','revision','stance','argument'],['p']);
  const agent=process.env.CLANK_NEWSROOM_AGENT;
  if(!desks.has(agent))throw new Error(`record_dissent may only be called by a reporting desk (${[...desks].join(', ')}), got ${JSON.stringify(agent)} — a dissent is a reporter's act and the tool set is the boundary`);
  if(!component.test(args.article_id))throw new Error(`article_id ${JSON.stringify(args.article_id)} must be 1-128 lowercase alphanumeric/hyphen characters, starting with a letter or digit`);
  if(!Number.isSafeInteger(args.revision)||args.revision<1)throw new Error(`revision must be an integer >= 1, got ${JSON.stringify(args.revision)}`);
  if(args.stance!=='dissent'&&args.stance!=='concur')throw new Error(`stance must be "dissent" (you hold a counter-call) or "concur" (you read it and nothing crossed the line), got ${JSON.stringify(args.stance)}`);
  if(typeof args.argument!=='string')throw new Error(`argument must be a string, got ${typeof args.argument}`);
  if(args.stance==='dissent'){
    if(typeof args.p!=='number'||!Number.isFinite(args.p)||args.p<0||args.p>1)throw new Error(`stance "dissent" requires p — your own probability for the call, a number in [0, 1] — got ${JSON.stringify(args.p)}`);
    if(args.argument.length<80||args.argument.length>2000)throw new Error(`stance "dissent" requires an argument between 80 and 2000 characters: the reasoning a reader can weigh, not a verdict. Got ${args.argument.length}`);
  }else{
    if(args.p!==undefined)throw new Error('stance "concur" carries no p — it puts you on the record as having read the call and not opposed it, not as holding a different number');
    if(args.argument.length<20||args.argument.length>2000)throw new Error(`stance "concur" requires an argument between 20 and 2000 characters saying why nothing crossed the line, got ${args.argument.length}`);
  }
  const filing=await readJson(location(args.edition,'filings',`${args.article_id}/${args.revision}`)).catch(()=>undefined);
  if(!filing){
    const filed=[];for(const id of await subdirNames(args.edition,'filings'))for(const revision of await revisionNames(args.edition,'filings',id))filed.push(`${id} rev ${revision}`);
    throw new Error(`nothing is filed at revision ${args.revision} of "${args.article_id}" in edition ${args.edition}${filed.length>0?` — what is filed: ${filed.join(', ')}`:' — no filing exists yet'}. The announcement in room:filing carries the id and the revision; dissent against that one.`);
  }
  if(((filing.byline?.agents??[])[0]??'').toLowerCase()===agent)throw new Error(`revision ${args.revision} of "${args.article_id}" carries your own byline — you cannot dissent from your own piece`);
  if((await jsonNames(args.edition,'receipts')).some(name=>name.startsWith('composed-')))throw new Error(`edition ${args.edition} is composed; a dissent recorded now cannot reach the page — say it on the floor, it will not be attributed to you in print`);
  const ruled=await readJson(location(args.edition,'verdicts',`${args.article_id}/${args.revision}`)).catch(()=>undefined);
  if(ruled?.verdict==='REVISION_REQUEST')throw new Error(`revision ${args.revision} of "${args.article_id}" was sent back for revision — dissent against the next one, once it is filed and announced`);
  const name=await personaName(agent);
  const value={version:'clank.dissent.v1',edition:args.edition,article_id:args.article_id,revision:args.revision,article_digest:sha(JSON.stringify(filing)),agent,name,stance:args.stance,...(args.stance==='dissent'?{p:args.p}:{}),argument:args.argument,event_key:args.event_key};
  const dissentPath=location(args.edition,'dissents',`${args.article_id}/${args.revision}`);
  const existing=await readJson(dissentPath).catch(()=>undefined);
  if(existing&&JSON.stringify(existing)!==JSON.stringify(value))throw new Error(`${existing.name??existing.agent} already holds the dissent on revision ${args.revision} of "${args.article_id}" — one dissent per piece`);
  await convergeIndexed(args.edition,dissentPath,value);
  let merged=false,note;
  if(args.stance==='dissent'){
    const articlePath=location(args.edition,'articles',args.article_id);
    const article=await readJson(articlePath).catch(()=>undefined);
    if(article&&article.revision===args.revision){await supersedeIndexed(args.edition,articlePath,{...article,dissent:{agent:name,p:args.p,argument:args.argument}});merged=true;}
    else if(article)note=`the editor passed revision ${article.revision} of "${args.article_id}", not the revision ${args.revision} you read — this dissent is on the record but is not on the page`;
    else note='the editor has not passed this piece yet; the dissent will be merged when he does';
  }
  return{recorded:true,stance:args.stance,merged,...(note?{note}:{}),receipt:await receipt(args,'dissented',value)};
}

async function dissentToMerge(args,filing){
  const revisions=await revisionNames(args.edition,'dissents',args.article_id);
  if(revisions.length===0)return undefined;
  const held=[];for(const revision of revisions){const record=await readJson(location(args.edition,'dissents',`${args.article_id}/${revision}`));if(record.stance==='dissent')held.push(record);}
  const exact=held.find(record=>record.revision===args.revision);
  if(exact)return{dissent:{agent:exact.name,p:exact.p,argument:exact.argument}};
  const earlier=held.filter(record=>record.revision<args.revision).sort((left,right)=>right.revision-left.revision)[0];
  if(!earlier)return undefined;
  const prior=await readJson(location(args.edition,'filings',`${args.article_id}/${earlier.revision}`)).catch(()=>undefined);
  if(prior===undefined||prior.confidence?.value!==filing.confidence?.value||prior.next_update_utc!==filing.next_update_utc)return{dropped:`recorded against revision ${earlier.revision}; the call changed`};
  await converge(location(args.edition,'dissents',`${args.article_id}/${args.revision}`),{...earlier,revision:args.revision,against_revision:earlier.revision,article_digest:sha(JSON.stringify(filing)),carried_by_event_key:args.event_key});
  return{dissent:{agent:earlier.name,p:earlier.p,argument:earlier.argument}};
}
async function reviewArticleAction(args){
  identity(args);exact(args,['edition','event_key','article_id','revision','filing_digest','verdict','notes']);
  if(process.env.CLANK_NEWSROOM_AGENT!=='spike')throw new Error(`review_article may only be called by "spike", got "${process.env.CLANK_NEWSROOM_AGENT}"`);
  if(!component.test(args.article_id))throw new Error(`article_id ${JSON.stringify(args.article_id)} must be 1-128 lowercase alphanumeric/hyphen characters, starting with a letter or digit`);
  if(!Number.isSafeInteger(args.revision)||args.revision<1)throw new Error(`revision must be an integer >= 1, got ${JSON.stringify(args.revision)}`);
  if(!['PASS','REVISION_REQUEST','HOLD','SPIKE'].includes(args.verdict))throw new Error(`verdict must be one of: PASS, REVISION_REQUEST, HOLD, SPIKE — got ${JSON.stringify(args.verdict)}`);
  if(typeof args.notes!=='string'||args.notes.length>8000)throw new Error(`notes must be a string of at most 8000 characters, got ${typeof args.notes==='string'?`${args.notes.length} characters`:typeof args.notes}`);
  const filing=await readJson(location(args.edition,'filings',`${args.article_id}/${args.revision}`)).catch(()=>{throw new Error(`no filing found for article_id ${JSON.stringify(args.article_id)} revision ${args.revision} — the reporter must file_article that revision before it can be reviewed`);});
  if(!/^sha256:[a-f0-9]{64}$/u.test(args.filing_digest??'')||args.filing_digest!==sha(JSON.stringify(filing)))throw new Error('filing_digest is stale or invalid — read the current filing and its INDEX digest before reviewing; no verdict was recorded');
  const merge=args.verdict==='PASS'?await dissentToMerge(args,filing):undefined;
  const review={version:'clank.editorial-verdict.v1',article_id:args.article_id,revision:args.revision,article_digest:sha(JSON.stringify(filing)),verdict:args.verdict,notes:args.notes,event_key:args.event_key,...(merge?.dropped?{dissent_dropped:merge.dropped}:{})};
  await convergeIndexed(args.edition,location(args.edition,'verdicts',`${args.article_id}/${args.revision}`),review);
  if(args.verdict==='PASS'){const{assignment_ref:_,lint:__,...article}=filing;await converge(location(args.edition,'reviews',args.article_id),review);await convergeIndexed(args.edition,location(args.edition,'articles',args.article_id),merge?.dissent?{...article,dissent:merge.dissent}:article);}
  return{...review,warnings:filing.lint?.warnings??[],...(merge?.dissent?{dissent:merge.dissent}:{}),next:reviewNoticeInstruction(args,filing.assignment_ref?.owner??((filing.byline?.agents??[])[0]??'owner').toLowerCase()),receipt:await receipt(args,'reviewed',review)};
}
async function fileDeskAction(args){
  identity(args);exact(args,['edition','event_key','name','document']);
  const agent=process.env.CLANK_NEWSROOM_AGENT,allowed=agent==='ledger'?new Set(['ledger.settlements','ledger.worlddesk']):agent==='caslon'?new Set(['caslon.chrome','caslon.weather']):new Set();
  if(!allowed.has(args.name))throw new Error(`name ${JSON.stringify(args.name)} is not owned by "${agent}" — allowed names for "${agent}": ${allowed.size?[...allowed].join(', '):'none'}`);
  const findings=deskDocumentFindings(args.name,object(args.document),{profile:'filing'});
  if(findings.length>0)throw new Error(`desk document ${JSON.stringify(args.name)} does not match the shape the edition is assembled from — ${findings.join('; ')}`);
  if(args.name==='ledger.worlddesk')await authenticateWorldDeskFiling(args);
  await converge(location(args.edition,'history',`desk/${args.name}/${sha(JSON.stringify(args.document)).slice(7)}`),args.document);
  await supersedeIndexed(args.edition,location(args.edition,'desk',args.name),args.document);
  return{name:args.name,receipt:await receipt(args,'desk-filed',args.document)};
}
async function composeEditionAction(args){
  exact(args,Object.hasOwn(args,'layout_sha256')?['edition','event_key','layout_sha256']:['edition','event_key','pages'],Object.hasOwn(args,'layout_sha256')?[]:['maps','artifacts']);
  args=await(await adapter('CLANK_NEWSROOM_STATE_ADAPTER',['compositionInput'])).compositionInput(args,{publicRoot:path.resolve(import.meta.dirname,'../..')});
  identity(args);exact(args,['edition','event_key','pages'],['maps','artifacts']);
  if(process.env.CLANK_NEWSROOM_AGENT!=='caslon')throw new Error(`compose_edition may only be called by "caslon", got "${process.env.CLANK_NEWSROOM_AGENT}"`);
  if(!Array.isArray(args.pages)||args.pages.length!==2)throw new Error(`pages must be an array of exactly 2 page documents, got ${Array.isArray(args.pages)?args.pages.length:typeof args.pages}`);
  if(new Set(args.pages.map(page=>page.name)).size!==2||args.pages.some(page=>!['front','tape'].includes(page.name)))throw new Error(`pages[].name must be exactly one "front" and one "tape", got ${JSON.stringify(args.pages.map(page=>page.name))}`);
  const articles=await jsonNames(args.edition,'articles'),reviews=await jsonNames(args.edition,'reviews'),desk=await jsonNames(args.edition,'desk');
  if(articles.length<5)throw new Error(`edition tree incomplete — at least 5 PASSed articles required, found ${articles.length}`);
  if(reviews.length!==articles.length)throw new Error(`edition tree incomplete — reviews (${reviews.length}) must match articles (${articles.length})`);
  if(desk.length!==4)throw new Error(`edition tree incomplete — exactly 4 desk documents required (ledger.settlements, ledger.worlddesk, caslon.chrome, caslon.weather), found ${desk.length}`);
  const values=[];for(const name of articles){const article=await readJson(location(args.edition,'articles',name)),review=await readJson(location(args.edition,'reviews',name)),filing=await readJson(location(args.edition,'filings',`${name}/${article.revision}`));if(review.verdict!=='PASS'||review.article_digest!==sha(JSON.stringify(filing)))throw new Error(`composition requires selected authentic PASS articles — "${name}" carries verdict "${review.verdict}" or a stale digest`);const{assignment_ref:_,lint:__,...filedArticle}=filing,{dissent:___,...publishedArticle}=article;if(JSON.stringify(publishedArticle)!==JSON.stringify(filedArticle))throw new Error(`composition requires reporter-owned prose unchanged from the PASS filing — "${name}" differs`);values.push(article);}
  const coverage=compositionCoverage(values);assertCompositionCoverage(coverage);
  const gates=composeGateStatus({edition:args.edition,passed:articles.length,desks:desk.length,coverage,forecasts:values.filter(isDatedForecast).length,dissents:values.filter(hasNamedDissent).length});
  const pageArticles=new Set(),pageMaps=new Set(),papers=new Set();for(const page of args.pages){object(page.document);for(const value of publicArticleRefs(page.document))pageArticles.add(value);for(const value of walkValues(page.document,'map'))pageMaps.add(value);for(const value of walkValues(page.document,'paper'))papers.add(value);}
  if([...pageArticles].sort().join()!==articles.join())throw new Error(`page completeness invalid — pages must reference exactly the PASSed articles [${articles.join(', ')}], got [${[...pageArticles].sort().join(', ')}]`);
  if(papers.size<2)throw new Error(`paper diversity invalid — pages must use at least 2 distinct "paper" values, found ${papers.size}`);
  const frontPageDocument=args.pages.find(page=>page.name==='front').document,frontHero=(frontPageDocument.head??[]).find(block=>block?.block==='Hero');
  {const leadError=leadArtError(frontHero);if(leadError)throw new Error(`lead illustration invalid — ${leadError}`);}
  const frontVisuals=visualCount(frontPageDocument);
  if(frontVisuals<2||frontVisuals>3)throw new Error(`illustration rhythm invalid — the "front" page must carry 2-3 MapGlyph/GlyphArt/Illustration/Image blocks, found ${frontVisuals}`);
  const selected={maps:new Map(),glyphs:new Map()};
  if(args.artifacts!==undefined&&!Array.isArray(args.artifacts))throw new Error('artifacts must be an array of immutable Caslon artwork references');
  for(const reference of args.artifacts??[]){
    if(!reference||!['map','glyph'].includes(reference.kind)||!component.test(reference.name)||!/^[a-f0-9]{64}$/u.test(reference.sha256??''))throw new Error('invalid composition artifact reference');
    const base=within(root(),'editions',args.edition,'art',reference.sha256),bytes=await readFile(path.join(base,`${reference.kind}.json`),'utf8'),provenance=await readJson(path.join(base,'provenance.json'));
    const artifact=validateCompositionArtifact(reference,bytes,provenance),target=selected[reference.kind==='map'?'maps':'glyphs'];
    if(target.has(reference.name))throw new Error('duplicate composition artifact name');target.set(reference.name,artifact);
  }
  const suppliedMaps=new Map();
  for(const map of args.maps??[]){if(!component.test(map?.name))throw new Error('invalid map name');if(suppliedMaps.has(map.name))throw new Error('duplicate supplied map name');object(map.document);suppliedMaps.set(map.name,map.document);}
  for(const [name,document] of selected.maps){if(suppliedMaps.has(name)&&JSON.stringify(suppliedMaps.get(name))!==JSON.stringify(document))throw new Error('selected map digest differs from supplied map');suppliedMaps.set(name,document);}
  const articleMaps=new Set(values.flatMap(value=>[value.art?.map,value.art?.hero_map]).filter(Boolean)),requiredMaps=new Set([...articleMaps,...pageMaps]);
  if([...suppliedMaps.keys()].sort().join()!==[...requiredMaps].sort().join())throw new Error(`maps must exactly match article art and page references — required [${[...requiredMaps].sort().join(', ')}], supplied [${[...suppliedMaps.keys()].sort().join(', ')}]`);
  const archive=archiveIndex();
  for(const [name,document] of suppliedMaps){if(selected.maps.has(name))continue;const archived=archive.get(name);if(!archived)throw new Error(`map "${name}" is not an authenticated selected artifact or archived map`);const original=typeof archived==='string'?JSON.parse(await readFile(archived,'utf8')):archived;if(JSON.stringify(original)!==JSON.stringify(document))throw new Error(`archived map "${name}" digest differs from supplied map`);}
  const pageGlyphs=new Set(args.pages.flatMap(page=>walkValues(page.document,'glyph')));
  for(const name of selected.glyphs.keys())if(!pageGlyphs.has(name))throw new Error(`selected glyph "${name}" is not referenced by a page`);
  for(const name of pageGlyphs)if(!selected.glyphs.has(name))throw new Error(`page glyph "${name}" requires its authenticated selected artifact`);
  for(const page of args.pages){await converge(location(args.edition,'history',`pages/${page.name}/${sha(JSON.stringify(page.document)).slice(7)}`),page.document);await supersedeIndexed(args.edition,location(args.edition,'pages',page.name),page.document);}
  for(const [kind,documents] of [['maps',suppliedMaps],['glyphs',selected.glyphs]]){for(const name of await jsonNames(args.edition,kind))if(!documents.has(name))await(await stateAdapter()).removeJson(location(args.edition,kind,name));for(const [name,document] of documents){await converge(location(args.edition,'history',`${kind}/${name}/${sha(JSON.stringify(document)).slice(7)}`),document);await supersede(location(args.edition,kind,name),document);}}
  const pageNames=['front','tape'],mapNames=[...suppliedMaps.keys()].sort(),glyphNames=[...selected.glyphs.keys()].sort(),tree={articles,desk,pages:pageNames,maps:mapNames,glyphs:glyphNames,article_digests:await digests(args.edition,'articles',articles),desk_digests:await digests(args.edition,'desk',desk),page_digests:await digests(args.edition,'pages',pageNames),map_digests:await digests(args.edition,'maps',mapNames),glyph_digests:await digests(args.edition,'glyphs',glyphNames)};
  const composition={tree,tree_digest:sha(JSON.stringify(tree)),compose_gates:composeGateLine(gates),forecasts:gates.forecasts,dissents:gates.dissents};return composedResult(args,composition);
}
const jsonNames=async(edition,kind)=>(await stateAdapter()).jsonNames(within(root(),'editions',edition,kind));
const run=async(command,args,cwd)=>{const home=path.join(cwd,'.release-home'),temporary=path.join(cwd,'.release-tmp');await mkdir(home,{recursive:true});await mkdir(temporary,{recursive:true});return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd,stdio:'pipe',env:{CI:'1',HOME:home,TMPDIR:temporary,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'}});let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} failed: ${stderr.slice(-2000)}`)));});};
export async function makeOwnerWritable(rootDir){
  const entries=await readdir(rootDir,{recursive:true,withFileTypes:true});
  for(const file of [rootDir,...entries.map(entry=>path.join(entry.parentPath??entry.path,entry.name))]){
    const stats=await lstat(file);
    if(stats.isSymbolicLink())continue;
    const mode=stats.mode&0o7777,next=mode|(stats.isDirectory()?0o700:0o600);
    if(next!==mode)await chmod(file,next);
  }
}
export async function stagePublicSource(source,temporary,filter){
  await cp(source,temporary,{recursive:true,dereference:true,filter});
  await makeOwnerWritable(temporary);
}
export async function mergeBundle(from,into){
  await cp(from,into,{recursive:true,force:true});
  await makeOwnerWritable(into);
}
async function releaseAction(method,args){
  identity(args);exact(args,['edition','event_key']);
  if(process.env.CLANK_NEWSROOM_AGENT!=='pressman')throw new Error(`${method} may only be called by "pressman"`);
  const compositionReceipt=await authenticatedCurrentComposition(args.edition),release=await adapter('CLANK_NEWSROOM_RELEASE_ADAPTER',[method]);
  return release[method]({args,compositionReceipt,stateRoot:root(),sourceRoot:process.env.CLANK_PUBLIC_SOURCE_ROOT,stagingRoot:process.env.CLANK_RELEASE_STAGING_ROOT,dependencyRoots:(process.env.CLANK_WEBSITE_DEPS_ROOTS??'').split(':').filter(Boolean),assetRoots:(process.env.CLANK_PUBLIC_ASSET_ROOTS??'').split(':').filter(Boolean),helpers:{stagePublicSource,mergeBundle,makeOwnerWritable}});
}
async function operation(name,args,action,resource=name,{cache=true}={}){identity(args);const state=await stateAdapter();return state.runEditionOperation({root:root(),edition:args.edition,operation:name,role:process.env.CLANK_NEWSROOM_AGENT??null,wakeId:args.event_key,request:args,resource,cache,afterCommit:()=>writeEditionIndex(root(),args.edition)},()=>action(args));}
export const qualifySignal=args=>operation('qualify_signal',args,qualifySignalAction,args.source_id===undefined?'qualify_signal':signalKey(args.source_id));
export const recordAssignment=args=>operation('record_assignment',args,recordAssignmentAction);
export const fileArticle=args=>operation('file_article',args,fileArticleAction,async()=>{const {assignment}=await resolveAssignment(args,object(args.article),process.env.CLANK_NEWSROOM_AGENT);return `${assignment.id}/${args.article.revision}`;});
export const recordDissent=args=>operation('record_dissent',args,recordDissentAction,`${args.article_id}/${args.revision}`);
export const reviewArticle=args=>operation('review_article',args,reviewArticleAction,`${args.article_id}/${args.revision}`);
export const fileDesk=args=>operation('file_desk',args,fileDeskAction,args.name);
export const composeEdition=args=>operation('compose_edition',args,composeEditionAction,'edition',{cache:false});
export const prepareRelease=args=>operation('prepare_release',args,value=>releaseAction('prepareRelease',value),'edition',{cache:false});
export const stageRelease=args=>operation('stage_release',args,value=>releaseAction('stageRelease',value),'edition',{cache:false});
