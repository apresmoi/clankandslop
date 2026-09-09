import { isBerlinRelease } from './release-time.mjs';

const digestPattern=/^sha256:[a-f0-9]{64}$/;
const identityPattern=/^[a-z0-9-]{6,80}$/;
const editionPattern=/^\d{4}-\d{2}-\d{2}$/;
const owner={readiness:'brass',blocker:'brass',finalization:'brass',released:'pressman',staged:'pressman'};
const status={readiness:'ready',blocker:'blocked',finalization:'finalized',released:'released',staged:'staged'};
const edge={readiness:new Set(),blocker:new Set(['readiness']),finalization:new Set(['readiness','blocker']),released:new Set(['finalization']),staged:new Set(['released'])};
const componentPattern=/^[a-z0-9._-]+$/;
export const isSafeReceiptRef=(value)=>{if(typeof value!=='string'||!value.startsWith('state/edition/receipts/'))return false;const parts=value.slice('state/edition/receipts/'.length).split('/');return parts.length>0&&parts.every((part)=>componentPattern.test(part)&&part!=='.'&&part!=='..');};
const fail=(message)=>{throw new Error(`lifecycle graph ${message}`);};

export function validateLifecycleGraph(nodes,{externalFinalization,mode='full'}={}){
  if(!Array.isArray(nodes))fail('must be an array');
  const ids=new Set(),refs=new Set();let identity;let previousSequence=0;const seen=new Map();const sequenceMode=nodes[0]?.sequence!==undefined;
  if(mode==='suffix'||mode==='authority'){if(!externalFinalization||externalFinalization.kind!=='finalization'||!identityPattern.test(externalFinalization.id)||!editionPattern.test(externalFinalization.edition)||!isBerlinRelease(externalFinalization.edition,externalFinalization.release)||!identityPattern.test(externalFinalization.correlation)||!digestPattern.test(externalFinalization.digest)||!isSafeReceiptRef(externalFinalization.ref)||externalFinalization.owner!==owner.finalization||externalFinalization.status!==status.finalization||typeof externalFinalization.parent!=='string'||!identityPattern.test(externalFinalization.parent))fail('suffix finalization parent invalid');ids.add(externalFinalization.id);refs.add(externalFinalization.ref);if(mode==='authority')return true;}
  for(const node of nodes){
    if(!node||typeof node!=='object'||!identityPattern.test(node.id)||!edge[node.kind]||!editionPattern.test(node.edition)||!isBerlinRelease(node.edition,node.release)||!identityPattern.test(node.correlation)||!digestPattern.test(node.digest)||!isSafeReceiptRef(node.ref)||node.owner!==owner[node.kind]||node.status!==status[node.kind])fail('node schema, owner, status, digest, or reference invalid');
    if(ids.has(node.id)||refs.has(node.ref))fail('IDs and receipt refs must be unique');ids.add(node.id);refs.add(node.ref);
    const current=`${node.edition}\0${node.release}\0${node.correlation}`;if(identity===undefined)identity=current;else if(identity!==current)fail('edition, release, or correlation identity drift');
    if((node.sequence!==undefined)!==sequenceMode)fail('sequence presence must be consistent');if(sequenceMode){if(!Number.isSafeInteger(node.sequence)||node.sequence<1||node.sequence!==previousSequence+1)fail('sequence must be contiguous positive integers');previousSequence=node.sequence;}
    if(node.kind==='readiness'){if(node.parent!==null)fail('readiness parent must be null');}
    else if(mode==='suffix'&&node.kind==='released'&&seen.size===0){if(externalFinalization.edition!==node.edition||externalFinalization.release!==node.release||externalFinalization.correlation!==node.correlation||node.parent!==externalFinalization.id)fail('suffix finalization parent invalid');}
    else {if(typeof node.parent!=='string')fail('non-root parent must be non-null');const parent=seen.get(node.parent);if(!parent)fail('parent must precede child');if(!edge[node.kind].has(parent.kind))fail('edge is not allowed');if(node.kind==='staged'&&node.digest!==parent.digest)fail('released and staged digests must match');}
    seen.set(node.id,node);
  }
  const count=(kind)=>nodes.filter((node)=>node.kind===kind).length;
  if(mode==='suffix'){if(nodes.length!==2||count('released')!==1||count('staged')!==1||count('readiness')+count('blocker')+count('finalization')!==0)fail('suffix must contain exactly released and staged');}
  else {for(const kind of ['readiness','finalization','released','staged'])if(count(kind)!==1)fail(`full cardinality invalid for ${kind}`);if(count('blocker')>1)fail('full blocker cardinality invalid');const blocker=nodes.find((node)=>node.kind==='blocker');const finalization=nodes.find((node)=>node.kind==='finalization');if(blocker&&finalization.parent!==blocker.id)fail('blocker must be in the lifecycle chain');}
  return true;
}
