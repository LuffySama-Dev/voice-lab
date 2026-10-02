import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new Error('QA forbids real microphone');};});await page.goto('/');await expect(page.getByRole('button',{name:'Start session'})).toBeEnabled();});
test('demo streams, interrupts, stops and restarts repeatedly without mic or provider traffic',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const external:string[]=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4318'))external.push(r.url());});
  await page.getByRole('button',{name:'Start session'}).click();await expect(page.locator('#status')).toHaveText('The demo is ready');
  await page.getByRole('button',{name:'Send demo message'}).click();await expect(page.locator('#response')).toContainText('This is a local');await expect(page.locator('#phrase-count')).toContainText('committed phrase');
  await page.getByRole('button',{name:'Emergency mute'}).click();await expect(page.locator('#status')).toHaveText('Muted. Session ended.');const text=await page.locator('#response').textContent();await page.waitForTimeout(800);expect(await page.locator('#response').textContent()).toBe(text);
  for(let i=0;i<5;i++){await page.getByRole('button',{name:'Start session'}).click();await expect(page.locator('#status')).toHaveText('The demo is ready');await page.getByRole('button',{name:'Stop',exact:false}).click();await expect(page.locator('#status')).toHaveText('Ready when you are');}
  expect(errors).toEqual([]);expect(external).toEqual([]);
});
test('missing credentials gives actionable message before microphone access',async({page})=>{await page.route('**/api/config',async route=>{const response=await route.fetch();await route.fulfill({json:{...await response.json(),paidServicesEnabled:true}});});await page.reload();await page.getByRole('button',{name:'Live voice',exact:true}).click();await page.getByRole('button',{name:'Start session'}).click();await expect(page.getByRole('alert')).toContainText('Live setup is incomplete');await expect(page.locator('#status')).toHaveText('Ready when you are');await expect(page.locator('#notice')).toContainText('API charges');});
test('new turn cancels old generation and Escape terminates session',async({page})=>{await page.getByRole('button',{name:'Start session'}).click();await expect(page.locator('#status')).toHaveText('The demo is ready');await page.getByRole('button',{name:'Send demo message'}).click();await expect(page.locator('#response')).toContainText('This');await page.locator('#demo-text').fill('Replacement turn');await page.getByRole('button',{name:'Send demo message'}).click();await expect(page.locator('#transcript')).toHaveText('Replacement turn');await expect(page.locator('#status')).toHaveText('The demo is ready',{timeout:10000});await expect(page.locator('#response')).toHaveText('This is a local demonstration of the conversation flow. In live mode, I will respond using your chosen cloned voice. You can interrupt me at any time with the controls below. ');await page.keyboard.press('Escape');await expect(page.locator('#status')).toHaveText('Muted. Session ended.');});
test('desktop and narrow layouts remain usable',async({page})=>{await page.screenshot({path:'evidence/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await expect(page.getByRole('button',{name:'Start session'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'evidence/mobile.png',fullPage:true});});
test('audio queue is cleared immediately, including partial PCM carry',async({page})=>{
  const result=await page.evaluate(async()=>{
    // @ts-expect-error Browser imports this native module from the local server.
    const {Player}=await import('/audio.js');const player=new Player();await player.unlock();
    player.add(btoa(String.fromCharCode(0)),24000);const carryBefore=player.carry;
    player.add(btoa(String.fromCharCode(0).repeat(48000)),24000);const queued=player.sources.size;
    player.clear();const after={sources:player.sources.size,remaining:player.remaining,carry:player.carry};player.close();return {carryBefore,queued,after};
  });
  expect(result.carryBefore).toBe(0);expect(result.queued).toBe(1);expect(result.after).toEqual({sources:0,remaining:0,carry:null});
});
test('stop during pending microphone permission discards late stream',async({page})=>{
  const result=await page.evaluate(async()=>{
    // @ts-expect-error Browser imports this native module from the local server.
    const {Microphone}=await import('/audio.js');let release:(s:unknown)=>void=()=>{};let stopped=0;
    navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{release=resolve;});
    const mic=new Microphone();const pending=mic.start(()=>{});mic.stop();release({getTracks:()=>[{stop:()=>stopped++}]});const started=await pending;return {started,stopped,context:mic.context};
  });expect(result).toEqual({started:false,stopped:1,context:null});
});
test('localhost access checks reject hostile host and cross-origin websocket',async({page,request})=>{
  const response=await request.get('/',{headers:{Host:'hostile.example:4318'}});expect(response.status()).toBe(403);
  const response2=await request.get('/.env');expect(response2.status()).toBe(404);
  const config=await (await request.get('/api/config')).json();expect(Object.keys(config)).not.toContain('openaiKey');
  const {WebSocket}=await import('ws');
  const rejected=await new Promise<number>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:4318/session?token=${config.token}`,{origin:'https://hostile.example'});ws.on('unexpected-response',(_r,r)=>{resolve(r.statusCode||0);ws.terminate();});ws.on('error',()=>{});ws.on('open',()=>{ws.close();reject(new Error('Hostile origin accepted'));});});expect(rejected).toBe(403);
  await expect(page.locator('#status')).toHaveText('Ready when you are');
});
test('local microphone mode shows capture, final text and Stop without cloud setup (mock capture)',async({page})=>{
  await page.route('**/api/config',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{...data,localMicEnabled:true,paidServicesEnabled:false}});});
  const messages:string[]=[];
  await page.routeWebSocket('**/session?*',ws=>{ws.onMessage(raw=>{const e=JSON.parse(String(raw));messages.push(e.type);if(e.type==='start'){expect(e.mode).toBe('local');ws.send(JSON.stringify({type:'status',state:'listening',epoch:1}));ws.send(JSON.stringify({type:'transcript.delta',text:'A synthetic local transcript',epoch:1}));}if(e.type==='commit'){ws.send(JSON.stringify({type:'transcription.done',text:'A synthetic local transcript.',epoch:1}));ws.send(JSON.stringify({type:'status',state:'local-ready',epoch:1}));}});});
  await page.goto('/?mode=local');await expect(page.locator('#notice')).toContainText('Audio and text stay local');await page.getByRole('button',{name:'Start session'}).click();await expect(page.locator('#recording')).toBeVisible();await expect(page.locator('#transcript')).toContainText('synthetic local');await expect(page.locator('#response')).toContainText('disabled');await page.getByRole('button',{name:'Stop',exact:false}).click();await expect(page.locator('#status')).toHaveText('Transcript complete');await expect(page.locator('#recording')).toBeHidden();expect(messages).toContain('stop');
});
test('live drafts replace earlier hypotheses and final words appear exactly once',async({page})=>{
  await page.route('**/api/config',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{...data,localMicEnabled:true,localPartials:true,paidServicesEnabled:false}});});
  let snapshot:(finalized:string,draft:string)=>void=()=>{};
  await page.routeWebSocket('**/session?*',ws=>{snapshot=(finalized,draft)=>ws.send(JSON.stringify({type:'transcript.snapshot',finalized,draft,epoch:1}));ws.onMessage(raw=>{const e=JSON.parse(String(raw));if(e.type==='start'){ws.send(JSON.stringify({type:'status',state:'listening',epoch:1}));snapshot('Hello, ','their');}if(e.type==='commit')ws.send(JSON.stringify({type:'transcription.done',text:'Hello, there. A second sentence.',epoch:1}));});});
  await page.goto('/?mode=local');await page.getByRole('button',{name:'Start session'}).click();await expect(page.locator('.draft-text')).toHaveText('their');await expect(page.locator('#transcript-state')).toContainText('LIVE DRAFT');
  snapshot('Hello, ','there.');await expect(page.locator('#transcript')).toHaveText('Hello, there.');await expect(page.locator('#transcript')).not.toContainText('their');
  snapshot('Hello, there. ','A second');await expect(page.locator('.finalized-text')).toHaveText('Hello, there. ');await expect(page.locator('.draft-text')).toHaveText('A second');
  snapshot('Hello, there. A second sentence.','');await expect(page.locator('#transcript')).toHaveText('Hello, there. A second sentence.');await expect(page.locator('#transcript-state')).toHaveText('FINALIZED TEXT');
  await page.getByRole('button',{name:'Stop',exact:false}).click();await expect(page.locator('#transcript')).toHaveText('Hello, there. A second sentence.');await expect(page.locator('#status')).toHaveText('Transcript complete');
});

test('paid services default off and are rejected before capture',async({page,request})=>{const config=await(await request.get('/api/config')).json();expect(config.paidServicesEnabled).toBe(false);await page.getByRole('button',{name:'Live voice',exact:true}).click();await page.getByRole('button',{name:'Start session'}).click();await expect(page.getByRole('alert')).toContainText('Paid services are OFF');const {WebSocket}=await import('ws');const message=await new Promise<string>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:4318/session?token=${config.token}`,{origin:'http://127.0.0.1:4318'});ws.on('open',()=>ws.send(JSON.stringify({type:'start',mode:'live'})));ws.on('message',raw=>{const event=JSON.parse(raw.toString());if(event.type==='error'){ws.close();resolve(event.message);}});ws.on('error',reject);});expect(message).toContain('Paid services are disabled');});
