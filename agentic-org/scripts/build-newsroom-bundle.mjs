import { lstatSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTar, gitModeMap, normalizeMode, privateRoot } from './private-archive.mjs';
import { SOURCE_REQUIRED, buildSourceArchive, sourceArchivePlan } from './source-archive.mjs';
import { repinPublicAssetPins } from './repin-runtime-bundle-pins.mjs';

const repo=path.resolve(import.meta.dirname,'../..');
const required=SOURCE_REQUIRED;
// What belongs in the source archive, and the modes it is written with, are
// owned by source-archive.mjs -- the same module the descriptor drift check
// rebuilds from, so the pin CI enforces and the pin this writes cannot come
// from two different ideas of the tree.
const sourcePlan=sourceArchivePlan(repo);
const assetEntries=new Set();

// Tar header modes come from git's recorded mode, never a live filesystem
// stat (which varies with local umask and checkout tooling); see
// private-archive.mjs, which owns that normalization and the ustar writer
// so this build and repin-private-source.mjs cannot drift apart.
const repoModes=gitModeMap(repo,['ls-files','--stage','-z']);

// THE RESEARCH CORPUS IS NOT BUILT HERE ANY MORE.
//
// This script used to cut a sixth archive, newsroom-private.tar: the whole
// private research repo at the commit policies/private-source.json pinned,
// checksummed into the descriptor's `private` block and pinned by all twelve
// agent Spawnfiles. That made a day's research part of the image, so a new
// day's research meant a new ~5GB image -- a daily build, and a daily chance
// to lose the day to a disk floor or a health probe. agentic-org/Spawnfile now
// mounts the corpus as the team-shared `clank-newsroom-corpus` volume, which a
// host timer populates outside the agent boundary, so there is nothing about
// the corpus left for a build to pin.
//
// The private checkout is still needed here, and for an unrelated reason: it
// owns the website DEPENDENCY archive producer. Those two archives are node
// modules, not research, and they still belong to the image.
const privateRepoPath=path.join(repo,privateRoot.slice(0,-1));
const { assertWebsiteDependencies }=await import(pathToFileURL(path.join(privateRepoPath,'newsroom/build/dependencies.mjs')).href);
const { buildDependencyArchives }=await import(pathToFileURL(path.join(privateRepoPath,'newsroom/build/archive.mjs')).href);
await assertWebsiteDependencies(repo);

function walkAssets(relative){for(const name of readdirSync(path.join(repo,relative)).sort()){const child=path.posix.join(relative,name),stat=lstatSync(path.join(repo,child));if(stat.isDirectory())walkAssets(child);else if(stat.isFile())assetEntries.add(child);else throw new Error(`unsupported asset input: ${child}`);}}
walkAssets('website/public/og');

// Entries git does not track (vendored node_modules, generated og images) have
// no recorded mode to defer to; the best available machine-independent signal
// for those is still collapsed through the same two-value normalization,
// never the raw filesystem mode bits.
const modeFor=(name,file)=>{
  if(repoModes.has(name))return normalizeMode(repoModes.get(name).mode);
  return normalizeMode(lstatSync(file).mode);
};

const build=(entries,output)=>buildTar(entries,output,{resolveFile:(name)=>path.join(repo,name),modeFor});
const [dependencyA,dependencyB]=(await buildDependencyArchives(repo,path.join(repo,'agentic-org'))).map(entry=>({digest:entry.sha256,count:entry.file_count,total:entry.content_bytes}));
const assetShards=[new Set(),new Set()];let assetSizes=[0,0];for(const name of [...assetEntries].sort()){const index=assetSizes[0]<=assetSizes[1]?0:1;assetShards[index].add(name);assetSizes[index]+=lstatSync(path.join(repo,name)).size;}
const source=buildSourceArchive(repo,path.join(repo,'agentic-org/newsroom-runtime.tar'),sourcePlan),assetA=build(assetShards[0],path.join(repo,'agentic-org/newsroom-assets-a.tar')),assetB=build(assetShards[1],path.join(repo,'agentic-org/newsroom-assets-b.tar'));
const value={version:'clank.newsroom-runtime-bundle.v2',source:{archive:'newsroom-runtime.tar',sha256:source.digest,file_count:source.count,content_bytes:source.total},dependencies:[{archive:'newsroom-dependencies-a.tar',sha256:dependencyA.digest,mount:'deps-a',file_count:dependencyA.count,content_bytes:dependencyA.total},{archive:'newsroom-dependencies-b.tar',sha256:dependencyB.digest,mount:'deps-b',file_count:dependencyB.count,content_bytes:dependencyB.total}],assets:[{archive:'newsroom-assets-a.tar',sha256:assetA.digest,mount:'assets-a',file_count:assetA.count,content_bytes:assetA.total},{archive:'newsroom-assets-b.tar',sha256:assetB.digest,mount:'assets-b',file_count:assetB.count,content_bytes:assetB.total}],lockfile:'website/package-lock.json',entrypoint:'agentic-org/scripts/production-newsroom-mcp.mjs'};
writeFileSync(path.join(repo,'agentic-org/newsroom-runtime-bundle.json'),`${JSON.stringify(value,null,2)}\n`);repinPublicAssetPins(repo,value);console.log(`${source.digest}\n${dependencyA.digest}\n${dependencyB.digest}\n${assetA.digest}\n${assetB.digest}`);
