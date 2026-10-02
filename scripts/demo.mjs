import {spawn} from 'node:child_process';
import {mkdir,open,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const router=process.argv.includes('--openrouter');
const voice=router||process.argv.includes('--codex-voice');
const codex=voice||process.argv.includes('--codex');
const localMic=codex||process.argv.includes('--local-mic');
const port=codex?4319:4317;
if(voice&&!(process.env.ELEVEN_TTS_ENABLED==='1'&&process.env.ELEVENLABS_API_KEY&&process.env.ELEVENLABS_VOICE_ID)){console.error('Voice setup is incomplete. Run npm run setup:voice privately after choosing an authorized voice and approving paid speech. No server was started.');process.exit(1);}
const root=fileURLToPath(new URL('../',import.meta.url));
const url=`http://127.0.0.1:${port}`;
try {
  await fetch(url,{signal:AbortSignal.timeout(1000)});
  console.error(`Port ${port} already responds. No process was changed. Inspect it before starting another server.`);
  process.exit(1);
} catch { /* No responding HTTP server; the child will also fail safely on a port conflict. */ }
await mkdir(new URL('../.runtime/',import.meta.url),{recursive:true});
const log=await open(new URL('../.runtime/demo.log',import.meta.url),'a',0o600);
const child=spawn(process.execPath,['dist/server.js'],{cwd:root,detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,PORT:String(port),CODEX_AI_ENABLED:codex?'1':'0',OPENROUTER_ENABLED:router&&process.env.OPENROUTER_ENABLED==='1'?'1':'0',OPENROUTER_API_KEY:router?process.env.OPENROUTER_API_KEY:'',OPENAI_API_KEY:'',ELEVEN_TTS_ENABLED:voice?'1':'0',ELEVENLABS_API_KEY:voice?process.env.ELEVENLABS_API_KEY:'',ELEVENLABS_VOICE_ID:voice?process.env.ELEVENLABS_VOICE_ID:'',YAP_READY:localMic?'1':'0',LOCAL_MIC_ENABLED:localMic?'1':'0',LOCAL_PARTIALS_ENABLED:localMic?'1':'0',PAID_SERVICES_ENABLED:'0',ASR_PROVIDER:'yap'}});
let failure;child.once('error',error=>{failure=error;});
child.unref();await log.close();
for(let i=0;i<30;i++){
  if(failure)throw failure;
  if(child.exitCode!==null)throw new Error('Demo server exited. Inspect .runtime/demo.log.');
  await delay(100);
  try {
    const response=await fetch(`${url}/api/config`,{signal:AbortSignal.timeout(1000)});
    const config=await response.json();
    if(!response.ok || config.localMicEnabled!==localMic || config.codex.available!==codex || config.eleven.available!==voice || config.paidServicesEnabled || !config.missing.includes('OPENAI_API_KEY'))throw new Error('Unexpected server configuration');
    await writeFile(new URL(voice?'../.runtime/voice.pid':codex?'../.runtime/codex.pid':'../.runtime/demo.pid',import.meta.url),`${child.pid}\n`,{mode:0o600});
    console.log(`${voice?'Codex + Eleven v4 Turbo':codex?'Codex text demo':localMic?'Local mic test':'Demo'} running: http://localhost:${port}${router?'/?mode=codex&voice=1&provider=openrouter':voice?'/?mode=codex&voice=1':codex?'/?mode=codex':localMic?'/?mode=local':''} (PID ${child.pid})`);
    console.log(voice?'Local server only. Microphone and paid Eleven speech start only after browser consent and Start.':localMic?'Detached local process. YAP starts only on user Start; paid services disabled.':'Detached local process; no login service. Live credentials and YAP startup disabled.');
    process.exit(0);
  } catch { /* Retry a short bounded startup window. */ }
}
child.kill('SIGTERM');throw new Error('Demo did not become ready. Inspect .runtime/demo.log.');
