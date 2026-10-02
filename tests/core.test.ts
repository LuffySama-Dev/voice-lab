import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {Session,Phrases,type Providers,type Emit} from '../src/core.js';
import {sse,configuration,missing} from '../src/providers.js';

test('phrases stream before completion without losing text',()=>{const p=new Phrases();assert.deepEqual(p.add('Hello there. Still'),['Hello there. ']);assert.deepEqual(p.add(' thinking'),[]);assert.deepEqual(p.add('',true),['Still thinking']);const text='long '.repeat(50);const q=new Phrases();assert.equal([...q.add(text),...q.add('',true)].join(''),text);});
test('SSE handles fragmented UTF-8 and CRLF frames',async()=>{const data=new TextEncoder().encode('data: {"type":"delta","text":"café"}\r\n\r\ndata: [DONE]\n\n');const stream=new ReadableStream<Uint8Array>({start(c){for(const byte of data)c.enqueue(Uint8Array.of(byte));c.close();}});const events=[];for await(const event of sse(stream))events.push(event);assert.deepEqual(events,[{type:'delta',text:'café'}]);});
test('config exposes missing names, never key contents',()=>{assert.deepEqual(missing(configuration({})),['OPENAI_API_KEY','ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID']);});
function mock(){let cancelled=0,aborted=false;let transcription:Emit=()=>{};const provider:Providers={recognize:async(emit)=>{transcription=emit;return{append:()=>{},commit:()=>{emit({type:'transcript.final',text:'Hello'});emit({type:'transcript.final',text:'duplicate'});},cancel:()=>cancelled++};},async *generate(_h,signal){signal.addEventListener('abort',()=>{aborted=true;});yield 'First sentence. ';await delay(50);yield 'Late sentence.';},speak:async(emit)=>({push:text=>emit({type:'audio',audio:text}),finish:async()=>{},cancel:()=>cancelled++})};return {provider,get cancelled(){return cancelled;},get aborted(){return aborted;},late:()=>transcription({type:'transcript.final',text:'late'})};}
test('cancel aborts generation and suppresses late text/audio',async()=>{const m=mock();const events:Record<string,unknown>[]=[];const session=new Session(m.provider,e=>events.push(e));const reply=session.reply('hello');await delay(5);session.cancel(true);const count=events.length;await reply;assert.equal(events.length,count);assert.ok(m.cancelled);assert.ok(m.aborted);assert.equal(session.isActive,false);});
test('repeated start/stop and stale recognition callbacks stay cancelled',async()=>{const m=mock();const events:Record<string,unknown>[]=[];const session=new Session(m.provider,e=>events.push(e));for(let i=0;i<10;i++){await session.listen();session.cancel(true);const count=events.length;m.late();assert.equal(events.length,count);}assert.equal(m.cancelled,10);});
test('commit only triggers one reply; short audio never triggers generation',async()=>{const m=mock();const events:Record<string,unknown>[]=[];const session=new Session(m.provider,e=>events.push(e));await session.listen();session.commit();assert.ok(events.some(e=>e.type==='error'));await session.listen();session.append(Buffer.alloc(6000).toString('base64'));session.commit();session.commit();await delay(80);assert.equal(events.filter(e=>e.type==='turn').length,1);session.cancel(true);});
test('cancel while recognition opens closes late handle',async()=>{let closes=0;const m=mock();m.provider.recognize=async()=>{await delay(20);return{append:()=>{},commit:()=>{},cancel:()=>closes++};};const events:Record<string,unknown>[]=[];const session=new Session(m.provider,e=>events.push(e));const pending=session.listen();session.cancel(true);await pending;assert.equal(closes,1);assert.equal(events.filter(e=>e.state==='listening').length,0);});
test('commit near listening deadline gets a separate bounded finalization window',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const m=mock();m.provider.recognize=async()=>({native:true,append:()=>{},commit:()=>{},cancel:()=>{}});
  const events:Record<string,unknown>[]=[];const session=new Session(m.provider,e=>events.push(e));await session.listen();
  t.mock.timers.tick(59_000);session.commit();t.mock.timers.tick(2_000);
  assert.equal(events.some(e=>e.type==='error'),false);
  t.mock.timers.tick(18_001);assert.ok(events.some(e=>e.type==='error'&&String(e.message).includes('finalization')));
  session.cancel(true);
});
test('local-only transcription completes without invoking generation or speech',async()=>{
  let recognitionEmit:Emit=()=>{};let cloudCalls=0,closes=0;
  const provider:Providers={recognize:async emit=>{recognitionEmit=emit;return {native:true,append:()=>{},commit:()=>recognitionEmit({type:'transcript.final',text:'Local synthetic transcript'}),cancel:()=>closes++};},async *generate(){cloudCalls++;yield 'must not run';},speak:async()=>{cloudCalls++;throw new Error('must not run');}};
  const events:Record<string,unknown>[]=[];const session=new Session(provider,e=>events.push(e),true);await session.listen();session.commit();
  assert.equal(cloudCalls,0);assert.ok(closes>0);assert.equal(events.filter(e=>e.type==='transcription.done').length,1);assert.ok(events.some(e=>e.state==='local-ready'));
  await session.reply('Attempted reply');assert.equal(cloudCalls,0);session.cancel(true);
});
test('continuous local transcription appends segments beyond old turn timeout without committing',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});let callback:Emit=()=>{};let commits=0,closes=0;
  const m=mock();m.provider.recognize=async emit=>{callback=emit;return{native:true,append:()=>{},commit:()=>commits++,cancel:()=>closes++};};
  const events:Record<string,unknown>[]=[];const session=new Session(m.provider,e=>events.push(e),true);await session.listen();callback({type:'transcript.delta',text:'First sentence. '});t.mock.timers.tick(65_000);callback({type:'transcript.delta',text:'Second sentence. '});t.mock.timers.tick(65_000);
  assert.equal(commits,0);assert.equal(closes,0);assert.equal(events.some(e=>e.type==='error'),false);assert.equal(events.filter(e=>e.type==='transcript.delta').length,2);
  session.commit();assert.equal(commits,1);session.cancel(true);assert.equal(closes,1);
});
