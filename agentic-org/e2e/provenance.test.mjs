import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertProvenance } from './provenance.mjs';

const valid=()=>({version:'clank.e2e-provenance.v1',compile_fingerprint:'sf1:123456789abc',components:{org:{digest:`sha256:${'a'.repeat(64)}`}},image_manifest_digest:`sha256:${'b'.repeat(64)}`,moltnet_archive_sha256:`sha256:${'c'.repeat(64)}`});
test('provenance mutations fail closed',()=>{assert.doesNotThrow(()=>assertProvenance(valid()));for(const mutate of [value=>{value.compile_fingerprint+='0';},value=>{value.components.org.digest=`sha256:${'0'.repeat(63)}`;},value=>{value.image_manifest_digest='latest';},value=>{value.moltnet_archive_sha256='changed';}]){const value=valid();mutate(value);assert.throws(()=>assertProvenance(value),/provenance/);}});
test('explicit-test newsroom MCP authority is limited to Brass and Pressman',async()=>{const declaration=JSON.parse(await readFile(new URL('./explicit-test-mcp-declaration.json',import.meta.url)));assert.deepEqual(declaration.servers.map(({agent_id,tools})=>({agent_id,tools})),[{agent_id:'agent:brass',tools:['checkpoint']},{agent_id:'agent:pressman',tools:['checkpoint']}]);});
