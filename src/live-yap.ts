import {spawn, type ChildProcess} from 'node:child_process';
import {isAbsolute} from 'node:path';
import type {Emit, Recognition} from './core.js';
import {LiveProviders, type Config} from './providers.js';
import {yapAvailable} from './yap.js';

let previousClosed: Promise<void> = Promise.resolve();
let launchQueue: Promise<void> = Promise.resolve();
const failureMessage = 'Live local transcription stopped. Check microphone permission, language assets, and the local helper setup, then start again.';

export class LiveYapProviders extends LiveProviders {
  constructor(config: Config, private binary: string, private locale: string, private liveOptions: {continuous?: boolean} = {}) { super(config); }
  override recognize(emit: Emit, signal: AbortSignal): Promise<Recognition> {
    // Reserve launch order before any asynchronous availability check.
    const result = launchQueue.then(async () => {
      await previousClosed;
      if (signal.aborted) throw new Error('Cancelled');
      if (!isAbsolute(this.binary) || !await yapAvailable(this.binary)) throw new Error('Local helper unavailable');
      if (signal.aborted) throw new Error('Cancelled');
      const child = spawn(this.binary, ['--locale', this.locale, ...(this.liveOptions.continuous ? ['--continuous'] : [])], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'en_US.UTF-8'},
      });
      return recognizeLiveProcess(child, emit, signal, this.liveOptions);
    });
    launchQueue = result.then(() => {}, () => {});
    return result;
  }
}

/** Bounded NDJSON: legacy snapshots finalize on clean exit; continuous segments stay live until cancellation. */
export function recognizeLiveProcess(
  child: ChildProcess, emit: Emit, signal: AbortSignal,
  options: {startupTimeoutMs?: number; commitTimeoutMs?: number; continuous?: boolean} = {},
): Promise<Recognition> {
  let ready = false, committing = false, cancelled = false, ended = false, failed = false;
  let pending = '', completedText: string | undefined;
  let segmentId = 1, finalizedEndMs = 0, activityTimeMs = 0;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed: () => void = () => {};
  previousClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let resolveReady: (recognition: Recognition) => void;
  let rejectReady: (error: Error) => void;
  const result = new Promise<Recognition>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const clearTimers = () => { clearTimeout(startupTimer); clearTimeout(commitTimer); };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    clearTimers();
    if (!ended) child.kill('SIGKILL');
    if (!ready) rejectReady(new Error('Cancelled'));
  };
  const fail = () => {
    if (failed || cancelled) return;
    failed = true;
    // Neither arbitrary native error codes nor stderr can reach the UI/logs.
    if (!ready) rejectReady(new Error('Local transcription unavailable'));
    cancel();
    emit({type: 'error', message: failureMessage});
  };
  const recognition: Recognition = {
    native: true,
    append: () => {},
    commit: () => {
      // Conversational boundaries never finalize or replace a continuous capture.
      if (options.continuous) return;
      if (committing || cancelled || ended) return;
      committing = true;
      commitTimer = setTimeout(fail, options.commitTimeoutMs ?? 15_000);
      if (!child.kill('SIGINT')) fail();
    },
    cancel,
  };
  const accept = (line: string) => {
    const frame: unknown = JSON.parse(line);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid frame');
    const event = frame as Record<string, unknown>;
    if (event.type === 'error') { fail(); return; }
    if (completedText !== undefined) throw new Error('Frame after completion');
    if (event.type === 'ready') {
      if (ready || (options.continuous ? event.continuous !== true : event.continuous === true)) throw new Error('Invalid readiness');
      ready = true;
      clearTimeout(startupTimer);
      resolveReady(recognition);
    } else if (event.type === 'transcript.segment') {
      const {id, text, final, startMs, endMs} = event;
      if (!ready || !options.continuous || !Number.isSafeInteger(id) || id !== segmentId ||
          typeof text !== 'string' || text.length > 100_000 || typeof final !== 'boolean' ||
          !finiteNonnegative(startMs) || !finiteNonnegative(endMs) || endMs < startMs || startMs < finalizedEndMs - 1) throw new Error('Invalid segment');
      emit({type: 'transcript.segment', id, text, final, startMs, endMs});
      if (final) { segmentId++; finalizedEndMs = endMs; }
    } else if (event.type === 'audio.activity') {
      const {rms, timeMs, durationMs} = event;
      if (!ready || !options.continuous || !finiteNonnegative(rms) || rms > 1 ||
          !finiteNonnegative(timeMs) || timeMs <= activityTimeMs || !finiteNonnegative(durationMs) ||
          durationMs <= 0 || durationMs > 250 || timeMs < durationMs || timeMs - durationMs < activityTimeMs - 1) throw new Error('Invalid activity');
      activityTimeMs = timeMs;
      emit({type: 'audio.activity', rms, timeMs, durationMs});
    } else if (event.type === 'snapshot') {
      if (!ready || options.continuous || typeof event.finalized !== 'string' || typeof event.draft !== 'string' || event.finalized.length + event.draft.length > 100_000) throw new Error('Invalid snapshot');
      emit({type: 'transcript.snapshot', finalized: event.finalized, draft: event.draft});
    } else if (event.type === 'done') {
      if (!ready || !committing || typeof event.text !== 'string' || event.text.length > 100_000) throw new Error('Invalid completion');
      completedText = event.text;
    } else throw new Error('Unknown frame');
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (cancelled) return;
    try {
      pending += chunk;
      if (pending.length > 1_000_000) throw new Error('Oversized output');
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length > 200_000) throw new Error('Oversized frame');
        if (line) accept(line);
        if (cancelled) break;
      }
      if (pending.length > 200_000) throw new Error('Oversized frame');
    } catch { fail(); }
  });
  child.stderr?.resume();
  child.on('error', fail);
  child.on('close', (code, exitSignal) => {
    ended = true;
    clearTimers();
    resolveClosed();
    signal.removeEventListener('abort', cancel);
    if (cancelled) return;
    if (pending.trim() || !committing || code !== 0 || exitSignal || completedText === undefined) { fail(); return; }
    emit({type: 'transcript.final', text: completedText});
  });
  signal.addEventListener('abort', cancel, {once: true});
  const startupTimer = setTimeout(fail, options.startupTimeoutMs ?? 30_000);
  if (signal.aborted) cancel();
  return result;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
