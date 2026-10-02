import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as flush} from 'node:timers/promises';
import {HandsFreeSession} from '../src/hands-free.js';
import type {Providers,Emit} from '../src/core.js';
function fixture(t:TestContext,textOnly=true){
  let callback:Emit=()=>{},now=0,time=0,opens=0,closes=0,voiceCloses=0;
  const events:Record<string,unknown>[]=[],histories:{role:string;content:string}[][]=[];
  const provider:Providers={recognize:async emit=>{opens++;callback=emit;return{native:true,append:()=>{},commit:()=>{throw Error('Capture must not finalize between turns');},cancel:()=>closes++};},async *generate(history){histories.push(structuredClone(history));yield 'A synthetic reply. ';},speak:async emit=>({push:()=>emit({type:'audio',audio:'AA==',sampleRate:24000}),finish:async()=>{},cancel:()=>voiceCloses++})};
  const session=new HandsFreeSession(provider,e=>events.push(e),{textOnly,now:()=>now});t.after(()=>session.cancel(true));
  const audio=(count:number,rms:number)=>{for(let i=0;i<count;i++){now+=100;time+=100;callback({type:'audio.activity',rms,timeMs:time,durationMs:100});}};
  const segment=(id:number,text:string,final=true,startMs=Math.max(0,time-400),endMs=time)=>callback({type:'transcript.segment',id,text,final,startMs,endMs});
  return{session,provider,events,histories,audio,segment,get opens(){return opens;},get closes(){return closes;},get voiceCloses(){return voiceCloses;},get time(){return time;},advance(ms:number){now+=ms;session.checkEndpoint();},late:()=>callback({type:'error'}),async utterance(id:number,text:string,final=true){audio(5,.06);segment(id,text,final);audio(final?12:18,0);await flush();}};
}
test('multiple automatic turns share one native capture and retain context',async t=>{
  const f=fixture(t);await f.session.listen();await f.utterance(1,'Remember the blue bicycle.');await f.utterance(2,'What color was it?');
  assert.equal(f.opens,1);assert.equal(f.closes,0);assert.equal(f.histories.length,2);assert.deepEqual(f.histories[1].map(m=>m.role),['user','assistant','user']);assert.match(f.histories[1][0].content,/blue bicycle/);assert.equal(f.events.filter(e=>e.type==='turn').length,2);
});
test('voice reply waits for matching browser playback completion before listening',async t=>{
  const f=fixture(t,false);await f.session.listen();await f.utterance(1,'Say hello.');const done=f.events.find(e=>e.type==='response.done')!;
  const count=f.events.length;f.session.playbackDone(Number(done.epoch)-1);assert.equal(f.events.length,count);f.session.playbackDone(Number(done.epoch));assert.ok(f.events.slice(count).some(e=>e.state==='listening'));assert.equal(f.closes,0);
});
test('draft fallback commits once and ignores its late revised final',async t=>{
  const f=fixture(t);await f.session.listen();await f.utterance(1,'A provisional question',false);assert.equal(f.histories.length,1);
  f.segment(1,'A provisional question.',true,0,500);f.audio(30,0);await flush();assert.equal(f.histories.length,1);
  await f.utterance(2,'A genuinely new turn.');assert.equal(f.histories.length,2);assert.equal(f.histories[1].at(-1)?.content,'A genuinely new turn.');
});
test('same provisional segment can grow across turns without repeating consumed prefix',async t=>{
  const f=fixture(t);await f.session.listen();await f.utterance(1,'First question',false);f.audio(5,.05);f.segment(1,'First question second question',false,0,f.time);f.audio(18,0);await flush();assert.equal(f.histories[1].at(-1)?.content,'second question');
});
test('old finalized text cannot close new speech; new ASR must reach the fresh activity',async t=>{
  const f=fixture(t);await f.session.listen();f.segment(1,'Stale text',true,0,200);f.audio(30,0);f.audio(5,.05);f.audio(20,0);await flush();assert.equal(f.histories.length,0);
});
test('silence, transcript-only noise, impulses, and unrecognized sustained sound do not spend turns',async t=>{
  const f=fixture(t);await f.session.listen();f.segment(1,'Hallucinated noise',true,0,100);f.audio(20,0);f.audio(1,.2);f.audio(20,0);await flush();assert.equal(f.histories.length,0);
  f.audio(10,.08);f.audio(100,0);await flush();assert.equal(f.histories.length,0);
});
test('spoken barge-in cancels thinking, preserves interrupted context, and ignores late output',async t=>{
  const f=fixture(t);let release:()=>void=()=>{};const hold=new Promise<void>(r=>release=r);let aborted=false;
  f.provider.generate=async function*(history,signal){f.histories.push(structuredClone(history));yield 'Partial generated draft. ';if(f.histories.length===1){signal.addEventListener('abort',()=>aborted=true);await hold;yield 'STALE OUTPUT';}};
  await f.session.listen();await f.utterance(1,'Initial question.');f.audio(3,.08);assert.equal(aborted,true);assert.equal(f.closes,0);
  f.audio(2,.08);f.segment(2,'Actually, change the subject.');f.audio(12,0);await flush();assert.equal(f.histories.length,2);assert.match(f.histories[1][1].content,/Interrupted response/);assert.match(f.histories[1][1].content,/unconfirmed/);
  const count=f.events.length;release();await flush();assert.equal(f.events.length,count);assert.equal(f.events.some(e=>String(e.text).includes('STALE OUTPUT')),false);
});
test('barge-in clears voice and rejects late audio, then next turn recovers',async t=>{
  const f=fixture(t,false);let stale:Emit=()=>{},release:()=>void=()=>{};const hold=new Promise<void>(r=>release=r);let calls=0;
  f.provider.speak=async emit=>{calls++;if(calls===1)stale=emit;return{push:()=>emit({type:'audio',audio:'AA=='}),finish:()=>calls===1?hold:Promise.resolve(),cancel:()=>{}};};
  await f.session.listen();await f.utterance(1,'First.');f.audio(3,.1);const count=f.events.length;stale({type:'audio',audio:'LATE'});release();await flush();assert.equal(f.events.length,count);
  f.audio(3,.05);f.segment(2,'Next turn.');f.audio(12,0);await flush();assert.equal(f.histories.length,2);assert.equal(f.closes,0);
});
test('headphone leakage matching assistant text is rejected after playback',async t=>{
  const f=fixture(t,false);await f.session.listen();await f.utterance(1,'Hello.');const done=f.events.find(e=>e.type==='response.done')!;f.session.playbackDone(Number(done.epoch));f.audio(5,.05);f.segment(2,'A synthetic reply.');f.audio(20,0);await flush();
  // Three-word matches are intentionally not filtered, to avoid swallowing short legitimate replies.
  assert.equal(f.histories.length,2);
});
test('stop/disconnect closes capture and providers and suppresses every late packet across repeated starts',async t=>{
  const f=fixture(t);for(let i=0;i<5;i++){await f.session.listen();f.session.cancel(true);const count=f.events.length;f.late();f.audio(20,.1);f.segment(1,'late');f.advance(1000);await flush();assert.equal(f.events.length,count);}assert.equal(f.opens,5);assert.equal(f.closes,5);
});
test('stop during capture startup closes the late native handle',async t=>{
  const f=fixture(t);let release:()=>void=()=>{},closed=0;const hold=new Promise<void>(r=>release=r);f.provider.recognize=async()=>{await hold;return{append:()=>{},commit:()=>{},cancel:()=>closed++};};const pending=f.session.listen();f.session.cancel(true);release();await pending;assert.equal(closed,1);assert.equal(f.events.some(e=>e.state==='listening'),false);
});
test('idle deadline stops capture without sending empty input',async t=>{const f=fixture(t);await f.session.listen();f.advance(180001);assert.equal(f.session.isActive,false);assert.equal(f.histories.length,0);assert.ok(f.events.some(e=>e.type==='error'));});
test('short recognized speech qualifies for a turn without weakening raw-noise barge-in',async t=>{
  const f=fixture(t);await f.session.listen();f.audio(2,.05);f.segment(1,'Yes',true,0,200);f.audio(12,0);await flush();assert.equal(f.histories.length,1);assert.equal(f.histories[0][0].content,'Yes');
});
test('late transcription re-arms the matching utterance after a recognition gap',async t=>{
  const f=fixture(t);await f.session.listen();f.audio(5,.05);f.audio(90,0);f.segment(1,'Delayed recognition',true,0,500);f.advance(400);await flush();assert.equal(f.histories.length,1);
});
test('revised spelling in a consumed draft preserves the newly spoken suffix',async t=>{
  const f=fixture(t);await f.session.listen();await f.utterance(1,'Send it to Jon',false);f.audio(5,.06);f.segment(1,'Send it to John and make it urgent',true,0,f.time);f.audio(12,0);await flush();assert.equal(f.histories.length,2);assert.equal(f.histories[1].at(-1)?.content,'and make it urgent');
});
test('repeating a text response remains valid input',async t=>{
  const f=fixture(t);f.provider.generate=async function*(h){f.histories.push(structuredClone(h));yield 'I can help with that today';};await f.session.listen();await f.utterance(1,'Hello.');await f.utterance(2,'I can help with that today');assert.equal(f.histories.length,2);
});
test('four-word playback leakage is rejected but a later deliberate repetition is accepted',async t=>{
  const f=fixture(t,false);f.provider.generate=async function*(h){f.histories.push(structuredClone(h));yield 'I can help with that today.';};await f.session.listen();await f.utterance(1,'Hello.');const done=f.events.find(e=>e.type==='response.done')!;
  const start=f.time;f.audio(3,.06);f.segment(2,'I can help with that today.',true,start,f.time);f.audio(20,0);await flush();assert.equal(f.histories.length,1);
  f.session.playbackDone(Number(done.epoch));await f.utterance(3,'I can help with that today.');assert.equal(f.histories.length,2);
});
test('voice handshake overlaps generation and display; interruption closes a late voice handle',async t=>{
  const f=fixture(t,false);let open:((s:{push:(text:string)=>void;finish:()=>Promise<void>;cancel:()=>void})=>void)=()=>{},closed=0;const spoken:string[]=[];
  f.provider.speak=()=>new Promise(resolve=>open=resolve);
  await f.session.listen();await f.utterance(1,'Hello.');assert.equal(f.histories.length,1);assert.ok(f.events.some(e=>e.type==='response.delta'));assert.equal(f.events.some(e=>e.type==='audio'),false);
  f.session.cancel();open({push:text=>spoken.push(text),finish:async()=>{},cancel:()=>closed++});await flush();assert.equal(closed,1);assert.deepEqual(spoken,[]);
});
test('canonical delivery metadata reaches speech but not display or follow-up context',async t=>{
  const f=fixture(t,false);const spoken:string[]=[];
  f.provider.generate=async function*(history){f.histories.push(structuredClone(history));yield '[[voi';yield 'ce:warmly]]Hello, ';yield 'keep [literal brackets]. [[voice:cur';yield 'ious]]What next?';};
  f.provider.speak=async()=>({push:text=>spoken.push(text),finish:async()=>{},cancel:()=>{}});
  await f.session.listen();await f.utterance(1,'Greet me.');const display=f.events.filter(e=>e.type==='response.delta').map(e=>e.text).join('');assert.equal(display,'Hello, keep [literal brackets]. What next?');assert.equal(spoken.join(''),'[warmly] Hello, keep [literal brackets]. [curious] What next?');
  const done=f.events.find(e=>e.type==='response.done')!;f.session.playbackDone(Number(done.epoch));await f.utterance(2,'Continue.');assert.equal(f.histories[1][1].content,display);
});
test('interruption discards split delivery metadata and never flushes its stale words',async t=>{
  const f=fixture(t,false);let release:()=>void=()=>{};const hold=new Promise<void>(r=>release=r),spoken:string[]=[];
  f.provider.generate=async function*(){yield '[[voice:war';await hold;yield 'mly]]Stale answer.';};f.provider.speak=async()=>({push:text=>spoken.push(text),finish:async()=>{},cancel:()=>{}});
  await f.session.listen();await f.utterance(1,'Hello.');f.session.cancel();const count=f.events.length;release();await flush();assert.deepEqual(spoken,[]);assert.equal(f.events.length,count);assert.equal(f.events.some(e=>e.type==='response.delta'),false);
});
