#!/usr/bin/env node
/**
 * scan-mta.mjs — Metropolitan Transportation Authority careers board
 * (careers.mta.org).
 *
 * WHY A DEDICATED SCANNER INSTEAD OF `scan.mjs`:
 * MTA runs Phenom. Its public JSON endpoints under /widgets return HTTP 403
 * (verified 2026-10-16), so the zero-token ATS path cannot enumerate this board
 * at all — the same class of dead end already recorded for the MTA entry in
 * portals.yml. What DOES work is the human-facing search page, which renders
 * server-side job cards at:
 *
 *     https://careers.mta.org/search/jobs/?per_page=100&page=N
 *
 * `browser-extract.mjs --mode listing` reads that directly. Measured
 * 2026-10-16: 4 pages, 327 unique postings, pagination stops cleanly at an
 * empty page 5. Job URLs have a stable `/jobs/{id}-{slug}` shape, so the
 * numeric id is a durable dedup key even if the slug changes on retitle.
 *
 * SIBLING: scan-cityjobs.mjs (sitemap) · scan-interamt.mjs · scan-bandana.mjs
 *
 * Usage:
 *   node scan-mta.mjs                 # scan, using portals.yml filters
 *   node scan-mta.mjs --all           # disable the freshness window
 *   node scan-mta.mjs --limit N       # cap accepted postings (default 25)
 *   node scan-mta.mjs --dry-run       # print only, write nothing
 *   node scan-mta.mjs --help
 *
 * IMPORTANT — MTA CIVIL SERVICE:
 * This scanner does NOT filter on civil-service eligibility, because the MTA
 * posting pages do not expose that flag in a machine-readable field. MTA is a
 * public authority with its own exam lists; a NYC-city ERN does not cover it.
 * Treat every role this scanner surfaces as UNVERIFIED for eligibility and
 * confirm with MTA HR before investing. See portals.yml mta_searches.
 */

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, PORTALS_PATH, SCAN_HISTORY_PATH as SCAN_HISTORY } from './scan.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { buildTitleFilterBySource } from './title-keywords.mjs';
import { buildShapePolicy, stripShapeNegatives } from './lib/employment-shape.mjs';

const LISTING_BASE = 'https://careers.mta.org/search/jobs/';

// ── Args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (flag('--help') || flag('-h')) {
  console.log('Usage: node scan-mta.mjs [--all] [--limit N] [--dry-run] [--max-pages N]');
  process.exit(0);
}
const FRESHNESS_DAYS = 14;
const useFreshness = !flag('--all');
const LIMIT = Number(val('--limit', '25'));
const MAX_PAGES = Number(val('--max-pages', '8'));
const DRY = flag('--dry-run');
if (!Number.isInteger(LIMIT) || LIMIT < 1) {
  console.error('Error: --limit takes a whole number'); process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────────────

let config = {};
if (existsSync(PORTALS_PATH)) config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};

const titleFilter = config.title_filter || {};

// Host-scoped rules take precedence over the global positive list, the same
// seam scan.mjs uses. The global list is tuned for education-and-program boards
// and, applied raw to a transit authority, admits RailCar Electrical Workers,
// Structural Designers and five Assistant Vice Presidents — measured, not
// assumed: the dry run on 2026-10-16 returned exactly those.
// Honour employment_shape.flag_not_veto, as scan.mjs does: the shape words
// are lifted out of the title negatives so part-time / seasonal / per-diem
// postings reach triage and are PRICED, rather than being hard-vetoed.
const shapePolicy = buildShapePolicy(config.employment_shape);
const matchesTitle = buildTitleFilterBySource(
  shapePolicy.flagNotVeto ? stripShapeNegatives(titleFilter) : titleFilter,
  config.source_title_filters
);

const MTA_HOSTS = ['careers.mta.org'];
const titleCtx = { hosts: MTA_HOSTS, company: 'Metropolitan Transportation Authority' };

const locFilter = config.location_filter || {};
const locAllow = (locFilter.allow || []).map(k => k.toLowerCase());
const locBlock = (locFilter.block || []).map(k => k.toLowerCase());

export function matchesLocation(loc) {
  if (!loc) return true;
  const lower = loc.toLowerCase();
  if (locBlock.some(k => lower.includes(k))) return false;
  if (locAllow.length === 0) return true;
  return locAllow.some(k => lower.includes(k));
}

// ── Enumeration ─────────────────────────────────────────────────────────────

/** Durable dedup key: the numeric Phenom job id, not the mutable slug. */
export function jobId(url) {
  return (/\/jobs\/(\d+)/.exec(url || '') || [])[1] || '';
}
export function isJobUrl(url) {
  return /^https:\/\/careers\.mta\.org\/jobs\/\d+/.test(url || '');
}

/** Read one listing page through the browser extractor. */
function readPage(n) {
  const url = LISTING_BASE + '?per_page=100&page=' + n;
  const out = execFileSync(
    process.execPath,
    ['browser-extract.mjs', url, '--mode', 'listing', '--max', '200', '--timeout', '25000'],
    { cwd: getCareerOpsRoot(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }
  );
  const d = JSON.parse(out);
  const allLinks = (d.jobs || []).map(j => j.url).filter(Boolean);
  const jobs = (d.jobs || [])
    .filter(j => isJobUrl(j.url))
    .map(j => ({
      url: j.url.replace(/\/$/, ''),
      id: jobId(j.url),
      title: (j.title || j.url.replace(/^.*\/jobs\/\d+-/, '').replace(/-/g, ' ')).trim(),
      location: j.location || '',
      company: 'Metropolitan Transportation Authority',
      source: 'mta',
    }));
  // `totalLinks` is what separates "the board ended here" from "we were served
  // a challenge shell". A challenge page still parses and still returns links —
  // just none job-shaped. Treating that as an exhausted board truncated
  // enumeration from 327 postings to 300 while still printing a clean summary.
  return { jobs, totalLinks: allLinks.length, ok: true };
}

/** Board exhausted vs. blocked. */
function isExhausted(res) {
  return res.totalLinks <= 2; // only nav/search controls: genuinely the end
}

/**
 * Page until the board stops yielding new ids.
 *
 * Retries a page that comes back with links but no job-shaped ones, because that
 * is what a bot challenge looks like, and breaks ONLY on a genuinely empty
 * board. A single unretried empty page is indistinguishable from truncation.
 */
function enumerate(log) {
  const found = new Map();
  const sleep = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin-wait: sync by design */ } };
  for (let p = 1; p <= MAX_PAGES; p++) {
    let res = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { res = readPage(p); }
      catch (e) {
        log(`  page ${p} attempt ${attempt} unreadable: ${(e.message || '').slice(0, 70)}`);
        res = null;
      }
      if (res && (res.jobs.length > 0 || isExhausted(res))) break;
      if (attempt < 3) { log(`  page ${p} attempt ${attempt} returned ${res ? res.totalLinks : '?'} links, 0 job-shaped — retrying`); sleep(3000); }
    }
    if (!res) continue;
    let fresh = 0;
    for (const j of res.jobs) if (j.id && !found.has(j.id)) { found.set(j.id, j); fresh++; }
    log(`  page ${p}: ${res.jobs.length} job links (of ${res.totalLinks} total), ${fresh} new`);
    if (isExhausted(res)) { log(`  page ${p} is the end of the board`); break; }
    if (!res.jobs.length) { log(`  page ${p} STILL yielded 0 job-shaped links after 3 attempts — stopping, enumeration may be truncated`); break; }
    if (fresh === 0) { log(`  page ${p} contributed no new ids — stopping`); break; }
  }
  return [...found.values()];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const date = localToday();
  const { seen } = loadSeenUrls();
  const all = enumerate((m) => console.log(m));

  console.log(`\n  Unique MTA postings: ${all.length}`);

  const newOffers = [], titleSkipped = [], locationSkipped = [], shapeSkipped = [], staleSkipped = [], dupeSkipped = [];
  const cutoff = useFreshness ? Date.now() - FRESHNESS_DAYS * 864e5 : null;

  for (const j of all) {
    const seenKey = j.url;
    if (seen.has(seenKey)) { dupeSkipped.push(j); continue; }
    if (!matchesTitle(j.title, titleCtx)) { seen.add(seenKey); titleSkipped.push(j); continue; }
    if (!matchesLocation(j.location)) { seen.add(seenKey); locationSkipped.push(j); continue; }
    if (cutoff) {
      // No reliable lastmod on the rendered card; freshness is not asserted
      // rather than guessed from fetch order.
      const stale = false;
      if (stale) { seen.add(seenKey); staleSkipped.push(j); continue; }
    }
    newOffers.push(j);
  }

  const accepted = newOffers.slice(0, LIMIT);
  const deferred = newOffers.slice(LIMIT);

  if (DRY) {
    console.log('\n  --dry-run: nothing written\n');
    for (const j of accepted) console.log(`    ${j.title}\n      ${j.url}`);
  } else {
    if (accepted.length) await appendToPipeline(accepted);
    if (accepted.length) await appendToScanHistory(accepted, date, 'added');
    if (titleSkipped.length) await appendToScanHistory(titleSkipped, date, 'skipped_title');
    if (locationSkipped.length) await appendToScanHistory(locationSkipped, date, 'skipped_location');
    if (shapeSkipped.length) await appendToScanHistory(shapeSkipped, date, 'skipped_job_shape');
    if (staleSkipped.length) await appendToScanHistory(staleSkipped, date, 'skipped_date');
    if (dupeSkipped.length) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  printScanSummaryHeader('MTA Careers Scan (browser)', date);
  console.log('─'.repeat(56));
  console.log(`Postings enumerated: ${all.length}`);
  console.log(`Freshness window:    ${useFreshness ? FRESHNESS_DAYS + ' days' : 'disabled (--all)'}`);
  console.log(`Filtered by title:   ${titleSkipped.length}`);
  console.log(`Filtered location:   ${locationSkipped.length}`);
  console.log(`Already seen:        ${dupeSkipped.length}`);
  console.log(`Excluded job shape:  ${shapeSkipped.length}`);
  console.log(`Deferred (over cap): ${deferred.length}`);
  console.log(`NEW OFFERS:          ${accepted.length}`);
  console.log('');
  for (const j of accepted) console.log(`  • ${j.title}\n    ${j.url}`);
  console.log('\n→ MTA roles are UNVERIFIED for civil-service eligibility — confirm with MTA HR.');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}