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
import { buildTitleFilterBySource } from './title-keywords.mjs';
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

  const { seen } = loadSeenUrls();
  const accepted = [];
  const offLane = [];
  const dupe = [];
  const offRegion = [];

  for (const j of jobs) {
    const title = String(j.title || '').trim();
    const url = String(j.url || '').trim();
    if (!title || !url) continue;
    if (seen.has(normalizeUrlForDedup(url))) { dupe.push({ url, title }); continue; }
    if (!ALL && !matchesTitle(title, { hosts: HOSTS, company: COMPANY })) { offLane.push({ url, title }); continue; }
    if (!matchesLocation(j.location, url, title)) { offRegion.push({ url, title, location: j.location }); continue; }
    accepted.push({ url, title, company: COMPANY, location: j.location || '', source: 'nyc-smartrecruiters' });
  }

  console.log(`  Passing the lane filter: ${accepted.length}`);
  console.log(`  Filtered off-lane:      ${offLane.length}`);
  console.log(`  Filtered off-region:    ${offRegion.length}`);
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
    if (dupe.length) await appendToScanHistory(dupe, localToday(), 'skipped_dup');
  }

  printScanSummaryHeader(COMPANY, localToday());
  console.log('─'.repeat(56));
  console.log(`Board postings:     ${jobs.length}`);
  console.log(`Filtered off-lane:  ${offLane.length}`);
  console.log(`Filtered off-region:${String(offRegion.length).padStart(4)}`);
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
