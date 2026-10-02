import {type Emit,type Providers,type Recognition,type Speech} from './core.js';
import {Delivery,type DeliveryOutput} from './delivery.js';

type Segment={id:number;text:string;final:boolean;startMs:number;endMs:number;consumed:string};
type Turn={epoch:number;control:AbortController;speech?:Speech;text:string;done:boolean;delivery?:Delivery;timer?:ReturnType<typeof setTimeout>};
const words=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,'').trim().split(/\s+/).filter(Boolean);
/** One user-started capture, independently cancellable replies. Audio time gates ASR revisions. */
export class HandsFreeSession {
  private active=false;
  private epoch=0;
  private capture?:AbortController;
  private recognition?:Recognition;
  private tick?:ReturnType<typeof setInterval>;
  private turn?:Turn;
  private history:{role:string;content:string}[]=[];
  private segments=new Map<number,Segment>();
  private clock=0;
  private lastVoice=-Infinity;
  private hotMs=0;
  private utterance=false;
  private floor=.001;
  private changedAt=0;
  private consumedThrough=-Infinity;
  private lastAssistant='';
  private audibleFrom=Infinity;
  private audibleUntil=-Infinity;
  private lastEnergy=-Infinity;
  private burstMs=0;
  private listeningSince=0;
  constructor(private providers:Providers,private emit:Emit,private options:{textOnly?:boolean;now?:()=>number;quietMs?:number;draftQuietMs?:number;stableMs?:number}={}){}
  private now(){return this.options.now?.()??Date.now();}
  private send(event:Record<string,unknown>){if(this.active)this.emit({...event,epoch:this.epoch,continuous:true});}
  get isActive(){return this.active;}
  async listen(){
    if(this.active){this.cancel();return;}
    this.active=true;this.epoch++;this.clock=0;this.lastVoice=-Infinity;this.hotMs=0;this.utterance=false;this.floor=.001;this.consumedThrough=-Infinity;this.audibleFrom=Infinity;this.audibleUntil=-Infinity;this.lastEnergy=-Infinity;this.burstMs=0;this.lastAssistant='';this.listeningSince=this.now();
    const capture=new AbortController();this.capture=capture;
    this.send({type:'status',state:'connecting'});
    this.tick=setInterval(()=>this.checkEndpoint(),100);
    try{
      const recognition=await this.providers.recognize(event=>{
        if(!this.active||capture.signal.aborted)return;
        if(event.type==='audio.activity')this.activity(Number(event.rms),Number(event.timeMs),Number(event.durationMs));
        else if(event.type==='transcript.segment')this.segment(event);
        else if(event.type==='error')this.fail('Local speech recognition stopped. Start again to reconnect.');
      },capture.signal);
      if(!this.active||capture.signal.aborted){recognition.cancel();return;}
      this.recognition=recognition;this.send({type:'status',state:'listening'});
    }catch{if(!capture.signal.aborted)this.fail('Continuous transcription could not start. Check native setup and microphone permission.');}
  }
  append(audio:string){void audio;} // Native capture is the sole microphone path.
  private activity(rms:number,time:number,duration:number){
    if(!Number.isFinite(rms)||!Number.isFinite(time)||!Number.isFinite(duration)||time<this.clock)return;
    this.clock=time;
    const threshold=Math.max(.008,this.floor*3.5);
    if(rms>=threshold){
      this.hotMs+=Math.min(duration,150);this.burstMs=this.hotMs;this.lastEnergy=time;
      if(this.hotMs>=250){
        if(!this.utterance){this.utterance=true;this.changedAt=this.now();}
        this.lastVoice=time;
        if(this.turn)this.cancel();
      }
    }else{
      this.hotMs=0;
      if(rms<threshold)this.floor=Math.min(.01,this.floor*.98+rms*.02);
    }
    this.armRecognizedSpeech();this.checkEndpoint();
  }
  private armRecognizedSpeech(){
    if(this.burstMs<150||this.lastEnergy<=this.consumedThrough)return;
    if(this.pending().some(s=>s.endMs>=this.lastEnergy-1200&&s.startMs<=this.lastEnergy)){if(this.turn)this.cancel();this.utterance=true;this.lastVoice=this.lastEnergy;}
  }
  private remaining(segment:Segment){
    if(!segment.consumed)return segment.text.trim();
    if(segment.text.startsWith(segment.consumed))return segment.text.slice(segment.consumed.length).trim();
    // A late revision of committed words must never become a second user turn.
    const before=words(segment.consumed),after=words(segment.text);
    if(before.every((word,index)=>after[index]===word)){
      return segment.text.trim().split(/\s+/).slice(before.length).join(' ');
    }
    // Align a revised committed prefix before extracting newly spoken suffix words.
    // Timing still has to extend past the consumed watermark; edits alone cannot create turns.
    const limit=Math.min(after.length,before.length+8);
    let row=Array.from({length:limit+1},(_,i)=>i);
    for(let i=1;i<=before.length;i++){
      const next=[i];for(let j=1;j<=limit;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(before[i-1]===after[j-1]?0:1));row=next;
    }
    let boundary=0,best=Infinity;
    for(let j=Math.max(1,before.length-8);j<=limit;j++){const score=row[j]+Math.abs(j-before.length)*.01;if(score<best){best=score;boundary=j;}}
    if(best<=Math.max(1,before.length*.3)&&boundary<after.length)return segment.text.trim().split(/\s+/).slice(boundary).join(' ');
    return '';
  }
  private segment(event:Record<string,unknown>){
    const id=Number(event.id),startMs=Number(event.startMs),endMs=Number(event.endMs);
    if(!Number.isSafeInteger(id)||id<1||typeof event.text!=='string'||typeof event.final!=='boolean'||!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<startMs)return;
    const previous=this.segments.get(id);
    if(previous?.final)return;
    const value:Segment={id,text:event.text.slice(0,8000),final:event.final,startMs,endMs,consumed:previous?.consumed||''};
    if(endMs<=this.consumedThrough){value.consumed=value.text;}
    // Headphone leakage matching an assistant passage is discarded. This is not acoustic echo cancellation.
    const normalized=words(value.text).join(' '),assistant=words(this.lastAssistant).join(' ');
    if(!this.options.textOnly&&value.startMs>=this.audibleFrom-250&&value.endMs<=this.audibleUntil+250&&normalized.split(' ').length>=4&&assistant.includes(normalized)){value.consumed=value.text;}
    this.segments.set(id,value);
    if(!previous||previous.text!==value.text||previous.final!==value.final)this.changedAt=this.now();
    if(this.segments.size>128){const oldest=[...this.segments.values()].find(s=>!this.remaining(s));if(oldest)this.segments.delete(oldest.id);else{this.fail('Transcript limit reached. Start a new session.');return;}}
    this.render();this.armRecognizedSpeech();this.checkEndpoint();
  }
  private pending(){return [...this.segments.values()].sort((a,b)=>a.startMs-b.startMs||a.id-b.id).filter(s=>s.endMs>this.consumedThrough&&this.remaining(s));}
  private render(){const segments=this.pending();this.send({type:'transcript.snapshot',finalized:segments.filter(s=>s.final).map(s=>this.remaining(s)).join(' '),draft:segments.filter(s=>!s.final).map(s=>this.remaining(s)).join(' ')});}
  /** Called by capture activity and a wall-clock watchdog; quiet is measured on the audio timeline. */
  checkEndpoint(){
    if(!this.active||this.turn)return;
    if(this.now()-this.listeningSince>180_000){this.fail('No completed turn for three minutes. Microphone stopped; Start to continue.');return;}
    if(!this.utterance)return;
    const pending=this.pending(),quiet=this.clock-this.lastVoice,stable=this.now()-this.changedAt;
    if(!pending.length){if(quiet>8000){this.utterance=false;this.send({type:'status',state:'listening',detail:'No words recognized. Keep speaking or use Stop.'});}return;}
    const latest=Math.max(...pending.map(s=>s.endMs));
    if(latest<this.lastVoice-1200)return; // Old finalized text cannot close fresh speech.
    const finalized=pending.every(s=>s.final);
    if(quiet>=(finalized?(this.options.quietMs??950):(this.options.draftQuietMs??1600))&&stable>=(finalized?(this.options.stableMs??350):Math.max(this.options.stableMs??350,700)))this.commit();
  }
  commit(){
    if(!this.active||this.turn)return;
    const pending=this.pending();const text=pending.map(s=>this.remaining(s)).join(' ').trim();
    if(!text){this.send({type:'status',state:'listening',detail:'No new words yet.'});return;}
    if(text.length>4000){this.fail('This turn is too long. Start again with a shorter message.');return;}
    for(const segment of this.segments.values())segment.consumed=segment.text;
    this.consumedThrough=Math.max(this.lastVoice,...pending.map(s=>s.endMs))+150;
    this.utterance=false;this.hotMs=0;this.listeningSince=this.now();
    void this.reply(text);
  }
  async reply(text:string){
    if(!this.active)return;
    if(this.turn)this.cancel();
    const turn:Turn={epoch:++this.epoch,control:new AbortController(),text:'',done:false};this.turn=turn;
    const current=()=>this.active&&this.turn===turn&&!turn.control.signal.aborted;
    const send:Emit=event=>{if(current()){if(event.type==='audio'){this.audibleFrom=Math.min(this.audibleFrom,this.clock);this.audibleUntil=Infinity;}this.send(event);}};
    this.audibleFrom=Infinity;this.audibleUntil=-Infinity;this.lastAssistant='';
    this.history.push({role:'user',content:text});this.history=this.history.slice(-11);
    send({type:'turn',text});send({type:'status',state:'thinking'});
    turn.timer=setTimeout(()=>{if(current())this.fail('Reply timed out. Microphone stopped; Start again.');},120_000);
    try{
      // Open synthesis concurrently: text generation must not wait for the voice handshake.
      const pendingSpeech=(this.options.textOnly?Promise.resolve<Speech>({push:()=>{},finish:async()=>{},cancel:()=>{}}):this.providers.speak(send,turn.control.signal)).then(speech=>{if(!current())speech.cancel();else turn.speech=speech;return speech;});
      void pendingSpeech.catch(()=>{if(current())this.fail('Voice connection failed. Check voice setup, then Start again.');});
      const delivery=new Delivery();turn.delivery=delivery;
      const publish=async(output:DeliveryOutput)=>{
        if(!current())return;
        turn.text+=output.display;this.lastAssistant=turn.text;
        if(turn.text.length>12000)throw new Error('Response limit');
        if(output.display)send({type:'response.delta',text:output.display});
        if(output.phrases.length){const speech=await pendingSpeech;if(!current())return;for(const phrase of output.phrases){speech.push(phrase);if(!this.options.textOnly)send({type:'phrase',text:phrase});}}
      };
      for await(const delta of this.providers.generate(this.history,turn.control.signal)){
        if(!current())return;
        await publish(delivery.add(delta));
      }
      if(!current())return;
      await publish(delivery.add('',true));
      if(!turn.text.trim())throw new Error('Empty response');
      const speech=await pendingSpeech;if(!current())return;
      await speech.finish();if(!current())return;
      turn.done=true;send({type:'response.done'});
      if(this.options.textOnly)this.playbackDone(turn.epoch);
      else{clearTimeout(turn.timer);turn.timer=setTimeout(()=>{if(current())this.fail('Playback did not finish. Microphone stopped; Start again.');},35_000);}
    }catch{if(current())this.fail('Reply stopped. Check reply-provider access, voice setup, or session limits, then Start again.');}
  }
  playbackDone(epoch:number){
    const turn=this.turn;if(!turn||turn.epoch!==epoch||!turn.done)return;
    clearTimeout(turn.timer);turn.speech?.cancel();this.audibleUntil=this.clock;
    this.history.push({role:'assistant',content:turn.text});this.turn=undefined;this.listeningSince=this.now();
    this.send({type:'status',state:'listening'});this.render();
  }
  cancel(stop=false){
    const turn=this.turn;
    if(turn){this.audibleUntil=this.clock;turn.control.abort();turn.delivery?.reset();turn.speech?.cancel();clearTimeout(turn.timer);if(turn.text)this.history.push({role:'assistant',content:`[Interrupted response. Generated draft below; playback was interrupted and delivery is unconfirmed. Do not assume the user heard it.]\n${turn.text}`});this.turn=undefined;}
    this.epoch++;
    if(stop){this.active=false;this.capture?.abort();this.recognition?.cancel();this.recognition=undefined;clearInterval(this.tick);this.providers.close?.();this.history=[];this.segments.clear();}
    this.emit({type:'cancelled',epoch:this.epoch,stopped:stop,continuous:true});
    if(!stop&&this.active){this.listeningSince=this.now();this.send({type:'status',state:'listening'});}
  }
  private fail(message:string){this.cancel(true);this.emit({type:'error',message});}
}
