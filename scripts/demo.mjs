import {spawn} from 'node:child_process';
import {mkdir,open,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const localMic=process.argv.includes('--local-mic');
const root=fileURLToPath(new URL('../',import.meta.url));
const url='http://127.0.0.1:4317';
try {
  await fetch(url,{signal:AbortSignal.timeout(1000)});
  console.error('Port 4317 already responds. No process was changed. Inspect it before starting another server.');
  process.exit(1);
} catch { /* No responding HTTP server; the child will also fail safely on a port conflict. */ }
await mkdir(new URL('../.runtime/',import.meta.url),{recursive:true});
const log=await open(new URL('../.runtime/demo.log',import.meta.url),'a',0o600);
const child=spawn(process.execPath,['dist/server.js'],{cwd:root,detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,PORT:'4317',OPENAI_API_KEY:'',ELEVENLABS_API_KEY:'',ELEVENLABS_VOICE_ID:'',YAP_READY:localMic?'1':'0',LOCAL_MIC_ENABLED:localMic?'1':'0',LOCAL_PARTIALS_ENABLED:localMic?'1':'0',PAID_SERVICES_ENABLED:'0',ASR_PROVIDER:'yap'}});
let failure;child.once('error',error=>{failure=error;});
child.unref();await log.close();
for(let i=0;i<30;i++){
  if(failure)throw failure;
  if(child.exitCode!==null)throw new Error('Demo server exited. Inspect .runtime/demo.log.');
  await delay(100);
  try {
    const response=await fetch(`${url}/api/config`,{signal:AbortSignal.timeout(1000)});
    const config=await response.json();
    if(!response.ok || config.localMicEnabled!==localMic || config.paidServicesEnabled || !config.missing.includes('OPENAI_API_KEY'))throw new Error('Unexpected server configuration');
    await writeFile(new URL('../.runtime/demo.pid',import.meta.url),`${child.pid}\n`,{mode:0o600});
    console.log(`${localMic?'Local mic test':'Demo'} running: http://localhost:4317${localMic?'/?mode=local':''} (PID ${child.pid})`);
    console.log(localMic?'Detached local process. YAP starts only on user Start; paid services disabled.':'Detached local process; no login service. Live credentials and YAP startup disabled.');
    process.exit(0);
  } catch { /* Retry a short bounded startup window. */ }
}
child.kill('SIGTERM');throw new Error('Demo did not become ready. Inspect .runtime/demo.log.');
