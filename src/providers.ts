import WebSocket from 'ws';
import {elevenSpeech} from './eleven.js';
import {setTimeout as delay} from 'node:timers/promises';
import type {Emit, Providers, Recognition, Speech} from './core.js';

export interface Config { openaiKey: string; elevenKey: string; voice: string; model: string; effort: string; tier: string }
export function configuration(env: NodeJS.ProcessEnv): Config {
  return {openaiKey:env.OPENAI_API_KEY || '',elevenKey:env.ELEVENLABS_API_KEY || '',voice:env.ELEVENLABS_VOICE_ID || '',model:env.OPENAI_MODEL || 'gpt-6-astra',effort:env.OPENAI_REASONING_EFFORT || 'high',tier:env.OPENAI_SERVICE_TIER || 'fast'};
}
export function missing(config: Config) {
  return [['OPENAI_API_KEY',config.openaiKey],['ELEVENLABS_API_KEY',config.elevenKey],['ELEVENLABS_VOICE_ID',config.voice]].filter(([,v])=>!v).map(([k])=>k);
}
function connect(url: string, headers: Record<string,string>, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted) { reject(new Error('Cancelled')); return; }
    const ws = new WebSocket(url,{headers,handshakeTimeout:10_000,maxPayload:4*1024*1024});
    const abort = () => { ws.terminate(); reject(new Error('Cancelled')); };
    signal.addEventListener('abort',abort,{once:true});
    ws.once('close',()=>signal.removeEventListener('abort',abort));
    ws.on('error',()=>reject(new Error('Connection failed')));
    ws.once('open',()=>resolve(ws));
  });
}
function send(ws: WebSocket, event: unknown) {
  if(ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 2*1024*1024) throw new Error('Connection unavailable');
  ws.send(JSON.stringify(event));
}
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string,unknown>> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let pending = '';
  try {
    while(true) {
      const {value,done} = await reader.read();
      if(done) break;
      pending += decoder.decode(value,{stream:true});
      let match;
      while((match = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0,match.index); pending = pending.slice(match.index+match[0].length);
        const data = block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
        if(data && data !== '[DONE]') yield JSON.parse(data);
      }
      if(pending.length > 1_000_000) throw new Error('Oversized event');
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export class LiveProviders implements Providers {
  constructor(private config: Config, private transport = {connect, fetch: globalThis.fetch}) {}
  async recognize(emit: Emit, signal: AbortSignal): Promise<Recognition> {
    const ws = await this.transport.connect('wss://api.openai.com/v1/realtime?intent=transcription',{Authorization:`Bearer ${this.config.openaiKey}`},signal);
    await new Promise<void>((resolve,reject)=>{
      const timeout = setTimeout(()=>reject(new Error('Transcription setup timeout')),10_000);
      const ready = () => { clearTimeout(timeout); resolve(); };
      ws.on('message',raw=>{
        try {
          const e = JSON.parse(raw.toString());
          if(e.type === 'session.updated' || e.type === 'transcription_session.updated') ready();
          if(e.type === 'conversation.item.input_audio_transcription.delta') emit({type:'transcript.delta',text:e.delta});
          if(e.type === 'conversation.item.input_audio_transcription.completed') emit({type:'transcript.final',text:e.transcript});
          if(e.type === 'error' || e.type === 'conversation.item.input_audio_transcription.failed') { clearTimeout(timeout); reject(new Error('Transcription rejected')); emit({type:'error',message:'Transcription failed. Check OpenAI model access.'}); }
        } catch { emit({type:'error',message:'Invalid transcription service response.'}); }
      });
      ws.on('close',()=>{ clearTimeout(timeout); reject(new Error('Closed')); if(!signal.aborted) emit({type:'error',message:'Transcription disconnected. Start again.'}); });
      ws.on('error',()=>{ clearTimeout(timeout); reject(new Error('Disconnected')); });
      send(ws,{type:'session.update',session:{type:'transcription',audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:{model:'gpt-live-transcribe',delay:'low'},turn_detection:null}}}});
    });
    return {append:audio=>send(ws,{type:'input_audio_buffer.append',audio}),commit:()=>send(ws,{type:'input_audio_buffer.commit'}),cancel:()=>ws.terminate()};
  }
  async *generate(history: {role:string;content:string}[], signal: AbortSignal) {
    const response = await this.transport.fetch('https://api.openai.com/v1/responses',{method:'POST',signal,headers:{Authorization:`Bearer ${this.config.openaiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:this.config.model,reasoning:{effort:this.config.effort},service_tier:this.config.tier,store:false,stream:true,max_output_tokens:4096,instructions:'You are an AI voice conversation partner for a private prototype. You are not the human whose cloned voice speaks your replies. Reply naturally in 2 to 4 short sentences. Use plain speech without markdown or voice tags. Do not claim to perform external actions. Be honest about uncertainty.',input:history})});
    if(!response.ok || !response.body) throw new Error('Response rejected');
    let completed = false;
    for await(const event of sse(response.body)) {
      if(event.type === 'response.output_text.delta') yield String(event.delta || '');
      if(event.type === 'response.completed') completed = true;
      if(['error','response.failed','response.incomplete'].includes(String(event.type))) throw new Error('Response incomplete');
    }
    if(!completed) throw new Error('Stream interrupted');
  }
  async speak(emit: Emit, signal: AbortSignal): Promise<Speech> {
    return elevenSpeech(this.config,this.transport.connect,emit,signal);
  }
}
export class DemoProviders implements Providers {
  async recognize(): Promise<Recognition> { throw new Error('Demo never accesses microphone'); }
  async *generate(_history: unknown, signal: AbortSignal) {
    for(const word of 'This is a local demonstration of the conversation flow. In live mode, I will respond using your chosen cloned voice. You can interrupt me at any time with the controls below.'.split(' ')) { await delay(65,undefined,{signal}); yield word+' '; }
  }
  async speak(emit: Emit, signal: AbortSignal): Promise<Speech> {
    return {push:()=>{if(!signal.aborted) { const pcm=Buffer.alloc(24000/4*2); for(let i=0;i<pcm.length/2;i++) pcm.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*330/24000)*450*Math.sin(Math.PI*i/(pcm.length/2))),i*2);emit({type:'audio',audio:pcm.toString('base64'),sampleRate:24000}); }},finish:async()=>{},cancel:()=>{}};
  }
}
