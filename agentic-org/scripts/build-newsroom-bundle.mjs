import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo=path.resolve(import.meta.dirname,'../..');
const required=['agentic-org/scripts/production-newsroom.mjs','agentic-org/scripts/production-newsroom-mcp.mjs'];
const tracked=execFileSync('git',['ls-files','-z'],{cwd:repo}).toString().split('\0').filter(Boolean).filter(name=>!name.startsWith('clankandslop-private/')&&!name.startsWith('website/node_modules/')&&!name.startsWith('website/public/og/')&&!name.endsWith('/Spawnfile')&&name!=='agentic-org/Spawnfile').filter(name=>!lstatSync(path.join(repo,name)).isSymbolicLink());
const sourceEntries=new Set([...tracked,...required]),dependencyEntries=new Set(),assetEntries=new Set();

// Tar headers must not depend on the machine that built the archive. Git
// tracks exactly one bit of file mode -- executable or not (100755 vs
// 100644) -- so every mode we embed is derived from git's recorded mode
// (never from a live filesystem stat, which varies with local umask and
// checkout tooling) and collapsed to the two canonical values below.
// `git ls-files --stage`/`ls-tree` give that recorded mode per path.
const normalizeMode=(rawMode)=>(rawMode&0o111)?0o755:0o644;
const gitModeMap=(cwd,args)=>{
  const map=new Map();
  const raw=execFileSync('git',args,{cwd,maxBuffer:1024*1024*256}).toString();
  for(const entry of raw.split('\0')){
    if(!entry)continue;
    const tab=entry.indexOf('\t');
    const fields=entry.slice(0,tab).split(' ');
    map.set(entry.slice(tab+1),{mode:parseInt(fields[0],8),type:fields.length>2&&args.includes('ls-tree')?fields[1]:'blob'});
  }
  return map;
};
const repoModes=gitModeMap(repo,['ls-files','--stage','-z']);

const privateRoot='clankandslop-private/';
const privateRepoPath=path.join(repo,privateRoot.slice(0,-1));
const privatePin=JSON.parse(readFileSync(path.join(repo,'agentic-org/policies/private-source.json'),'utf8'));
const privateCommit=privatePin.commit;
try{
  execFileSync('git',['-C',privateRepoPath,'cat-file','-e',`${privateCommit}^{commit}`]);
}catch{
  throw new Error(`private newsroom archive commit ${privateCommit} not found in ${privateRepoPath}: fetch it before building (pin lives in agentic-org/policies/private-source.json)`);
}
const privateTree=gitModeMap(privateRepoPath,['ls-tree','-r','-z',privateCommit]);
const privateModes=new Map(),privateRelativeEntries=[];
for(const[relative,entry]of privateTree){
  if(entry.mode===0o120000)continue; // symlink recorded at the pinned commit: excluded, same as the main repo
  if(entry.type!=='blob')throw new Error(`unsupported private tree entry: ${entry.type} ${relative}`);
  privateModes.set(privateRoot+relative,entry.mode);
  privateRelativeEntries.push(relative);
}
if(privateRelativeEntries.length===0)throw new Error('private newsroom archive is empty: fetch clankandslop-private before building');
const privateExtractDir=mkdtempSync(path.join(tmpdir(),'clank-private-source-'));
try{
  const archiveBuffer=execFileSync('git',['-C',privateRepoPath,'archive','--format=tar',privateCommit],{maxBuffer:1024*1024*1024});
  execFileSync('tar',['-x','-C',privateExtractDir],{input:archiveBuffer,maxBuffer:1024*1024*1024});
}catch(error){
  rmSync(privateExtractDir,{recursive:true,force:true});
  throw error;
}
const privateEntries=new Set(privateRelativeEntries.map(name=>privateRoot+name));

const omit=name=>name.endsWith('.map')||(name.endsWith('.d.ts')&&!name.startsWith('website/node_modules/astro/templates/'))||name.endsWith('.md')||name.startsWith('website/node_modules/esbuild/bin/')||/(^|\/)(test|tests|docs|example|examples)(\/|$)/u.test(name);
function walk(relative){for(const name of readdirSync(path.join(repo,relative)).sort()){const child=path.posix.join(relative,name),stat=lstatSync(path.join(repo,child));if(stat.isSymbolicLink())continue;if(stat.isDirectory())walk(child);else if(stat.isFile()&&!omit(child))dependencyEntries.add(child);else if(!stat.isFile())throw new Error(`unsupported bundle input: ${child}`);}}
walk('website/node_modules');
function walkAssets(relative){for(const name of readdirSync(path.join(repo,relative)).sort()){const child=path.posix.join(relative,name),stat=lstatSync(path.join(repo,child));if(stat.isDirectory())walkAssets(child);else if(stat.isFile())assetEntries.add(child);else throw new Error(`unsupported asset input: ${child}`);}}
walkAssets('website/public/og');
for(const name of required)if(!lstatSync(path.join(repo,name)).isFile())throw new Error(`required newsroom input missing: ${name}`);

// Entries git does not track (vendored node_modules, generated og images) have
// no recorded mode to defer to; the best available machine-independent signal
// for those is still collapsed through the same two-value normalization,
// never the raw filesystem mode bits.
const modeFor=(name,file)=>{
  if(repoModes.has(name))return normalizeMode(repoModes.get(name).mode);
  if(privateModes.has(name))return normalizeMode(privateModes.get(name));
  return normalizeMode(lstatSync(file).mode);
};

const octal=(value,width)=>`${value.toString(8).padStart(width-1,'0')}\0`;
function header(name,size,mode){const bytes=Buffer.alloc(512),raw=Buffer.from(name);let prefix=Buffer.alloc(0),base=raw;if(raw.length>100){const split=name.lastIndexOf('/');prefix=Buffer.from(name.slice(0,split));base=Buffer.from(name.slice(split+1));if(base.length>100||prefix.length>155)throw new Error(`bundle path exceeds ustar bounds: ${name}`);}base.copy(bytes,0);Buffer.from(octal(mode&0o777,8)).copy(bytes,100);Buffer.from(octal(0,8)).copy(bytes,108);Buffer.from(octal(0,8)).copy(bytes,116);Buffer.from(octal(size,12)).copy(bytes,124);Buffer.from(octal(0,12)).copy(bytes,136);bytes.fill(0x20,148,156);bytes[156]=0x30;Buffer.from('ustar\0').copy(bytes,257);Buffer.from('00').copy(bytes,263);Buffer.from('root').copy(bytes,265);Buffer.from('root').copy(bytes,297);prefix.copy(bytes,345);const sum=bytes.reduce((a,b)=>a+b,0);Buffer.from(`${sum.toString(8).padStart(6,'0')}\0 `).copy(bytes,148);return bytes;}
function build(entries,output,strip='',resolveFile=(name)=>path.join(repo,name)){const fd=openSync(output,'w',0o644),buffer=Buffer.alloc(1024*1024);let total=0;try{for(const name of [...entries].sort()){if(strip&&!name.startsWith(strip))throw new Error(`bundle entry outside strip root: ${name}`);const file=resolveFile(name),stat=lstatSync(file);writeSync(fd,header(name.slice(strip.length),stat.size,modeFor(name,file)));const source=openSync(file,'r');try{for(let offset=0;offset<stat.size;){const count=readSync(source,buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!count)throw new Error(`short read: ${name}`);writeSync(fd,buffer,0,count);offset+=count;}}finally{closeSync(source);}const padding=(512-(stat.size%512))%512;if(padding)writeSync(fd,Buffer.alloc(padding));total+=stat.size;}writeSync(fd,Buffer.alloc(1024));}finally{closeSync(fd);}return{digest:`sha256:${createHash('sha256').update(readFileSync(output)).digest('hex')}`,total,count:entries.size};}
const groups=new Map();for(const name of dependencyEntries){const parts=name.split('/'),key=parts[2].startsWith('@')?`${parts[2]}/${parts[3]}`:parts[2];if(!groups.has(key))groups.set(key,[]);groups.get(key).push(name);}const shards=[new Set(),new Set()];let sizes=[0,0];for(const key of [...groups.keys()].sort()){const names=groups.get(key),size=names.reduce((sum,name)=>sum+lstatSync(path.join(repo,name)).size,0),index=sizes[0]<=sizes[1]?0:1;for(const name of names)shards[index].add(name);sizes[index]+=size;}
const assetShards=[new Set(),new Set()];let assetSizes=[0,0];for(const name of [...assetEntries].sort()){const index=assetSizes[0]<=assetSizes[1]?0:1;assetShards[index].add(name);assetSizes[index]+=lstatSync(path.join(repo,name)).size;}
const privateArchive=build(privateEntries,path.join(repo,'agentic-org/newsroom-private.tar'),privateRoot,(name)=>path.join(privateExtractDir,name.slice(privateRoot.length)));
rmSync(privateExtractDir,{recursive:true,force:true});
const source=build(sourceEntries,path.join(repo,'agentic-org/newsroom-runtime.tar')),dependencyA=build(shards[0],path.join(repo,'agentic-org/newsroom-dependencies-a.tar')),dependencyB=build(shards[1],path.join(repo,'agentic-org/newsroom-dependencies-b.tar')),assetA=build(assetShards[0],path.join(repo,'agentic-org/newsroom-assets-a.tar')),assetB=build(assetShards[1],path.join(repo,'agentic-org/newsroom-assets-b.tar'));
const value={version:'clank.newsroom-runtime-bundle.v2',source:{archive:'newsroom-runtime.tar',sha256:source.digest,file_count:source.count,content_bytes:source.total},dependencies:[{archive:'newsroom-dependencies-a.tar',sha256:dependencyA.digest,mount:'deps-a',file_count:dependencyA.count,content_bytes:dependencyA.total},{archive:'newsroom-dependencies-b.tar',sha256:dependencyB.digest,mount:'deps-b',file_count:dependencyB.count,content_bytes:dependencyB.total}],assets:[{archive:'newsroom-assets-a.tar',sha256:assetA.digest,mount:'assets-a',file_count:assetA.count,content_bytes:assetA.total},{archive:'newsroom-assets-b.tar',sha256:assetB.digest,mount:'assets-b',file_count:assetB.count,content_bytes:assetB.total}],private:{archive:'newsroom-private.tar',sha256:privateArchive.digest,mount:'repos/newsroom-private',file_count:privateArchive.count,content_bytes:privateArchive.total,commit:privateCommit},lockfile:'website/package-lock.json',entrypoint:'agentic-org/scripts/production-newsroom-mcp.mjs'};
writeFileSync(path.join(repo,'agentic-org/newsroom-runtime-bundle.json'),`${JSON.stringify(value,null,2)}\n`);console.log(`${source.digest}\n${privateArchive.digest}\n${dependencyA.digest}\n${dependencyB.digest}\n${assetA.digest}\n${assetB.digest}`);
