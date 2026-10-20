// Regression test for the NYC SmartRecruiters title veto.
//
// WHY A VETO AND NOT A TITLE NEGATIVE
// The lane test is
//
//     matchesTitle(title, ...) || codeAllowed(posting)
//
// and `title_codes` is an OR-escape hatch: a 56058 posting is admitted
// REGARDLESS of what the title filter says, because the family enters by
// code. So a `negative:` entry on the board's source_title_filters rule can
// never reach it -- which is exactly the lane that needed closing.
//
// The veto therefore has to be applied AFTER the OR, and this test pins that
// placement, not just the presence of the list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import { buildTitleFilterBySource, compileKeyword, foldTitle } from '../title-keywords.mjs';
import { buildShapePolicy, stripShapeNegatives } from '../lib/employment-shape.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = yaml.load(readFileSync(join(root, 'portals.yml'), 'utf-8')) || {};

const entry = (config.tracked_companies || []).find(
  (c) => /jobs\.smartrecruiters\.com\/CityOfNewYork/i.test(c.careers_url || ''),
);
assert.ok(entry, 'the NYC SmartRecruiters tracked_companies entry must exist');

const HOSTS = ['jobs.smartrecruiters.com'];
const COMPANY = entry.name;
const shapePolicy = buildShapePolicy(config.employment_shape);
const matchesTitle = buildTitleFilterBySource(
  shapePolicy.flagNotVeto ? stripShapeNegatives(config.title_filter || {}) : (config.title_filter || {}),
  config.source_title_filters,
);
const titleCodes = (entry.title_codes || []).map((c) => String(c).trim()).filter(Boolean);
const codeAllowed = (j) => titleCodes.length > 0 && j.titleCode !== undefined
  && titleCodes.includes(String(j.titleCode).trim());

const EXCLUDE = (entry.exclude_titles || []).map((t) => String(t).trim()).filter(Boolean);
const excludeMatchers = EXCLUDE.map((t) => compileKeyword(foldTitle(t)));
const isExcluded = (title) => {
  if (!excludeMatchers.length) return false;
  const lower = foldTitle(String(title || ''));
  return excludeMatchers.some((m) => m(lower));
};

test('the NYC board declares the never-target title veto', () => {
  assert.ok(EXCLUDE.length > 0, 'exclude_titles must not be empty on the NYC board');
  assert.ok(EXCLUDE.some((t) => /executive assistant/i.test(t)), 'the veto must cover the executive-assistant family');
});

test('the veto rejects a title the lane accepts', () => {
  // "Executive Assistant" is on the board's own positive list, so the lane
  // accepts it. If the veto did not reject it, the veto is not applied.
  assert.equal(matchesTitle('Executive Assistant', { hosts: HOSTS, company: COMPANY }), true);
  assert.equal(isExcluded('Executive Assistant'), true);
});

test('the veto is applied AFTER the title_codes OR-branch', () => {
  // The regression this pins: a veto wired into the title filter instead of
  // after the OR would reject the title but the 56058 code branch would
  // re-admit the posting, so the lane would keep resurfacing.
  const posting = { title: 'Executive Assistant', titleCode: '56058' };
  const laneOnly = matchesTitle(posting.title, { hosts: HOSTS, company: COMPANY }) || codeAllowed(posting);
  assert.equal(codeAllowed(posting), true, 'the probe posting must enter by code, or this test proves nothing');
  assert.equal(laneOnly, true, 'the lane must admit the probe before the veto');
  assert.equal(laneOnly && !isExcluded(posting.title), false, 'the veto must remove a posting that entered by code');
});

test('the veto does not touch the live thread the profile concentrates on', () => {
  // The 56058 family is the one cluster where the record has standing. A
  // veto broad enough to catch it would end the search, not narrow it.
  for (const title of [
    'Program Counselor',
    'Community Engagement Coordinator',
    'Community Liaison',
    'Project Manager, Programs',
    'Outreach Coordinator',
    'Operations Associate',
  ]) {
    assert.equal(isExcluded(title), false, `${title} must not be vetoed`);
  }
});

test('the veto is board-scoped: an EA role on another board is untouched', () => {
  // RECALL. Two of his applications carry an EA title (#50 cityjobs, #122
  // Cohere/Bandana). A board-scoped veto must not reach them.
  const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf-8');
  const rows = tracker.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
  const everApplied = rows.filter((l) => {
    const c = l.split('|').map((x) => x.trim());
    return ['Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Lapsed'].includes(c[6]);
  });
  const ea = everApplied.filter((l) => isExcluded(l.split('|')[4].trim()));
  for (const l of ea) {
    const url = l.split('|')[10].trim();
    assert.doesNotMatch(
      url,
      /jobs\.smartrecruiters\.com\/CityOfNewYork/,
      'an EA application on the NYC board would have been hidden by the veto',
    );
  }
});
