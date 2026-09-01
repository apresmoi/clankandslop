import { createInterface } from 'node:readline';
import { composeEdition, fileArticle, fileDesk, qualifySignal, recordAssignment, reviewArticle, stageRelease } from './production-newsroom.mjs';

const definitions={
  qualify_signal:{description:'Durably qualify one sensor event and return the selected desks to mention.',required:['edition','event_key','summary','selected_desks','evidence_refs'],execute:qualifySignal},
  record_assignment:{description:'Durably record the chief-approved lineup before sending natural-language assignments.',required:['edition','event_key','assignments'],execute:recordAssignment},
  file_article:{description:'File one assignment-bound complete sourced article revision.',required:['edition','event_key','assignment_event_key','article'],execute:fileArticle},
  review_article:{description:'Record Spike’s verdict for one immutable filing revision.',required:['edition','event_key','article_id','revision','verdict','notes'],execute:reviewArticle},
  file_desk:{description:'File one Ledger- or Caslon-owned desk document.',required:['edition','event_key','name','document'],execute:fileDesk},
  compose_edition:{description:'Compose the two page documents and verify the complete PASS edition tree.',required:['edition','event_key','pages'],execute:composeEdition},
  stage_release:{description:'Copy the complete edition into local staging, validate content, and build the site.',required:['edition','event_key'],execute:stageRelease}
};
const roleTools={klaxon:['qualify_signal'],brass:['record_assignment'],cogsworth:['file_article'],sprockett:['file_article'],foreman:['file_article'],graves:['file_article'],tinkerton:['file_article'],vesta:['file_article'],spike:['review_article'],ledger:['file_desk'],caslon:['file_desk','compose_edition'],pressman:['stage_release']};
const role=process.env.CLANK_NEWSROOM_AGENT,tools=roleTools[role]??[];
const schema=definition=>({type:'object',additionalProperties:true,required:definition.required,properties:Object.fromEntries(definition.required.map(name=>[name,name==='edition'||name==='event_key'?{type:'string'}:{}]))});
const reply=(id,result,error)=>process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id,...(error?{error:{code:-32000,message:error}}:{result})})}\n`);
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){let request;try{request=JSON.parse(line);if(request.method==='initialize')reply(request.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:`clank-newsroom-${role}`,version:'1.0.0'}});else if(request.method==='notifications/initialized'){}else if(request.method==='tools/list')reply(request.id,{tools:tools.map(name=>({name,description:definitions[name].description,inputSchema:schema(definitions[name])}))});else if(request.method==='tools/call'){const name=request.params?.name;if(!tools.includes(name))throw new Error('tool exceeds agent authority');const value=await definitions[name].execute(request.params.arguments);reply(request.id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});}else if(request.id!==undefined)reply(request.id,undefined,'unsupported method');}catch(error){reply(request?.id??null,undefined,error instanceof Error?error.message:'newsroom tool failed');}}
