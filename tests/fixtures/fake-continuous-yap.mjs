const mode = process.argv[2];
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
setInterval(() => {}, 1000);
process.on('SIGINT', () => send({type: 'error', code: 'unexpected-conversational-commit'}));
send({type: 'ready', continuous: mode !== 'missing-capability'});
const segment = {type: 'transcript.segment', id: 1, text: 'One', final: false, startMs: 0, endMs: 100};
const activity = {type: 'audio.activity', rms: 0.125, timeMs: 100, durationMs: 100};
switch (mode) {
  case 'missing-capability': break;
  case 'segment-id': send({...segment, id: 2}); break;
  case 'segment-id-fraction': send({...segment, id: 1.5}); break;
  case 'segment-range': send({...segment, startMs: 101}); break;
  case 'segment-time-string': send({...segment, startMs: '0'}); break;
  case 'segment-final': send({...segment, final: 'false'}); break;
  case 'segment-reopen': send({...segment, final: true}); send(segment); break;
  case 'segment-overlap': send({...segment, final: true}); send({...segment, id: 2}); break;
  case 'activity-rms': send({...activity, rms: 1.1}); break;
  case 'activity-negative': send({...activity, rms: -0.1}); break;
  case 'activity-null': send({...activity, rms: null}); break;
  case 'activity-time': send({...activity, timeMs: 99}); break;
  case 'activity-duration': send({...activity, timeMs: 1000, durationMs: 1000}); break;
  case 'activity-zero': send({...activity, durationMs: 0}); break;
  case 'activity-repeat': send(activity); send(activity); break;
  case 'activity-overlap': send(activity); send({...activity, timeMs: 150}); break;
  case 'unexpected-snapshot': send({type: 'snapshot', finalized: '', draft: ''}); break;
  case 'unexpected-exit': setTimeout(() => process.exit(0), 10); break;
  default:
    send(activity);
    send(segment);
    send({...segment, text: 'One revised', endMs: 200});
    send({...activity, rms: 0, timeMs: 200});
    send({...segment, text: 'One revised.', final: true, endMs: 200});
    send({...segment, id: 2, text: 'Two', startMs: 300, endMs: 400});
    send({...segment, id: 2, text: 'Two.', final: true, startMs: 300, endMs: 400});
}
