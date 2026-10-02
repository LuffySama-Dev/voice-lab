import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OpenRouterProviders,openrouterReadiness} from '../src/openrouter.js';
import {configuration} from '../src/providers.js';
const history=[{role:'user',content:'Synthetic question.'}];
const frame=(content:string,finish_reason:string|null=null)=>({choices:[{index:0,delta:{content},finish_reason}]});
const stream=(events:unknown[])=>new Response(events.map(e=>': heartbeat\r\ndata: '+(typeof e==='string'?e:JSON.stringify(e))+'\r\n\r\n').join(''));
const provider=(request:typeof fetch,key='synthetic-router')=>new OpenRouterProviders(configuration({}),'/unused','en-US',key,true,request);
async function collect(p:OpenRouterProviders,signal=new AbortController().signal){let text='';for await(const part of p.generate(history,signal))text+=part;return text;}
test('OpenRouter readiness is opt-in and never exposes key data',()=>{assert.equal(openrouterReadiness({OPENROUTER_API_KEY:'synthetic-secret'}).available,false);assert.equal(openrouterReadiness({OPENROUTER_ENABLED:'1'}).available,false);const ready=openrouterReadiness({OPENROUTER_ENABLED:'1',OPENROUTER_API_KEY:'synthetic-secret'});assert.equal(ready.available,true);assert.ok(!JSON.stringify(ready).includes('synthetic-secret'));});
test('OpenRouter streams canonical cues once with pinned model/provider, context and no tools',async()=>{
  let body:Record<string,unknown>={},auth='';const p=provider(async(url,options)=>{assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');body=JSON.parse(String(options?.body));auth=(options?.headers as Record<string,string>).Authorization;return stream([frame('[[voice:warmly]]Hello '),frame('there.','stop'),{choices:[{index:0,delta:{content:''},finish_reason:'stop'}],usage:{completion_tokens:8}},'[DONE]']);});
  assert.equal(await collect(p),'[[voice:warmly]]Hello there.');assert.equal(auth,'Bearer synthetic-router');assert.equal(body.model,'google/gemini-3.5-flash-lite');assert.equal(body.max_tokens,512);assert.deepEqual(body.reasoning,{effort:'low',exclude:true});assert.deepEqual(body.provider,{only:['google-ai-studio'],order:['google-ai-studio'],ignore:['google-ai-studio/flex','google-ai-studio/priority'],allow_fallbacks:false,require_parameters:true});assert.deepEqual(body.tools,[]);assert.deepEqual(body.plugins,[]);assert.equal(body.tool_choice,'none');assert.deepEqual((body.messages as unknown[]).slice(1),history);p.close();
});
test('HTTP and midstream errors are sanitized, including secret-looking provider error text',async()=>{
  for(const response of [new Response('synthetic-secret',{status:401}),new Response('credits',{status:402}),stream([{error:{message:'synthetic-secret'}}]),stream([frame('partial','length'),'[DONE]']),stream([frame('text','stop')]),stream(['[DONE]'])]){const p=provider(async()=>response);await assert.rejects(collect(p),e=>e instanceof Error&&!e.message.includes('synthetic-secret'));p.close();}
});
test('fragmented UTF-8, comments, and usage-only frames do not duplicate content',async()=>{
  const data=new TextEncoder().encode('data: '+JSON.stringify(frame('café','stop'))+'\n\ndata: {"choices":[],"usage":{}}\n\ndata: [DONE]\n\n');const p=provider(async()=>new Response(new ReadableStream({start(c){for(const byte of data)c.enqueue(Uint8Array.of(byte));c.close();}})));assert.equal(await collect(p),'café');p.close();
});
test('cancel midstream aborts request and closes body without emitting queued late content',async()=>{
  let sink:ReadableStreamDefaultController<Uint8Array>,requestSignal:AbortSignal|undefined,cancelled=0;const p=provider(async(_url,options)=>{requestSignal=options?.signal as AbortSignal;return new Response(new ReadableStream({start(c){sink=c;},cancel(){cancelled++;}}));});const control=new AbortController(),iterator=p.generate(history,control.signal);const first=iterator.next();await new Promise(r=>setImmediate(r));sink!.enqueue(new TextEncoder().encode('data: '+JSON.stringify(frame('First'))+'\n\n'));assert.equal((await first).value,'First');const next=iterator.next();control.abort();await assert.rejects(next);assert.equal(requestSignal?.aborted,true);assert.equal(cancelled,1);p.close();
});
test('missing key, aborted signal, oversized history and closed session never fetch',async()=>{
  let calls=0;const request:typeof fetch=async()=>{calls++;throw Error();};await assert.rejects(collect(provider(request,'')));const control=new AbortController();control.abort();await assert.rejects(collect(provider(request),control.signal));const p=provider(request);await assert.rejects(async()=>{for await(const text of p.generate([{role:'user',content:'x'.repeat(4001)}],new AbortController().signal))assert.fail(text);});p.close();await assert.rejects(collect(p));assert.equal(calls,0);
});
test('session turn cap survives failed attempts and does not silently use Codex fallback',async()=>{let calls=0;const p=provider(async()=>{calls++;return new Response('',{status:429});});for(let i=0;i<7;i++)await assert.rejects(collect(p));assert.equal(calls,6);p.close();});
test('tool events, oversized deltas and malformed frames fail closed',async()=>{
  for(const response of [stream([{choices:[{index:0,delta:{tool_calls:[{}]}}]}]),stream([frame('x'.repeat(12001),'stop'),'[DONE]']),new Response('data: invalid\n\n'),new Response('data: '+ 'x'.repeat(1000001))]){const p=provider(async()=>response);await assert.rejects(collect(p));p.close();}
});
