import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);

export async function sourceManifest(root){
  const names=execFileSync('git',['-C',root,'ls-files','-co','--exclude-standard','-z']).toString().split('\0').filter(Boolean).sort();
  const files=[];
  for(const name of names){const file=path.join(root,name),entry=await lstat(file);if(entry.isSymbolicLink())files.push({path:name,kind:'symlink',mode:entry.mode&0o777,target:await readlink(file)});else if(entry.isFile())files.push({path:name,kind:'file',mode:entry.mode&0o777,sha256:sha(await readFile(file))});else throw new Error(`unsupported build input ${name}`);}
  const manifest={version:'clank.e2e-source-manifest.v1',files};
  return{...manifest,digest:sha(canonical(manifest))};
}

export function assertProvenance(value){
  if(!value||value.version!=='clank.e2e-provenance.v1'||!/^sf1:[a-f0-9]{12}$/.test(value.compile_fingerprint)||!value.components||Object.values(value.components).some(component=>!/^sha256:[a-f0-9]{64}$/.test(component.digest))||!/^sha256:[a-f0-9]{64}$/.test(value.image_manifest_digest)||!/^sha256:[a-f0-9]{64}$/.test(value.moltnet_archive_sha256))throw new Error('E2E provenance is invalid');
  return value;
}
