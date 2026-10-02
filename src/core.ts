export type Emit = (event: Record<string, unknown>) => void;
export interface Speech { push(text: string): void; finish(): Promise<void>; cancel(): void }
export interface Recognition { native?: boolean; append(audio: string): void; commit(): void; cancel(): void }
export interface Providers {
  close?():void;
  recognize(emit: Emit, signal: AbortSignal): Promise<Recognition>;
  generate(history: {role: string; content: string}[], signal: AbortSignal): AsyncIterable<string>;
  speak(emit: Emit, signal: AbortSignal): Promise<Speech>;
}

/** Commit at punctuation or a bounded word boundary. Never speak provisional text. */
export class Phrases {
  private buffer = '';
  add(delta: string, final = false): string[] {
    this.buffer += delta;
    const result: string[] = [];
    while (this.buffer) {
      const punctuation = /[.!?;:,](?:\s|$)/.exec(this.buffer);
      let end = punctuation ? punctuation.index + punctuation[0].length : -1;
      if (end < 0 && this.buffer.length > 150) end = this.buffer.lastIndexOf(' ', 150) + 1;
      if (end <= 0) { if (final) end = this.buffer.length; else break; }
      const phrase = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      if (phrase.trim()) result.push(phrase);
    }
    return result;
  }
}

export class Session {
  private epoch = 0;
  private control?: AbortController;
  private recognition?: Recognition;
  private speech?: Speech;
  private timer?: ReturnType<typeof setTimeout>;
  private committing = false;
  private bytes = 0;
  private active = false;
  private history: {role: string; content: string}[] = [];
  private autoCommit?: ReturnType<typeof setTimeout>;
  constructor(private providers: Providers, private emit: Emit, private transcriptionOnly = false, private options:{textOnly?:boolean;autoTurnMs?:number} = {}) {}
  cancel(stop = false) {
    this.epoch++;
    this.control?.abort(); this.recognition?.cancel(); this.speech?.cancel();
    clearTimeout(this.timer);clearTimeout(this.autoCommit);
    this.recognition = undefined; this.speech = undefined; this.committing = false; this.bytes = 0;
    if (stop) { this.active = false; this.history = []; this.providers.close?.(); }
    this.emit({type:'cancelled', epoch:this.epoch, stopped:stop});
  }
  private begin() {
    this.cancel(); this.active = true;
    const epoch = this.epoch;
    this.control = new AbortController();
    const send: Emit = event => { if (this.epoch === epoch && !this.control?.signal.aborted) this.emit({...event,epoch}); };
    this.timer = setTimeout(() => { if (epoch === this.epoch) this.fail('Turn timed out. Try again.'); }, 120_000);
    return {epoch, signal:this.control.signal, send};
  }
  private fail(message: string) { this.cancel(true); this.emit({type:'error',message}); }
  async listen() {
    const {epoch, signal, send} = this.begin();
    send({type:'status',state:'connecting'});
    try {
      const recognition = await this.providers.recognize(event => {
        if (epoch !== this.epoch) return;
        if (event.type === 'transcript.snapshot' && this.options.autoTurnMs && !this.committing) {
          clearTimeout(this.autoCommit);
          if(typeof event.finalized==='string' && event.finalized.trim() && event.draft==='') this.autoCommit=setTimeout(()=>{if(epoch===this.epoch)this.commit();},this.options.autoTurnMs);
        }
        if (event.type === 'transcript.final') {
          if (!this.committing) return;
          const text = String(event.text || '').trim();
          if (!text && !this.transcriptionOnly) { this.fail('No speech was recognized. Try again.'); return; }
          send(event);
          if (this.transcriptionOnly) {
            this.cancel();
            this.emit({type:'transcription.done',text,epoch:this.epoch});
            this.emit({type:'status',state:'local-ready',epoch:this.epoch});
          } else void this.reply(text);
        } else if (event.type === 'error') this.fail(String(event.message));
        else send(event);
      }, signal);
      if (epoch !== this.epoch) { recognition.cancel(); return; }
      this.recognition = recognition;
      clearTimeout(this.timer);
      if (!this.transcriptionOnly) this.timer = setTimeout(() => { if (epoch === this.epoch) this.fail('Listening timed out after 60 seconds. Start again.'); }, 60_000);
      send({type:'status',state:'listening'});
    } catch { if (epoch === this.epoch) this.fail('Transcription could not start. Check the selected ASR setup and permissions, then try again.'); }
  }
  append(audio: string) {
    if (!this.recognition || this.committing) return;
    this.bytes += Math.floor(audio.length * 3 / 4);
    if (this.bytes > 24_000 * 2 * 60) { this.fail('One turn is limited to 60 seconds.'); return; }
    this.recognition.append(audio);
  }
  commit() {
    if (!this.recognition || this.committing) return;
    if (!this.recognition.native && this.bytes < 4_800) { this.fail('Speak for a moment before sending.'); return; }
    this.committing = true;
    clearTimeout(this.autoCommit);clearTimeout(this.timer);
    const epoch = this.epoch;
    this.timer = setTimeout(() => { if (epoch === this.epoch) this.fail('Transcription finalization timed out. Start again.'); }, 20_000);
    this.emit({type:'status',state:'transcribing',epoch:this.epoch});
    this.recognition.commit();
  }
  async reply(text: string) {
    if (this.transcriptionOnly) { this.fail('AI responses are disabled in local microphone mode.'); return; }
    const {epoch, signal, send} = this.begin();
    send({type:'turn',text}); send({type:'status',state:'thinking'});
    this.history.push({role:'user',content:text});
    this.history = this.history.slice(-12);
    let full = '';
    try {
      const speech:Speech = this.options.textOnly ? {push:()=>{},finish:async()=>{},cancel:()=>{}} : await this.providers.speak(send, signal);
      if (epoch !== this.epoch) { speech.cancel(); return; }
      this.speech = speech;
      const phrases = new Phrases();
      for await (const delta of this.providers.generate(this.history,signal)) {
        if (epoch !== this.epoch) return;
        full += delta;
        if (full.length > 12_000) throw new Error('Response limit');
        send({type:'response.delta',text:delta});
        for (const phrase of phrases.add(delta)) { speech.push(phrase); if(!this.options.textOnly)send({type:'phrase',text:phrase}); }
      }
      for (const phrase of phrases.add('',true)) { speech.push(phrase); if(!this.options.textOnly)send({type:'phrase',text:phrase}); }
      await speech.finish();
      if (epoch !== this.epoch) return;
      this.history.push({role:'assistant',content:full});
      clearTimeout(this.timer); this.speech = undefined;
      send({type:'response.done'});
      if(this.options.textOnly)send({type:'status',state:'ready'});
    } catch { if (epoch === this.epoch) this.fail(this.options.textOnly?'Codex response stopped. Check subscription access or start a new session.':'Response or voice service failed. Check model access, voice ID, and provider limits.'); }
  }
  get isActive() { return this.active; }
}
