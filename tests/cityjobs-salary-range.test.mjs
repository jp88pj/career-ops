// Two salary-parsing defects on the City Jobs board, both found 2026-10-06.
//
// 1. parseSalaryRange accepted a per-diem/hourly figure as an annual SALARY.
//    jid-33840 "Supervisor Dockbuilder" publishes `Salary range: $469.44` in its
//    annual field. The $60K comp floor happened to exclude it - but by luck, not
//    by logic. A role publishing "$1,000 per week" clears a $60K floor and would
//    have been stored as a $1,000 salary. An arithmetically impossible annual
//    figure now returns null, so the absence is explicit.
//
// 2. parseDetail's page-text fallback took `fromText?.min` - a STRING - and then
//    read `salary.min` / `salary.max` off it, which is `undefined` on a string.
//    Any posting resolved without JSON-LD produced the literal salary
//    "undefined-undefined" and salaryMax NaN.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalaryRange, parseDetail } from '../scan-cityjobs.mjs';

describe('cityjobs parseSalaryRange', () => {
  it('reads a two-figure annual band', () => {
    assert.deepEqual(parseSalaryRange('$38,220-$45,500'), { min: '38220', max: '45500' });
  });

  it('reads the site en-dash form with cents', () => {
    assert.deepEqual(parseSalaryRange('$70,653.00 – $74,955.00'), { min: '70653', max: '74955' });
  });

  it('reads a single-figure annual band', () => {
    assert.deepEqual(parseSalaryRange('$100,000'), { min: '100000', max: '100000' });
  });

  it('rejects a per-diem figure sitting in the annual field', () => {
    // The defect: $469.44 is a daily rate, not a salary.
    assert.equal(parseSalaryRange('$469.44'), null);
  });

  it('rejects an hourly rate', () => {
    assert.equal(parseSalaryRange('$25.00'), null);
  });

  it('rejects a weekly figure that would clear a $60K floor', () => {
    // This is why the fix is a plausibility floor rather than "small numbers
    // only": $1,000/week is large enough to pass a $60K comparison.
    assert.equal(parseSalaryRange('$1,000'), null);
  });

  it('returns null for empty input', () => {
    assert.equal(parseSalaryRange(''), null);
  });
});

describe('cityjobs parseDetail salary fallback', () => {
  it('produces a usable salary when only the page text carries one', () => {
    // No JSON-LD block at all, so parseDetail must fall back to the page text.
    const html = `<html><body>
      <p>Salary range: $64,000 – $71,000 per year.</p>
      <p>Full-time position in Manhattan.</p>
    </body></html>`;
    const d = parseDetail(html);
    assert.equal(d.salarySource, 'page-text');
    assert.notEqual(d.salaryMax, null);
    assert.ok(Number.isFinite(d.salaryMax), `salaryMax must be a number, got ${d.salaryMax}`);
    assert.equal(d.salaryMin, 64000);
    assert.equal(d.salaryMax, 71000);
    assert.ok(!/undefined/.test(d.salary), `salary must not contain "undefined", got ${d.salary}`);
  });

  it('reports salarySource absent when a page has no figure at all', () => {
    const d = parseDetail('<html><body><p>Full-time role, no compensation published.</p></body></html>');
    assert.equal(d.salarySource, 'absent');
    assert.equal(d.salaryMin, null);
    assert.equal(d.salaryMax, null);
  });
});