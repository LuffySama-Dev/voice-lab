import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexReplyClient,codexReadiness,type RpcTransport} from '../src/codex.js';
class Rpc implements RpcTransport {
  calls:{method:string;params:Record<string,unknown>}[]=[];
  listener:((m:string,p:Record<string,unknown>)=>void)|undefined;
  closed=false;inherited=false;count=0;
  async request(method:string,params:Record<string,unknown>){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'synthetic-thread'},instructionSources:this.inherited?['synthetic-inherited-instructions']:[]};if(method==='turn/start')return {turn:{id:'turn-'+(++this.count)}};return {};}
  onNotification(listener:(m:string,p:Record<string,unknown>)=>void){this.listener=listener;return()=>{this.listener=undefined;};}
  close(){this.closed=true;}
  send(method:string,params:Record<string,unknown>){this.listener?.(method,{threadId:'synthetic-thread',turnId:'turn-'+this.count,...params});}
}
const prompt=[{role:'user',content:'A synthetic conversational question.'}];
async function settle(){await delay(0);}
test('Codex readiness requires explicit local opt-in',()=>{assert.equal(codexReadiness(false).available,false);assert.equal(codexReadiness(true).available,true);assert.match(codexReadiness(true).reason,/not proven isolation/);});
test('Codex protocol streams reply, carries ephemeral context, and pins Astra high Fast',async()=>{
  const rpc=new Rpc(),client=new CodexReplyClient(rpc,'/synthetic-empty-workspace');
  for(let i=0;i<2;i++){
    const parts:string[]=[];const done=(async()=>{for await(const text of client.generate(prompt,new AbortController().signal))parts.push(text);})();await settle();
    rpc.send('item/agentMessage/delta',{delta:'Hello '});rpc.send('item/agentMessage/delta',{delta:'there.'});rpc.send('turn/completed',{turn:{id:'turn-'+rpc.count,status:'completed'}});await done;assert.equal(parts.join(''),'Hello there.');
  }
  assert.equal(rpc.calls.filter(c=>c.method==='thread/start').length,1);
  const start=rpc.calls[0].params;assert.equal(start.ephemeral,true);assert.equal(start.model,'gpt-6-astra');assert.equal(start.serviceTier,'priority');assert.deepEqual(start.environments,[]);
  const turns=rpc.calls.filter(c=>c.method==='turn/start');assert.ok(turns.every(c=>c.params.effort==='high'));assert.ok(turns.every(c=>c.params.serviceTier==='priority'));client.close();
});
test('Codex abort interrupts, closes transport and discards late output',async()=>{
  const rpc=new Rpc(),client=new CodexReplyClient(rpc,'/synthetic-empty-workspace'),control=new AbortController();let text='';
  const done=(async()=>{for await(const delta of client.generate(prompt,control.signal))text+=delta;})();const rejected=assert.rejects(done);await settle();control.abort();rpc.send('item/agentMessage/delta',{delta:'must not appear'});await rejected;assert.equal(text,'');assert.ok(rpc.closed);assert.ok(rpc.calls.some(c=>c.method==='turn/interrupt'));
});
test('Codex tool events and oversized output fail closed',async()=>{
  for(const scenario of ['tool','oversize']){
    const rpc=new Rpc();rpc.inherited=scenario==='instructions';const client=new CodexReplyClient(rpc,'/synthetic-empty-workspace');
    const done=(async()=>{for await(const delta of client.generate(prompt,new AbortController().signal))assert.equal(delta,'never');})();const rejected=assert.rejects(done);await settle();
    if(scenario==='tool')rpc.send('item/started',{item:{type:'commandExecution'}});
    if(scenario==='oversize')rpc.send('item/agentMessage/delta',{delta:'x'.repeat(12001)});
    await rejected;assert.ok(rpc.closed);if(scenario==='instructions')assert.equal(rpc.calls.some(c=>c.method==='turn/start'),false);
  }
});
test('Codex rejects oversized input before requesting a thread or turn',async()=>{const rpc=new Rpc(),client=new CodexReplyClient(rpc,'/synthetic-empty-workspace');await assert.rejects(async()=>{for await(const delta of client.generate([{role:'user',content:'x'.repeat(4001)}],new AbortController().signal))assert.equal(delta,'never');});assert.equal(rpc.calls.length,0);});

test('Codex cancellation while turn setup is pending cannot hang',async()=>{
  const rpc=new Rpc();const original=rpc.request.bind(rpc);rpc.request=async(method,params)=>method==='turn/start'?new Promise(()=>{}):original(method,params);
  const client=new CodexReplyClient(rpc,'/synthetic-empty-workspace'),control=new AbortController();const done=(async()=>{for await(const delta of client.generate(prompt,control.signal))assert.equal(delta,'never');})();const rejected=assert.rejects(done);await settle();control.abort();await rejected;assert.ok(rpc.closed);
});
test('Codex early notifications are buffered until the turn ID is known',async()=>{
  const rpc=new Rpc();const original=rpc.request.bind(rpc);rpc.request=async(method,params)=>{const result=await original(method,params);if(method==='turn/start'){rpc.send('item/agentMessage/delta',{delta:'Fast synthetic reply'});rpc.send('turn/completed',{turn:{id:'turn-'+rpc.count,status:'completed'}});}return result;};
  const client=new CodexReplyClient(rpc,'/synthetic-empty-workspace');let text='';for await(const delta of client.generate(prompt,new AbortController().signal))text+=delta;assert.equal(text,'Fast synthetic reply');client.close();
});


test('Codex transport loss without a thread ID ends the response promptly',async()=>{
  const rpc=new Rpc(),client=new CodexReplyClient(rpc,'/synthetic-empty-workspace');const done=(async()=>{for await(const delta of client.generate(prompt,new AbortController().signal))assert.equal(delta,'never');})();const rejected=assert.rejects(done);await settle();rpc.listener?.('error',{});await rejected;assert.ok(rpc.closed);
});

test('Codex thread receives exact structured disabled MCP names, without requiring optional instruction metadata',async()=>{
  const rpc=new Rpc();const original=rpc.request.bind(rpc);rpc.request=async(method,params)=>method==='thread/start'?{thread:{id:'synthetic-thread'}}:original(method,params);
  let start:Record<string,unknown>|undefined;const wrapped=rpc.request.bind(rpc);rpc.request=async(method,params)=>{if(method==='thread/start')start=params;return wrapped(method,params);};
  const client=new CodexReplyClient(rpc,'/synthetic-empty-workspace',{'synthetic.plugin.server':{enabled:false}});
  const done=(async()=>{for await(const delta of client.generate(prompt,new AbortController().signal))assert.equal(delta,'ok');})();await settle();rpc.send('item/agentMessage/delta',{delta:'ok'});rpc.send('turn/completed',{turn:{id:'turn-1',status:'completed'}});await done;
  assert.deepEqual((start?.config as Record<string,unknown>).mcp_servers,{'synthetic.plugin.server':{enabled:false}});client.close();
});

test('Codex completion snapshots never repeat or revise already streamed speech text',async()=>{
  const rpc=new Rpc(),client=new CodexReplyClient(rpc,'/synthetic-empty-workspace');let text='';
  const done=(async()=>{for await(const delta of client.generate(prompt,new AbortController().signal))text+=delta;})();await settle();
  rpc.send('item/agentMessage/delta',{delta:'Committed clause. '});rpc.send('item/completed',{item:{type:'agentMessage',text:'Committed clause. Revised full snapshot.'}});rpc.send('item/agentMessage/delta',{delta:'Final clause.'});rpc.send('turn/completed',{turn:{id:'turn-1',status:'completed'}});await done;
  assert.equal(text,'Committed clause. Final clause.');client.close();
});
