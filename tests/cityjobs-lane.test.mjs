// Regression test for the NYC City Jobs lane rule.
//
// The board had NO source_title_filters rule, so it fell through to the GLOBAL
// title list -- which admits 1,203 of the tenant's 1,689 postings (71%) and
// MISSES 57 of the 349 whose civil-service title is in-lane. Measured on the
// 38 cityjobs entries in the pipeline: 31 of 38 were off-lane, and 13 of them
// were the same title (Heating Plant Technician).
//
// The rule has three parts and each has an invariant worth pinning:
//
//   positive   - must cover EVERY business title of the in-lane codes, or an
//                in-lane posting is filtered out before it can be evaluated.
//   negative   - must never reject an in-lane posting. The slug appends the
//                DIVISION to the title, so a negative on a division word would
//                reject an in-lane posting whose division shares the word.
//                "Payment Liaison Office Of OFA For The Division Of Fiscal
//                Affairs" IS a 56058 posting -- a "Fiscal" negative would
//                reject it.
//   title_codes - the exact filter, and the only field that governs
//                eligibility.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import { buildTitleFilterBySource } from '../title-keywords.mjs';
import { buildShapePolicy, stripShapeNegatives } from '../lib/employment-shape.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = yaml.load(readFileSync(join(root, 'portals.yml'), 'utf-8')) || {};
const rule = (config.source_title_filters || []).find((r) => (r.match_hosts || []).includes('cityjobs.nyc.gov'));
assert.ok(rule, 'the cityjobs board must have its own source_title_filters rule');

const shapePolicy = buildShapePolicy(config.employment_shape);
const matchesTitle = buildTitleFilterBySource(
  shapePolicy.flagNotVeto ? stripShapeNegatives(config.title_filter || {}) : (config.title_filter || {}),
  config.source_title_filters,
);
const CODES = (rule.title_codes || []).map(String);
const judge = (title) => matchesTitle(title, { hosts: ['cityjobs.nyc.gov'], company: '' });

test('the cityjobs board declares the in-lane civil-service title codes', () => {
  assert.ok(CODES.length > 0, 'title_codes must not be empty');
  assert.ok(CODES.includes('56058'), '56058 COMMUNITY COORDINATOR is the live thread and must be listed');
});

test("the record's OWN lanes are in the code list", () => {
  // MEASURED 2026-10-20: the first code list was assembled by pattern-matching
  // the codes and it EXCLUDED 70810 SPECIAL OFFICER and 60421 URBAN PARK
  // RANGER - his own lane, the one the tracker already carries an Applied row
  // for (row 2, Parks Enforcement Patrol). The cityjobs title-code gate shipped
  // on 2026-10-20 used that list, so it would have REJECTED the postings of
  // his own primary lane. A code says what civil-service title he would be
  // appointed to; a code whose title names work he has done is his, whatever
  // the digits say.
  for (const code of ['56058', '56057', '56056', '70810', '60421', '52287', '52615', '60888']) {
    assert.ok(CODES.includes(code), `${code} is one of the record's own lanes and must be listed`);
  }
  // The closed professions stay out: a supervisory title the record has never
  // held, a legal title, and a management title.
  for (const code of ['70817', '30087', '10035']) {
    assert.ok(!CODES.includes(code), `${code} is a closed profession and must NOT be listed`);
  }
});

test('the rule admits a posting whose title only names the division', () => {
  // The slug carries the FULL title plus the division. A positive copied from
  // a shorter form must still match, and no negative may reject it.
  // These two are 56058 and 56057 postings -- in-lane by code, and the ones
  // the retirement kept.
  assert.equal(judge('Payment Liaison Office Of Ofa For The Division Of Fiscal Affairs'), true);
  assert.equal(judge('Clerical Support For The Division Of Code Enforcement Dce'), true);
});

test('the rule rejects the off-lane families the board was admitting', () => {
  for (const title of [
    'Heating Plant Technician',
    'Psychiatrist Director Health And Wellness Section',
    'Supervisor Electrician',
    'Bob Manager Of Design',
    'It Project Manager For The Division Of Hpd Tech',
    'Asbestos Remediation Specialist In Outside Nyc',
    'Forensic Mortuary Technician I',
    'Eh And S Audits And Assessments Section Chief Associate Public Health Sanitarian Iii',
    // 30087 AGENCY ATTORNEY - a legal title.
    'Agency Attorney',
    // 70817 SUPERVISING SPECIAL OFFICER - a supervisory title the record has
    // never held (sergeant), and the one code the first list left out of the
    // IN-lane set. These replace 'Aeu Program Planner', which stopped being
    // off-lane when 22122 CITY PLANNER joined the list: that code carries
    // 'Project Coordinator, OLS' and 'Revocable Consent Specialist', which
    // ARE the record's work, so the whole code could not stay out.
    //
    // The titles here carry NO in-lane title as a substring, which is what
    // makes them title-stage rejections. 'Supervising Special Officer' is
    // admitted by the TITLE stage because it contains the in-lane 'Special
    // Officer' - it is rejected by the CODE stage instead (70817 is not in
    // title_codes). Two stages, two different gates; this test covers the
    // title stage, and the scanner applies the code gate on the detail page.
    'Sergeant Bureau Of Operations',
    'Field Officer Captain',
  ]) {
    assert.equal(judge(title), false, `${title} should be off-lane`);
  }
});

test('the scanner reads the title code off the detail page', () => {
  const src = readFileSync(join(root, 'scan-cityjobs.mjs'), 'utf-8');
  assert.ok(src.includes('titleCode'), 'parseDetail must return the code');
  assert.ok(src.includes('CITYJOBS_TITLE_CODES'), 'the gate must read the codes from the config');
  assert.ok(src.includes('skipped_title_code'), 'the gate must record its rejections in scan-history');
});

test('a rule rejection must not PIN the url in scan-history', () => {
  // A posting rejected by a RULE can be rejected for free, and pinning it
  // makes it unrecoverable when the rule changes. That is the failure that
  // cost the 56058 family 89 postings on 2026-10-20.
  const scan = readFileSync(join(root, 'scan.mjs'), 'utf-8');
  const m = /const OBSERVATIONAL_SCAN_HISTORY_STATUSES = new Set\(\[([\s\S]*?)\]\)/.exec(scan);
  assert.ok(m, 'the observational set must be findable');
  assert.match(m[1], /'skipped_title'/, 'skipped_title must be observational');
  assert.match(m[1], /'skipped_title_code'/, 'skipped_title_code must be observational');
});
