import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StdioRpc,connectCodex} from '../src/codex-rpc.js';
test('missing Codex binary produces a sanitized initialization error',async()=>{await assert.rejects(connectCodex('/nonexistent/must-never-run','/tmp'),/Codex initialization failed/);});
test('an already cancelled connection never launches the specified executable',async()=>{const control=new AbortController();control.abort();await assert.rejects(connectCodex('/nonexistent/must-never-run','/tmp',control.signal),/^Error: Cancelled$/);});
test('cancellation tears down a pending handshake with a synthetic local fixture',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-lab-rpc-test-'));
  const fixture=join(directory,'synthetic-codex');
  const control=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    await writeFile(fixture,'#!/usr/bin/env node\nprocess.stdin.resume();\n',{mode:0o700});
    const pending=connectCodex(fixture,directory,control.signal);
    timeout=setTimeout(()=>control.abort(),20);
    await assert.rejects(pending,/Codex initialization failed/);
  }finally{clearTimeout(timeout);control.abort();await rm(directory,{recursive:true,force:true});}
});
test('stdio parses fragmented JSON responses and rejects disallowed client operations',async()=>{
  const fixture=spawn(process.execPath,['--input-type=module','-e',String.raw`let s='';process.stdin.on('data',b=>{s+=b;const end=s.indexOf('\n');if(end<0)return;const request=JSON.parse(s.slice(0,end));process.stdout.write('{"id":');process.stdout.write(JSON.stringify(request.id)+',"result":{"synthetic":true}}\n');});`]);
  const rpc=new StdioRpc(fixture);assert.deepEqual(await rpc.request('account/read',{refreshToken:false}),{synthetic:true});await assert.rejects(rpc.request('command/exec',{command:['must-never-run']}));rpc.close();
});
test('stdio rejects malformed frames and sanitizes native errors',async()=>{
  const fixture=spawn(process.execPath,['-e',String.raw`process.stdin.once('data',()=>process.stdout.write('sensitive-malformed-frame\n'));`]);const rpc=new StdioRpc(fixture);await assert.rejects(rpc.request('account/read',{}),error=>error instanceof Error&&error.message==='Codex disconnected');rpc.close();
});


test('stdio closes on a server tool or approval request without executing it',async()=>{
  const fixture=spawn(process.execPath,['-e',String.raw`process.stdin.once('data',()=>process.stdout.write(JSON.stringify({id:99,method:'item/tool/call',params:{name:'synthetic-tool'}})+'\n'));`]);const rpc=new StdioRpc(fixture);await assert.rejects(rpc.request('account/read',{}),/disconnected/);rpc.close();
});
