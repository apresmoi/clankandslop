import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const request=(child,value)=>new Promise((resolve,reject)=>{let bytes='';const onData=chunk=>{bytes+=chunk;const end=bytes.indexOf('\n');if(end>=0){child.stdout.off('data',onData);resolve(JSON.parse(bytes.slice(0,end)));}};child.stdout.on('data',onData);child.once('error',reject);child.stdin.write(`${JSON.stringify(value)}\n`);});
test('newsroom MCP exposes only the checkpoint tool and rejects unknown tools',async()=>{const child=spawn(process.execPath,['newsroom-mcp.mjs'],{cwd:import.meta.dirname,stdio:['pipe','pipe','pipe']});try{const initialized=await request(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{}});assert.equal(initialized.result.serverInfo.name,'clank-newsroom');const listed=await request(child,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}});assert.deepEqual(listed.result.tools.map(tool=>tool.name),['checkpoint']);const rejected=await request(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'other',arguments:{}}});assert.match(rejected.error.message,/unknown/);}finally{child.kill();}});
