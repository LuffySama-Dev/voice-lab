import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdir} from 'node:fs/promises';
await mkdir('.runtime',{recursive:true});
await mkdir('evidence',{recursive:true});
await promisify(execFile)('/usr/bin/say',['-v','Samantha','-r','140','-o','.runtime/partial-test.aiff','This is a synthetic microphone test. I am speaking a long sentence to check whether draft words appear while the sentence is still being spoken. The screen should revise the draft and keep the finished words only once. No person is being recorded during this test.']);
const started=Date.now();
const child=spawn('./bin/yap-live',['--locale','en-US','--input','.runtime/partial-test.aiff','--realtime']);
let buffer='',inputComplete=false,partials=0,finalized=0,firstPartialMs=null,firstPartialBeforeInputComplete=false,done=false,finalText='';
child.stdout.setEncoding('utf8');
child.stdout.on('data',chunk=>{
  buffer+=chunk;let end;
  while((end=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;
    const event=JSON.parse(line);
    if(event.type==='input_complete')inputComplete=true;
    if(event.type==='snapshot'){
      if(event.draft){partials++;if(firstPartialMs===null){firstPartialMs=Date.now()-started;firstPartialBeforeInputComplete=!inputComplete;console.log(`First native draft: ${firstPartialMs}ms; before audio finished: ${firstPartialBeforeInputComplete}`);}}
      if(event.finalized)finalized++;
    }
    if(event.type==='error')console.log('Native test error: '+event.code);
    if(event.type==='done'){done=true;finalText=event.text;}
  }
});
child.stderr.resume();
const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});clearTimeout(timer);
const proof={synthetic:true,microphoneUsed:false,code,partials,finalized,firstPartialMs,firstPartialBeforeInputComplete,inputComplete,done,finalCharacters:finalText.length,elapsedMs:Date.now()-started};
await writeFile('evidence/native-partials.json',JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify(proof));
assert.equal(code,0);assert.ok(partials>0);assert.ok(firstPartialBeforeInputComplete);assert.ok(done);assert.ok(finalText.toLowerCase().includes('synthetic'));
