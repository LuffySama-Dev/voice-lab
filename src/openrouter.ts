import {LiveYapProviders} from './live-yap.js';
import type {Config} from './providers.js';
import {DELIVERY_CUES} from './delivery.js';
export const OPENROUTER_MODEL='google/gemini-3.5-flash-lite';
export const OPENROUTER_PROVIDER='google-ai-studio';
export function openrouterReadiness(env:NodeJS.ProcessEnv){const requested=env.OPENROUTER_ENABLED==='1';return{requested,available:requested&&!!env.OPENROUTER_API_KEY,model:OPENROUTER_MODEL,provider:OPENROUTER_PROVIDER,effort:'low',reason:'OpenRouter is disabled or private key setup is incomplete. Complete approved local setup and restart; Codex remains available.'};}
const instruction=(voice:boolean)=>'You are an AI voice conversation partner, not the person whose voice may speak your reply. Answer immediately in one or two short sentences unless asked for more detail. Use earlier messages for context; interrupted assistant drafts are not proof the user heard them. Do not use tools, browse, or claim external actions. No markdown. '+(voice?`Produce one canonical answer. Default to no delivery cue; use at most two context-appropriate reserved markers ${DELIVERY_CUES.map(c=>'[[voice:'+c+']]').join(', ')} before affected words, with reactions where the sound belongs. Every cue needs following words. Do not emit raw square-bracket voice tags or SSML. Keep ordinary literal bracketed prose intact.`:'Use plain text without delivery metadata or stage directions.');
/** Authenticated requests occur only after the server's explicit opt-in and browser Start. */
export class OpenRouterProviders extends LiveYapProviders {
  private lifetime=new AbortController();
  private turns=0;private bytes=0;
  constructor(config:Config,binary:string,locale:string,private key:string,private voiceEnabled=false,private request:typeof fetch=globalThis.fetch){super(config,binary,locale,{continuous:true});}
  override async *generate(history:{role:string;content:string}[],signal:AbortSignal){
    const last=history.at(-1);const size=history.reduce((n,m)=>n+Buffer.byteLength(m.content),0);
    if(!this.key||signal.aborted||this.lifetime.signal.aborted||!last||last.role!=='user'||!last.content.trim()||history.length>12||size>48000||history.some(m=>!['user','assistant'].includes(m.role)||(m.role==='user'&&Buffer.byteLength(m.content)>4000))||this.turns>=6||this.bytes+Buffer.byteLength(last.content)>48000)throw Error('OpenRouter session unavailable or limit reached');
    this.turns++;this.bytes+=Buffer.byteLength(last.content);
    const requestControl=new AbortController();const combined=AbortSignal.any([signal,this.lifetime.signal,requestControl.signal]);
    const timer=setTimeout(()=>requestControl.abort(),45000);let output=0,completed=false,done=false;
    try{
      const response=await this.request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',signal:combined,headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENROUTER_MODEL,messages:[{role:'system',content:instruction(this.voiceEnabled)},...history],stream:true,max_tokens:512,reasoning:{effort:'low',exclude:true},tools:[],tool_choice:'none',plugins:[],provider:{only:[OPENROUTER_PROVIDER],order:[OPENROUTER_PROVIDER],ignore:['google-ai-studio/flex','google-ai-studio/priority'],allow_fallbacks:false,require_parameters:true}})});
      if(!response.ok||!response.body)throw Error('Request rejected');
      for await(const event of openrouterEvents(response.body,combined)){
        if(combined.aborted)throw Error('Cancelled');
        if(event===null){done=true;break;}
        if(event.error)throw Error('Stream error');
        const choices=event.choices;if(!Array.isArray(choices))throw Error('Invalid stream');
        for(const choice of choices){
          if(choice.index!==0)throw Error('Unexpected choice');
          const delta=choice.delta;if(!delta||typeof delta!=='object'||delta.tool_calls||delta.function_call)throw Error('Unexpected response');
          if(delta.content!==undefined&&delta.content!==null&&typeof delta.content!=='string')throw Error('Invalid content');
          if(delta.content){if(completed)throw Error('Late content');output+=Buffer.byteLength(delta.content);this.bytes+=Buffer.byteLength(delta.content);if(output>12000||this.bytes>48000)throw Error('Output limit');yield delta.content as string;}
          if(choice.finish_reason!==undefined&&choice.finish_reason!==null){if(choice.finish_reason!=='stop')throw Error('Incomplete response');completed=true;}
        }
      }
      if(!completed||!done||!output)throw Error('Incomplete stream');
    }catch{throw Error('OpenRouter reply failed or was cancelled. Check access, credits, and the selected Google endpoint.');}
    finally{clearTimeout(timer);requestControl.abort();}
  }
  close(){this.lifetime.abort();}
}
/** Strict bounded SSE, including the required end marker and comment heartbeats. */
export async function* openrouterEvents(body:ReadableStream<Uint8Array>,signal:AbortSignal):AsyncGenerator<Record<string,unknown>|null>{
  const reader=body.getReader(),decoder=new TextDecoder();let pending='';const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
    while(!signal.aborted){const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});if(pending.length>1000000)throw Error('Oversized event');let match;
      while((match=/\r?\n\r?\n/.exec(pending))){const block=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;if(data==='[DONE]'){yield null;return;}const event=JSON.parse(data);if(!event||typeof event!=='object')throw Error('Invalid event');yield event;}
    }
    if(signal.aborted||pending.trim())throw Error('Interrupted stream');
  }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
