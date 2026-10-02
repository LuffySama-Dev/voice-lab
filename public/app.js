import {Player,Microphone} from './audio.js';
/** @template {HTMLElement} T @param {string} id @returns {T} */
function el(id){return /** @type {T} */(document.getElementById(id));}
/** @param {string} id @returns {HTMLButtonElement} */
const button=id=>el(id);
/** @param {string} id @returns {HTMLInputElement} */
const input=id=>el(id);
const player=new Player();const mic=new Microphone();
const codexUrl='http://localhost:4319/?mode=codex';
function continuous(){return mode==='codex'&&config?.handsFree===true;}
function routerSelected(){return mode==='codex'&&/** @type {HTMLSelectElement} */(el('reply-provider')).value==='openrouter';}
function codexVoice(){return mode==='codex'&&input('codex-voice').checked;}
function codexUnavailable(){return !config?.codex?`This page is connected to the older transcription server on port ${location.port}. Open ${codexUrl} for Codex replies. No transcript was sent.`:`${config.codex.reason} Open ${codexUrl} for the running Codex demo.`;}
/** @type {WebSocket | null} */let socket=null;
/** @type {{token:string,handsFree?:boolean,missing:string[],model:string,effort:string,tier:string,asr:string,yapReady:boolean,localMicEnabled:boolean,paidServicesEnabled:boolean,localPartials:boolean,eleven?:{available:boolean,requested:boolean,missing:string[],model:string},openrouter?:{available:boolean,requested:boolean,model:string,provider:string,reason:string},codex?:{available:boolean,requested:boolean,reason:string,model?:string,effort?:string,tier?:string}} | null} */let config=null;
let mode='demo',state='idle',active=false,run=0,acceptAudio=false,epoch=0,phrases=0;
let heard=false,lastVoice=0,voiceFrames=0,listenStarted=0,waiting=false;
const labels={'local-ready':['Transcript complete','The microphone is off. Start a new session whenever you’re ready.'],idle:['Ready when you are','Start a demo to explore the conversation flow.'],connecting:['Connecting…','Preparing a private session.'],listening:['I’m listening','Speak, then pause. Or select Send turn.'],transcribing:['Finishing your words…','Microphone paused while your turn is sent.'],thinking:['A thought is taking shape','Microphone paused. You can interrupt at any time.'],speaking:['Speaking a reply','Microphone paused to prevent feedback.'],ready:['Your turn','Select Talk to begin, or Stop to end.'],'demo-ready':['The demo is ready','Send a sample thought. Synthetic tones represent streamed audio.'],muted:['Muted. Session ended.','All audio stopped. Start a new session when you’re ready.']};
/** @param {string} value */
function setState(value){state=value;const label=labels[/** @type {keyof typeof labels} */(value)]||labels.idle;el('status').textContent=label[0];el('hint').textContent=label[1];el('orb').classList.toggle('active',['listening','speaking','thinking'].includes(value));button('start').disabled=active||!config;button('stop').disabled=!active||(mode==='local'&&value==='transcribing');button('stop').textContent=mode==='local'&&value==='transcribing'?'Finishing…':'■ Stop';button('talk').disabled=!active||!['live','local','codex'].includes(mode)||['listening','connecting','transcribing'].includes(value);button('talk').textContent=['thinking','speaking'].includes(value)?'Interrupt & talk':'Talk';button('send').disabled=value!=='listening';button('demo-send').disabled=!active||mode!=='demo';button('demo').disabled=active;button('live').disabled=active;button('local').disabled=active;button('codex').disabled=active;input('codex-voice').disabled=active||!config?.eleven?.available;/** @type {HTMLSelectElement} */(el('reply-provider')).disabled=active;el('recording').hidden=!(mode!=='demo'&&active&&(continuous()||['connecting','listening','transcribing'].includes(value)));button('send').hidden=mode==='local';button('talk').hidden=mode==='local';button('send').textContent='Send turn';if(continuous()&&active){el('hint').textContent=value==='listening'?'Microphone on. Speak, then pause; the next turn starts automatically.':'Microphone on. Speak to interrupt, or use Interrupt & talk. Headphones required.';if(value==='connecting')el('hint').textContent='Preparing continuous microphone capture.';}if(mode==='local'&&value==='transcribing')el('hint').textContent='Stopping YAP capture and finalizing your transcript locally.';}
/** @param {Record<string,unknown>} event */
function send(event){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(event));}
function clearAudio(){acceptAudio=false;player.clear();}
/** @param {string} message */
function error(message){stop();el('error').textContent=message;el('error').hidden=false;}
/** @param {boolean} [muted] */
function stop(muted=false){run++;active=false;clearAudio();mic.stop();send({type:'stop'});const old=socket;socket=null;old?.close();player.close();setState(muted?'muted':'idle');}
/** @param {string} selected */
function selectMode(selected){
  if(active)return;mode=selected;
  el('model-info').textContent=mode==='codex'?`${config?.codex?.model||'gpt-6-astra'} · ${config?.codex?.effort||'low'} reasoning / Fast requested`:`${config?.model||'gpt-6-astra'} · ${config?.effort||'high'} / ${config?.tier||'fast'} requested`;
  el('ai-disclosure').textContent=continuous()?'This is an AI-generated response, even when it sounds like you. Speak to interrupt, or use the controls. Headphones required.':'This is an AI-generated response, even when it sounds like you. Use the controls to interrupt or stop.';
  el('demo-form').hidden=mode!=='demo';el('live-consent').hidden=mode!=='live';el('local-help').hidden=mode!=='local';el('codex-consent').hidden=mode!=='codex';el('codex-link').hidden=mode!=='codex'||!!config?.codex?.available;
  el('mode-badge').textContent=mode==='codex'?'CODEX SUBSCRIPTION':mode==='live'?'PAID API USAGE':'NO API USAGE';
  el('notice').textContent=mode==='demo'?'Demo is local and scripted. No microphone, no AI service, no cloned voice. Short synthetic tones stand in for speech.':mode==='local'?'Continuous microphone transcription with YAP on your Mac. Start once and keep talking until Stop. Audio and text stay local; paid AI services are OFF.':'AI-generated speech in your authorized cloned voice. Headphones required. Live mode contacts OpenAI and ElevenLabs and incurs API charges. ';
  for(const id of ['demo','local','codex','live']){button(id).classList.toggle('selected',id===mode);button(id).setAttribute('aria-pressed',String(id===mode));}
  if(mode==='codex')el('notice').textContent='Local speech recognition → transcript text to Codex → streamed text reply. Uses your ChatGPT Codex allowance; Fast uses more allowance. Start once for automatic turns; microphone stays on until Stop. Voice playback and ElevenLabs are off. Tool restrictions are demo safeguards, not proven isolation.';
  if(mode==='codex'){
    if(codexVoice()){el('notice').textContent='Local speech recognition → transcript text to Codex → generated reply text to ElevenLabs → AI speech in your selected voice. Uses Codex allowance plus paid ElevenLabs credits. Headphones required. Microphone stays on through replies; speak to interrupt. Stop ends capture. Automatic turns use brief silence plus stable transcript text.';el('mode-badge').textContent='CODEX + PAID ELEVEN';}
    el('codex-consent-label').textContent=codexVoice()?'I authorize sending transcript text to OpenAI and generated reply text to ElevenLabs for paid speech in my selected authorized voice. I am using headphones. Local microphone audio stays on this Mac. Capture stays on during replies until I press Stop.':'I agree to send my transcript text to OpenAI using my existing Codex allowance. Local audio stays on this Mac. This personal demo has limited tool safeguards; it is not fully isolated.';
    el('voice-setup').textContent=config?.eleven?.available?'Eleven v4 Turbo is configured. Selecting voice uses paid ElevenLabs credits.':'Eleven v4 Turbo is not enabled on this server. Private setup and an authorized voice are required; see README. The working text demo is unchanged.';
  }
  if(routerSelected()){
    el('notice').textContent='Local recognition → transcript and conversation history to OpenRouter → Google AI Studio (Gemini 3.5 Flash Lite). '+(codexVoice()?'Generated reply text also goes to ElevenLabs for paid speech. ':'')+'OpenRouter uses paid credits. Microphone audio stays on this Mac. Headphones required. Interrupting stops local audio, but Google may continue processing and billing the reply.';
    el('codex-consent-label').textContent='I approve sending transcript and history to OpenRouter and Google AI Studio using paid credits'+(codexVoice()?', plus generated text to ElevenLabs for paid speech':'')+'. I am using headphones and understand cancellation may still incur provider charges.';
    el('mode-badge').textContent=codexVoice()?'OPENROUTER + ELEVEN':'PAID OPENROUTER';
    el('model-info').textContent='Gemini 3.5 Flash Lite · low reasoning · Google AI Studio';
    el('codex-link').hidden=true;
  }
  if(mode==='live')el('notice').textContent+=(config?.asr==='yap'?'YAP transcribes locally; only transcript text goes to OpenAI.':'Cloud ASR sends microphone audio to OpenAI.');
  if(mode==='local'){el('local-help').textContent=config?.localPartials?'Click Start once and speak. Draft words appear in italics and can be revised; finalized words stay stable. Stop preserves the last words. Emergency mute or Escape stops immediately. No AI reply is generated.':'Click Start once and keep talking. YAP appends finalized segments. Stop preserves the last words; Escape stops immediately.';text('response','AI responses are disabled in Local mic mode.');el('response-state').textContent='LOCAL TRANSCRIPTION ONLY';el('phrase-count').textContent='No cloud processing · no generated reply';}
  else{el('response-state').textContent=mode==='codex'?(codexVoice()?'AI VOICE + TEXT':'CODEX TEXT REPLY'):'GENERATED RESPONSE';if(mode==='codex'){text('response',codexVoice()?'An AI reply will stream here and speak in your selected voice.':'An AI text reply will stream here after you speak.');el('phrase-count').textContent=codexVoice()?`${config?.codex?.model||'Astra'} → Eleven v4 Turbo · expressive paid speech`:`${config?.codex?.model||'Astra'} · ${config?.codex?.effort||'low'} reasoning · Fast · no voice playback`;}}
  el('error').hidden=true;setState('idle');
  if(mode==='live')el('hint').textContent='Review setup and the consent checkbox before starting.';
  if(mode==='codex')el('hint').textContent=config?.codex?.available?'Confirm cloud processing, then Start. Pause to send automatically, or use Send turn.':`Codex replies run on port 4319. Use the link below to open that page.`;
  if(routerSelected()){el('hint').textContent=config?.openrouter?.available?'Confirm paid processing, then Start. Codex remains available in the provider selector.':'OpenRouter is not enabled. Complete approved private setup first; Codex remains available.';el('response-state').textContent='GEMINI REPLY';el('phrase-count').textContent=codexVoice()?'OpenRouter → Eleven v4 Turbo · paid usage':'OpenRouter → Google AI Studio · paid text';}
  if(mode==='local')el('hint').textContent='Click Start session when you’re ready to speak. Microphone is off until then.';
}
/** @param {string} id @param {string} text */
function text(id,text){el(id).textContent=text;el(id).classList.remove('empty');}
/** @param {string} finalized @param {string} draft */
function snapshot(finalized,draft){
  const container=el('transcript');container.classList.remove('empty');
  const stable=document.createElement('span');stable.className='finalized-text';stable.textContent=finalized;
  const provisional=document.createElement('span');provisional.className='draft-text';provisional.textContent=draft;
  container.replaceChildren(stable,provisional);
  el('transcript-state').textContent=draft?'LIVE DRAFT · MAY CHANGE':'FINALIZED TEXT';
}
async function capture(){
  const current=run;heard=false;voiceFrames=0;lastVoice=0;listenStarted=performance.now();
  try{await mic.start((audio,rms)=>{
    if(current!==run||state!=='listening')return;
    send({type:'audio',audio});const now=performance.now();
    if(rms>.015){voiceFrames++;lastVoice=now;if(voiceFrames>=2)heard=true;}else voiceFrames=0;
    if(heard && now-lastVoice>900)commit();
    if(now-listenStarted>55_000) {if(heard)commit();else error('No speech detected. Session stopped.');}
  });}catch{if(current===run)error('Microphone unavailable. Allow microphone access in your browser, check your input device, and try again.');}
}
function commit(){if(state!=='listening')return;mic.stop();setState('transcribing');send({type:'commit'});}
async function start(){
  if(active||!config)return;
  el('error').hidden=true;
  if(mode==='codex'){
    if(routerSelected()){if(!config.openrouter?.available){error(config.openrouter?.reason||'OpenRouter setup is not enabled. Complete approved private setup and restart the local server.');return;}}else if(!config.codex?.available){error(codexUnavailable());return;}
    if(codexVoice()&&!config.eleven?.available){error('Eleven v4 Turbo is not enabled on this server. Complete private local voice setup first.');return;}
    if(!input('codex-confirm').checked){if(routerSelected()){error('Confirm paid transcript/history processing by OpenRouter and Google AI Studio before starting.');return;}error(codexVoice()?'Confirm OpenAI transcript processing and paid ElevenLabs speech with headphones before starting.':'Confirm that transcript text goes to OpenAI using your Codex allowance before starting.');return;}
  }
  if(mode==='local'&&!config.localMicEnabled){error('Local microphone setup is not enabled on this server. Run npm run mic:background after YAP setup.');return;}
  if(mode==='live'){
    if(!config.paidServicesEnabled){error('Paid services are OFF. Select Local mic for your live transcription test.');return;}
    if(config.missing.length){error(`Live setup is incomplete: ${config.missing.join(', ')}. Enter values privately in .env, restart the server, and reload this page.`);return;}
    if(!input('consent').checked){error('Confirm headphones, voice authorization, and paid API processing before starting live.');return;}
  }
  active=true;waiting=false;epoch=0;const current=++run;setState('connecting');
  try{if(mode!=='local'&&(mode!=='codex'||codexVoice()))await player.unlock();if(current!==run)return;
    const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/session?token=${config.token}`);socket=ws;
    const timeout=setTimeout(()=>{if(current===run)error('Connection timed out. Check the local server.');},10_000);
    ws.onopen=()=>{clearTimeout(timeout);if(current!==run){ws.close();return;}send({type:'start',mode,voice:codexVoice(),provider:routerSelected()?'openrouter':'codex'});};
    ws.onerror=()=>{clearTimeout(timeout);if(current===run)error('Cannot connect. Check the local server and close any other active Voice Lab tab.');};
    ws.onclose=()=>{clearTimeout(timeout);if(current===run&&active)error('Session disconnected. Audio and microphone stopped. Start again.');};
    ws.onmessage=({data})=>{
      if(current!==run)return;
      try{
        const e=JSON.parse(data);
        if(e.type==='error'){error(e.message);return;}
        if(e.type==='cancelled'){clearAudio();epoch=e.epoch;waiting=false;return;}
        if(waiting && ['response.delta','response.done','audio','phrase'].includes(e.type))return;
        if(e.epoch!==undefined&&e.epoch<epoch)return;if(e.epoch!==undefined)epoch=e.epoch;
        if(e.type==='status'){setState(e.state);if(e.detail)el('hint').textContent=e.detail;if(e.state==='listening'){if(!continuous())text('transcript','');if(mode==='live'&&config?.asr==='openai')void capture();else el('hint').textContent=mode==='local'?(config?.localPartials?'Keep talking. Draft words update as you speak and settle as recognition finalizes. Click Stop when done.':'Keep talking. YAP appends finalized segments as they become available. Click Stop when done.'):mode==='codex'?(continuous()?'Microphone on. Speak, then pause. Replies and the next turn happen automatically; speak to interrupt.':'Speak, then pause, or select Send turn.'):'YAP uses the Mac microphone. Wait for finalized words, then select Send turn. Native permission may be required.';}}
        if(e.type==='transcript.snapshot')snapshot(e.finalized,e.draft);
        if(e.type==='transcript.delta')text('transcript',(el('transcript').textContent||'')+e.text);
        if(e.type==='transcript.final'){text('transcript',e.text);el('transcript-state').textContent='FINALIZED TEXT';}
        if(e.type==='transcription.done'){text('transcript',e.text||'No speech was recognized.');stop();setState('local-ready');}
        if(e.type==='turn'){mic.stop();text('transcript',e.text);text('response','');phrases=0;acceptAudio=true;el('phrase-count').textContent=mode==='codex'&&!codexVoice()?'Streaming reply text · voice playback off':'Committing phrases…';}
        if(e.type==='response.delta')text('response',(el('response').textContent||'')+e.text);
        if(e.type==='phrase'){phrases++;el('phrase-count').textContent=`${phrases} committed phrase${phrases===1?'':'s'} · ${mode==='demo'?'synthetic audio':'streaming voice'}`;}
        if(e.type==='audio'&&acceptAudio){player.add(e.audio,e.sampleRate);setState('speaking');}
        if(e.type==='response.done'){const completedEpoch=e.epoch;void player.finished().then(()=>{if(current!==run||completedEpoch!==epoch||!acceptAudio)return;acceptAudio=false;if(continuous()){send({type:'playback.done',epoch:completedEpoch});}else setState(mode==='demo'?'demo-ready':'ready');});}
      }catch{error('Playback or session failed. Start again.');}
    };
  }catch{if(current===run)error('Audio output is unavailable. Check browser permissions and try again.');}
}
el('reply-provider').onchange=()=>{input('codex-confirm').checked=false;selectMode(mode);};
input('codex-voice').onchange=()=>{input('codex-confirm').checked=false;selectMode(mode);};
button('start').onclick=()=>void start();button('stop').onclick=()=>{if(mode==='local'&&state==='listening')commit();else stop();};button('mute').onclick=()=>stop(true);button('send').onclick=commit;
button('talk').onclick=()=>{waiting=true;clearAudio();mic.stop();setState('connecting');send({type:'listen'});};
button('demo').onclick=()=>selectMode('demo');button('local').onclick=()=>selectMode('local');button('live').onclick=()=>selectMode('live');button('codex').onclick=()=>selectMode('codex');
el('demo-form').onsubmit=event=>{event.preventDefault();const value=input('demo-text').value.trim();if(!active||mode!=='demo'||!value)return;waiting=true;clearAudio();setState('thinking');send({type:'text',text:value});};
window.addEventListener('keydown',e=>{if(e.key==='Escape')stop(true);});window.addEventListener('pagehide',()=>stop());document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)stop();});
setState('idle');
fetch('/api/config').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(data=>{config=data;el('consent-label').textContent=data.asr==='yap'?'I’m using headphones and my authorized voice. YAP captures the Mac microphone locally; transcript text goes to OpenAI and generated text to ElevenLabs, with paid API usage. I have completed YAP native setup.':'I’m using headphones and my authorized voice. Microphone audio goes to OpenAI and generated text to ElevenLabs, with paid API usage.';el('transcript-state').textContent=data.localPartials?'LIVE DRAFT + FINAL':data.asr==='yap'?'YAP · FINAL SEGMENTS':'LIVE TRANSCRIPT';el('model-info').textContent=`${data.model} · ${data.effort} / ${data.tier} requested`;el('config-status').textContent=data.missing.length?`Not configured: ${data.missing.join(', ')}.`:'All required values are present. Provider access has not been verified.';const query=new URLSearchParams(location.search);input('codex-voice').checked=!!data.eleven?.available&&query.get('voice')==='1';const selected=query.get('mode');/** @type {HTMLSelectElement} */(el('reply-provider')).value=query.get('provider')==='openrouter'?'openrouter':'codex';if(selected==='codex')selectMode('codex');else if(selected==='local'&&data.localMicEnabled)selectMode('local');else setState('idle');}).catch(()=>error('Cannot load local configuration. Start the server and reload.'));
