import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildPrivateArchive, buildTar, gitModeMap, normalizeMode, privateArchivePlan, privateRoot } from './private-archive.mjs';

const repo=path.resolve(import.meta.dirname,'../..');
const required=['agentic-org/scripts/production-newsroom.mjs','agentic-org/scripts/production-newsroom-mcp.mjs'];
// newsroom-runtime-bundle.json describes the archives it is generated from,
// including this one's own sha256 -- it can never accurately describe its
// own digest if it is packed inside the archive it is describing (each
// rebuild would shift the digest by one generation, even from an untouched
// clean checkout). It is a build-time/repo-level manifest only: no agent
// reads it from the mounted workspace, so it is excluded here the same way
// Spawnfile and the other non-payload paths are.
const tracked=execFileSync('git',['ls-files','-z'],{cwd:repo}).toString().split('\0').filter(Boolean).filter(name=>!name.startsWith('clankandslop-private/')&&!name.startsWith('website/node_modules/')&&!name.startsWith('website/public/og/')&&!name.endsWith('/Spawnfile')&&name!=='agentic-org/Spawnfile'&&name!=='agentic-org/newsroom-runtime-bundle.json').filter(name=>!lstatSync(path.join(repo,name)).isSymbolicLink());
const sourceEntries=new Set([...tracked,...required]),dependencyEntries=new Set(),assetEntries=new Set();

// Tar header modes come from git's recorded mode, never a live filesystem
// stat (which varies with local umask and checkout tooling); see
// private-archive.mjs, which owns that normalization and the ustar writer
// so this build and repin-private-source.mjs cannot drift apart.
const repoModes=gitModeMap(repo,['ls-files','--stage','-z']);

const privateRepoPath=path.join(repo,privateRoot.slice(0,-1));
const privateCommit=JSON.parse(readFileSync(path.join(repo,'agentic-org/policies/private-source.json'),'utf8')).commit;
const privateModes=privateArchivePlan(privateRepoPath,privateCommit).modes;

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

const build=(entries,output)=>buildTar(entries,output,{resolveFile:(name)=>path.join(repo,name),modeFor});
const groups=new Map();for(const name of dependencyEntries){const parts=name.split('/'),key=parts[2].startsWith('@')?`${parts[2]}/${parts[3]}`:parts[2];if(!groups.has(key))groups.set(key,[]);groups.get(key).push(name);}const shards=[new Set(),new Set()];let sizes=[0,0];for(const key of [...groups.keys()].sort()){const names=groups.get(key),size=names.reduce((sum,name)=>sum+lstatSync(path.join(repo,name)).size,0),index=sizes[0]<=sizes[1]?0:1;for(const name of names)shards[index].add(name);sizes[index]+=size;}
const assetShards=[new Set(),new Set()];let assetSizes=[0,0];for(const name of [...assetEntries].sort()){const index=assetSizes[0]<=assetSizes[1]?0:1;assetShards[index].add(name);assetSizes[index]+=lstatSync(path.join(repo,name)).size;}
const privateArchive=buildPrivateArchive({privateRepoPath,commit:privateCommit,output:path.join(repo,'agentic-org/newsroom-private.tar'),modeFor});
const source=build(sourceEntries,path.join(repo,'agentic-org/newsroom-runtime.tar')),dependencyA=build(shards[0],path.join(repo,'agentic-org/newsroom-dependencies-a.tar')),dependencyB=build(shards[1],path.join(repo,'agentic-org/newsroom-dependencies-b.tar')),assetA=build(assetShards[0],path.join(repo,'agentic-org/newsroom-assets-a.tar')),assetB=build(assetShards[1],path.join(repo,'agentic-org/newsroom-assets-b.tar'));
const value={version:'clank.newsroom-runtime-bundle.v2',source:{archive:'newsroom-runtime.tar',sha256:source.digest,file_count:source.count,content_bytes:source.total},dependencies:[{archive:'newsroom-dependencies-a.tar',sha256:dependencyA.digest,mount:'deps-a',file_count:dependencyA.count,content_bytes:dependencyA.total},{archive:'newsroom-dependencies-b.tar',sha256:dependencyB.digest,mount:'deps-b',file_count:dependencyB.count,content_bytes:dependencyB.total}],assets:[{archive:'newsroom-assets-a.tar',sha256:assetA.digest,mount:'assets-a',file_count:assetA.count,content_bytes:assetA.total},{archive:'newsroom-assets-b.tar',sha256:assetB.digest,mount:'assets-b',file_count:assetB.count,content_bytes:assetB.total}],private:{archive:'newsroom-private.tar',sha256:privateArchive.digest,mount:'repos/newsroom-private',file_count:privateArchive.count,content_bytes:privateArchive.total,commit:privateCommit},lockfile:'website/package-lock.json',entrypoint:'agentic-org/scripts/production-newsroom-mcp.mjs'};
writeFileSync(path.join(repo,'agentic-org/newsroom-runtime-bundle.json'),`${JSON.stringify(value,null,2)}\n`);console.log(`${source.digest}\n${privateArchive.digest}\n${dependencyA.digest}\n${dependencyB.digest}\n${assetA.digest}\n${assetB.digest}`);
