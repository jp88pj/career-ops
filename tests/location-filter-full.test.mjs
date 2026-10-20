import assert from 'assert/strict';
import { execFileSync } from 'node:child_process';
import { resolveLocationFilterConfig, filterFingerprints } from '../scan-ats-full.mjs';
import { buildLocationFilter } from '../scan.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nPer-sweep location filter (location_filter_full)');

// ── 1. The resolver prefers the sweep-specific key ──────────────────────────
// The global location_filter is tuned for scan.mjs's curated board list, where
// admitting the whole United States is right. A reverse sweep over 50,170
// public boards is a different question, and the two need different answers.
{
  const global = { always_allow: ['Remote', 'United States'], allow: ['Remote'] };
  const full = { always_allow: ['Remote', 'New York'], allow: ['Remote', 'New York'] };

  assert.deepEqual(resolveLocationFilterConfig({ location_filter: global }), global);
  assert.deepEqual(resolveLocationFilterConfig({ location_filter: global, location_filter_full: full }), full);
  assert.deepEqual(resolveLocationFilterConfig({}), undefined);
  pass('resolveLocationFilterConfig prefers location_filter_full and falls back to location_filter');
}

// ── 2. The sweep records the filter it actually read ────────────────────────
// A checkpoint written under different filter settings must not be resumed
// under new ones, so the fingerprint has to be keyed by whichever filter the
// sweep read.
{
  const global = { allow: ['Remote'] };
  const full = { allow: ['Remote', 'New York'] };

  const fpGlobal = filterFingerprints({ location_filter: global });
  const fpFull = filterFingerprints({ location_filter: global, location_filter_full: full });

  assert.ok(fpGlobal.location_filter, 'without location_filter_full the fingerprint key is location_filter');
  assert.ok(!fpGlobal.location_filter_full, 'without location_filter_full there is no location_filter_full key');
  assert.ok(fpFull.location_filter_full, 'with location_filter_full the fingerprint key is location_filter_full');
  assert.ok(!fpFull.location_filter, 'with location_filter_full the old key is not used');
  assert.notEqual(fpGlobal.location_filter, fpFull.location_filter_full, 'the two filters fingerprint differently');
  pass('filterFingerprints keys the location filter under whichever one the sweep read');
}

// ── 3. The filter actually rejects out-of-region and keeps New York ────────
// The bug this whole key exists to fix: `always_allow` is checked BEFORE
// `block`, so an always_allow naming the United States admits every US state
// and a plain `block` is never consulted. Only `block_hard` can override it.
{
  const f = buildLocationFilter({
    always_allow: ['Remote', 'New York', 'NYC', 'Brooklyn', 'Queens', 'Manhattan', 'Bronx', 'New Jersey'],
    block_hard: ['Texas', ', TX', 'California', ', CA', 'Ohio', ', OH', 'Indiana', ', IN'],
    allow: ['Remote', 'United States', 'USA', 'New York', 'NYC', 'New Jersey'],
  });

  assert.equal(f('New York, NY, United States', '', 'x'), true, 'New York passes');
  assert.equal(f('Brooklyn, NY, United States', '', 'x'), true, 'Brooklyn passes');
  assert.equal(f('Remote, United States', '', 'x'), true, 'Remote passes');
  assert.equal(f('United States', '', 'x'), true, 'an unresolvable US location passes rather than being dropped');

  assert.equal(f('Austin, TX, United States', '', 'x'), false, 'Texas is rejected');
  assert.equal(f('Austin, Texas, United States', '', 'x'), false, 'Texas by name is rejected');
  assert.equal(f('San Francisco, CA, United States', '', 'x'), false, 'California is rejected');
  assert.equal(f('Columbus, OH, United States', '', 'x'), false, 'Ohio is rejected');
  pass('block_hard rejects out-of-region states that always_allow would otherwise admit');
}

// ── 4. The comma-prefixed abbreviation form ─────────────────────────────────
// The bare abbreviation "IN" matches inside "In-Office" -- the boundary rule
// allows a hyphen to end a word -- so a first draft rejected three genuine
// New York roles as Indiana. ", IN" needs the comma to be present, which a
// hyphenated word does not have.
{
  const f = buildLocationFilter({
    always_allow: ['Remote', 'New York', 'NYC'],
    block_hard: ['Indiana', ', IN'],
    allow: ['Remote', 'United States', 'USA', 'New York', 'NYC'],
  });

  assert.equal(f('In-Office · New York, NY, USA', '', 'x'), true, 'In-Office is not Indiana');
  assert.equal(f('Indianapolis, IN, United States', '', 'x'), false, 'Indianapolis is still rejected');
  assert.equal(f('Indianapolis, Indiana, United States', '', 'x'), false, 'Indiana by name is rejected');
  pass('a comma-prefixed abbreviation does not match inside a hyphenated word');
}

// ── 5. validate-portals rejects a malformed location_filter_full ────────────
// A misspelled field is the dangerous case, not a missing one: `allow:` leaves
// the allow list undefined, buildLocationFilter treats an empty allow list as
// "no allow constraint", and the sweep then admits every location on every
// board.
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-lff-'));
  const p = path.join(dir, 'portals.yml');
  try {
    fs.writeFileSync(p, 'tracked_companies: []\nlocation_filter_full:\n  allow:\n    - "Remote"\n  typo_field: ["x"]\n');
    // validate-portals reads a FILE (--file), or the one in the data root. It
    // does not read stdin, so the fixture has to be on disk and named.
    let out = '';
    let code = 0;
    try {
      out = execFileSync('node', ['validate-portals.mjs', '--file', p], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
      code = e.status ?? 1;
    }
    assert.match(out, /location_filter_full\.typo_field/, 'an unknown field is reported');
    assert.notEqual(code, 0, 'validation exits non-zero on a malformed location_filter_full');
    pass('validate-portals rejects an unknown field inside location_filter_full');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
