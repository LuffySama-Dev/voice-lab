import assert from 'node:assert/strict';
import test from 'node:test';
import { Delivery, DELIVERY_CUES } from '../src/delivery.js';

function run(chunks: string[]) {
  const parser = new Delivery();
  let display = '';
  const phrases: string[] = [];
  for (const chunk of chunks) {
    const output = parser.add(chunk);
    display += output.display; phrases.push(...output.phrases);
  }
  const output = parser.add('', true);
  display += output.display; phrases.push(...output.phrases);
  return {display, phrases};
}
const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];
const withoutCues = (text: string) => text.replace(/\[(?:warmly|curious|thoughtful|excited|whispers|chuckles)\] /g, '');

test('plain answers have no implicit cues and stream punctuation', () => {
  const parser = new Delivery();
  assert.deepEqual(parser.add('Hello, '), {display:'Hello, ', phrases:['Hello, ']});
  assert.deepEqual(parser.add('how are you'), {display:'how are you', phrases:[]});
  assert.deepEqual(parser.add('?', true), {display:'?', phrases:['how are you?']});
});

test('every two-delta boundary and character streaming preserve canonical words', () => {
  const input = '[[voice:warmly]]Good morning. [[voice:curious]]What would you like to explore?';
  const expected = 'Good morning. What would you like to explore?';
  for (let boundary = 0; boundary <= input.length; boundary++) {
    const output = run([input.slice(0, boundary), input.slice(boundary)]);
    assert.equal(output.display, expected, `display at ${boundary}`);
    assert.deepEqual(words(withoutCues(output.phrases.join(''))), words(expected), `words at ${boundary}`);
    assert.equal(output.phrases.filter(p => p.includes('[warmly]')).length, 1);
    assert.equal(output.phrases.filter(p => p.includes('[curious]')).length, 1);
    assert.ok(output.phrases.every(p => !p.includes('[[voice:')));
  }
  const output = run([...input]);
  assert.equal(output.display, expected);
  assert.deepEqual(words(withoutCues(output.phrases.join(''))), words(expected));
});

test('every whitelisted cue converts only reserved metadata', () => {
  for (const cue of DELIVERY_CUES) {
    const input = `[[voice:${cue}]]Hello.`;
    for (let boundary = 0; boundary <= input.length; boundary++) {
      assert.deepEqual(run([input.slice(0, boundary), input.slice(boundary)]), {display:'Hello.', phrases:[`[${cue}] Hello.`]});
    }
  }
  const literal = 'Keep [curious], [citation: 4], and [[ordinary prose]] in the answer.';
  const output = run([...literal]);
  assert.equal(output.display, literal);
  assert.equal(output.phrases.join(''), literal);
});

test('cues attach to following words and never produce a tag-only utterance', () => {
  const parser = new Delivery();
  assert.deepEqual(parser.add('Hello. [[voice:warmly]]'), {display:'Hello. ', phrases:['Hello. ']});
  assert.deepEqual(parser.add('   '), {display:'   ', phrases:[]});
  assert.deepEqual(parser.add('Welcome.'), {display:'Welcome.', phrases:['[warmly]    Welcome.']});
  assert.deepEqual(parser.add('[[voice:chuckles]]', true), {display:'', phrases:[]});
  assert.deepEqual(run(['[[voice:warmly]]']), {display:'', phrases:[]});
});

test('two-cue cap removes excess metadata without removing answer words', () => {
  const output = run(['[[voice:warmly]]One. [[voice:curious]]Two. [[voice:excited]]Three.']);
  assert.equal(output.display, 'One. Two. Three.');
  assert.equal(output.phrases.join(''), '[warmly] One. [curious] Two. Three.');
});

test('malformed and unknown reserved cues recover without leaking markup', () => {
  for (const invalid of ['unknown', 'WARM', '', 'warm ly', 'warm!']) {
    const input = `Before. [[voice:${invalid}]]After.`;
    for (let boundary = 0; boundary <= input.length; boundary++) {
      const output = run([input.slice(0, boundary), input.slice(boundary)]);
      assert.equal(output.display, 'Before. After.');
      assert.deepEqual(words(output.phrases.join('')), ['Before', 'After']);
    }
  }
  const long = run([...`[[voice:${'x'.repeat(10_000)}]]Recovered.`]);
  assert.deepEqual(long, {display:'Recovered.', phrases:['Recovered.']});
  assert.deepEqual(run(['[[voice:bad text\nRecovered.']), {display:'\nRecovered.', phrases:['\nRecovered.']});
});

test('unterminated reserved metadata is dropped and final flush happens once', () => {
  for (const ending of ['[[v', '[[voice:', '[[voice:war', '[[voice:warmly]', '[[voice:bad text']) {
    const output = run(['Hello. ', ending]);
    assert.equal(output.display, 'Hello. ');
    assert.equal(output.phrases.join(''), 'Hello. ');
  }
  const parser = new Delivery();
  parser.add('[[voice:thoughtful]]Let me think');
  assert.deepEqual(parser.add('', true), {display:'', phrases:['[thoughtful] Let me think']});
  assert.deepEqual(parser.add('', true), {display:'', phrases:[]});
  assert.deepEqual(parser.add('late packet'), {display:'', phrases:[]});
});

test('cancellation reset discards pending text and split metadata', () => {
  for (const pending of ['[[voice:war', '[[voice:warmly]]Uncommitted words', '[[voice:invalid long metadata']) {
    const parser = new Delivery();
    parser.add(pending);
    parser.reset();
    assert.deepEqual(parser.add('Fresh response.', true), {display:'Fresh response.', phrases:['Fresh response.']});
  }
});

test('long clauses commit at word boundaries without splitting literal brackets', () => {
  const plain = 'A useful thought '.repeat(20) + 'ends here.';
  const output = run([...`[[voice:thoughtful]]${plain}`]);
  assert.equal(output.display, plain);
  assert.deepEqual(words(withoutCues(output.phrases.join(''))), words(plain));
  assert.ok(output.phrases.length >= 2);
  const literal = `Example [${'some text '.repeat(20)}] is retained.`;
  assert.equal(run([...literal]).phrases.join(''), literal);
});

test('a reaction remains at its canonical position inside a phrase', () => {
  const output = run([..."That was unexpected [[voice:chuckles]]but I can help."]);
  assert.equal(output.display, 'That was unexpected but I can help.');
  assert.equal(output.phrases.join(''), 'That was unexpected [chuckles] but I can help.');
  assert.deepEqual(words(withoutCues(output.phrases.join(''))), words(output.display));
});


test('embedded cues never split words at any delta boundary', () => {
  for (const [input, expected] of [
    ['un[[voice:warmly]]usual.', 'unusual.'],
    ['dé[[voice:thoughtful]]jà.', 'déjà.'],
    ["can[[voice:warmly]]'t.", "can't."],
    ['re-[[voice:curious]]enter.', 're-enter.'],
  ]) {
    const chunks = [...Array.from({length:input.length + 1}, (_, boundary) => [input.slice(0, boundary), input.slice(boundary)]), [...input]];
    for (const partition of chunks) {
      const output = run(partition);
      assert.equal(output.display, expected);
      assert.equal(output.phrases.join(''), expected);
    }
  }
});
