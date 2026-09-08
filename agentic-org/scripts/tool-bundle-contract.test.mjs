import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtimeToolFindings } from './tool-bundle-contract.mjs';
import { parseManifest } from './check-instruction-budget.mjs';

const declaration=role=>parseManifest(readFileSync(new URL(`../agents/${role}/Spawnfile`,import.meta.url),'utf8'));
test('every actual declaration carries its private tool bundle and live admission',()=>{
  for (const role of ['klaxon','cogsworth','sprockett','foreman','graves','tinkerton','vesta','brass','spike','ledger','caslon','pressman']) assert.deepEqual(runtimeToolFindings(role,declaration(role)),[],role);
});

test('missing runtime adapters, wrong roles, unpinned bundles and missing art tools fail',()=>{
  for (const mutate of [
    x=>x.workspace.resources=x.workspace.resources.filter(item=>item.id!=='newsroom-tools'),
    x=>x.workspace.resources.find(item=>item.id==='newsroom-tools').sha256=`sha256:${'0'.repeat(64)}`,
    x=>delete x.environment.mcp_servers.find(item=>item.name==='newsroom').env.CLANK_NEWSROOM_STATE_ADAPTER,
    x=>x.environment.mcp_servers.find(item=>item.name==='art').env.CLANK_NEWSROOM_AGENT='pressman',
    x=>x.environment.mcp_servers.find(item=>item.name==='art').tools.pop(),
    x=>x.environment.mcp_servers.find(item=>item.name==='art').env.CLANK_STATE_OFFLINE_FIXTURE='1',
    x=>x.environment.mcp_servers.push({name:'unexpected',tools:['execute']}),
    x=>x.environment.mcp_servers.find(item=>item.name==='newsroom').args=['/wrong/server.mjs'],
    x=>x.environment.mcp_servers.find(item=>item.name==='newsroom').tools.push('stage_release'),
  ]) {
    const source=declaration('caslon');mutate(source);assert.ok(runtimeToolFindings('caslon',source).length);
  }
});
