const mode = process.argv[2];
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const keepAlive = setInterval(() => {}, 1000);
process.on('SIGINT', () => {
  if (mode === 'hang') return;
  if (mode !== 'missing-done') send({type: 'done', text: 'A revised draft. Next words.'});
  // Deliberately leave a gap: done must not finalize before clean process exit.
  setTimeout(() => { clearInterval(keepAlive); process.exit(mode === 'bad-exit' ? 1 : 0); }, 60);
});
if (mode !== 'silent') {
  send({type: 'ready'});
  if (mode === 'malformed') process.stdout.write('{sensitive malformed output}\n');
  else if (mode === 'oversized') process.stdout.write('x'.repeat(200001));
  else if (mode === 'error') send({type: 'error', code: 'secret-native-path'});
  else {
    send({type: 'snapshot', finalized: '', draft: 'A draft'});
    send({type: 'snapshot', finalized: '', draft: 'A revised draft'});
    send({type: 'snapshot', finalized: 'A revised draft.', draft: ' Next'});
  }
}
