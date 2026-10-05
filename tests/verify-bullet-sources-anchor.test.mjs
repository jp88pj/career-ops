// Text-anchor citations: durable across cv.md edits, and strict about
// ambiguity rather than silently taking the first match.
//
// The motivation, measured 2026-10-04: one source line drifted 71 → 106 → 107
// across two ordinary edits to cv.md, silently invalidating every downstream
// citation each time. The pre-existing loose form (`source_text`, first match
// wins) is worse in a different way: "Taught between 75 and 90 students" appears
// on three lines, so it silently resolved to Hudson's when the bullet belonged to
// Newark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBulletSources } from '../verify-bullet-sources.mjs';

const CV = [
  '## Work Experience',                                                    // 1
  '### Hudson Arts and Science Charter School',                            // 2
  '- Taught between 75 and 90 students each year as homeroom teacher, administering quizzes including NJSLA.', // 3
  '- Developed inclusive strategies for diverse learners.',                 // 4
  '### Newark Public Schools',                                             // 5
  '- Taught between 75 and 90 students each year as homeroom teacher, administering quizzes including NJSLA and NWEA MAP Growth.', // 6
  '- Recorded required data such as scores and time as necessary.',         // 7
].join('\n');

const payload = (bullets) => ({
  experience: [{ company: 'Acme', role: 'Coordinator', bullets }],
});

test('source_anchor resolves a unique phrase', () => {
  const r = verifyBulletSources(
    payload([{ text: 'Recorded required data such as scores and time as necessary.', source_anchor: 'Recorded required data' }]),
    CV,
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.checked, 1);
});

test('source_anchor REFUSES an ambiguous phrase instead of taking the first match', () => {
  const r = verifyBulletSources(
    payload([{ text: 'Taught between 75 and 90 students each year.', source_anchor: 'Taught between 75 and 90 students' }]),
    CV,
  );
  assert.equal(r.verdict, 'block', 'an ambiguous anchor must block, not silently resolve');
  assert.equal(r.unsourced.length, 1);
  assert.match(r.unsourced[0].reason, /AMBIGUOUS/);
  assert.match(r.unsourced[0].reason, /matches 2 lines/);
});

test('an anchor that does not exist says so precisely', () => {
  const r = verifyBulletSources(
    payload([{ text: 'Something plausible.', source_anchor: 'nonexistent phrase entirely' }]),
    CV,
  );
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /source_anchor .* not found in cv\.md/);
});

test('a drifted source_line fails loudly rather than citing the wrong line', () => {
  // Line 6 is the Newark bullet. Citing 3 instead — exactly what an insert
  // above the file produces — must not silently pass by support ratio.
  const wrong = verifyBulletSources(
    payload([{ text: 'Recorded required data such as scores and time as necessary.', source_line: 3 }]),
    CV,
  );
  assert.equal(wrong.verdict, 'block');
  assert.equal(wrong.unsourced[0].support < 0.6, true);
});

test('an anchor survives the edit that breaks a line number', () => {
  const bullet = { text: 'Recorded required data such as scores and time as necessary.', source_anchor: 'Recorded required data' };
  const before = verifyBulletSources(payload([bullet]), CV);
  assert.equal(before.verdict, 'pass');

  // Insert 40 lines at the top, as editing cv.md above the content would.
  const shifted = [Array.from({ length: 40 }, (_, i) => `inserted line ${i}`), CV].join('\n');
  const after = verifyBulletSources(payload([bullet]), shifted);
  assert.equal(after.verdict, 'pass', 'the anchor must still resolve after the shift');

  // The same bullet as a line number does NOT survive. Note the failure mode:
  // after a 40-line insert, line 7 still EXISTS — it just says something else.
  // Out-of-range is the rare case; landing on a real but wrong line is the
  // common one, and it is why a drifted citation cannot be noticed by eye.
  const numbered = { ...bullet, source_anchor: undefined, source_line: 7 };
  const numberedAfter = verifyBulletSources(payload([numbered]), shifted);
  assert.equal(numberedAfter.verdict, 'block', 'a line number cannot survive the shift');
  assert.equal(
    numberedAfter.unsourced[0].reason,
    'not supported by the cited line',
    'the drifted line exists but no longer supports the bullet',
  );
});

test('source_line and source_text keep working (backward compatible)', () => {
  assert.equal(
    verifyBulletSources(payload([{ text: 'Recorded required data such as scores and time as necessary.', source_line: 7 }]), CV).verdict,
    'pass',
  );
  // The loose legacy form still takes the first match — kept working, which is
  // why source_anchor is the one to reach for.
  assert.equal(
    verifyBulletSources(payload([{ text: 'Recorded required data such as scores and time as necessary.', source_text: 'Recorded required data' }]), CV).verdict,
    'pass',
  );
});

test('a bullet with no citation at all is still unsourced', () => {
  const r = verifyBulletSources(payload([{ text: 'Recorded required data such as scores and time as necessary.' }]), CV);
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /no source_line or source_text citation/);
});

test('a role with no usable bullets blocks', () => {
  const r = verifyBulletSources(payload([{ source_anchor: 'Recorded required data' }]), CV);
  assert.equal(r.verdict, 'block');
  assert.equal(r.emptyRoles.length, 1);
  assert.match(r.emptyRoles[0].where, /Acme — Coordinator/);
});

test('a role with bullets: [] blocks', () => {
  const r = verifyBulletSources(payload([]), CV);
  assert.equal(r.verdict, 'block');
  assert.equal(r.emptyRoles.length, 1);
});
