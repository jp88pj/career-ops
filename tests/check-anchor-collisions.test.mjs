// The anchor-collision lint must FAIL on a real collision, not just pass.
//
// MEASURED 2026-10-10: five separate anchor collisions in one session, each found
// by a throwaway script written after the fact, twice while writing the notes that
// document the previous fix. `verify-bullet-sources.mjs` already detects ambiguity
// correctly - but only against a PAYLOAD, so the failure was always discovered once
// it was already load-bearing. These tests pin the preflight.
//
// NOTE ON THE FIRST TEST: its first draft used a SUBSTRING of a real anchor
// ("radio dispatch to supervisors") rather than the anchor itself
// ("worked by **radio dispatch to supervisors**"). The tainted line did not contain
// the full anchor, nothing collided, and the lint correctly reported "pass" - so the
// test asserted nothing and failed. Anchors carry bold markers and leading words, so
// a fixture built from a partial phrase proves nothing. It now uses the anchor
// verbatim, read out of _custom.md at runtime rather than retyped, so it cannot rot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkAnchors, parseAnchors } from '../check-anchor-collisions.mjs';
import { resolveAnchor } from '../verify-bullet-sources.mjs';

const CV = readFileSync(new URL('../cv.md', import.meta.url), 'utf8');
const CUSTOM = readFileSync(new URL('../modes/_custom.md', import.meta.url), 'utf8');

// Pulled from the live anchor table, never retyped - a hardcoded copy would drift
// the first time someone edits that row, and a test that quietly stops reproducing
// its defect is the failure this whole tool exists to prevent.
const P2_ANCHOR = parseAnchors(CUSTOM).find((a) => a.id === 'P2')?.anchor;
assert.ok(P2_ANCHOR, 'P2 must have at least one anchor for this test to be meaningful');

test('a quoted anchor FAILS - the exact defect this was built for', () => {
  const tainted = `${CV}\n- A new note that quotes: ${P2_ANCHOR}\n`;
  const r = checkAnchors(CUSTOM, tainted);
  assert.equal(r.verdict, 'fail', 'the lint must fail when cv.md quotes an anchor verbatim');
  const hit = r.ambiguous.find((a) => a.anchor === P2_ANCHOR);
  assert.ok(hit, `the quoted anchor must be reported ambiguous; got ${JSON.stringify(r.ambiguous)}`);
  assert.equal(hit.lines, 2, 'exactly two lines should match after one quotation');
});

test('the UNTAINTED files pass - otherwise the lint is broken, not the files', () => {
  const r = checkAnchors(CUSTOM, CV);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.ambiguous.length, 0);
  assert.equal(r.missing.length, 0);
  assert.ok(r.checked > 40, `expected the real anchor set; got ${r.checked}`);
});

test('ambiguous and missing are classified separately - they need different fixes', () => {
  // Conflating them sends you to reword the anchor when you should reword cv.md.
  const custom = '| Z1 | covers it | `a phrase that is nowhere in cv.md at all` |\n';
  const r = checkAnchors(custom, CV);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.ambiguous.length, 0, 'a zero-match anchor is missing, not ambiguous');
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].id, 'Z1');
});

test('the lint agrees with the shipped gate about what matches, and why', () => {
  // The lint imports resolveAnchor precisely so the two cannot drift. If someone
  // reimplements matching, this is what catches it.
  const tainted = [...CV.split(/\r?\n/), `- note quoting ${P2_ANCHOR}`];
  const fromGate = resolveAnchor(tainted, 'source_anchor', P2_ANCHOR);
  const fromLint = checkAnchors(`| Z1 | x | \`${P2_ANCHOR}\` |`, tainted.join('\n'));
  assert.equal(fromGate.line, null, 'the gate must reject the ambiguous anchor');
  assert.equal(fromLint.ambiguous.length, 1, 'the lint must reject it identically');
  assert.equal(fromGate.reason, fromLint.ambiguous[0].detail, 'and explain it identically');
});

test('anchor tables parse; prose tables in the same file do not', () => {
  // _custom.md also holds a verification-failure table and a tool-name table. A
  // naive parser turns their backticked cells into citations that resolve nowhere.
  const parsed = parseAnchors(CUSTOM);
  for (const a of parsed) {
    assert.match(a.id, /^[A-Z]{1,2}\d+$/, `cell "${a.id}" is not a twin id`);
  }
  assert.ok(parsed.length > 40, `expected the real anchor rows; got ${parsed.length}`);
  assert.ok(parsed.every((a) => a.anchor.length > 0));
});

test('every real anchor resolves to exactly one line', () => {
  const r = checkAnchors(CUSTOM, CV);
  assert.equal(r.ambiguous.length, 0, `ambiguous: ${JSON.stringify(r.ambiguous)}`);
  assert.equal(r.missing.length, 0, `unresolvable: ${JSON.stringify(r.missing)}`);
});

test('multi-anchor rows are all checked, not just the first', () => {
  // A row like P2 cites two phrases. Checking only the first would miss a collision
  // on the second - which is exactly what happened with P1 on 2026-10-10.
  const p2 = parseAnchors(CUSTOM).filter((a) => a.id === 'P2');
  assert.ok(p2.length >= 2, `P2 should cite at least 2 anchors; found ${p2.length}`);
  const second = p2[1].anchor;
  const tainted = `${CV}\n- quoting ${second}\n`;
  const r = checkAnchors(`| Z1 | x | \`${second}\` |`, tainted);
  assert.equal(r.verdict, 'fail', 'the second anchor of a row must be checked too');
});