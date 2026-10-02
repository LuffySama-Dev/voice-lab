import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {elevenSpeech,elevenReadiness} from '../src/eleven.js';
import {LiveProviders,configuration} from '../src/providers.js';

class Socket extends EventEmitter {
  readyState=WebSocket.OPEN;bufferedAmount=0;frames:Record<string,unknown>[]=[];
  send(value:string){this.frames.push(JSON.parse(value));}
  close(){this.emit('close');} terminate(){this.emit('close');}
}
const config=configuration({OPENAI_API_KEY:'synthetic-openai',ELEVENLABS_API_KEY:'synthetic-eleven',ELEVENLABS_VOICE_ID:'synthetic-voice'});
test('Responses uses configured model/reasoning/tier, no storage, streaming deltas',async()=>{
  let body:Record<string,unknown>={};
  const request:typeof fetch=async(_url,options)=>{body=JSON.parse(String(options?.body));return new Response('data: {"type":"response.output_text.delta","delta":"Hi there."}\n\ndata: {"type":"response.completed"}\n\n');};
  const provider=new LiveProviders(config,{connect:async()=>{throw new Error('Unexpected socket');},fetch:request});
  let text='';for await(const delta of provider.generate([{role:'user',content:'Synthetic prompt'}],new AbortController().signal))text+=delta;
  assert.equal(text,'Hi there.');assert.equal(body.model,'gpt-6-astra');assert.deepEqual(body.reasoning,{effort:'high'});assert.equal(body.service_tier,'fast');assert.equal(body.store,false);assert.equal(body.stream,true);
});
test('truncated response stream is an error',async()=>{const provider=new LiveProviders(config,{connect:async()=>{throw new Error();},fetch:async()=>new Response('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n')});await assert.rejects(async()=>{for await(const delta of provider.generate([],new AbortController().signal))assert.equal(delta,'Partial');});});
test('Eleven TTD registers one voice, flushes committed phrases, accepts snake_case final',async()=>{
  const socket=new Socket();let url='';const events:Record<string,unknown>[]=[];
  const provider=new LiveProviders(config,{connect:async(endpoint)=>{url=endpoint;return socket as unknown as WebSocket;},fetch:async()=>{throw new Error();}});
  const speech=await provider.speak(e=>events.push(e),new AbortController().signal);
  speech.push('A committed phrase. ');const done=speech.finish();
  assert.ok(url.includes('/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=pcm_24000'));
  assert.deepEqual(socket.frames,[{voices:['synthetic-voice']},{inputs:[{text:'A committed phrase. ',voice_id:'synthetic-voice',new_turn:false}],flush:true},{close_socket:true}]);
  socket.emit('message',Buffer.from(JSON.stringify({audio:'AAAA',is_final:true})));await done;
  assert.equal(events[0].type,'audio');assert.equal(events[0].sampleRate,24000);
});
test('Eleven failure before finish does not become an unhandled rejection',async()=>{const socket=new Socket();const provider=new LiveProviders(config,{connect:async()=>socket as unknown as WebSocket,fetch:async()=>{throw new Error();}});const speech=await provider.speak(()=>{},new AbortController().signal);socket.emit('message',Buffer.from('{"error":"synthetic failure"}'));await assert.rejects(speech.finish());speech.cancel();});

test('Eleven readiness needs separate paid opt-in and only Eleven credentials',()=>{
  assert.equal(elevenReadiness(false,config).available,false);assert.equal(elevenReadiness(true,config).available,true);
  const ready=elevenReadiness(true,{elevenKey:'',voice:''});assert.equal(ready.available,false);assert.deepEqual(ready.missing,['ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID']);assert.ok(!JSON.stringify(elevenReadiness(true,config)).includes('synthetic-eleven'));
});
test('Eleven cancellation discards late audio, clears keepalive, and cannot resume synthesis',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});const socket=new Socket(),control=new AbortController(),events:unknown[]=[];let header='';
  const speech=await elevenSpeech(config,async(_url,headers)=>{header=headers['xi-api-key'];return socket as unknown as WebSocket;},e=>events.push(e),control.signal);
  assert.equal(header,'synthetic-eleven');speech.push('First phrase. ');t.mock.timers.tick(10000);assert.deepEqual(socket.frames.at(-1),{keep_alive:true});
  socket.emit('message',Buffer.from('{"audio":"AAAA"}'));assert.equal(events.length,1);control.abort();const frames=socket.frames.length;t.mock.timers.tick(30000);socket.emit('message',Buffer.from('{"audio":"AAAA","is_final":true}'));
  assert.equal(events.length,1);assert.equal(socket.frames.length,frames);assert.throws(()=>speech.push('Must not be sent.'));await assert.rejects(speech.finish());
});
test('Eleven sends each committed phrase once, finalizes once, and rejects malformed audio',async()=>{
  const socket=new Socket();const speech=await elevenSpeech(config,async()=>socket as unknown as WebSocket,()=>{},new AbortController().signal);
  speech.push('One clause, ');speech.push('then another.');const done=speech.finish();assert.equal(speech.finish(),done);assert.equal(socket.frames.filter(f=>f.close_socket).length,1);
  assert.deepEqual(socket.frames.filter(f=>f.inputs).map(f=>(f.inputs as {text:string}[])[0].text),['One clause, ','then another.']);
  socket.emit('message',Buffer.from('{"audio":"not base64!"}'));await assert.rejects(done);
});
test('Eleven setup refuses missing key before connect and bounds abandoned replies',async(t)=>{
  let calls=0;await assert.rejects(elevenSpeech({elevenKey:'',voice:'synthetic'},async()=>{calls++;throw new Error();},()=>{},new AbortController().signal));assert.equal(calls,0);
  t.mock.timers.enable({apis:['setTimeout','setInterval']});const socket=new Socket();const speech=await elevenSpeech(config,async()=>socket as unknown as WebSocket,()=>{},new AbortController().signal);t.mock.timers.tick(120001);await assert.rejects(speech.finish());
});
