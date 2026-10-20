#!/usr/bin/env node
/**
 * scan-nyc-smartrecruiters.mjs — the citywide NYC SmartRecruiters tenant.
 *
 * WHY A SEPARATE SCANNER: `jobs.smartrecruiters.com/CityOfNewYork` is ONE
 * tenant carrying every NYC agency that posts through SmartRecruiters. It is
 * not the cityjobs.nyc.gov board (the tracker rows for Parks live there) and it
 * is not a Parks board: measured 2026-10-19, only 3 of its 1,194
 * filter-passing titles mention Parks or Recreation. The bureau spread is
 * Health, Early Intervention, Childcare, Alcohol, Controller, Revenue, HR and
 * Budget. Found via `scan-ats-full --history-seeds`, where the seed inherited
 * a tracker row's company label and so first surfaced as "City of New York
 * (Parks)" — a wrong-entity board.
 *
 * WHY NOT scan.mjs: scan.mjs does not consult `source_title_filters`, and the
 * global title list carries bare "Manager", "Director", "Project", "Analyst",
 * "Specialist", "Coordinator" and "Operations". On a citywide municipal board
 * that admits 1,194 of 1,689 postings — Deputy Director of Budget, capital
 * Project Manager, and every "Program Manager, Bureau of ..." — all senior
 * civil-service posts the record cannot reach. That is the flood the
 * builtinnyc archive measured: 40% of the tracker, 6.1% of the applications.
 * The lane rule for this host in portals.yml names the lane explicitly
 * instead, which keeps 178 postings in 103 distinct titles.
 *
 * THE API IS ONE CALL. The SmartRecruiters provider returns the whole tenant
 * in a single JSON response, so this scanner costs one request per run and
 * needs no browser.
 *
 * ONE CAVEAT: this board exposes NO posting date. Every entry reads "n/a" for
 * postedAt. So there is no age signal here at all — a posting on this board
 * may have been open for a day or for a year. Verify liveness at the employer
 * before treating a match as live; the scanner does not claim otherwise.
 *
 * SIBLING: scan-cityjobs.mjs — scan-nystate.mjs — scan-mta.mjs — scan-usajobs.mjs
 *
 * Usage:
 *   node scan-nyc-smartrecruiters.mjs                 # scan the tenant
 *   node scan-nyc-smartrecruiters.mjs --dump          # list matches, write nothing
 *   node scan-nyc-smartrecruiters.mjs --all-postings  # bypass the lane (audit)
 *   node scan-nyc-smartrecruiters.mjs --dry-run       # preview without writing
 */

import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import {
  appendToPipeline,
  appendToScanHistory,
  loadSeenUrls,
  normalizeUrlForDedup,
  buildLocationFilter,
  buildTitleFilter,
  PORTALS_PATH,
} from './scan.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { buildTitleFilterBySource, compileKeyword, foldTitle } from './title-keywords.mjs';
import { buildShapePolicy, stripShapeNegatives } from './lib/employment-shape.mjs';
import smartrecruiters from './providers/smartrecruiters.mjs';
import { makeHttpCtx } from './providers/_http.mjs';

const HOSTS = ['jobs.smartrecruiters.com'];
const TENANT = 'CityOfNewYork';

// ── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const DUMP = flag('--dump');
const DRY = flag('--dry-run');
const ALL = flag('--all-postings');

// ── Config ──────────────────────────────────────────────────────────────────
let config = {};
if (existsSync(PORTALS_PATH)) config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};

// The board comes from portals.yml so the config stays single-sourced.
const entry = (config.tracked_companies || []).find(
  (c) => /jobs\.smartrecruiters\.com\/CityOfNewYork/i.test(c.careers_url || '')
);
if (!entry) {
  console.error('  ! No tracked_companies entry for jobs.smartrecruiters.com/CityOfNewYork in portals.yml.');
  process.exit(1);
}
const COMPANY = entry.name || 'City of New York (All Agencies)';

// Honour employment_shape.flag_not_veto, as scan.mjs does: the shape words are
// lifted out of the title negatives so part-time / seasonal / per-diem postings
// reach triage and are PRICED rather than hard-vetoed.
const shapePolicy = buildShapePolicy(config.employment_shape);
const matchesTitle = buildTitleFilterBySource(
  shapePolicy.flagNotVeto ? stripShapeNegatives(config.title_filter || {}) : config.title_filter || {},
  config.source_title_filters
);
const matchesLocation = buildLocationFilter(config.location_filter);

// `exclude_titles` on the tracked_companies entry: titles vetoed on THIS
// BOARD, whatever route the posting took in.
//
// WHY IT CANNOT LIVE IN THE TITLE FILTER: the lane test is
//
//     matchesTitle(...) || codeAllowed(j)
//
// and the title_codes branch is an OR-escape hatch. A 56058 posting is
// admitted REGARDLESS of what the title filter says -- the family enters by
// code, so a `negative:` entry on the source_title_filters rule can never
// reach it. The never-target lane needs a veto applied AFTER the OR.
//
// Measured 2026-10-20 against the whole tenant: 14 postings dropped, the
// admitted set 274 -> 260, and of the 87 evaluated 56058 postings the 7
// dropped all scored 2.0-3.6 -- none at 4.0 or above, so no top candidate is
// lost. RECALL: of his 61 applications, the 2 with an EA title are on other
// boards (cityjobs, Bandana), so a board-scoped veto touches neither.
const EXCLUDE_TITLES = (entry.exclude_titles || []).map((t) => String(t).trim()).filter(Boolean);
const excludeMatchers = EXCLUDE_TITLES.map((t) => compileKeyword(foldTitle(t)));
const isExcluded = (title) => {
  if (excludeMatchers.length === 0) return false;
  const lower = foldTitle(String(title || ''));
  return excludeMatchers.some((m) => m(lower));
};

// GUARD: the lane rule must actually fire for this tenant. The rule is keyed
// on the company, not the host (jobs.smartrecruiters.com is multi-tenant and
// also carries Sportradar), so renaming the portals.yml entry would silently
// stop the rule applying -- and the global list's bare "Manager"/"Director"
// would put 1,194 postings into the queue again. A rule that quietly stops
// working is worse than one that is absent, because nothing reports it.
// Detect it here, on the postings about to be read.
//
// "Deputy Director of Budget" is the probe: the global list ACCEPTS it (bare
// "Director" is a global positive) and the lane rule REJECTS it ("Deputy
// Director"). If the two verdicts agree, the rule did not fire.
const PROBE = 'Deputy Director of Budget';
function laneRuleFires() {
  const base = buildTitleFilter(config.title_filter || {});
  const baseVerdict = base(PROBE);
  const ruleVerdict = matchesTitle(PROBE, { hosts: HOSTS, company: COMPANY });
  return !(baseVerdict === ruleVerdict);
}

// GUARD for the title veto, on the same principle: a rule that quietly stops
// working is worse than one that is absent, because nothing reports it.
//
// The probe is a title the LANE ACCEPTS and the veto must REJECT. "Executive
// Assistant" is on the board's own positive list, so `matchesTitle` accepts it;
// if the veto does not reject it, the veto is not applied.
//
// This also catches the subtler failure: a veto that is wired into the title
// filter rather than after the OR would reject it too, and the 56058 postings
// would keep coming in through the title_codes branch. The guard only proves
// the veto rejects the probe; the COUNT in the run summary is what proves it
// is applied after the OR.
const VETO_PROBE = 'Executive Assistant';
function titleVetoFires() {
  if (EXCLUDE_TITLES.length === 0) return true;   // no veto configured - nothing to prove
  const laneAccepts = matchesTitle(VETO_PROBE, { hosts: HOSTS, company: COMPANY });
  const vetoRejects = isExcluded(VETO_PROBE);
  return laneAccepts && vetoRejects;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const ctx = makeHttpCtx();
  let jobs;
  try {
    jobs = await smartrecruiters.fetch(
      { name: COMPANY, careers_url: entry.careers_url, provider: 'smartrecruiters' },
      ctx
    );
  } catch (err) {
    console.error(`  ! board unreadable: ${err.message}`);
    process.exit(1);
  }

  console.log(`  Board: ${entry.careers_url}`);
  console.log(`  Postings on the board: ${jobs.length}`);

  if (!laneRuleFires()) {
    console.error('  ! The source_title_filters lane for this tenant is NOT firing.');
    console.error(`    Rule match_companies must contain "${COMPANY}".`);
    console.error('    Continuing anyway would put the global list\'s bare "Manager"/"Director"');
    console.error('    into the queue. Fix the config, or pass --all-postings to bypass the lane.');
    process.exit(1);
  }
  console.log('  Lane rule: firing (verified)');

  if (!titleVetoFires()) {
    console.error('  ! The exclude_titles veto for this tenant is NOT firing.');
    console.error(`    The veto list is ${JSON.stringify(EXCLUDE_TITLES)} and it does not reject`);
    console.error(`    "${VETO_PROBE}", which the lane accepts. The never-target lane will keep`);
    console.error('    re-entering the queue. Fix the config, or remove the veto deliberately.');
    process.exit(1);
  }
  console.log(`  Title veto: firing (verified) - ${EXCLUDE_TITLES.length} title pattern(s)`);

  const { seen } = loadSeenUrls();
  const accepted = [];
  const offLane = [];
  const dupe = [];
  const offRegion = [];
  const excluded = [];

  // A CIVIL SERVICE TITLE CODE is a stronger lane signal than the business
  // title. A posting bound to COMMUNITY COORDINATOR - 56058 can carry any
  // business title -- "Program Counselor", "Capital Analyst", "EAP Counselor" --
  // so a title-based rule misses most of the family. modes/_profile.md names
  // 56058 as "the one live thread ... the only cluster where the record has
  // standing". `title_codes` on the tracked_companies entry lists the codes
  // that count as in-lane regardless of the business title.
  const titleCodes = (entry.title_codes || []).map((c) => String(c).trim()).filter(Boolean);
  const codeAllowed = (j) => titleCodes.length > 0 && j.titleCode !== undefined
    && titleCodes.includes(String(j.titleCode).trim());

  for (const j of jobs) {
    const title = String(j.title || '').trim();
    const url = String(j.url || '').trim();
    if (!title || !url) continue;
    if (seen.has(normalizeUrlForDedup(url))) { dupe.push({ url, title }); continue; }
    const inLane = matchesTitle(title, { hosts: HOSTS, company: COMPANY }) || codeAllowed(j);
    if (!inLane) { offLane.push({ url, title }); continue; }
    // The veto runs AFTER the OR, because the code branch would otherwise
    // re-admit everything the title filter rejected.
    if (isExcluded(title)) { excluded.push({ url, title }); continue; }
    if (!matchesLocation(j.location, url, title)) { offRegion.push({ url, title, location: j.location }); continue; }
    accepted.push({
      url, title, company: COMPANY, location: j.location || '', source: 'nyc-smartrecruiters',
      ...(j.titleCode !== undefined ? { titleCode: j.titleCode } : {}),
      ...(j.postedOn ? { postedOn: j.postedOn } : {}),
      ...(j.expireOn ? { expireOn: j.expireOn } : {}),
      ...(j.applicantType ? { applicantType: j.applicantType } : {}),
      ...(j.jobType ? { jobType: j.jobType } : {}),
    });
  }

  console.log(`  Passing the lane filter: ${accepted.length}`);
  console.log(`  Filtered off-lane:      ${offLane.length}`);
  console.log(`  Filtered off-region:    ${offRegion.length}`);
  console.log(`  Vetoed by title:        ${excluded.length}`);
  console.log(`  Already seen:           ${dupe.length}`);

  if (DUMP) {
    console.log('\n  === MATCHES ===\n');
    accepted
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .forEach((j) => console.log(`   ${j.title.slice(0, 66).padEnd(68)}${j.location}`));
    return;
  }

  if (!DRY && accepted.length) {
    await appendToPipeline(accepted);
    await appendToScanHistory(accepted, localToday(), 'added');
    if (offLane.length) await appendToScanHistory(offLane, localToday(), 'skipped_title');
    if (offRegion.length) await appendToScanHistory(offRegion, localToday(), 'skipped_location');
    // `dupe` is deliberately NOT written to scan-history.
    //
    // A posting that is ALREADY recorded does not need a second row saying so.
    // Writing one for every previously-seen posting grew the file by ~1,700 rows
    // on every run, and -- worse -- it made the "seen" set self-reinforcing: a
    // posting that a later rule change would have admitted had already
    // acquired a skipped_dup row, which counts as seen, so it could never be
    // re-offered. That is how 89 postings of the 56058 family went missing
    // from a lane whose rule matched them.
  }

  printScanSummaryHeader(COMPANY, localToday());
  console.log('─'.repeat(56));
  console.log(`Board postings:     ${jobs.length}`);
  console.log(`Filtered off-lane:  ${offLane.length}`);
  console.log(`Filtered off-region:${String(offRegion.length).padStart(4)}`);
  console.log(`Vetoed by title:  ${String(excluded.length).padStart(4)}`);
  console.log(`Already seen:       ${dupe.length}`);
  console.log(`NEW OFFERS:         ${accepted.length}`);
  console.log('');
  accepted
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach((j) => console.log(`  • ${j.title}  [${j.location}]`));
  console.log('\n→ This board exposes NO posting date, so there is no age signal: a');
  console.log('  posting here may be a day old or a year old. Verify liveness at the');
  console.log('  employer before treating a match as live.');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
