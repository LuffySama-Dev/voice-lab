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
