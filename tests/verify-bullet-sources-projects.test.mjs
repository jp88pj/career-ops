// Project bullets must be gated exactly like experience bullets.
//
// MEASURED 2026-10-08: `verifyBulletSources` iterated only `payload.experience`.
// A fabricated bullet filed under `projects[]` returned checked=0, unsourced=0,
// verdict "pass" — while the identical bullet under `experience[]` blocked. Both
// remaining Projects (The Good Press, Volume of Prisms) carry CV bullets, so that
// was an unchecked path into a document that gets submitted.
//
// The test below uses ONE fabricated sentence in both slots. If this ever stops
// failing on projects, someone narrowed the loop again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyBulletSources } from '../verify-bullet-sources.mjs';

const CV = readFileSync(new URL('../cv.md', import.meta.url), 'utf8');

const FABRICATED = 'Personally rebuilt the Kubernetes orchestration layer and the Splunk telemetry stack in-house.';
const GOOD = 'Designed and authored CCSS-aligned curriculum independently as a freelancer.';

test('a fabricated bullet under projects[] BLOCKS, not silently passes', () => {
  const r = verifyBulletSources({ projects: [{ name: 'The Good Press', bullets: [{ text: FABRICATED, source_anchor: '64 issues as of 2026-10-07' }] }] }, CV);
  assert.equal(r.verdict, 'block');
  assert.ok(r.checked > 0, 'the project bullet must actually be counted, not skipped');
});

test('the same bullet blocks identically in both slots', () => {
  const exp = verifyBulletSources({ experience: [{ company: 'X', role: 'Y', bullets: [{ text: FABRICATED, source_anchor: '64 issues as of 2026-10-07' }] }] }, CV);
  const prj = verifyBulletSources({ projects: [{ name: 'X', bullets: [{ text: FABRICATED, source_anchor: '64 issues as of 2026-10-07' }] }] }, CV);
  assert.equal(prj.checked, exp.checked);
  assert.equal(prj.unsourced.length, exp.unsourced.length);
  assert.equal(prj.verdict, exp.verdict);
});

test('a genuine project bullet passes', () => {
  const r = verifyBulletSources({ projects: [{ name: 'Volume of Prisms', bullets: [{ text: GOOD, source_anchor: 'Freelance curriculum design services, authoring the curriculum design portfolio' }] }] }, CV);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.checked, 1);
});

test('an uncited project bullet is a failure, like any other', () => {
  const r = verifyBulletSources({ projects: [{ name: 'P', bullets: ['a bare string with no citation'] }] }, CV);
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /no source_line, source_anchor or source_text citation/);
});

test('a failure names the PROJECT, not a blank company/role pair', () => {
  const r = verifyBulletSources({ projects: [{ name: 'The Good Press', bullets: ['bare'] }] }, CV);
  assert.match(r.unsourced[0].where, /The Good Press/);
});

test('a multi-anchor project bullet works, including the pooled support path', () => {
  // Uses the CURRENT approved Good Press wording. An earlier version of this test
  // quoted the superseded wording ("...as of 2026-10-07", present tense) and began
  // failing the moment the project was recorded as COMPLETE on 2026-10-08 — a test
  // encoding retired phrasing is a test that rots. Keep these strings in step with
  // modes/_custom.md, and do not quote a superseded phrase here.
  const r = verifyBulletSources({
    projects: [{
      name: 'The Good Press',
      bullets: [{
        text: 'Wrote and edited all 64 consecutive weekly issues alone, as sole author and editor of record.',
        source_anchor: ['sole author and editor of record', '64 consecutive weekly issues in total'],
      }],
    }],
  }, CV);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.checked, 1);
});

test('a payload with both experience and projects checks both', () => {
  const r = verifyBulletSources({
    experience: [{ company: 'Pearson', role: 'Test Administrator', bullets: [{ text: GOOD, source_anchor: 'Freelance curriculum design services, authoring the curriculum design portfolio' }] }],
    projects: [{ name: 'The Good Press', bullets: [{ text: FABRICATED, source_anchor: '64 issues as of 2026-10-07' }] }],
  }, CV);
  assert.equal(r.verdict, 'block');
  assert.equal(r.checked, 2, 'both bullets counted');
});
