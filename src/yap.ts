import {spawn, type ChildProcess} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import type {Emit, Recognition} from './core.js';
import {LiveProviders,type Config} from './providers.js';

/** YAP emits a pretty-printed JSON document incrementally, not NDJSON. */
export class YapSegments {
  private document='';
  private cursor=0;
  private started=false;
  add(chunk: string): string[] {
    this.document+=chunk;
    if(this.document.length>100_000)throw new Error('Transcript too long');
    if(!this.started){const start=/"segments"\s*:\s*\[/.exec(this.document);if(!start)return [];this.cursor=start.index+start[0].length;this.started=true;}
    const texts:string[]=[];
    while(this.cursor<this.document.length){
      while(/[\s,]/.test(this.document[this.cursor] || '')&&this.cursor<this.document.length)this.cursor++;
      if(this.document[this.cursor]!=='{')break;
      let depth=0,quoted=false,escaped=false,end=-1;
      for(let i=this.cursor;i<this.document.length;i++){
        const c=this.document[i];
        if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
        else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}
      }
      if(end<0)break;
      const segment=JSON.parse(this.document.slice(this.cursor,end));
      if(typeof segment.text!=='string')throw new Error('Invalid segment');
      texts.push(segment.text);this.cursor=end;
    }
    return texts;
  }
  finish(): string {
    const document=JSON.parse(this.document);
    if(!Array.isArray(document.segments))throw new Error('Invalid YAP output');
    return document.segments.map((s:{text:unknown})=>{if(typeof s.text!=='string')throw new Error('Invalid segment');return s.text;}).join(' ').trim();
  }
}
let previousClosed:Promise<void>=Promise.resolve();
export async function yapAvailable(path:string){try{await access(path,constants.X_OK);return true;}catch{return false;}}
export class YapProviders extends LiveProviders {
  constructor(config:Config,private binary:string,private locale:string){super(config);}
  override async recognize(emit:Emit,signal:AbortSignal):Promise<Recognition>{
    await previousClosed;
    if(signal.aborted)throw new Error('Cancelled');
    if(!await yapAvailable(this.binary))throw new Error('YAP missing');
    if(signal.aborted)throw new Error('Cancelled');
    // No shell, no API secrets in the native child's environment, no output files.
    const child=spawn(this.binary,['dictate','--json','--locale',this.locale],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG || 'en_US.UTF-8'}});
    return recognizeProcess(child,emit,signal);
  }
}
/** Exported for subprocess protocol tests using a synthetic CLI fixture. */
export async function recognizeProcess(child:ChildProcess,emit:Emit,signal:AbortSignal):Promise<Recognition>{
  const parser=new YapSegments();let committing=false,cancelled=false,ended=false;
  let deadline:ReturnType<typeof setTimeout>|undefined;
  let resolveClosed:()=>void;
  previousClosed=new Promise<void>(resolve=>{resolveClosed=resolve;});
  const cancel=()=>{cancelled=true;clearTimeout(deadline);if(!ended)child.kill('SIGKILL');};
  const failure=()=>{if(!cancelled)emit({type:'error',message:'YAP stopped unexpectedly. Check native microphone permission, language assets, and YAP setup in README.'});cancel();};
  signal.addEventListener('abort',cancel,{once:true});
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data',(chunk:string)=>{if(cancelled)return;try{for(const text of parser.add(chunk))emit({type:'transcript.delta',text:text+' '});}catch{failure();}});
  // Never relay stderr: it can contain user data or internal paths.
  child.stderr?.resume();
  child.on('error',failure);
  child.on('close',code=>{
    ended=true;clearTimeout(deadline);resolveClosed();signal.removeEventListener('abort',cancel);
    if(cancelled)return;
    if(!committing||code!==0){failure();return;}
    try{emit({type:'transcript.final',text:parser.finish()});}catch{failure();}
  });
  await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('YAP cannot start')));});
  if(signal.aborted){cancel();throw new Error('Cancelled');}
  return {native:true,append:()=>{},commit:()=>{if(committing||cancelled)return;committing=true;child.kill('SIGINT');deadline=setTimeout(failure,15_000);},cancel};
}
