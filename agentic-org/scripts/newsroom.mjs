import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isSafeReceiptRef, validateLifecycleGraph } from './lifecycle-graph.mjs';
import { isBerlinRelease } from './release-time.mjs';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const editionPattern = /^\d{4}-\d{2}-\d{2}$/;
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function assembleEdition(assignments, artifacts) {
  const assigned = new Map(assignments.map((item) => [item.artifact_ref, item])); const refs = artifacts.map((item) => item.ref);
  if (assigned.size !== assignments.length || new Set(refs).size !== artifacts.length || artifacts.length !== assignments.length || refs.some((ref) => !assigned.has(ref)) || [...assigned.keys()].some((ref) => !refs.includes(ref))) throw new Error('assembler requires an exact bijection between assignments and artifacts');
  const accepted = artifacts.map((artifact) => {
    const assignment = assigned.get(artifact.ref);
    if (assignment.owner !== artifact.owner || assignment.status !== 'PASS' || artifact.validated !== true || !digestPattern.test(artifact.digest)) throw new Error('assembler rejected unassigned or unvalidated artifact');
    return { assignment_id: assignment.id, digest: artifact.digest, owner: artifact.owner, ref: artifact.ref };
  }).sort((left, right) => left.assignment_id.localeCompare(right.assignment_id));
  const bytes = `${JSON.stringify({ version: 'v1', artifacts: accepted })}\n`; return { bytes, digest: sha(bytes) };
}

const convergeFile = async (file, bytes) => {
  await mkdir(dirname(file), { recursive: true });
  try { const existing=await readFile(file,'utf8'); if (existing!==bytes) throw new Error('idempotency conflict'); return; } catch (error) { if (error.code!=='ENOENT') throw error; }
  const temporary=`${file}.tmp-${randomUUID()}`; await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
  try { await link(temporary,file); } catch (error) { if (error.code!=='EEXIST' || await readFile(file,'utf8')!==bytes) throw error.code==='EEXIST' ? new Error('idempotency conflict') : error; } finally { await unlink(temporary).catch((error)=>{if(error.code!=='ENOENT')throw error;}); }
};

export async function stageLocalRelease({ afterArtifact, afterReceiptOpen, afterReleased, composition, correlationId, edition, editionStateRoot, finalization, outputRoot, release }) {
  if (!editionPattern.test(edition) || !isBerlinRelease(edition, release) || !/^[a-z0-9-]{6,80}$/.test(correlationId) || !finalization) throw new Error('release identity invalid');
  const approvedDigest=sha(composition.bytes); if (!digestPattern.test(composition.digest) || composition.digest!==approvedDigest) throw new Error('composition digest mismatch');
  const finalizationKeys=['version','id','kind','edition','release','owner','correlation_id','causal_parent','artifact_digest','receipt_ref','status'];
  if(!finalization||Object.keys(finalization).sort().join()!==[...finalizationKeys].sort().join()||finalization.version!=='v1'||!isSafeReceiptRef(finalization.receipt_ref))throw new Error('finalization receipt shape invalid');
  const stateRoot=resolve(editionStateRoot),receiptsRoot=resolve(stateRoot,'receipts'),component=finalization.receipt_ref.slice('state/edition/receipts/'.length);
  if(component!==basename(component))throw new Error('finalization receipt path invalid');
  const [stateStat,receiptsStat]=await Promise.all([lstat(stateRoot),lstat(receiptsRoot)]).catch((error)=>{throw new Error(`finalization receipt root unavailable: ${error.code}`);});
  if(!stateStat.isDirectory()||stateStat.isSymbolicLink()||!receiptsStat.isDirectory()||receiptsStat.isSymbolicLink())throw new Error('finalization receipt roots must be real directories');
  const [realState,realReceipts]=await Promise.all([realpath(stateRoot),realpath(receiptsRoot)]);if(realState!==stateRoot||realReceipts!==receiptsRoot||dirname(realReceipts)!==realState)throw new Error('finalization receipt roots must be canonical and directly contained');
  const receiptFile=join(receiptsRoot,component);let handle;try{handle=await open(receiptFile,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){throw new Error(`finalization receipt unavailable: ${error.code}`);}let bytes;try{const stat=await handle.stat();if(!stat.isFile()||stat.size>65536)throw new Error('finalization receipt must be a bounded regular file');await afterReceiptOpen?.();bytes=await handle.readFile();}finally{await handle.close();}if(bytes.length>65536)throw new Error('finalization receipt oversized');let durable;try{durable=JSON.parse(bytes);}catch{throw new Error('finalization receipt malformed');}
  if(!durable||Object.keys(durable).sort().join()!==[...finalizationKeys].sort().join()||durable.version!=='v1')throw new Error('finalization receipt shape invalid');
  if(finalizationKeys.some((key)=>durable[key]!==finalization[key]))throw new Error('caller finalization assertion does not match durable receipt');
  const authority={id:durable.id,kind:durable.kind,parent:durable.causal_parent,edition:durable.edition,release:durable.release,correlation:durable.correlation_id,digest:durable.artifact_digest,ref:durable.receipt_ref,owner:durable.owner,status:durable.status};
  validateLifecycleGraph([], { mode: 'authority', externalFinalization: authority });
  if (authority.edition!==edition||authority.release!==release||authority.correlation!==correlationId||authority.digest!==composition.digest) throw new Error('finalization identity or digest mismatch');
  const key=`${edition}-${approvedDigest.slice(7)}`; const artifact=join(outputRoot,`${key}.json`); const artifactBytes=`${JSON.stringify({version:'v1',edition,composition_digest:approvedDigest,content:composition.bytes})}\n`; await convergeFile(artifact,artifactBytes);
  await afterArtifact?.(); const artifactDigest=sha(artifactBytes); const receiptIdentity=`${edition}-${approvedDigest.slice(7,23)}`; const releasedId=`released-${receiptIdentity}`; const released={version:'v1',id:releasedId,kind:'released',edition,release,owner:'pressman',correlation_id:correlationId,causal_parent:finalization.id,artifact_digest:artifactDigest,receipt_ref:`state/edition/receipts/${key}.released.json`,status:'released'};
  const staged={...released,id:`staged-${receiptIdentity}`,kind:'staged',causal_parent:releasedId,receipt_ref:`state/edition/receipts/${key}.staged.json`,status:'staged'};
  await convergeFile(join(editionStateRoot,'receipts',`${key}.released.json`),`${JSON.stringify(released)}\n`); await afterReleased?.(); await convergeFile(join(editionStateRoot,'receipts',`${key}.staged.json`),`${JSON.stringify(staged)}\n`);
  return {artifact,artifactDigest,released,staged};
}

const checkpointReceipt=(kind,id,parent,digest,{correlationId,edition,release})=>({version:'v1',id,kind,edition,release,owner:'brass',correlation_id:correlationId,causal_parent:parent,artifact_digest:digest,receipt_ref:`state/edition/receipts/${id}.json`,status:kind==='readiness'?'ready':'finalized'});
const checkpointRecord=(sequence,state,item)=>({source:'state/edition',sequence,state,id:item.id,causal_parent:item.causal_parent,edition:item.edition,release:item.release,correlation_id:item.correlation_id,artifact_digest:item.artifact_digest,receipt_ref:item.receipt_ref});
const checkpointNode=(item,sequence)=>({id:item.id,kind:item.kind,parent:item.causal_parent,edition:item.edition,release:item.release,correlation:item.correlation_id,digest:item.artifact_digest,ref:item.receipt_ref,owner:item.owner,status:item.status,sequence});
export async function checkpointLocalEdition({artifacts,assignments,correlationId,edition,editionStateRoot,evidenceDigest,outputRoot,phase,release}){
  const identity={correlationId,edition,release};const receipts=join(editionStateRoot,'receipts'),records=join(editionStateRoot,'records'),compositionFile=join(editionStateRoot,'composition.json');await mkdir(receipts,{recursive:true});await mkdir(records,{recursive:true});
  if(phase==='drafting'){const ready=checkpointReceipt('readiness',`ready-${edition.replaceAll('-','')}`,null,evidenceDigest,identity);await convergeFile(join(receipts,basename(ready.receipt_ref)),`${JSON.stringify(ready)}\n`);await convergeFile(join(records,'001-drafting.json'),`${JSON.stringify(checkpointRecord(1,'drafting',ready))}\n`);return{phase,readiness:ready};}
  const ready=JSON.parse(await readFile(join(receipts,`ready-${edition.replaceAll('-','')}.json`),'utf8'));
  if(phase==='finalization'){const composition=assembleEdition(assignments,artifacts);const finalization=checkpointReceipt('finalization',`final-${edition.replaceAll('-','')}`,ready.id,composition.digest,identity);await convergeFile(compositionFile,`${JSON.stringify(composition)}\n`);await convergeFile(join(receipts,basename(finalization.receipt_ref)),`${JSON.stringify(finalization)}\n`);await convergeFile(join(records,'002-finalized.json'),`${JSON.stringify(checkpointRecord(2,'finalized',finalization))}\n`);return{phase,finalization};}
  if(phase!=='release')throw new Error('newsroom checkpoint phase invalid');const composition=JSON.parse(await readFile(compositionFile,'utf8')),finalization=JSON.parse(await readFile(join(receipts,`final-${edition.replaceAll('-','')}.json`),'utf8'));const staged=await stageLocalRelease({composition,correlationId,edition,editionStateRoot,finalization,outputRoot,release});validateLifecycleGraph([checkpointNode(ready,1),checkpointNode(finalization,2),checkpointNode(staged.released,3),checkpointNode(staged.staged,4)]);for(const [sequence,item]of[[3,staged.released],[4,staged.staged]])await convergeFile(join(records,`00${sequence}-${item.kind}.json`),`${JSON.stringify(checkpointRecord(sequence,item.kind,item))}\n`);const durable=[];for(const file of (await readdir(records)).filter(file=>file.endsWith('.json')).sort())durable.push(JSON.parse(await readFile(join(records,file),'utf8')));if(reconcileEdition(durable)!=='staged')throw new Error('newsroom checkpoint reconciliation failed');return{phase,released:staged.released,staged:staged.staged};
}

export function reconcileEdition(records) {
  if(!Array.isArray(records))throw new Error('durable edition records must be an array');if(records.length===0)return'empty';const keys=['source','sequence','state','id','causal_parent','edition','release','correlation_id','artifact_digest','receipt_ref'];
  const nodes=records.map((record)=>{if(!record||Object.keys(record).sort().join()!==[...keys].sort().join()||record.source!=='state/edition')throw new Error('durable edition record shape invalid');return{id:record.id,kind:record.state==='drafting'?'readiness':record.state==='finalized'?'finalization':record.state,parent:record.causal_parent,edition:record.edition,release:record.release,correlation:record.correlation_id,digest:record.artifact_digest,ref:record.receipt_ref,owner:['released','staged'].includes(record.state)?'pressman':'brass',status:record.state==='drafting'?'ready':record.state==='finalized'?'finalized':record.state==='blocker'?'blocked':record.state,sequence:record.sequence};});
  validateLifecycleGraph(nodes);return records.at(-1).state;
}
