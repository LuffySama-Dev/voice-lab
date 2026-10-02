import http from 'node:http';
import {codexReadiness,CodexProviders} from './codex.js';
import {elevenReadiness} from './eleven.js';
import {createCodexClient} from './codex-rpc.js';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {LiveYapProviders} from './live-yap.js';
import {YapProviders,yapAvailable} from './yap.js';
import {Session} from './core.js';
import {configuration,missing,DemoProviders,LiveProviders} from './providers.js';

const port = Number(process.env.PORT || 4317);
const token = randomBytes(32).toString('hex');
const config = configuration(process.env);
const asr = process.env.ASR_PROVIDER === 'openai' ? 'openai' : 'yap';
const yapPath = process.env.YAP_PATH || '/opt/homebrew/bin/yap';
const yapReady = process.env.YAP_READY === '1' && await yapAvailable(yapPath);
const localPartials = process.env.LOCAL_PARTIALS_ENABLED === '1';
const liveYapPath = fileURLToPath(new URL('../bin/yap-live',import.meta.url));
const partialsReady = !localPartials || await yapAvailable(liveYapPath);
const localMicEnabled = process.env.LOCAL_MIC_ENABLED === '1' && yapReady && partialsReady;
const codex = codexReadiness(process.env.CODEX_AI_ENABLED === '1');
const codexBinary = process.env.CODEX_PATH || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const codexCwd = fileURLToPath(new URL('../.runtime/codex-empty',import.meta.url));
const eleven = elevenReadiness(process.env.ELEVEN_TTS_ENABLED === '1',config);
const paidServicesEnabled = process.env.PAID_SERVICES_ENABLED === '1';
const setupMissing = () => [...missing(config), ...(asr === 'yap' && !yapReady ? ['YAP_READY (complete native setup first)'] : [])];
const files: Record<string,[string,string]> = {'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/audio.js':['audio.js','text/javascript'],'/capture-worklet.js':['capture-worklet.js','text/javascript'],'/style.css':['style.css','text/css']};
const hosts = new Set([`localhost:${port}`,`127.0.0.1:${port}`]);
const origins = new Set([...hosts].map(h=>`http://${h}`));
const server = http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Permissions-Policy','microphone=(self), camera=()');
  if(!hosts.has(req.headers.host || '')) {res.writeHead(403).end();return;}
  if(req.method!=='GET') {res.writeHead(405).end();return;}
  if(req.url==='/api/config') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({token,codex,eleven,missing:setupMissing(),asr,yapReady,localMicEnabled,paidServicesEnabled,localPartials,model:config.model,effort:config.effort,tier:config.tier}));return;}
  const pathname = new URL(req.url || '/',`http://127.0.0.1:${port}`).pathname;
  const file=files[pathname];
  if(!file) {res.writeHead(404).end();return;}
  try {res.setHeader('Content-Type',file[1]);res.end(await readFile(fileURLToPath(new URL(`../public/${file[0]}`,import.meta.url))));} catch {res.writeHead(500).end();}
});
const wss = new WebSocketServer({noServer:true,maxPayload:100_000});
server.on('upgrade',(req,socket,head)=>{
  const url = new URL(req.url || '/',`http://127.0.0.1:${port}`);
  if(!hosts.has(req.headers.host || '') || !origins.has(req.headers.origin || '') || url.pathname!=='/session' || url.searchParams.get('token')!==token || wss.clients.size>=1) {socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
});
wss.on('connection',ws=>{
  let session: Session | undefined; let mode='';
  const emit = (event: Record<string,unknown>)=>{if(ws.readyState===WebSocket.OPEN) {if(ws.bufferedAmount>4*1024*1024){ws.terminate();return;} ws.send(JSON.stringify(event));}};
  ws.on('message',raw=>{
    try {
      const e=JSON.parse(raw.toString());
      if(e.type==='start') {
        session?.cancel(true);
        mode=e.mode;
        const voiceEnabled=mode==='codex'&&e.voice===true;
        if(voiceEnabled&&!eleven.available){emit({type:'error',message:'Eleven v4 Turbo is not enabled or voice setup is incomplete. Complete private local voice setup before starting speech.'});return;}
        if(mode!=='demo' && mode!=='live' && mode!=='local' && mode!=='codex') throw new Error('Invalid mode');
        if(mode==='codex' && !codex.available){emit({type:'error',message:codex.reason});return;}
        if(mode==='codex' && (!localMicEnabled || !localPartials)){emit({type:'error',message:'Codex voice input needs the local live-caption helper. Launch with npm run codex:background.'});return;}
        if(mode==='local' && !localMicEnabled) {emit({type:'error',message:'Local microphone setup is not enabled. Run npm run mic:background after completing YAP setup.'});return;}
        if(mode==='live' && !paidServicesEnabled) {emit({type:'error',message:'Paid services are disabled on this server. Use Local mic to test transcription without cloud calls.'});return;}
        if(mode==='live' && setupMissing().length) {emit({type:'error',message:'Live mode needs local YAP setup and provider credentials. Review README, then restart the server.'});return;}
        const nativeProvider = mode==='local' && localPartials ? new LiveYapProviders(config,liveYapPath,process.env.YAP_LOCALE || 'en-US') : new YapProviders(config,yapPath,process.env.YAP_LOCALE || 'en-US');
        const provider=mode==='codex'?new CodexProviders(config,liveYapPath,process.env.YAP_LOCALE || 'en-US',()=>createCodexClient(codexBinary,codexCwd),voiceEnabled):mode==='demo'?new DemoProviders():mode==='local'||asr==='yap'?nativeProvider:new LiveProviders(config);
        session=new Session(provider,emit,mode==='local',mode==='codex'?{textOnly:!voiceEnabled,autoTurnMs:1600}:{});
        if(mode==='live'||mode==='local'||mode==='codex') void session.listen(); else emit({type:'status',state:'demo-ready'});
      } else if(e.type==='stop') {session?.cancel(true); session=undefined;}
      else if(e.type==='cancel') session?.cancel();
      else if(e.type==='listen' && (mode==='live'||mode==='local'||mode==='codex')) void session?.listen();
      else if(e.type==='commit') session?.commit();
      else if(e.type==='audio' && typeof e.audio==='string' && e.audio.length<=64_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(e.audio)) session?.append(e.audio);
      else if(e.type==='text' && mode==='demo' && typeof e.text==='string' && e.text.trim() && e.text.length<=2000) void session?.reply(e.text.trim());
    } catch {session?.cancel(true);emit({type:'error',message:'Invalid session message. Start again.'});}
  });
  ws.on('error',()=>session?.cancel(true));
  ws.on('close',()=>session?.cancel(true));
});
server.listen(port,'127.0.0.1',()=>console.log(`Voice Lab: http://localhost:${port} (live ${missing(config).length?'not configured':'configured'}; default demo)`));
function shutdown(){for(const client of wss.clients) client.terminate();wss.close();server.close();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
