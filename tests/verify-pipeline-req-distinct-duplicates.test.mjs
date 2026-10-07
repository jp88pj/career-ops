// verify-pipeline.mjs reported two genuinely distinct RFCUNY requisitions as a
// possible duplicate because both are titled "Program Manager":
//   #265  JR3338  $80,000-$85,000  grants and external vendors, one-year term
//   #267  JR178   $65,000         higher-education programme management
// Different URLs, different bands, different duties.
//
// merge-tracker.mjs and scan.mjs both treat a req/job number in the Notes cell
// as proof the rows are DISTINCT openings (#1524, #2009) — and this checker did
// not, so it re-reported as a duplicate exactly the pair the merge path had
// deliberately kept apart. The row-level key stayed `company::role`, which a
// req number never varies.
//
// The suppression is deliberately narrow: it applies only when EVERY row in the
// group carries a number AND all of them differ. A real duplicate — same req on
// both sides, or no number at all — must still warn, or the fix would silence
// the very thing this check exists to catch.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractReqNumber, normalizeTextKey } from '../tracker-parse.mjs';

/** The logic added to verify-pipeline.mjs, factored so it can be pinned. */
function classifyDuplicateGroup(group) {
  const nums = group.map((e) => extractReqNumber(e.notes));
  const allNumbered = nums.every((n) => n);
  const allDistinct = new Set(nums).size === nums.length;
  return { verdict: allNumbered && allDistinct ? 'distinct' : 'possible-duplicate', nums };
}

const row = (num, company, role, notes) => ({ num, company, role, notes });
const keyOf = (e) => normalizeTextKey(e.company) + '::' + normalizeTextKey(e.role);

describe('verify-pipeline duplicate check honours req numbers', () => {
  it('reads a req number from the Notes cell', () => {
    assert.equal(extractReqNumber('JR178 APPLY - 4.1/5, the best role on the board'), '178');
    assert.equal(extractReqNumber('JR3338 MARGINAL 3.6/5'), '3338');
    assert.equal(extractReqNumber('Req #1311 applied'), '1311');
    assert.equal(extractReqNumber('no identifier here'), null);
  });

  it('the two RFCUNY Program Manager rows key identically on company+role', () => {
    const a = row(265, 'RFCUNY', 'Program Manager', 'JR3338 MARGINAL 3.6/5');
    const b = row(267, 'RFCUNY', 'Program Manager', 'JR178 APPLY - 4.1/5');
    assert.equal(keyOf(a), keyOf(b), 'this is exactly why the warning fired');
  });

  it('suppresses the warning when every row carries a different req', () => {
    const g = classifyDuplicateGroup([
      row(265, 'RFCUNY', 'Program Manager', 'JR3338 MARGINAL 3.6/5'),
      row(267, 'RFCUNY', 'Program Manager', 'JR178 APPLY - 4.1/5'),
    ]);
    assert.equal(g.verdict, 'distinct');
    assert.deepEqual(g.nums, ['3338', '178']);
  });

  it('still warns when the req numbers are identical', () => {
    // The same posting captured twice is a real duplicate; the fix must not hide it.
    const g = classifyDuplicateGroup([
      row(10, 'Acme', 'Program Manager', 'JR7788 first capture'),
      row(11, 'Acme', 'Program Manager', 'JR7788 second capture'),
    ]);
    assert.equal(g.verdict, 'possible-duplicate');
  });

  it('still warns when either row carries no req number', () => {
    const none = classifyDuplicateGroup([
      row(1, 'Acme', 'Program Manager', 'no id at all'),
      row(2, 'Acme', 'Program Manager', 'JR1234 has one'),
    ]);
    assert.equal(none.verdict, 'possible-duplicate');

    const both = classifyDuplicateGroup([
      row(3, 'Acme', 'Program Manager', 'nothing here'),
      row(4, 'Acme', 'Program Manager', 'nor here'),
    ]);
    assert.equal(both.verdict, 'possible-duplicate');
  });

  it('suppresses across a group of three or more distinct requisitions', () => {
    const g = classifyDuplicateGroup([
      row(1, 'Bank', 'L&D Specialist', 'R_1494379'),
      row(2, 'Bank', 'L&D Specialist', 'R_1488728'),
      row(3, 'Bank', 'L&D Specialist', 'R_1500001'),
    ]);
    assert.equal(g.verdict, 'distinct');
    assert.equal(g.nums.length, 3);
  });
});