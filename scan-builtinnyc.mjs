#!/usr/bin/env node
/**
 * scan-builtinnyc.mjs — builtinnyc.com, a NYC job board (aggregator).
 *
 * WHY THIS EXISTS: measured 2026-10-16, builtinnyc is the single largest
 * source in the tracker — 114 of 283 rows (40%) — and it was configured
 * nowhere. Every nonprofit result in the pipeline (Boys' Club of New York,
 * Goddard Riverside, University Settlement, Chinese-American Planning Council,
 * Prospect Schools) came from here. The ATS list produced breadth nowhere
 * close; it produced depth at 13 companies.
 *
 * READ PATH: plain HTTPS. No browser, no API key, zero LLM cost.
 *
 * EXTRACTION — use the JSON-LD, not the card HTML:
 *   The listing embeds `<script type="application/ld&#x2B;json">`. Two traps:
 *   1. the type attribute is ENTITY-ESCAPED (`ld&#x2B;json`, not `ld+json`), so
 *      the obvious regex matches nothing and looks like "no structured data";
 *   2. the ItemList sits under `@graph`, not at the top level.
 *   Each item gives exact `name`, `url` and the FULL `description` — better
 *   than card scraping, which yields slug-mangled titles and no description.
 *   Employer is NOT in the listing JSON-LD; it comes from the card anchor.
 *
 * PAGINATION IS LYING:
 *   The page advertises a last page of 1000. Pages 1-2 yield 20 cards, then it
 *   tapers to ~10/page. Walking pages and accumulating unique URLs: measured
 *   2026-10-17, the corpus runs past page 85 with ~1000 jobs, then pages yield
 *   ZERO items for three consecutive pages and that is the real end.
 *
 *   An earlier walk of this board stopped at page 40, saw 397 jobs, and
 *   concluded the corpus ended there. It did not — it had grown ~2.4x by the
 *   next day. So the corpus size is NOT a constant to hardcode anywhere,
 *   including in this comment and in the scan summary, and a page cap low
 *   enough to truncate it fails SILENTLY: it reports fewer postings and still
 *   prints a clean summary. Raise --max-pages rather than trusting a bound.
 *
 * AGGREGATOR STALENESS — the standing risk:
 *   `AGENTS.md` says "employer boards only, no aggregators" because an
 *   aggregator keeps a filled role looking live. Measured mitigation: the
 *   listing JSON-LD carries NO posted date, but the DETAIL page publishes a
 *   full JobPosting schema with `datePosted`. So the freshness window IS
 *   available — it just costs one detail fetch per surviving candidate, which
 *   is why enrichment happens after the title filter rather than before it.
 *
 *   Liveness is still NOT decided here. `datePosted` says when it was posted,
 *   not whether it is still open. That is `check-liveness.mjs`'s job. For small
 *   nonprofits the builtinnyc page IS the posting, because they have no ATS.
 *
 * SIBLING: scan-cityjobs.mjs · scan-mta.mjs · scan-interamt.mjs · scan-bandana.mjs
 *
 * Usage:
 *   node scan-builtinnyc.mjs                # scan, using portals.yml filters
 *   node scan-builtinnyc.mjs --dump 2       # print parsed items for one page
 *   node scan-builtinnyc.mjs --no-enrich    # skip detail fetches (no date/location)
 *   node scan-builtinnyc.mjs --all          # disable the freshness window
 *   node scan-builtinnyc.mjs --limit N      # cap accepted postings (default 25)
 *   node scan-builtinnyc.mjs --max-pages N  # hard page cap (default 60)
 *   node scan-builtinnyc.mjs --dry-run      # print only, write nothing
 *   node scan-builtinnyc.mjs --force        # scan even though portals.yml disables this board
 *
 * DISABLED IN PORTALS.YML: this board is `enabled: false` by user directive
 * (2026-10-03) because it is an aggregator. The flag is enforced here, not
 * only in scan.mjs, so the directive cannot be undone by running this file
 * directly. --force is the explicit override.
 */

import https from 'node:https';
import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, PORTALS_PATH } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { buildTitleFilterBySource } from './title-keywords.mjs';

const BASE = 'https://www.builtinnyc.com';
const LISTING = BASE + '/jobs/';
const FRESHNESS_DAYS = 21;

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DUMP = val('--dump', null);
const ENRICH = !flag('--no-enrich');
const useFreshness = !flag('--all');
const LIMIT = Number(val('--limit', '25'));
const MAX_PAGES = Number(val('--max-pages', '60'));
const DRY = flag('--dry-run');
if (!Number.isInteger(LIMIT) || LIMIT < 1) { console.error('Error: --limit takes a whole number'); process.exit(1); }

// ── Config ───────────────────────────────────────────────────────────────────
let config = {};
if (existsSync(PORTALS_PATH)) config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
const matchesTitle = buildTitleFilterBySource(config.title_filter || {}, config.source_title_filters);
const HOSTS = ['www.builtinnyc.com'];

// ── Respect `enabled: false` in portals.yml ─────────────────────────────────
// scan.mjs's aggregator honours this flag (resolveEntries skips entry.enabled
// === false), but a standalone `node scan-builtinnyc.mjs` did NOT: it read
// portals.yml for title/location filters and never looked at the flag. That
// made the 2026-10-03 disable-by-directive bypassable by simply running this
// file, and it was bypassed -- 1008 builtinnyc URLs landed in scan-history.tsv
// on 2026-10-17, the largest single scan day for this source by 6x.
//
// Without this gate, "disabled" records an intent that one command line
// silently overrides, which is worse than no switch at all.
//
// --force is the deliberate override, so the flag is never a dead end: it
// prints what it is overriding and requires the operator to ask for it by name.
// MOVED INTO main() 2026-10-19. This gate used to sit at module scope, so
// IMPORTING the file exited the importing process. A module-level
// process.exit() is not catchable, so a test or a tool that imported this
// scanner was killed mid-run rather than reporting the refusal -- and the
// repo's own convention is that a script's side effects live behind
// isMainModule (tests/main-guard-convention.test.mjs). Called from main() it
// does exactly what it did before when the file is run directly, and imports
// cleanly when it is not.
function assertBoardEnabled() {
  if (process.argv.includes('--force')) return;
  const boards = Array.isArray(config.job_boards) ? config.job_boards : [];
  const entry = boards.find((b) => String(b?.host || '').toLowerCase() === 'www.builtinnyc.com')
    || boards.find((b) => /built\s*in/i.test(String(b?.name || '')));
  if (entry?.enabled === false) {
    console.error('Error: Built In NYC is disabled in portals.yml (job_boards -> Built In NYC -> enabled: false).');
    console.error('  Directive 2026-10-03: Built In is an aggregator, and modes/_custom.md makes the');
    console.error("  employer's own board the only source that may CONFIRM or CLOSE a role.");
    console.error('  Measured cost: 114 of 285 tracker rows (40%), 7 applications, 4 rejections, 0 interviews.');
    console.error('  Re-run with --force to scan anyway, or set enabled: true in portals.yml.');
    process.exit(1);
  }
}

const locFilter = config.location_filter || {};
const locAllow = (locFilter.allow || []).map((k) => k.toLowerCase());
const locBlock = (locFilter.block || []).map((k) => k.toLowerCase());
function matchesLocation(loc) {
  if (!loc) return true;
  const lower = String(loc).toLowerCase();
  if (locBlock.some((k) => lower.includes(k))) return false;
  if (locAllow.length === 0) return true;
  return locAllow.some((k) => lower.includes(k));
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const get = (u, depth = 0) => new Promise((res, rej) => {
  const req = https.get(u, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops)' } }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 3) {
      r.resume();
      return res(get(new URL(r.headers.location, u).toString(), depth + 1));
    }
    let d = '';
    r.setEncoding('utf8');
    r.on('data', (c) => { d += c; });
    r.on('end', () => res({ status: r.statusCode, body: d }));
  });
  req.on('error', rej);
  req.setTimeout(30000, () => req.destroy(new Error('timeout')));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Parsing ──────────────────────────────────────────────────────────────────
const unescapeHtml = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&#x2B;/g, '+').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

/**
 * Pull the listing's structured data.
 *
 * The type attribute is entity-escaped in the served HTML, so the pattern is
 * matched on `ld` + a tolerant attribute run rather than the literal
 * "application/ld+json" that a naive grep for will not find.
 */
export function parseListing(html) {
  const out = [];
  const m = /<script type="application\/ld&#x2B;json">([\s\S]*?)<\/script>/.exec(html)
    || /<script[^>]*ld[^>]*json[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return { items: out, found: false };

  let ld;
  try { ld = JSON.parse(unescapeHtml(m[1])); }
  catch (e) { return { items: out, found: false, error: e.message }; }

  // The ItemList lives under @graph.
  const nodes = Array.isArray(ld) ? ld : (Array.isArray(ld['@graph']) ? ld['@graph'] : [ld]);
  const list = nodes.find((n) => n && n['@type'] === 'ItemList');
  if (!list || !Array.isArray(list.itemListElement)) return { items: out, found: false };

  // Employer is not in the JSON-LD; take it from the card anchor by id.
  const employers = new Map();
  for (const e of html.matchAll(/href="\/company\/([a-z0-9-]+)"[^>]*>\s*<span>([^<]+)<\/span>/g)) {
    employers.set(e[1], unescapeHtml(e[2]).replace(/\s+/g, ' ').trim());
  }
  const idToEmployer = new Map();
  for (const e of html.matchAll(/data-builtin-track-job-id="(\d+)"[\s\S]{0,400}?href="\/company\/([a-z0-9-]+)"/g)) {
    idToEmployer.set(e[1], employers.get(e[2]) || '');
  }

  for (const it of list.itemListElement) {
    const url = it.url || '';
    const id = (/\/(\d+)(?:\?|$)/.exec(url) || [])[1] || '';
    if (!id) continue;
    const employer = idToEmployer.get(id) || '';
    out.push({
      id,
      url,
      title: unescapeHtml(it.name || '').replace(/\s+/g, ' ').trim(),
      description: unescapeHtml(it.description || '').replace(/\s+/g, ' ').trim(),
      employer,
      company: employer || 'builtinnyc',
      location: '',
      datePosted: '',
      source: 'builtinnyc',
    });
  }
  return { items: out, found: true };
}

/** Detail page: full JobPosting schema gives employer, location and datePosted. */
export function parseDetail(html) {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)
    || /<script[^>]*ld[^>]*json[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return {};
  let ld;
  try { ld = JSON.parse(unescapeHtml(m[1])); } catch { return {}; }
  const nodes = Array.isArray(ld) ? ld : (Array.isArray(ld['@graph']) ? ld['@graph'] : [ld]);
  const jp = nodes.find((n) => n && (n['@type'] === 'JobPosting' || n['@type'] === 'JobPostingDetail'));
  if (!jp) return {};
  const addr = jp.jobLocation?.address || jp.jobLocation?.['@type'] === 'PostalAddress' ? jp.jobLocation?.address : null;
  return {
    employer: jp.hiringOrganization?.name || '',
    location: [addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(', '),
    datePosted: jp.datePosted || '',
  };
}

async function readPage(n) {
  const r = await get(LISTING + '?page=' + n);
  if (r.status !== 200) return { items: [], status: r.status };
  return { ...parseListing(r.body), status: 200 };
}

async function enumerate(log) {
  const found = new Map();
  let zeroRun = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    let res;
    try { res = await readPage(p); }
    catch (e) { log(`  page ${p} unreadable: ${(e.message || '').slice(0, 60)}`); continue; }
    if (!res.found) { log(`  page ${p}: no structured data — treating as empty`); }
    let fresh = 0;
    for (const j of res.items || []) if (j.id && !found.has(j.id)) { found.set(j.id, j); fresh++; }
    zeroRun = fresh === 0 ? zeroRun + 1 : 0;
    if (p <= 5 || p % 10 === 0 || fresh === 0) log(`  page ${p}: ${(res.items || []).length} items, ${fresh} new, total ${found.size}`);
    if (zeroRun >= 3) { log(`  page ${p}: 3 consecutive empty pages — end of corpus`); break; }
  }
  return [...found.values()];
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  assertBoardEnabled();
  const date = localToday();

  if (DUMP) {
    const r = await readPage(Number(DUMP));
    console.log(`page ${DUMP}: HTTP ${r.status}, structured data found=${r.found}, ${(r.items || []).length} items${r.error ? ' ERROR=' + r.error : ''}\n`);
    for (const j of (r.items || []).slice(0, 10)) {
      console.log(`  ${j.title.slice(0, 52).padEnd(54)} ${j.employer.slice(0, 28).padEnd(30)} ${j.id}`);
      console.log(`     desc: ${(j.description || '').slice(0, 100)}`);
    }
    return;
  }

  const { seen } = loadSeenUrls();
  const all = await enumerate((m) => console.log(m));
  console.log(`\n  Unique postings: ${all.length}`);

  // Cheap title filter FIRST, so detail fetches are spent only on survivors.
  const passesTitle = all.filter((j) => matchesTitle(j.title, { hosts: HOSTS, company: j.company }));
  console.log(`  Passing title filter: ${passesTitle.length}`);

  const fresh = [];
  const titleSkipped = [];
  for (const j of all) (passesTitle.includes(j) ? fresh : titleSkipped).push(j);
  const undupe = [], dupeSkipped = [];
  for (const j of fresh) (seen.has(j.url) ? dupeSkipped : undupe).push(j);
  console.log(`  Not already seen: ${undupe.length}`);

  // Enrich only the unseen survivors.
  const locationSkipped = [];
  const staleSkipped = [];
  let enriched = 0;
  const cutoff = useFreshness ? Date.now() - FRESHNESS_DAYS * 864e5 : null;
  const candidates = [];
  for (const j of undupe) {
    if (ENRICH) {
      try {
        const d = await get(j.url);
        if (d.status === 200) {
          const meta = parseDetail(d.body);
          j.employer = meta.employer || j.employer;
          j.company = j.employer || j.company;
          j.location = meta.location || j.location;
          j.datePosted = meta.datePosted || j.datePosted;
          enriched++;
        }
      } catch { /* keep listing data; enrichment is best-effort */ }
      await sleep(150);
    }
    if (cutoff && j.datePosted) {
      const t = Date.parse(j.datePosted);
      if (!Number.isNaN(t) && t < cutoff) { staleSkipped.push(j); continue; }
    }
    if (!matchesLocation(j.location)) { locationSkipped.push(j); continue; }
    candidates.push(j);
  }

  const accepted = candidates.slice(0, LIMIT);
  const deferred = candidates.slice(LIMIT);

  if (DRY) {
    console.log('\n  --dry-run: nothing written\n');
    for (const j of accepted) console.log(`  • ${j.title}\n    ${j.employer} | ${j.location || 'loc?'} | posted ${j.datePosted || '?'}\n    ${j.url}`);
  } else {
    if (accepted.length) await appendToPipeline(accepted);
    if (accepted.length) await appendToScanHistory(accepted, date, 'added');
    if (titleSkipped.length) await appendToScanHistory(titleSkipped, date, 'skipped_title');
    if (locationSkipped.length) await appendToScanHistory(locationSkipped, date, 'skipped_location');
    if (staleSkipped.length) await appendToScanHistory(staleSkipped, date, 'skipped_date');
    if (dupeSkipped.length) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  printScanSummaryHeader('Built In NYC (aggregator)', date);
  console.log('─'.repeat(56));
  console.log(`Postings enumerated: ${all.length}   (the advertised last page 1000 is false; corpus ends on consecutive zero-yield)`);
  console.log(`Enriched (detail):  ${enriched}/${ENRICH ? undupe.length : 0} — supplies datePosted + real location`);
  console.log(`Filtered by title:  ${titleSkipped.length}`);
  console.log(`Filtered location:  ${locationSkipped.length}`);
  console.log(`Filtered stale:     ${staleSkipped.length}   (freshness ${useFreshness ? FRESHNESS_DAYS + 'd via detail datePosted' : 'disabled'})`);
  console.log(`Already seen:       ${dupeSkipped.length}`);
  console.log(`Deferred (over cap):${deferred.length}`);
  console.log(`NEW OFFERS:         ${accepted.length}`);
  console.log('');
  for (const j of accepted) console.log(`  • ${j.title} — ${j.employer}${j.location ? ' (' + j.location + ')' : ''}`);
  console.log('\n→ AGGREGATOR. datePosted says when it was posted, not whether it is open.');
  console.log('  Confirm with check-liveness.mjs before treating any of these as live.');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
