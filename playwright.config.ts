import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'tests/ui',workers:1,reporter:'list',
  use:{baseURL:'http://127.0.0.1:4318',channel:'chrome',headless:true,viewport:{width:1440,height:1100}},
  webServer:{
    command:'node --import tsx src/server.ts',
    env:{
      PORT:'4318',YAP_READY:'0',LOCAL_MIC_ENABLED:'0',
      PAID_SERVICES_ENABLED:'',
      OPENAI_API_KEY:'',
      ELEVENLABS_API_KEY:'',
      ELEVENLABS_VOICE_ID:'',
    },
    url:'http://127.0.0.1:4318',reuseExistingServer:false,
  },timeout:20000,
});
