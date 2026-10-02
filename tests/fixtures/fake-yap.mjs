// Synthetic protocol fixture: no microphone, speech engine, network, or files.
const mode=process.argv[2];
if(mode==='fail'){process.exit(2);}
process.stdout.write('{"metadata":{},"segments":[\n');
process.stdout.write('{"id":1,"start":0,"end":1,"text":"Synthetic first segment"}');
const keepAlive=setInterval(()=>{},1000);
process.on('SIGINT',()=>{process.stdout.write(',\n{"id":2,"start":1,"end":2,"text":"Final words"}\n]}\n');clearInterval(keepAlive);});
