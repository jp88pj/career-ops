// Pure cumulative-stage contract shared by CLI statistics and web views.
// No filesystem access: the caller chooses the tracker and its sibling ledger.
const RANKS = new Map([
  ['APPLIED', 1], ['RESPONDED', 2], ['REJECTED', 2],
  ['INTERVIEW', 3], ['OFFER', 4], ['HIRED', 5],
  // LAPSED ranks 1, alongside APPLIED, and never 2. An application was sent
  // for it, so it belongs in everApplied's denominator; but "no employer
  // response and no follow-up sent" is the definition of the state, so it can
  // never count as a response. Ranking it 0 (the default for an unmapped
  // status) would quietly remove those rows from the funnel denominator and
  // raise the reported response rate -- a reclassification that flatters the
  // number it was meant to correct.
  ['LAPSED', 1],
]);

export function funnelStageRank(status) {
  return RANKS.get(String(status ?? '').trim().toUpperCase()) || 0;
}

/** Parse {num}\t{date}\t{from}\t{to} observations, ignoring torn rows. */
export function parseStatusLogStages(content) {
  const out = [];
  for (const line of String(content ?? '').replace(/\r/g, '').split('\n')) {
    const [rawNum, date, from, to] = line.split('\t').map(s => s.trim());
    if (!/^\d+$/.test(rawNum || '') || !date || !from || !to) continue;
    out.push({ num: Number(rawNum), from, to });
  }
  return out;
}

/** Highest observed stage per distinct current tracker identity.
 * Non-numeric identities can retain snapshot counts but never join the ledger.
 * Current SKIP rows remain outside the funnel regardless of their history.
 */
export function recoverFunnelStages(statusByNum, ledger) {
  const reached = new Map();
  const bump = (num, status) => reached.set(num, Math.max(reached.get(num) || 0, funnelStageRank(status)));
  for (const [num, status] of statusByNum) {
    if (String(status ?? '').trim().toUpperCase() !== 'SKIP') bump(num, status);
  }
  for (const { num, from, to } of ledger) {
    if (!reached.has(num)) continue;
    bump(num, from);
    bump(num, to);
  }
  return reached;
}
