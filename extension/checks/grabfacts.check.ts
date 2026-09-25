/**
 * Grab-history fact checks.
 *
 * The Insights tab was reading 18 files of unknown kind and three domains of
 * zero bytes, and the cause was a merge that never happened: the in-page
 * button sent no facts at all, and nothing filled them in from the response
 * headers the background had already seen. The rules that fix it are small and
 * easy to invert by tidying — "sender wins" and "null is not an answer" look
 * like the same rule until a candidate carries an explicit null.
 *
 *   npm run check
 */

import { mergeGrabFacts } from '../src/common/grab_facts';

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`);
}

function group(name: string, fn: () => void): void {
  console.log('\n' + name);
  fn();
}

group('the log fills what the sender did not know', () => {
  const out = mergeGrabFacts(
    { kind: 'image', origin: 'dom', width: 1200, height: 800 },
    { kind: 'other', mime: 'image/jpeg', bytes: 240_000, score: 310 },
  );
  ok('the transfer size arrives from the log', out.bytes === 240_000, String(out.bytes));
  ok('so does the mime', out.mime === 'image/jpeg', String(out.mime));
  ok('so does the score', out.score === 310, String(out.score));
});

group('the sender wins wherever it spoke', () => {
  const out = mergeGrabFacts(
    { kind: 'video', width: 1920, height: 1080 },
    { kind: 'image', width: 64, height: 64, bytes: 900 },
  );
  ok('a stated kind is not overwritten', out.kind === 'video', String(out.kind));
  ok('decoded dimensions beat the log', out.width === 1920, String(out.width));
});

group('null is unknown, not an answer', () => {
  // The sidebar builds facts from a candidate whose bytes may be null; taking
  // that as a stated zero throws away the Content-Length the log has.
  const out = mergeGrabFacts(
    { kind: 'image', bytes: null, mime: null },
    { bytes: 51_200, mime: 'image/webp' },
  );
  ok('a null size is filled', out.bytes === 51_200, String(out.bytes));
  ok('a null mime is filled', out.mime === 'image/webp', String(out.mime));
});

group('a missing side is not a failure', () => {
  ok('no log at all still records what was sent',
    mergeGrabFacts({ kind: 'image' }, undefined).kind === 'image');
  ok('no facts at all still takes the log',
    mergeGrabFacts(undefined, { kind: 'video', bytes: 12 }).bytes === 12);
  ok('neither side leaves an empty object',
    Object.keys(mergeGrabFacts(undefined, undefined)).length === 0);
});

group('the merge does not mutate its inputs', () => {
  const sent = { kind: 'image' };
  mergeGrabFacts(sent, { bytes: 10 });
  ok('the sender object is untouched', (sent as any).bytes === undefined);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
