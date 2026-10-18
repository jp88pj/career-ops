#!/usr/bin/env node
/**
 * scan-teamworkonline.mjs — TeamWork Online, the sports/entertainment job board.
 *
 * WHY: measured 2026-10-17, the eight big US sports companies already tracked
 * (MLB, MLB Network, Mets, NHL, DAZN, Hudl, FloSports, Sportradar) hold 354
 * postings between them and contain ZERO safety, security, event-operations or
 * venue roles. They post league-office corporate work. TeamWork Online covers
 * the long tail those boards miss — arenas, venue management companies, event
 * services agencies and minor-league venues — and its first probe already
 * surfaced "In-house Security" (Key Bank Center), "Building Security Manager"
 * (Delta Center) and "Sports League Program Manager".
 *
 * READ PATH — Cloudflare, so a browser is mandatory:
 *   Plain HTTPS returns HTTP 403 with the "Just a moment..." interstitial on
 *   every path, including /jobs/. `browser-extract.mjs` passes the challenge
 *   cleanly, so every fetch here shells out to it. This is the cost: roughly
 *   3-6 seconds per page, versus one request for an ATS board. Budget for it.
 *
 *   robots.txt disallows ONLY /cdn-cgi/. Job pages are not disallowed.
 *
 * STRUCTURE (measured, not assumed):
 *   /<category>-jobs/                      category index -> list of EMPLOYERS
 *   /<category>-jobs/<emp>/<emp>-jobs      employer page  -> list of JOBS
 *   /<category>-jobs/<emp>/<emp>-jobs/<slug>              job detail
 *
 * CROSS-LINKING IS WHY THIS IS CHEAPER THAN EXPECTED:
 *   Employer pages are not isolated — they link out to jobs at OTHER employers
 *   and in OTHER categories. The Arena Network page alone returned 46 job URLs
 *   spanning Allied Universal Event Services, Sports Facilities Companies and
 *   the Delta Center. A 5-page probe yielded 100 unique jobs. The full 2-level
 *   crawl therefore returns far more unique postings than it fetches pages, and
 *   no page needs fetching twice.
 *
 *   Two dead ends, recorded so nobody retries them:
 *     - No sitemap. /sitemap.xml, /sitemap_index.xml and /job-sitemap.xml all 404.
 *     - ?search= is IGNORED. safety / security / event operations all returned
 *       the identical employer index, because search is client-side only. Do not
 *       spend a request on it; filter locally instead.
 *
 * SIBLING: scan-builtinnyc.mjs · scan-mta.mjs · scan-nystate.mjs · scan-usajobs.mjs
 *
 * Usage:
 *   node scan-teamworkonline.mjs                 # operations-heavy categories
 *   node scan-teamworkonline.mjs --all-categories
 *   node scan-teamworkonline.mjs --dump
 *   node scan-teamworkonline.mjs --max-employers N   # cap per category (default 40)
 *   node scan-teamworkonline.mjs --dry-run
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, normalizeUrlForDedup, PORTALS_PATH } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { buildTitleFilterBySource } from './title-keywords.mjs';

const ROOT = process.cwd();
const HOSTS = ['www.teamworkonline.com'];

// Operations-heavy categories first: venues, event services, agencies. These are
// where safety/security/event-ops live. Team categories are league-office
// marketing and are deprioritised for that reason, not because they are unreadable.
const OPS_CATEGORIES = ['arenas-facilities-jobs', 'agency-jobs', 'multiple-properties', 'youth-sports-jobs'];
const ALL_CATEGORIES = [...OPS_CATEGORIES, 'sports-technology-jobs', 'basketball-jobs', 'hockey-jobs',
  'baseball-jobs', 'football-jobs', 'motorsports-jobs', 'golf-tennis-jobs'];

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DUMP = flag('--dump');
const DRY = flag('--dry-run');
const MAX_EMPLOYERS = Number(val('--max-employers', '40'));
const CATEGORIES = flag('--all-categories') ? ALL_CATEGORIES : OPS_CATEGORIES;

// ── Config ───────────────────────────────────────────────────────────────────
let config = {};
if (existsSync(PORTALS_PATH)) config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
const matchesTitle = buildTitleFilterBySource(config.title_filter || {}, config.source_title_filters);

// ── Browser fetch ────────────────────────────────────────────────────────────
let fetches = 0;
function fetchLinks(url) {
  fetches++;
  const out = execFileSync(
    'node',
    ['browser-extract.mjs', url, '--mode', 'listing', '--max', '150', '--timeout', '45000'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }
  );
  return JSON.parse(out).jobs || [];
}

const segs = (u) => { try { return new URL(String(u)).pathname.split('/').filter(Boolean); } catch { return []; } };

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const found = new Map();
  const employersSeen = new Set();

  for (const cat of CATEGORIES) {
    const catUrl = `https://www.teamworkonline.com/${cat}/`;
    let catLinks;
    try { catLinks = fetchLinks(catUrl); }
    catch (e) { console.error(`  ${cat}: category page unreadable (${(e.message || '').slice(0, 50)})`); continue; }

    const here = new URL(catUrl).pathname.replace(/\/$/, '');
    const employers = catLinks
      .filter((j) => {
        const s = segs(j.url);
        return s.length === 3 && s[0] === cat && new URL(j.url).pathname.replace(/\/$/, '') !== here;
      })
      .slice(0, MAX_EMPLOYERS)
      .map((j) => j.url);

    console.log(`  ${cat}: ${employers.length} employers`);

    for (const empUrl of employers) {
      if (employersSeen.has(empUrl)) continue;
      employersSeen.add(empUrl);
      let links;
      try { links = fetchLinks(empUrl); }
      catch { continue; } // one dead employer page must not stop the crawl
      const empPath = new URL(empUrl).pathname.replace(/\/$/, '');
      for (const j of links) {
        if (/#/.test(String(j.url))) continue;
        const s = segs(j.url);
        if (s.length < 3 || !s[0].endsWith('-jobs')) continue;
        if (new URL(j.url).pathname.replace(/\/$/, '') === empPath) continue;
        const title = String(j.title || '').trim();
        if (title.length < 4) continue;
        const url = String(j.url).replace(/\/$/, '');
        if (!found.has(url)) found.set(url, { url, title, category: s[0], employerPath: empPath });
      }
    }
  }

  const all = [...found.values()];
  console.log(`\n  Browser fetches: ${fetches}`);
  console.log(`  Unique jobs discovered: ${all.length}`);

  const { seen } = loadSeenUrls();
  const accepted = [], offLane = [], dupe = [];
  for (const j of all) {
    if (seen.has(normalizeUrlForDedup(j.url))) { dupe.push(j); continue; }
    if (!matchesTitle(j.title, { hosts: HOSTS, company: '' })) { offLane.push(j); continue; }
    accepted.push(j);
  }

  console.log(`  Passing title filter: ${accepted.length}`);

  if (DUMP) {
    console.log('\n  === MATCHES ===\n');
    accepted.forEach((j) => console.log(`   ${j.title.slice(0, 62).padEnd(64)}${j.category}`));
    return;
  }

  const rows = accepted.map((j) => ({
    url: j.url, title: j.title, company: 'TeamWork Online (sports/entertainment)',
    location: '', source: 'teamworkonline',
  }));

  if (!DRY && rows.length) {
    await appendToPipeline(rows);
    await appendToScanHistory(rows, localToday(), 'added');
    if (offLane.length) await appendToScanHistory(offLane.map((j) => ({ url: j.url, title: j.title })), localToday(), 'skipped_title');
    if (dupe.length) await appendToScanHistory(dupe.map((j) => ({ url: j.url, title: j.title })), localToday(), 'skipped_dup');
  }

  printScanSummaryHeader('TeamWork Online (sports/entertainment)', localToday());
  console.log('─'.repeat(56));
  console.log(`Browser fetches:     ${fetches}   (Cloudflare blocks plain HTTP; ~3-6s each)`);
  console.log(`Categories:          ${CATEGORIES.length}  (${CATEGORIES.join(', ')})`);
  console.log(`Unique jobs:         ${all.length}`);
  console.log(`Filtered off-lane:   ${offLane.length}`);
  console.log(`Already seen:        ${dupe.length}`);
  console.log(`NEW OFFERS:          ${rows.length}`);
  console.log('');
  rows.forEach((j) => console.log(`  • ${j.title}`));
  console.log('\n→ Location is NOT on the listing card; read it from the job page before');
  console.log('  deciding commutable. Venue roles are on-site by nature and many are');
  console.log('  part-time or seasonal - check the employment type before treating as a role.');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
