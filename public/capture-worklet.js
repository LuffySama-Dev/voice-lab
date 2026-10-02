/* Audio never connects audibly to output. 24 kHz little-endian PCM, ~80 ms frames. */
class Capture extends AudioWorkletProcessor {
  constructor(){super();this.samples=[];this.phase=0;this.sum=0;this.count=0;}
  process(inputs){
    const input=inputs[0]?.[0];if(!input)return true;
    for(const sample of input){
      this.sum+=sample;this.count++;this.phase+=24000;
      if(this.phase>=sampleRate){this.phase-=sampleRate;this.samples.push(this.sum/this.count);this.sum=0;this.count=0;}
      if(this.samples.length>=1920){const pcm=new ArrayBuffer(this.samples.length*2);const view=new DataView(pcm);let power=0;this.samples.forEach((s,i)=>{const value=Math.max(-1,Math.min(1,s));view.setInt16(i*2,Math.round(value*(value<0?32768:32767)),true);power+=s*s;});this.port.postMessage({pcm,rms:Math.sqrt(power/this.samples.length)},[pcm]);this.samples=[];}
    }
    return true;
  }
}
registerProcessor('pcm-capture',Capture);
