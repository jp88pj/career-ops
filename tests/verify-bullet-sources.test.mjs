// tests/verify-bullet-sources.test.mjs - the provenance gate for CV bullets.
//
// Three unsourced duties shipped in real applications before this check
// existed, all of them plausible and all of them mine:
//
//   "holding a large group to plan and scheduling staff"                        Camp Hillard
//   "accurately across administrations, reconciling results against procedure"  DCAS
//   "explaining requirements clearly and professionally to people who did not
//    ask for them"                                                              Parks
//
// None tripped the existing fact check: no invented metric, no named tool, no
// entity. This closes that gap at the layer where it is decidable - the author
// cites a cv.md line, the tool verifies the citation.
//
// A first attempt scored bullets against the whole of cv.md and flagged 88 of
// 88 existing CVs, including a verbatim source line. Reformatting a duty and
// inventing one are the same operation at different intensities, so a global
// similarity threshold cannot separate them. Comparing against the single cited
// line can. These tests exist to keep it that way: they assert on the REAL
// cv.md lines, so a threshold that starts over-flagging fails here rather than
// in a user's next job application.

import { pass, fail } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verifyBulletSources } from '../verify-bullet-sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CV = readFileSync(join(ROOT, 'cv.md'), 'utf8');
const lines = CV.split(/\r?\n/);
const src = (n) => lines[n - 1];

console.log('\nverify-bullet-sources.mjs — every bullet cites a cv.md line');

const payload = (bullets, company = 'Acme', role = 'Tester') => ({
  candidate: { name: 'Test' },
  experience: [{ company, role, bullets }],
});

// Locate a line by its leading phrase, so these tests do not break when cv.md is
// edited. If the phrase is gone the test fails loudly rather than silently
// citing the wrong line.
function lineOf(phrase) {
  const n = lines.findIndex((l) => l.includes(phrase));
  return n >= 0 ? n + 1 : null;
}

const L_EDUCATE = lineOf('Educate members of the public on parks');
const L_PROTECT = lineOf('Uphold order and protect people');
const L_RECORD = lineOf('recording required data');
const L_CAMP = lineOf('Six consecutive summer seasons');

if (![L_EDUCATE, L_PROTECT, L_RECORD, L_CAMP].every(Boolean)) {
  fail('cv.md no longer contains the phrases these tests cite — update them, or the record moved');
} else {
  pass(`located cv.md lines: educate=${L_EDUCATE} protect=${L_PROTECT} record=${L_RECORD} camp=${L_CAMP}`);

  // --- honest bullets must PASS, using the real source text
  const honest = [
    ['a verbatim source line', src(L_PROTECT).replace(/^\s*-\s*/, '').trim(), L_PROTECT],
    ['camp bullet 1 (reworded)', 'Six consecutive summer seasons on staff; progressed to directing and guiding co-counselors across daily sports, music, arts and crafts, and swimming', L_CAMP],
    ['camp bullet 2 (compressed)', 'Oversaw health and safety protocols, administered camper and counselor progress reports, and coordinated group mealtime protocols', L_CAMP],
    ['DCAS, trimmed of invention', 'Recorded required data (scores, times) as necessary', L_RECORD],
  ];
  for (const [label, text, line] of honest) {
    const r = verifyBulletSources(payload([{ text, source_line: line }]), CV);
    if (r.verdict === 'pass') pass(`accepts ${label}`);
    else fail(`rejected ${label}: ${JSON.stringify(r.unsourced)}`);
  }

  // --- the three real fabrications must FAIL
  const fabrications = [
    ['camp clause', 'holding a large group to plan and scheduling staff', L_CAMP],
    ['DCAS reconciliation detail', 'Recorded required data (scores, times) accurately across administrations, reconciling results against procedure so records held up on review', L_RECORD],
    ['parks explanation clause', 'Educate members of the public on rules and regulations - explaining requirements clearly and professionally to people who did not ask for them', L_EDUCATE],
    ['wholly invented duty', 'Managed a three million dollar departmental budget and vendor portfolio', L_EDUCATE],
  ];
  for (const [label, text, line] of fabrications) {
    const r = verifyBulletSources(payload([{ text, source_line: line }]), CV);
    if (r.verdict === 'block') pass(`rejects ${label}`);
    else fail(`ACCEPTED ${label} — the gate is not doing its job`);
  }

  // --- a citation to the wrong line must fail, not silently pass
  {
    // A DCAS duty cited to the Camp Hillard line: the text is real, the pointer is not.
    const r = verifyBulletSources(
      payload([{ text: src(L_RECORD).replace(/^\s*-\s*/, '').trim(), source_line: L_CAMP }]), CV
    );
    if (r.verdict === 'block') pass('rejects a real duty cited to the wrong line');
    else fail('accepted a duty cited to an unrelated line');
  }

  // --- source_text lookup, for when line numbers are fragile
  {
    const text = src(L_PROTECT).replace(/^\s*-\s*/, '').trim();
    const r = verifyBulletSources(payload([{ text, source_text: 'Uphold order and protect people' }]), CV);
    if (r.verdict === 'pass') pass('resolves a source_text citation by phrase');
    else fail('source_text citation did not resolve');
  }
  {
    const r = verifyBulletSources(payload([{ text: 'Anything', source_text: 'phrase absent from cv.md' }]), CV);
    if (r.verdict === 'block') pass('rejects a source_text that matches nothing');
    else fail('unmatched source_text was accepted');
  }

  // --- a bare string bullet is unsourced. This is the whole point: the three
  // fabrications shipped as plain strings with nothing to check against.
  {
    const r = verifyBulletSources(payload(['Uphold order and protect people, parks, and property']), CV);
    if (r.verdict === 'block') pass('rejects an uncited bare-string bullet');
    else fail('accepted a bullet with no citation at all');
    // The reason, not just the verdict. A bare string also fails downstream in
    // resolveCitation() with "source_text not found in cv.md" - a true verdict
    // for the wrong reason, and one that sends the reader hunting through
    // cv.md for a phrase that was never there. Asserting the reason is what
    // makes this guard distinguishable from its accidental twin.
    if (r.unsourced[0]?.reason === 'no source_line or source_text citation') {
      pass('  reported as a missing citation, not a failed search');
    } else {
      fail(`  wrong reason: "${r.unsourced[0]?.reason}"`);
    }
  }

  // --- out-of-range citations must be rejected as a bad POINTER. Assert the
  // reason, not just the verdict: mutation-testing showed a verdict-only
  // assertion passes even with the range check deleted, because the citation
  // then resolves to the wrong line and fails on support instead. Same verdict,
  // different defect, and the reason is the only thing that tells them apart.
  for (const n of [0, -3, 99999, 1.5]) {
    const r = verifyBulletSources(payload([{ text: 'Managed a budget', source_line: n }]), CV);
    if (r.verdict === 'block') pass(`rejects out-of-range source_line ${n}`);
    else fail(`accepted out-of-range source_line ${n}`);
    if (r.unsourced[0]?.reason === `source_line ${n} does not exist in cv.md`) {
      pass(`  reported as a bad pointer, not a support failure`);
    } else {
      fail(`  wrong reason for ${n}: "${r.unsourced[0]?.reason}"`);
    }
  }

  // --- an empty source must not vacuously pass. Line 1 is used deliberately:
  // with an empty document there is exactly one line, so the citation RESOLVES
  // and the block has to come from support() finding no shared words. Using a
  // line number beyond the range would be rejected by the pointer check first
  // and this would test the wrong thing.
  {
    const r = verifyBulletSources(payload([{ text: 'Did the thing', source_line: 1 }]), '');
    if (r.verdict === 'block') pass('empty source blocks rather than passing vacuously');
    else fail('empty source produced a pass');
    if (r.unsourced[0]?.reason === 'not supported by the cited line') {
      pass('  blocked because the empty source supports nothing');
    } else {
      fail(`  wrong reason: "${r.unsourced[0]?.reason}"`);
    }
  }

  // --- multiple bullets: one bad one must not hide behind good ones
  {
    const r = verifyBulletSources(payload([
      { text: src(L_PROTECT).replace(/^\s*-\s*/, '').trim(), source_line: L_PROTECT },
      { text: 'holding a large group to plan and scheduling staff', source_line: L_CAMP },
    ]), CV);
    if (r.verdict === 'block' && r.unsourced.length === 1) pass('reports only the offending bullet, not its neighbours');
    else fail(`expected exactly 1 finding, got ${r.unsourced.length}`);
  }

  // --- non-experience sections are not this check's business
  {
    const r = verifyBulletSources({
      candidate: { name: 'Test' },
      experience: [],
      skills: [{ category: 'K', items: 'unsourced thing' }],
    }, CV);
    if (r.verdict === 'pass' && r.checked === 0) pass('ignores non-experience sections');
    else fail('scanned something other than experience bullets');
  }
}
