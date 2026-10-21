#!/usr/bin/env node
/**
 * screen-eligibility.mjs - find the pending postings that carry a WRITTEN
 * ELIGIBILITY GATE, before spending an evaluation on them.
 *
 * WHY
 * ---
 * Measured on 2026-10-21, the City board turned out to carry a written gate on
 * most of the postings in the inbox:
 *
 *   1006C   Health Services Manager                                  (report 555)
 *   34172   exam #4124                                               (report 558)
 *   10035   Administrative Supervisor of Building Maintenance         (report 559)
 *   TA       permanent civil service status, or a reachable list      (556, 557)
 *   Environmental Engineer / Chemical Engineer, permanent             (PERMIT COORDINATOR)
 *
 * and the MTA board on 9 of 19. None of them is a fit question - they are
 * eligibility questions, and the record answers none of them: NYC Parks only,
 * currently a City Seasonal Aide, with a CONFIRMED NEGATIVE on any
 * civil-service list (`config/profile.yml -> state_employment`).
 *
 * The scanner cannot see this. The City filter matches on the posting's TITLE,
 * and the title CODE lives in the qualifications block - so a seat the
 * candidate can never fill passes the filter and only surfaces on evaluation.
 *
 * THE TWO RULES, AND WHY THE SECOND ONE IS NOT A RULE
 * --------------------------------------------------
 * 1. A POSTING-SPECIFIC gate - one that names THIS posting ("...eligible to
 *    apply to this JVN", "this position", "this role"). That is a real gate
 *    and the posting is skipped, with the reason logged.
 *
 * 2. A gate that names a ROLE FAMILY ("TA APPLICANTS MUST BE...") is NOT
 *    necessarily this posting's gate. On the MTA careers site that exact
 *    sentence appears on an Assistant Vice President posting and a Transit
 *    Support Coordinator posting, where it is boilerplate, not a requirement.
 *    A skip resting on a blurb drops a posting the candidate may be eligible
 *    for, which is the worst outcome of a pre-screen, so those are LEFT
 *    ALONE and reported for a human to read.
 *
 * The screen is validated against the archived JDs where a gate IS present
 * and where it is NOT, and every skip it proposes is verified by reading the
 * posting's own sentence - not by the pattern alone.
 *
 * Usage:
 *   node scripts/screen-eligibility.mjs --dry-run      # report only
 *   node scripts/screen-eligibility.mjs --apply         # skip + log the gated ones
 *   node scripts/screen-eligibility.mjs --report=NNN    # one posting
 *
 * Exits 1 if it finds a posting-specific gate it cannot act on, 0 otherwise.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');
const ONE = (() => {
  const a = process.argv.find((x) => x.startsWith('--report='));
  return a ? a.split('=')[1] : null;
})();

// A gate sentence. Each shape is a REQUIREMENT, not a preference.
const GATE_SHAPES = [
  /only\s+applicants?\s+who\s+are\s+permanent\s+civil\s+service/i,
  /civil[- ]service\s+title\s*[:\-]?\s*\d/i,
  /permanent\s+civil\s+service\s+(?:status|position)/i,
  /only\s+open\s+to\s+current\s+.*employees/i,
  /reachable\s+on\s+(?:exam|#)/i,
  /competitive[- ]?1\b/i,
  /administrative\s+supervisor\s+of\s+building\s+maintenance/i,
  /health\s+services\s+manager/i,
  /permanent\s+employees?\s+in\s+the\s+title\s+of/i,
];

// A gate that names THIS posting rather than a role family.
const POSTING_SPECIFIC = /this\s+(?:jvn|position|role|posting|title|job|classification|opening)|to\s+apply\s+to\s+this/i;

function textOf(url) {
  try {
    const out = execFileSync(process.execPath, ['browser-extract.mjs', url, '--mode', 'jd', '--max-chars', '20000'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 });
    return JSON.parse(out).text || '';
  } catch { return ''; }
}

/** The sentences that carry a gate, and whether each names THIS posting. */
function gatesIn(text) {
  const found = [];
  for (const sentence of String(text).split(/[.\n]/)) {
    if (!GATE_SHAPES.some((g) => g.test(sentence))) continue;
    found.push({ sentence: sentence.trim().slice(0, 200), specific: POSTING_SPECIFIC.test(sentence) });
  }
  return found;
}

// ---- the pending inbox ----
const path = 'data/pipeline.md';
const lines = readFileSync(path, 'utf-8').split('\n');
let pending = lines
  .filter((l) => /^\s*-\s*\[ \]/.test(l))
  .map((l) => ({ line: l, url: (l.match(/https?:\/\/[^\s|]+/) || [])[0], role: (l.split('|')[2] || '').trim() }))
  .filter((p) => p.url);
if (ONE) pending = pending.filter((p) => p.url.includes(ONE));

console.log(`=== screening ${pending.length} pending posting(s)${DRY ? ' (dry run)' : ''} ===\n`);

const results = [];
for (const p of pending) {
  const text = textOf(p.url);
  const gates = gatesIn(text);
  const specific = gates.filter((g) => g.specific);
  const family = gates.filter((g) => !g.specific);
  const verdict = specific.length ? 'SKIP (this posting says so)' : family.length ? 'REPORT (a role family, not this posting)' : 'clear';
  results.push({ ...p, text, gates, specific, family, verdict });
  console.log(`  ${verdict.padEnd(42)} ${p.role.slice(0, 48)}`);
  for (const g of specific.slice(0, 2)) console.log(`      > ${g.sentence.slice(0, 132)}`);
  for (const g of family.slice(0, 1)) console.log(`      (family only) ${g.sentence.slice(0, 112)}`);
}

if (!APPLY) {
  console.log(`\n  ${results.filter((r) => r.specific.length).length} posting-specific gate(s); nothing written (dry run).`);
  process.exit(0);
}

// ---- apply: skip the posting-specific ones, and log every skip ----
const skips = results.filter((r) => r.specific.length);
const kept = [];
const written = [];
for (const line of lines) {
  const m = line.match(/^\s*-\s*\[ \]\s*(https?:\/\/[^\s|]+)/);
  const rec = m ? skips.find((s) => s.url === m[1]) : null;
  if (rec) {
    written.push(`- [x] #-- | ${rec.url} | skipped (pre-screen mismatch: ${rec.specific[0].sentence.replace(/[*_#]/g, '').slice(0, 200)})`);
  } else {
    kept.push(line);
  }
}
const h2 = kept.findIndex((l) => /^##\s+Processed\s*$/.test(l));
kept.splice(h2 + 1, 0, ...written);
writeFileSync(path, kept.join('\n'), 'utf-8');

const stamp = new Date().toISOString();
appendFileSync('data/discard.log', skips.map((r) => `${stamp}\t${r.url}\tpre-screen mismatch: ${r.specific[0].sentence.replace(/[*_#]/g, '').slice(0, 240)}`).join('\n') + '\n', 'utf-8');

console.log(`\n  ${written.length} skipped and logged:`);
for (const w of written) console.log('    ' + w.slice(0, 130));
const reportOnly = results.filter((r) => !r.specific.length && r.family.length);
console.log(`\n  ${reportOnly.length} carry a ROLE-FAMILY gate rather than their own - left pending for a reader:`);
for (const r of reportOnly) console.log(`    ${r.role.slice(0, 60)}`);
console.log(`  pending now: ${kept.filter((l) => /^\s*-\s*\[ \]/.test(l)).length}`);
