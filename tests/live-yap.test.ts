import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {recognizeLiveProcess} from '../src/live-yap.js';

const fixture = (mode = '') => spawn(process.execPath, ['tests/fixtures/fake-live-yap.mjs', mode]);
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(10);
  assert.ok(predicate(), 'Expected protocol event within one second');
}
test('live snapshots replace drafts before commit; final waits for clean exit and occurs once', async () => {
  const events: Record<string, unknown>[] = [];
  const child = fixture(); const closed = once(child, 'close');
  const recognition = await recognizeLiveProcess(child, e => events.push(e), new AbortController().signal);
  await until(() => events.length === 3);
  assert.deepEqual(events.map(e => e.draft), ['A draft', 'A revised draft', ' Next']);
  assert.equal(events[2].finalized, 'A revised draft.');
  assert.ok(events.every(e => e.type === 'transcript.snapshot'));
  assert.equal(recognition.native, true);
  recognition.commit(); recognition.commit();
  await delay(20);
  assert.equal(events.some(e => e.type === 'transcript.final'), false);
  await closed;
  assert.deepEqual(events.filter(e => e.type === 'transcript.final'), [{type: 'transcript.final', text: 'A revised draft. Next words.'}]);
});
test('live abort kills capture immediately and never commits a final', async () => {
  const events: Record<string, unknown>[] = [];
  const child = fixture(); const closed = once(child, 'close'); const control = new AbortController();
  await recognizeLiveProcess(child, e => events.push(e), control.signal);
  control.abort(); await closed;
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(events.some(e => e.type === 'transcript.final' || e.type === 'error'), false);
});
test('live readiness is bounded and cancellation during startup rejects', async () => {
  for (const abort of [false, true]) {
    const child = fixture('silent'); const closed = once(child, 'close'); const control = new AbortController();
    const result = recognizeLiveProcess(child, () => {}, control.signal, {startupTimeoutMs: 80});
    if (abort) control.abort();
    await assert.rejects(result, abort ? /Cancelled/ : /unavailable/);
    await closed;
    assert.equal(child.signalCode, 'SIGKILL');
  }
});
test('live invalid frames, oversize output and native errors are sanitized', async () => {
  for (const mode of ['malformed', 'oversized', 'error']) {
    const events: Record<string, unknown>[] = [];
    const child = fixture(mode); const closed = once(child, 'close');
    await recognizeLiveProcess(child, e => events.push(e), new AbortController().signal);
    await closed;
    assert.equal(events.filter(e => e.type === 'error').length, 1);
    assert.ok(!JSON.stringify(events).includes('secret-native-path'));
    assert.ok(!JSON.stringify(events).includes('sensitive malformed'));
    assert.equal(child.signalCode, 'SIGKILL');
  }
});
test('live commit rejects missing completion, failed exit and hung finalization', async () => {
  for (const mode of ['missing-done', 'bad-exit', 'hang']) {
    const events: Record<string, unknown>[] = [];
    const child = fixture(mode); const closed = once(child, 'close');
    const recognition = await recognizeLiveProcess(child, e => events.push(e), new AbortController().signal, {commitTimeoutMs: 150});
    recognition.commit(); await closed;
    assert.equal(events.filter(e => e.type === 'error').length, 1);
    assert.equal(events.some(e => e.type === 'transcript.final'), false);
  }
});

const continuousFixture = (mode = '') => spawn(process.execPath, ['tests/fixtures/fake-continuous-yap.mjs', mode]);
test('continuous revisions reuse segment IDs and commits keep the same capture alive', async () => {
  const events: Record<string, unknown>[] = [];
  const child = continuousFixture(); const closed = once(child, 'close'); const control = new AbortController();
  const recognition = await recognizeLiveProcess(child, e => events.push(e), control.signal, {continuous: true, commitTimeoutMs: 20});
  await until(() => events.length === 7);
  assert.deepEqual(events.filter(e => e.type === 'transcript.segment').map(e => [e.id, e.text, e.final, e.startMs, e.endMs]), [
    [1, 'One', false, 0, 100], [1, 'One revised', false, 0, 200], [1, 'One revised.', true, 0, 200],
    [2, 'Two', false, 300, 400], [2, 'Two.', true, 300, 400],
  ]);
  assert.deepEqual(events.filter(e => e.type === 'audio.activity'), [
    {type: 'audio.activity', rms: 0.125, timeMs: 100, durationMs: 100},
    {type: 'audio.activity', rms: 0, timeMs: 200, durationMs: 100},
  ]);
  recognition.commit(); recognition.commit();
  await delay(50);
  assert.equal(child.killed, false);
  control.abort(); await closed;
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(events.length, 7);
});
test('continuous mode requires advertised readiness and never silently falls back', async () => {
  for (const continuous of [false, true]) {
    const child = continuousFixture(continuous ? 'missing-capability' : ''); const closed = once(child, 'close');
    await assert.rejects(recognizeLiveProcess(child, () => {}, new AbortController().signal, {continuous}), /unavailable/);
    await closed;
    assert.equal(child.signalCode, 'SIGKILL');
  }
});
test('continuous invalid segment and activity metadata fail closed', async () => {
  for (const mode of ['segment-id', 'segment-id-fraction', 'segment-range', 'segment-time-string', 'segment-final', 'segment-reopen', 'segment-overlap',
    'activity-rms', 'activity-negative', 'activity-null', 'activity-time', 'activity-duration', 'activity-zero', 'activity-repeat', 'activity-overlap', 'unexpected-snapshot', 'unexpected-exit']) {
    const events: Record<string, unknown>[] = [];
    const child = continuousFixture(mode); const closed = once(child, 'close');
    await recognizeLiveProcess(child, e => events.push(e), new AbortController().signal, {continuous: true});
    await closed;
    assert.equal(events.filter(e => e.type === 'error').length, 1, mode);
    assert.equal(events.some(e => e.type === 'transcript.final'), false, mode);
  }
});
test('continuous cancellation during startup rejects without publishing late events', async () => {
  const events: Record<string, unknown>[] = [];
  const child = continuousFixture(); const closed = once(child, 'close'); const control = new AbortController();
  const result = recognizeLiveProcess(child, e => events.push(e), control.signal, {continuous: true});
  control.abort();
  await assert.rejects(result, /Cancelled/);
  await closed;
  assert.deepEqual(events, []);
});
