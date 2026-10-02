export class Player {
  /** @type {AudioContext | null} */ context = null;
  /** @type {Set<AudioBufferSourceNode>} */ sources = new Set();
  next = 0;
  /** @type {Set<()=>void>} */ waiters = new Set();
  /** @type {number | null} */ carry = null;
  async unlock() { if(!this.context || this.context.state==='closed') this.context=new AudioContext(); await this.context.resume(); }
  /** @param {string} base64 @param {number} rate */
  add(base64,rate) {
    const ctx=this.context; if(!ctx || ctx.state!=='running') throw new Error('Audio output unavailable. Start again.');
    const decoded=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    const bytes=new Uint8Array(decoded.length+(this.carry===null?0:1));
    if(this.carry!==null){bytes[0]=this.carry;bytes.set(decoded,1);}else bytes.set(decoded);
    this.carry=bytes.length%2?bytes[bytes.length-1]:null;
    const length=Math.floor(bytes.length/2);if(!length)return;
    const buffer=ctx.createBuffer(1,length,rate);const channel=buffer.getChannelData(0);const view=new DataView(bytes.buffer);
    for(let i=0;i<length;i++)channel[i]=view.getInt16(i*2,true)/32768;
    if(Math.max(0,this.next-ctx.currentTime)+buffer.duration>30)throw new Error('Audio queue is too long. Please interrupt and try again.');
    const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);this.sources.add(source);
    source.onended=()=>{this.sources.delete(source);source.disconnect();if(!this.sources.size)this.drained();};
    this.next=Math.max(this.next,ctx.currentTime+.035);source.start(this.next);this.next+=buffer.duration;
  }
  drained(){for(const resolve of this.waiters)resolve();this.waiters.clear();}
  finished(){return this.sources.size?new Promise(resolve=>this.waiters.add(()=>resolve(undefined))):Promise.resolve();}
  clear(){for(const source of this.sources){source.onended=null;try{source.stop();}catch{/* Already stopped. */}source.disconnect();}this.sources.clear();this.next=0;this.carry=null;this.drained();}
  get remaining(){return this.context?Math.max(0,this.next-this.context.currentTime)*1000:0;}
  close(){this.clear();const context=this.context;this.context=null;void context?.close().catch(()=>{});}
}
export class Microphone {
  /** @type {MediaStream | null} */ stream=null;
  /** @type {AudioContext | null} */ context=null;
  /** @type {AudioWorkletNode | null} */ node=null;
  version=0;
  /** @param {(audio:string,rms:number)=>void} chunk */
  async start(chunk){
    this.stop();const version=this.version;
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(version!==this.version){stream.getTracks().forEach(t=>t.stop());return false;}
    this.stream=stream;const context=new AudioContext({sampleRate:24000});this.context=context;
    try{
      await context.audioWorklet.addModule('/capture-worklet.js');
      if(version!==this.version)return false;
      await context.resume();
      if(version!==this.version)return false;
      const source=context.createMediaStreamSource(stream);const node=new AudioWorkletNode(context,'pcm-capture');this.node=node;
      node.port.onmessage=({data})=>{if(version!==this.version)return;const bytes=new Uint8Array(data.pcm);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);chunk(btoa(binary),data.rms);};
      const silent=context.createGain();silent.gain.value=0;source.connect(node);node.connect(silent);silent.connect(context.destination);
      return true;
    }catch(error){this.stop();throw error;}
  }
  stop(){this.version++;if(this.node){this.node.port.onmessage=null;this.node.disconnect();this.node=null;}this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;const context=this.context;this.context=null;void context?.close().catch(()=>{});}
}
