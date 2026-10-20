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
    'Aeu Program Planner',
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
