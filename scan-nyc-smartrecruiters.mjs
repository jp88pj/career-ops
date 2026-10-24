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
 * THE BOARD CARRIES DATES. This scanner used to say the opposite — "this
 * board exposes NO posting date ... there is no age signal here at all" —
 * and the claim was false. The SmartRecruiters list payload carries them as
 * custom fields, "Posted On Date" and "Expire Date"; the provider reads both
 * (providers/smartrecruiters.mjs) and the scanner passes the posted date into
 * the pipeline row as `posted:`, so the age signal IS there.
 *
 * MEASURED 2026-10-22 against the whole tenant: 1,653 of 1,654 postings
 * carry a Posted On Date and 1,643 carry an Expire Date (an earlier count on
 * the 1,626-posting tenant read 1,625 and 1,615 — the same shape, one
 * posting short at each end).
 *
 * WHAT A DATE DOES NOT DO: it is the BOARD's own account of the posting, not
 * a liveness probe. A posting past its Expire Date is closed by the
 * employer's own record; one whose Expire Date is still ahead can have been
 * filled anyway. Verify liveness at the employer before treating a match as
 * live; the scanner does not claim otherwise.
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

// The board's "Posted On Date" as epoch milliseconds, or undefined when the
// posting carries no date. UTC midnight, so the rendered YYYY-MM-DD is the
// board's own date rather than the local calendar day.
const postedAtOf = (iso) => {
  if (!iso) return undefined;
  const ms = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
};

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

  // THE TITLE CLASSIFICATION - the City's own statement of whether the seat
  // needs an EXAM, and therefore the eligibility question the code cannot
  // answer on its own.
  //
  // WHY A VETO AND NOT A GATE. The title_codes list is an ESCAPE: a 56058
  // posting is admitted regardless of what the title filter says, because 131
  // COMMUNITY COORDINATOR postings carry 124 distinct business titles. So
  // "the code decides" would throw away seats the list does not name.
  //
  // WHY THE VETO IS NEEDED AT ALL. The title branch admits on the BUSINESS
  // title, and a business title says nothing about eligibility. Measured
  // 2026-10-21: a Dual Recovery Coordinator posting bound to title code
  // 1006C was admitted because "Coordinator" matches a positive, and a
  // Quality Assurance Specialist bound to 34172 was admitted because
  // "Specialist" does - both are "Competitive-1", both need an exam the record
  // cannot reach, and both were evaluated to a written qualification gate
  // before anyone noticed.
  //
  // So: a seat that needs an exam is in-lane ONLY if the code is one he can
  // reach. A seat that needs no exam is in-lane on the title, as before.
  const examRequired = (j) => /^competitive/i.test(String(j.titleClassification || '').trim())
    || /exam\s+required/i.test(String(j.titleClassification || '').trim());

  for (const j of jobs) {
    const title = String(j.title || '').trim();
    const url = String(j.url || '').trim();
    if (!title || !url) continue;
    if (seen.has(normalizeUrlForDedup(url))) { dupe.push({ url, title }); continue; }
    const inLane = (examRequired(j) && !codeAllowed(j))
      ? false
      : (matchesTitle(title, { hosts: HOSTS, company: COMPANY }) || codeAllowed(j));
    if (!inLane) { offLane.push({ url, title }); continue; }
    // The veto runs AFTER the OR, because the code branch would otherwise
    // re-admit everything the title filter rejected.
    if (isExcluded(title)) { excluded.push({ url, title }); continue; }
    if (!matchesLocation(j.location, url, title)) { offRegion.push({ url, title, location: j.location }); continue; }
    // The board's posted date, carried into the pipeline row.
    //
    // The board publishes it as a YYYY-MM-DD string ("Posted On Date"), but
    // the pipeline row's `posted:` segment is rendered from epoch
    // milliseconds (formatPipelineOffer -> postedAtIsoDate), so the string
    // alone never reached the row: the row carried NO date, which is why this
    // scanner claimed the board had no age signal. Converted here, at UTC
    // midnight, so the rendered date is the board's own date and not the local
    // calendar day.
    const postedAt = postedAtOf(j.postedOn);
    accepted.push({
      url, title, company: COMPANY, location: j.location || '', source: 'nyc-smartrecruiters',
      ...(j.titleCode !== undefined ? { titleCode: j.titleCode } : {}),
      ...(j.postedOn ? { postedOn: j.postedOn } : {}),
      ...(j.expireOn ? { expireOn: j.expireOn } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
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
  // The age signal, stated as a measurement rather than as a claim.
  const boardPosted = jobs.filter((j) => j.postedOn).length;
  const boardExpire = jobs.filter((j) => j.expireOn).length;
  const offerPosted = accepted.filter((j) => j.postedOn).length;
  console.log(`Posted On Date:     ${boardPosted}/${jobs.length} postings`);
  console.log(`Expire Date:        ${boardExpire}/${jobs.length} postings`);
  console.log('');
  accepted
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach((j) => console.log(`  • ${j.title}  [${j.location}]`));
  console.log('');
  console.log(`→ This board DOES carry dates: ${boardPosted} of its ${jobs.length} postings publish`);
  console.log(`  a Posted On Date (all ${offerPosted} new offers above reach the pipeline row as`);
  console.log(`  \`posted:\`), and ${boardExpire} publish an Expire Date. A posting past its`);
  console.log('  Expire Date is closed by the employer\'s own record; one still inside it can');
  console.log('  have been filled, so verify liveness at the employer before treating a match');
  console.log('  as live.');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
