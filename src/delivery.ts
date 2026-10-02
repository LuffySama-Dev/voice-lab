/** Delivery metadata is deliberately distinct from ordinary bracketed answer text. */
export const DELIVERY_CUES = ['warmly', 'curious', 'thoughtful', 'excited', 'whispers', 'chuckles'] as const;
export type DeliveryCue = typeof DELIVERY_CUES[number];
export interface DeliveryOutput { display: string; phrases: string[] }
const PREFIX = '[[voice:';
const MAX_MARKER_BODY = 24;

/**
 * Parse one canonical answer into display text and committed speech phrases.
 * Only reserved [[voice:cue]] metadata is removed from the display. Invalid or
 * incomplete reserved metadata is discarded; ordinary bracketed prose survives.
 * A malformed reserved marker recovers at its closing ]] or a newline, retaining
 * at most a closing-bracket lookbehind. Call reset on cancellation, or discard
 * this per-response instance. Calling add after finalization has no effect.
 */
export class Delivery {
  private pending = '';
  private discarding = false;
  private closed = false;
  private cueCount = 0;
  private speech = '';
  private cues: { offset: number; name: DeliveryCue }[] = [];

  reset() {
    this.pending = ''; this.discarding = false; this.closed = false;
    this.cueCount = 0; this.speech = ''; this.cues = [];
  }

  add(delta: string, final = false): DeliveryOutput {
    const result: DeliveryOutput = { display: '', phrases: [] };
    if (this.closed) return result;
    this.pending += delta;
    const plain = (text: string) => { result.display += text; this.speech += text; };
    while (this.pending) {
      if (this.discarding) {
        const boundary = /\]\]|\n/.exec(this.pending);
        if (boundary) {
          this.pending = this.pending.slice(boundary.index + (boundary[0] === '\n' ? 0 : 2));
          this.discarding = false;
          continue;
        }
        this.pending = this.pending.endsWith(']') ? ']' : '';
        break;
      }
      const start = this.pending.indexOf('[[');
      if (start < 0) {
        const end = !final && this.pending.endsWith('[') ? this.pending.length - 1 : this.pending.length;
        plain(this.pending.slice(0, end)); this.pending = this.pending.slice(end);
        break;
      }
      if (start > 0) {
        plain(this.pending.slice(0, start)); this.pending = this.pending.slice(start);
      }
      if (PREFIX.startsWith(this.pending)) {
        // An unfinished reserved prefix is never leaked to the voice provider.
        if (final) this.pending = '';
        break;
      }
      if (!this.pending.startsWith(PREFIX)) {
        plain(this.pending[0]); this.pending = this.pending.slice(1);
        continue;
      }
      const body = this.pending.slice(PREFIX.length);
      const end = body.indexOf(']]');
      if (end >= 0 && end <= MAX_MARKER_BODY && /^[a-z]+$/.test(body.slice(0, end))) {
        const name = body.slice(0, end);
        if (this.cueCount < 2 && DELIVERY_CUES.includes(name as DeliveryCue)) {
          this.cues.push({offset: this.speech.length, name: name as DeliveryCue});
          this.cueCount++;
        }
        this.pending = body.slice(end + 2);
        continue;
      }
      if (end < 0 && body.length <= MAX_MARKER_BODY && /^[a-z]*\]?$/.test(body)) {
        if (final) this.pending = '';
        break;
      }
      // Discard only the reserved metadata; do not reinterpret it as prose.
      this.pending = body;
      this.discarding = true;
    }
    result.phrases = this.commit(final);
    if (final) {
      this.closed = true; this.pending = ''; this.discarding = false;
      this.speech = ''; this.cues = [];
    }
    return result;
  }

  private commit(final: boolean): string[] {
    const phrases: string[] = [];
    while (this.speech) {
      let depth = 0;
      let end = -1;
      let wordBoundary = -1;
      for (let i = 0; i < this.speech.length; i++) {
        const char = this.speech[i];
        if (char === '[') depth++;
        if (char === ']' && depth > 0) depth--;
        if (depth) continue;
        if (/\s/.test(char) && i <= 150) wordBoundary = i + 1;
        if (/[.!?;:,]/.test(char) && (i + 1 === this.speech.length || /\s/.test(this.speech[i + 1]))) {
          end = i + 1;
          while (end < this.speech.length && /\s/.test(this.speech[end])) end++;
          break;
        }
      }
      if (end < 0 && this.speech.length > 150) end = wordBoundary;
      if (end <= 0) { if (final) end = this.speech.length; else break; }
      const text = this.speech.slice(0, end);
      let phrase = '';
      let position = 0;
      const remaining: typeof this.cues = [];
      for (const cue of this.cues) {
        if (cue.offset < end && /[\p{L}\p{N}]/u.test(text.slice(cue.offset))) {
          // Wait until emission to inspect both sides: the following word may
          // arrive in a later delta. Metadata must never split a spoken word.
          const insideWord = /[\p{L}\p{N}\p{M}_'’−-]$/u.test(text.slice(0, cue.offset))
            && /^[\p{L}\p{N}\p{M}_'’−-]/u.test(text.slice(cue.offset));
          if (insideWord) continue;
          phrase += text.slice(position, cue.offset) + `[${cue.name}] `;
          position = cue.offset;
        } else remaining.push({...cue, offset: Math.max(0, cue.offset - end)});
      }
      phrase += text.slice(position);
      this.cues = remaining;
      this.speech = this.speech.slice(end);
      if (text.trim()) phrases.push(phrase);
    }
    return phrases;
  }
}
