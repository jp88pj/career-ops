// Regression: a vendor that 404s must NOT be reported as a resolved board.
//
// Found 2026-10-06 running discover-ats.mjs over 14 unscanned companies. Twelve
// resolved to `ats.rippling.com/<slug>` and were reported as
//
//     "board(s) found but currently list 0 jobs - re-run later"
//
// but every one of those URLs returns HTTP 404 Not Found. The retry advice is
// impossible to satisfy, because the board does not exist - and under --write
// those phantoms land in portals.yml as live config, where every later scan
// treats a dead URL as a company to check.
//
// Cause: providers switch between "probe" and "full walk" on a finite
// ctx.maxPages (providers/rippling.mjs: `const probing = ctxCap !== Infinity`).
// In probe mode a fetch failure PROPAGATES; in a full walk it is swallowed,
// logged as "truncated at page 1", and the walk returns the jobs gathered so far
// - which for a page-1 failure is []. probeVendor handed every provider the
// unbounded discovery ctx, so a 404 became a successful empty result and read as
// `status: 'empty'` -> emptyBoards -> "board(s) found".
//
// Network-free, and stubbed at the right layer: providers reach the network
// through `ctx.fetchJson`, not global fetch. An earlier version of this file
// stubbed globalThis.fetch and passed ctx={} — every case then returned 'error'
// with "ctx.fetchJson is not a function", so the 404 assertion was a FALSE PASS
// for the wrong reason. Real ctx comes from makeHttpCtx() with fetchJson
// replaced, so only the intended error can produce the expected result.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeVendor, buildCandidateUrls } from '../discover-ats.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';

function candidateFor(vendor) {
  const { candidates } = buildCandidateUrls({ name: 'Pearson' });
  const c = candidates.find((x) => x.vendor === vendor);
  assert.ok(c, `expected a ${vendor} candidate`);
  return c;
}

// The error shape providers/_http.mjs produces for a 404: a plain Error carrying
// a numeric `status`, which is what probeVendor forwards into httpStatus and
// isDefinitiveAbsence() reads.
function notFoundError() {
  const err = new Error('HTTP 404 Not Found');
  err.status = 404;
  return err;
}

function ctxThat(fn) {
  const ctx = makeHttpCtx();
  ctx.fetchJson = fn;
  return ctx;
}

describe('discover-ats probeVendor: 404 is not an empty board', () => {
  it('reports a 404 board as an error, never as an empty board', async () => {
    const ctx = ctxThat(async () => { throw notFoundError(); });
    const r = await probeVendor({ name: 'Pearson' }, candidateFor('rippling'), ctx);
    assert.equal(
      r.status,
      'error',
      `a 404 must not read as 'empty' - that is what produced "board(s) found but currently list 0 jobs"`
    );
    assert.equal(r.httpStatus, 404);
  });

  it('keeps a live board with zero postings as empty', async () => {
    // The 200-with-no-items case is legitimately "found but empty". Conflating
    // it with the 404 case is the bug; conflating it the other way would discard
    // real boards that simply have no openings today.
    const ctx = ctxThat(async () => ({ items: [] }));
    const r = await probeVendor({ name: 'Pearson' }, candidateFor('rippling'), ctx);
    assert.equal(r.status, 'empty', `unexpected: ${JSON.stringify(r)}`);
  });

  it('reports a live board with postings as a match', async () => {
    const ctx = ctxThat(async () => ({
      items: [{ name: 'Program Coordinator', url: 'https://ats.rippling.com/pearson/jobs/1' }],
    }));
    const r = await probeVendor({ name: 'Pearson' }, candidateFor('rippling'), ctx);
    assert.equal(r.status, 'match', `unexpected: ${JSON.stringify(r)}`);
    assert.equal(r.jobCount, 1);
  });
});