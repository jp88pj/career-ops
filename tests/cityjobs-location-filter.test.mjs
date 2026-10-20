// Regression test: the cityjobs location filter must not drop NYC borough
// postings.
//
// WHY THIS EXISTS
// `scan-cityjobs.mjs` hand-rolled its own location matcher and consulted only
// `location_filter.allow` and `.block` -- never `always_allow`, which is the
// tier that actually names the boroughs, and never `block_hard`, the non-US
// tier.
//
// `locationFromSlug` returns "NYC" for an all-boros posting but
// "Manhattan, NY" / "Brooklyn, NY" / "Queens, NY" / "Bronx, NY" /
// "Staten Island, NY" for a borough-specific one. None of those substrings
// matches `allow` ("Remote", "United States", "USA", "New York", "NYC",
// "New Jersey"), so 6 of 7 slug shapes were DROPPED and only citywide
// postings survived.
//
// The failure was silent and looked like an empty board rather than a bug:
// three separate evaluation workers reported the same posting being dropped
// repeatedly ("skipped_location") and having to surface on the sibling
// SmartRecruiters board instead.
//
// The fix routes the scanner through the shared `buildLocationFilter`, which
// checks block_hard -> always_allow -> block -> allow. This test pins that
// behaviour so the two-implementations-drift failure cannot return.
//
// Verified to fail against the old matcher: "manhattan (location "Manhattan,
// NY") was dropped by the cityjobs location filter".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import { matchesLocation, locationFromSlug } from '../scan-cityjobs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Every borough shape the cityjobs sitemap produces, plus the citywide one.
const NYC_SLUGS = [
  ['citywide', 'https://cityjobs.nyc.gov/job/senior-data-coordinator-in-nyc-all-boros-jid-1'],
  ['manhattan', 'https://cityjobs.nyc.gov/job/foo-in-manhattan-jid-2'],
  ['brooklyn', 'https://cityjobs.nyc.gov/job/foo-in-brooklyn-jid-3'],
  ['queens', 'https://cityjobs.nyc.gov/job/foo-in-queens-jid-4'],
  ['bronx', 'https://cityjobs.nyc.gov/job/foo-in-the-bronx-jid-5'],
  ['staten island', 'https://cityjobs.nyc.gov/job/foo-in-staten-island-jid-6'],
];

test('every NYC borough location survives the cityjobs location filter', () => {
  for (const [name, url] of NYC_SLUGS) {
    const loc = locationFromSlug(url);
    assert.equal(
      matchesLocation(loc),
      true,
      `${name} (location ${JSON.stringify(loc)}) was dropped by the cityjobs location filter`
    );
  }
});

test('the cityjobs filter still rejects locations outside the US', () => {
  // The fix must not have widened the filter into "keep everything". These
  // are the shapes block_hard exists for, and the global `location_filter`
  // names Canada, the United Kingdom, England and India explicitly.
  for (const loc of ['Toronto, Ontario', 'London, England', 'Bengaluru, India', 'Edinburgh, Scotland']) {
    assert.equal(matchesLocation(loc), false, `${JSON.stringify(loc)} should be rejected`);
  }
});

test('a posting with no resolvable location is not dropped', () => {
  // Missing data must not be penalised -- the scanner has no strict mode set,
  // and dropping a posting because its location could not be read is exactly
  // the failure mode this test exists to prevent.
  assert.equal(matchesLocation(''), true);
  assert.equal(matchesLocation(undefined), true);
});

test('the location filter is the shared one, not a second implementation', async () => {
  // The failure mode was two matchers that disagreed. Assert that this
  // scanner and the sibling SmartRecruiters scanner agree on every shape.
  const { buildLocationFilter } = await import('../scan.mjs');
  const config = yaml.load(readFileSync(join(root, 'portals.yml'), 'utf-8')) || {};
  const sibling = buildLocationFilter(config.location_filter);

  for (const [, url] of NYC_SLUGS) {
    const loc = locationFromSlug(url);
    assert.equal(matchesLocation(loc), sibling(loc), `scanners disagree on ${JSON.stringify(loc)}`);
  }
});
