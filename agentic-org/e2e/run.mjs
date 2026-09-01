import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceManifest } from './provenance.mjs';

const orgRoot=path.resolve(import.meta.dirname,'..');
const ecosystem=path.resolve(orgRoot,'..','..');
const spawnfileRoot=path.join(ecosystem,'noopolis-org','spawnfile');
const daimonRoot=path.join(ecosystem,'noopolis-org','daimon');
const moltnetRoot=path.join(ecosystem,'noopolis-org','moltnet');
const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const run=(file,args,options={})=>execFileSync(file,args,{stdio:'inherit',...options});
const output=(file,args,options={})=>execFileSync(file,args,{encoding:'utf8',...options}).trim();
const registryName=`clank-e2e-registry-${randomUUID().slice(0,8)}`;
let imageTag,registryStarted=false,root;

try{
  root=await mkdtemp(path.join(os.homedir(),'.clank-e2e-'));
  const imageRoot=path.join(root,'test-image'),releaseRoot=path.join(root,'moltnet-release');
  await mkdir(path.join(imageRoot,'daimon-test-runtime'),{recursive:true});
  await mkdir(path.join(imageRoot,'daimon-node-modules'),{recursive:true});
  await mkdir(releaseRoot,{recursive:true});

  const components={org:await sourceManifest(path.resolve(orgRoot,'..')),spawnfile:await sourceManifest(spawnfileRoot),daimon:await sourceManifest(daimonRoot),moltnet:await sourceManifest(moltnetRoot)};

  run('npm',['run','build'],{cwd:spawnfileRoot});
  run('npm',['run','build'],{cwd:daimonRoot});
  run('npm',['run','build:test-runtime'],{cwd:daimonRoot});
  await cp(path.join(daimonRoot,'dist-test-runtime'),path.join(imageRoot,'daimon-test-runtime'),{recursive:true});
  await cp(path.join(daimonRoot,'node_modules'),path.join(imageRoot,'daimon-node-modules'),{recursive:true});
  await cp(path.join(import.meta.dirname,'Dockerfile.test-runtime'),path.join(imageRoot,'Dockerfile'));
  const sourceDigest=components.daimon.digest;
  const manifestDigest=sha(await readFile(path.join(daimonRoot,'dist','runtime','contract-manifest.json')));

  const registryInspect=JSON.parse(output('docker',['image','inspect','registry:2']));
  const registryImage=registryInspect[0]?.RepoDigests?.find(value=>value.startsWith('registry@sha256:'));
  assert.ok(registryImage,'a preflighted local registry:2 digest is required');
  run('docker',['run','-d','--rm','--name',registryName,'-p','127.0.0.1::5000',registryImage]);
  registryStarted=true;
  const registryAuthority=output('docker',['port',registryName,'5000/tcp']);
  assert.match(registryAuthority,/^127\.0\.0\.1:[1-9]\d{0,4}$/);
  imageTag=`${registryAuthority}/noopolis/spawnfile-runtime-daimon:e2e-${randomUUID().slice(0,8)}`;
  run('docker',['buildx','build','--platform','linux/amd64','--push','-t',imageTag,
    '--build-arg',`DAIMON_SOURCE_SHA256=${sourceDigest}`,'--build-arg',`DAIMON_MANIFEST_SHA256=${manifestDigest}`,imageRoot]);
  run('docker',['pull','--platform','linux/amd64',imageTag]);
  const inspected=JSON.parse(output('docker',['image','inspect',imageTag]));
  assert.equal(inspected.length,1);assert.equal(inspected[0].Architecture,'amd64');
  assert.equal(inspected[0].Config.Labels['org.noopolis.e2e-only'],'true');
  assert.deepEqual(inspected[0].Config.Entrypoint,['/usr/local/bin/node','/opt/noopolis/daimon-test/dist/runtime/testRuntimeSubprocess.js']);
  const imageReference=inspected[0].RepoDigests.find(value=>value.startsWith(`${registryAuthority}/`));
  assert.ok(imageReference);const imageManifestDigest=imageReference.slice(imageReference.indexOf('@')+1);
  const capability={version:'spawnfile.daimon-test-runtime-capability-receipt.v1',e2e_only:true,manifest_sha256:manifestDigest,image_manifest_digest:imageManifestDigest};
  const capabilityFile=path.join(root,'test-capability.json');await writeFile(capabilityFile,`${JSON.stringify(capability)}\n`);
  const identity={version:'spawnfile.local-daimon-runtime-identity.v3',capability_receipt_sha256:sha(await readFile(capabilityFile)),development:{mode:'local-development',non_production:true,unpublished:true,unsigned:true},image_architecture:'amd64',image_config_digest:inspected[0].Id,image_manifest_digest:imageManifestDigest,image_reference:imageReference,manifest_sha256:manifestDigest,registry_authority:registryAuthority};
  const identityFile=path.join(root,'test-identity.json');await writeFile(identityFile,`${JSON.stringify(identity)}\n`);
  assert.notEqual(imageReference.split('@')[0].split('/')[0],'docker.io');

  const linuxBinary=path.join(root,'moltnet'),hostBinary=path.join(root,'moltnet-host');
  run('go',['build','-trimpath','-o',linuxBinary,'./cmd/moltnet'],{cwd:moltnetRoot,env:{...process.env,CGO_ENABLED:'0',GOOS:'linux',GOARCH:'amd64'}});
  run('go',['build','-trimpath','-o',hostBinary,'./cmd/moltnet'],{cwd:moltnetRoot});
  run('tar',['-C',root,'-czf',path.join(releaseRoot,'moltnet_linux_amd64.tar.gz'),'moltnet']);
  const archive=await readFile(path.join(releaseRoot,'moltnet_linux_amd64.tar.gz'));
  const stamp={arch:'amd64',asset:'moltnet_linux_amd64.tar.gz',capabilities:['daimon-bridge','pi-bridge'],development:{mode:'local-development',non_production:true,unsigned:true,unpublished:true},sha256:sha(archive).slice(7),source_sha256:components.moltnet.digest,stamp_version:'spawnfile.local-moltnet-release-stamp.v1'};
  await writeFile(path.join(releaseRoot,'local_moltnet_release_stamp_amd64.json'),`${JSON.stringify(stamp)}\n`);

  const stagedSpawn=path.join(root,'noopolis-org','spawnfile'),stagedOrg=path.join(root,'clankandslop','agentic-org');
  await mkdir(stagedSpawn,{recursive:true});await mkdir(path.dirname(stagedOrg),{recursive:true});
  for(const name of ['dist','node_modules','package.json','runtimes.yaml'])await cp(path.join(spawnfileRoot,name),path.join(stagedSpawn,name),{recursive:true});
  await cp(orgRoot,stagedOrg,{recursive:true});
  const compiled=path.join(root,'compiled');
  run('docker',['run','--rm','--platform','linux/amd64','-v',`${root}:/work`,'-w','/work/noopolis-org/spawnfile',
    '-e','SPAWNFILE_ALLOW_LOCAL_E2E=1','-e','SPAWNFILE_MOLTNET_TARGET_ARCH=amd64',
    '-e','SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR=/work/moltnet-release',
    '-e','SPAWNFILE_MOLTNET_CLI=/work/moltnet',
    '-e','SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY=/work/test-identity.json','node:22-bookworm-slim',
    'node','dist/cli/index.js','compile','/work/clankandslop/agentic-org','--out','/work/compiled']);
  const report=JSON.parse(await readFile(path.join(compiled,'spawnfile-report.json'),'utf8'));
  assert.deepEqual(report.container.local_daimon_runtime,{capability_receipt_sha256:identity.capability_receipt_sha256,image_reference:imageReference,registry_authority:registryAuthority});
  await cp(path.join(orgRoot,'scripts'),path.join(root,'scripts'),{recursive:true});
  const mcpOut=path.join(root,'mcp');
  run('npm',['run','compile:explicit-test-mcp','--','--declaration',path.join(import.meta.dirname,'explicit-test-mcp-declaration.json'),'--report',path.join(compiled,'spawnfile-report.json'),'--out',mcpOut],{cwd:spawnfileRoot});
  const provenanceFile=path.join(root,'provenance.json');
  await writeFile(provenanceFile,`${JSON.stringify({version:'clank.e2e-provenance.v1',compile_fingerprint:report.compile_fingerprint,components,image_manifest_digest:imageManifestDigest,moltnet_archive_sha256:sha(archive)})}\n`);
  const result=spawnSync(process.execPath,['--test',path.join(import.meta.dirname,'sensor-only.test.mjs'),path.join(import.meta.dirname,'provenance.test.mjs')],{stdio:'inherit',env:{...process.env,CLANK_E2E_COMPILED_ROOT:compiled,CLANK_E2E_DAIMON_IMAGE:imageReference,CLANK_E2E_MOLTNET_BIN:hostBinary,CLANK_E2E_MOLTNET_LINUX_BIN:linuxBinary,CLANK_E2E_PROVENANCE:provenanceFile,CLANK_E2E_ROOT:root,CLANK_E2E_MCP_CONFIG:path.join(mcpOut,'explicit-test-mcp.json'),CLANK_E2E_MCP_RECEIPT:path.join(mcpOut,'explicit-test-mcp-receipt.json')}});
  if(result.status!==0)process.exitCode=result.status??1;
}finally{
  if(registryStarted)spawnSync('docker',['rm','-f',registryName],{stdio:'ignore'});
  if(imageTag)spawnSync('docker',['image','rm','-f',imageTag],{stdio:'ignore'});
  if(root)await rm(root,{recursive:true,force:true});
  assert.notEqual(spawnSync('docker',['inspect',registryName]).status,0,'ephemeral registry was not cleaned');
}
