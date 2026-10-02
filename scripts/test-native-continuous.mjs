import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, writeFile} from 'node:fs/promises';

await mkdir('.runtime', {recursive: true});
await mkdir('evidence', {recursive: true});
const input = '.runtime/continuous-synthetic.aiff';
await promisify(execFile)('/usr/bin/say', ['-v', 'Samantha', '-r', '145', '-o', input,
  'This is a synthetic continuous capture test with a pause between two sentences. [[slnc 1600]] The same capture keeps listening for the second sentence and revises its draft words.']);
const child = spawn('./bin/yap-live-continuous', ['--locale', 'en-US', '--continuous', '--input', input, '--realtime']);
let pending = '', ready = false, inputComplete = false, done = false;
let segmentId = 1, revisions = 0, finalSegments = 0, previousSegmentId = 0, finalizedEndMs = 0;
let windows = 0, quietWindows = 0, activeWindows = 0, lastAudioMs = 0, firstSegmentBeforeEnd = false;
let failure;
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  try {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const event = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      if (event.type === 'ready') { assert.equal(ready, false); assert.equal(event.continuous, true); ready = true; continue; }
      assert.equal(ready, true);
      if (event.type === 'audio.activity') {
        assert.ok(Number.isFinite(event.rms) && event.rms >= 0 && event.rms <= 1);
        assert.ok(event.durationMs > 0 && event.durationMs <= 100.001);
        assert.ok(Math.abs(event.timeMs - event.durationMs - lastAudioMs) < 0.01);
        lastAudioMs = event.timeMs; windows++;
        if (event.rms < 0.005) quietWindows++;
        if (event.rms > 0.02) activeWindows++;
      } else if (event.type === 'transcript.segment') {
        assert.equal(event.id, segmentId);
        assert.equal(typeof event.text, 'string'); assert.equal(typeof event.final, 'boolean');
        assert.ok(Number.isFinite(event.startMs) && Number.isFinite(event.endMs));
        assert.ok(event.startMs >= finalizedEndMs - 1 && event.endMs >= event.startMs);
        if (previousSegmentId === event.id) revisions++;
        if (!previousSegmentId) firstSegmentBeforeEnd = !inputComplete;
        previousSegmentId = event.id;
        if (event.final) { finalSegments++; segmentId++; finalizedEndMs = event.endMs; }
      } else if (event.type === 'input_complete') inputComplete = true;
      else if (event.type === 'done') done = true;
      else throw new Error(`Unexpected native event ${event.type}`);
    }
  } catch (error) { failure = error; child.kill('SIGKILL'); }
});
child.stderr.resume();
const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
const [code, signal] = await new Promise((resolve, reject) => { child.once('close', (...args) => resolve(args)); child.once('error', reject); });
clearTimeout(timeout);
if (failure) throw failure;
assert.equal(code, 0); assert.equal(signal, null); assert.equal(pending, '');
assert.ok(ready && done && inputComplete && firstSegmentBeforeEnd);
assert.ok(revisions > 0 && finalSegments >= 2 && windows > 20 && quietWindows > 5 && activeWindows > 5);
const evidence = {synthetic: true, microphoneUsed: false, captureProcesses: 1, code, revisions, finalSegments, windows, quietWindows, activeWindows, audioDurationMs: lastAudioMs, firstSegmentBeforeEnd, done};
await writeFile('evidence/native-continuous.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
