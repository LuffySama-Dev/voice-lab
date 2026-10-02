import {spawn,type ChildProcess} from 'node:child_process';
import {CodexReplyClient,type RpcTransport,type CodexRuntime} from './codex.js';
import {mkdir} from 'node:fs/promises';

/** Bounded JSONL transport for the documented app-server stdio interface. Never logs frames. */
export class StdioRpc implements RpcTransport {
  private id=0;
  private pending=new Map<number,{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private listeners=new Set<(method:string,params:Record<string,unknown>)=>void>();
  private buffer='';
  private ended=false;
  constructor(private child:ChildProcess){
    child.stdout?.setEncoding('utf8');child.stdout?.on('data',(chunk:string)=>this.receive(chunk));
    child.stderr?.resume();child.on('error',()=>this.close());child.on('close',()=>this.close());
  }
  private receive(chunk:string){
    if(this.ended)return;
    try{
      this.buffer+=chunk;if(this.buffer.length>1_000_000)throw new Error();let newline;
      while((newline=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);if(!line.trim())continue;
        const frame=JSON.parse(line);
        if(frame.method && frame.id!==undefined){this.close();return;} // No client-executed tools, auth refresh callbacks, or approvals.
        if(typeof frame.id==='number'){
          const waiter=this.pending.get(frame.id);if(!waiter)continue;this.pending.delete(frame.id);clearTimeout(waiter.timer);
          if(frame.error || !frame.result || typeof frame.result!=='object')waiter.reject(new Error('Codex request failed'));
          else waiter.resolve(frame.result);
        }else if(typeof frame.method==='string' && frame.params && typeof frame.params==='object'){
          for(const listener of this.listeners)listener(frame.method,frame.params);
        }else throw new Error();
      }
    }catch{this.close();}
  }
  request(method:string,params:Record<string,unknown>):Promise<Record<string,unknown>>{
    if(this.ended)return Promise.reject(new Error('Codex disconnected'));
    if(!['initialize','account/read','model/list','thread/start','turn/start','turn/interrupt','mcpServerStatus/list'].includes(method))return Promise.reject(new Error('Unsupported Codex operation'));
    const frame=JSON.stringify({id:++this.id,method,params});if(Buffer.byteLength(frame)>64000)return Promise.reject(new Error('Codex request too large'));
    const id=this.id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex request timed out'));this.close();},60000);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin?.write(frame+'\n',error=>{if(error)this.close();});
    });
  }
  initialized(){if(!this.ended)this.child.stdin?.write(JSON.stringify({method:'initialized',params:{}})+'\n');}
  onNotification(listener:(method:string,params:Record<string,unknown>)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  close(){
    if(this.ended)return;this.ended=true;
    for(const waiter of this.pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('Codex disconnected'));}this.pending.clear();
    for(const listener of this.listeners)listener('error',{});this.listeners.clear();
    this.child.stdin?.end();if(this.child.exitCode===null&&!this.child.killed)this.child.kill('SIGTERM');
  }
}

/** Uses the existing supported ChatGPT sign-in; never reads or copies credentials. */
export async function connectCodex(binary:string,cwd:string,signal?:AbortSignal):Promise<StdioRpc>{
  if(signal?.aborted)throw new Error('Cancelled');
  const child=spawn(binary,['app-server','--stdio','-c','forced_login_method="chatgpt"',...['features.shell_tool=false','features.unified_exec=false','features.apps=false','features.plugins=false','features.hooks=false','features.multi_agent=false','features.view_image=false','web_search="disabled"','project_doc_max_bytes=0'].flatMap(value=>['-c',value])],{
    cwd,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,CODEX_HOME:process.env.CODEX_HOME},
  });
  const rpc=new StdioRpc(child);
  const abort=()=>rpc.close();
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  try{await rpc.request('initialize',{clientInfo:{name:'voice_lab',version:'0.1.0'},capabilities:{experimentalApi:true}});if(signal?.aborted)throw new Error('Cancelled');rpc.initialized();return rpc;}
  catch{rpc.close();throw new Error('Codex initialization failed');}
  finally{signal?.removeEventListener('abort',abort);}
}

export async function createCodexClient(binary:string,cwd:string,signal?:AbortSignal,runtime:CodexRuntime={}){
  if(signal?.aborted)throw new Error('Cancelled');
  await mkdir(cwd,{recursive:true,mode:0o700});
  const rpc=await connectCodex(binary,cwd,signal);
  const abort=()=>rpc.close();
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  try{
    const account=await rpc.request('account/read',{refreshToken:false});
    if((account.account as {type?:string}|undefined)?.type!=='chatgpt')throw new Error('ChatGPT sign-in required');
    const inventory=await rpc.request('mcpServerStatus/list',{limit:100,detail:'toolsAndAuthOnly'});
    if(signal?.aborted)throw new Error('Cancelled');
    if(!Array.isArray(inventory.data)||inventory.nextCursor)throw new Error('Incomplete MCP inventory');
    const disabled:Record<string,unknown>={};
    for(const server of inventory.data){if(typeof server.name!=='string')throw new Error('Invalid MCP inventory');disabled[server.name]={enabled:false};}
    return new CodexReplyClient(rpc,cwd,disabled,runtime);
  }catch{rpc.close();throw new Error('Codex setup failed. Check the existing ChatGPT sign-in.');}
  finally{signal?.removeEventListener('abort',abort);}
}
