import WebSocket from 'ws';
import type {Emit,Speech} from './core.js';
export const ELEVEN_MODEL='eleven_v4_turbo';
export const ELEVEN_URL=`wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=${ELEVEN_MODEL}&output_format=pcm_24000`;
export type VoiceConfig={elevenKey:string;voice:string};
export function elevenReadiness(requested:boolean,config:VoiceConfig){
  const missing=[['ELEVENLABS_API_KEY',config.elevenKey],['ELEVENLABS_VOICE_ID',config.voice]].filter(([,value])=>!value).map(([name])=>name);
  return {requested,available:requested&&!missing.length,model:ELEVEN_MODEL,missing};
}
export type VoiceConnect=(url:string,headers:Record<string,string>,signal:AbortSignal)=>Promise<WebSocket>;
/** One ordered TTD socket per reply. No replay, reconnect, or resynthesis of sent text. */
export async function elevenSpeech(config:VoiceConfig,connect:VoiceConnect,emit:Emit,signal:AbortSignal):Promise<Speech>{
  if(signal.aborted||!config.elevenKey||!config.voice)throw new Error('Voice setup is incomplete');
  const ws=await connect(ELEVEN_URL,{'xi-api-key':config.elevenKey},signal);
  if(signal.aborted){ws.terminate();throw new Error('Cancelled');}
  let ended=false,finishing=false,textBytes=0,audioBytes=0;
  let resolve:()=>void=()=>{},reject:(error:Error)=>void=()=>{};
  const completion=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void completion.catch(()=>{});
  const cleanup=()=>{clearInterval(keepAlive);clearTimeout(deadline);signal.removeEventListener('abort',cancel);};
  const fail=()=>{if(ended)return;ended=true;cleanup();reject(new Error('Voice stream stopped'));ws.terminate();};
  const cancel=()=>fail();
  const send=(frame:unknown)=>{if(ended||signal.aborted||ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>2*1024*1024){fail();throw new Error('Voice unavailable');}ws.send(JSON.stringify(frame));};
  const keepAlive=setInterval(()=>{try{send({keep_alive:true});}catch{fail();}},10000);
  const deadline=setTimeout(fail,120000);
  ws.on('message',raw=>{
    if(ended||signal.aborted)return;
    try{
      const frame=JSON.parse(raw.toString());
      if(frame.error)throw new Error();
      if(frame.audio!==undefined&&frame.audio!==null&&frame.audio!==''){
        if(typeof frame.audio!=='string'||frame.audio.length>4*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(frame.audio)||frame.audio.length%4!==0)throw new Error();
        audioBytes+=Buffer.byteLength(frame.audio,'base64');if(audioBytes>24000*2*120)throw new Error();
        emit({type:'audio',audio:frame.audio,sampleRate:24000});
      }
      if(frame.is_final===true){if(!finishing)throw new Error();ended=true;cleanup();resolve();ws.close();}
    }catch{fail();}
  });
  ws.on('error',fail);ws.on('close',()=>{if(!ended)fail();});
  signal.addEventListener('abort',cancel,{once:true});
  try{send({voices:[config.voice]});}catch{fail();throw new Error('Voice setup failed');}
  return {
    push(text){if(finishing||ended)throw new Error('Voice is closed');if(!text.trim())return;textBytes+=Buffer.byteLength(text);if(textBytes>12000){fail();throw new Error('Voice text limit');}send({inputs:[{text,voice_id:config.voice,new_turn:false}],flush:true});},
    finish(){if(ended)return completion;if(!finishing){finishing=true;try{send({close_socket:true});}catch{fail();}}return completion;},
    cancel,
  };
}
