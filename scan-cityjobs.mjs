#!/usr/bin/env node

/**
 * scan-cityjobs.mjs — NYC City Jobs scanner (cityjobs.nyc.gov)
 *
 * ── WHY THE SITEMAP, NOT /jobs?q= ────────────────────────────────────────────
 *
 * robots.txt for this site says:
 *
 *   User-agent: *
 *   Disallow: /jobs?*
 *
 * That is the filtered/paged search path — `?q=parks`, `?q=<anything>` — and it
 * is explicitly disallowed. The site serves it with HTTP 200 and no bot
 * challenge, so nothing mechanical stops a crawler; that is not permission.
 * robots.txt is the publisher's stated policy and this scanner honours it.
 *
 * What the site DOES publish for machines is a sitemap, and it is linked from
 * robots-adjacent discovery (the sitemap index at /sitemap.xml):
 *
 *   https://cityjobs.nyc.gov/vacanciessitemap.xml
 *
 * That file lists every open vacancy as a canonical /job/<slug>-jid-<N> URL with
 * a <lastmod> timestamp. Individual /job/ pages are NOT covered by the
 * Disallow rule, so fetching one is fine. So the compliant shape is:
 *
 *   enumerate  → vacanciessitemap.xml   (one request, sanctioned, complete)
 *   filter     → the slug + <lastmod>   (zero extra requests)
 *   enrich     → /job/<slug>-jid-<N>    (only for listings that pass the filter)
 *
 * The sitemap carries 1678 vacancies, of which ~740 changed in the last 7 days.
 * Filtering on the slug means a routine run touches a handful of detail pages,
 * not 1678.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   node scan-cityjobs.mjs                 # scan, using portals.yml queries
 *   node scan-cityjobs.mjs --dry-run       # report only, write nothing
 *   node scan-cityjobs.mjs --since 7       # only vacancies changed in N days
 *   node scan-cityjobs.mjs --query parks   # restrict to a title substring
 *   node scan-cityjobs.mjs --detail 47320  # fetch one posting's full body
 *   node scan-cityjobs.mjs --list          # titles only, ZERO detail requests
 *   node scan-cityjobs.mjs --limit 40      # cap detail requests per run
 *   node scan-cityjobs.mjs --all           # ignore the freshness window
 *
 * ── REQUEST BUDGET ───────────────────────────────────────────────────────────
 * A max-breadth title_filter admits ~500 of the 1133 vacancies in a 14-day
 * window, and enriching each one costs a page fetch. Five hundred requests per
 * scheduled run is not a scan, it is a crawl, so two brakes apply by default:
 *
 *   --list   enumerate and filter on the sitemap only. No /job/ page is touched
 *            at all, so it can run as often as you like. This is the mode to
 *            use on a schedule.
 *   --limit  caps detail fetches per run (default 40). Listings past the cap are
 *            reported as DEFERRED with their URLs, never silently dropped, and
 *            because they are not marked seen, the next run picks them up.
 *
 * A run therefore reads at most 41 URLs: one sitemap plus the cap.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, PORTALS_PATH, SCAN_HISTORY_PATH as SCAN_HISTORY } from './scan.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { normalizeJdText } from './fingerprint-core.mjs';
import { createHash } from 'crypto';

const DATA_ROOT = getCareerOpsRoot();
const HOST = 'https://cityjobs.nyc.gov';
// The sanctioned enumeration source. Not a guess: linked from the site's own
// sitemap index, and every entry it lists is a /job/ page that robots.txt allows.
const SITEMAP_URL = `${HOST}/vacanciessitemap.xml`;
const SOURCE = 'cityjobs';

const BOROUGHS = /-in-(?:nyc-)?(manhattan|brooklyn|queens|(?:the-)?bronx|staten-island|all-boros|queens-ny|brooklyn-ny)$/;

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_FRESHNESS = args.includes('--all');
const sIdx = args.indexOf('--since');
const qIdx = args.indexOf('--query');
const dIdx = args.indexOf('--detail');

const needValue = (i, name, example) => {
  if (i === -1) return null;
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) {
    console.error(`Error: ${name} requires a value, e.g. ${name} ${example}`);
    process.exit(1);
  }
  return args[i + 1];
};
const SINCE_DAYS = needValue(sIdx, '--since', '7') ?? 14;
const SINGLE_QUERY = needValue(qIdx, '--query', 'parks');
const DETAIL_JID = needValue(dIdx, '--detail', '47320');
const LIST_ONLY = args.includes('--list');
const lIdx = args.indexOf('--limit');
const DETAIL_LIMIT = (() => {
  if (lIdx === -1) return LIST_ONLY ? 0 : 40;
  const v = args[lIdx + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error('Error: --limit requires a value, e.g. --limit 40');
    process.exit(1);
  }
  if (!/^\d+$/.test(v)) {
    console.error(`Error: --limit takes a whole number, got "${v}"`);
    process.exit(1);
  }
  return Number(v);
})();

// ── Config ──────────────────────────────────────────────────────────────────

let config = {};
if (existsSync(PORTALS_PATH)) config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};

const titleFilter = config.title_filter || {};
const positiveKw = (titleFilter.positive || []).map(k => k.toLowerCase());
const negativeKw = (titleFilter.negative || []).map(k => k.toLowerCase());

function matchesTitle(title) {
  const lower = (title || '').toLowerCase();
  if (negativeKw.some(k => lower.includes(k))) return false;
  if (positiveKw.length === 0) return true;
  return positiveKw.some(k => lower.includes(k));
}

const locFilter = config.location_filter || {};
const locAllow = (locFilter.allow || []).map(k => k.toLowerCase());
const locBlock = (locFilter.block || []).map(k => k.toLowerCase());

function matchesLocation(loc) {
  if (!loc) return true;
  const lower = loc.toLowerCase();
  if (locBlock.some(k => lower.includes(k))) return false;
  if (locAllow.length === 0) return true;
  return locAllow.some(k => lower.includes(k));
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Extract vacancy entries from the sitemap.
 *
 * Deliberately tolerant: a sitemap that stops parsing should yield fewer
 * entries with a loud warning, never a silent zero that reads as "no jobs".
 */
export function parseSitemap(xml) {
  const out = [];
  const entries = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  for (const e of entries) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(e)?.[1]?.trim();
    if (!loc || !/\/job\//.test(loc)) continue;
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(e)?.[1]?.trim() || '';
    const jid = /-jid-(\d+)/.exec(loc)?.[1] || '';
    out.push({ url: loc.replace(/&amp;/g, '&'), jid, lastmod });
  }
  return out;
}

/**
 * Turn a URL slug into a readable title.
 *
 * The slug is the site's own restatement of the title ("senior-data-coordinator
 * in Manhattan" → "Senior Data Coordinator"), which is enough to run the title
 * filter without spending a detail request. Fetching the page is reserved for
 * listings that pass, so a routine run reads a handful of pages rather than 1678.
 */
export function titleFromSlug(url) {
  let s = url.replace(/^https:\/\/[^/]+\/job\//, '').replace(/-jid-\d+$/, '');
  s = s.replace(BOROUGHS, '');
  return s.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Borough / work-site implied by the slug, for the location filter. */
export function locationFromSlug(url) {
  const m = BOROUGHS.exec(url.replace(/-jid-\d+$/, ''));
  if (!m) return '';
  const b = m[1].replace(/^the-/, '').replace(/-ny$/, '');
  // "all-boros" IS New York City, so it is not an unknown location -- emit the
  // canonical string the location_filter already allows ("NYC"). The previous
  // form produced "Nyc-all-boros, NY", which matched allow only by accident.
  if (b === 'all-boros') return 'NYC';
  const pretty = b === 'staten-island' ? 'Staten Island' : b;
  return pretty.charAt(0).toUpperCase() + pretty.slice(1) + ', NY';
}

/**
 * Fetch one posting's rendered body. /job/ pages are not disallowed by
 * robots.txt, so this is the sanctioned way to enrich a listing that has already
 * earned a request.
 */
export function parseDetail(html) {
  const text = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ').trim();

  const salary = /\$\s?([\d,]{4,})\s*(?:to|-|–)\s*\$?\s?([\d,]{4,})/.exec(text);
  const perYear = /per year|annually|per annum/i.test(text);
  const eligibility = /only open to[^.]{0,160}\./i.exec(text)?.[0]?.trim() || '';
  const borough = /in\s+([A-Z][a-z]+),\s*(?:NY|New York)/.exec(text)?.[1] || '';
  return {
    description: text,
    salary: salary ? `${salary[1]}–${salary[2]}${perYear ? ' per year' : ''}` : '',
    eligibilityNote: eligibility,
    borough,
    employmentType: employmentTypeOf(text),
  };
}

/**
 * Read the employment type off the posting body.
 *
 * This check lives here, not in title_filter, because on a municipal board the
 * type is not in the TITLE. Measured 2026-10-01 against cityjobs: "Contract
 * Manager" appears as both a permanent civil-service role and a genuine
 * CONTRACT posting (jid-44314), while "Early Childhood Education Consultant"
 * (jid-42582) is Full-time. A title keyword cannot separate those; the body can.
 *
 * Returns one of 'full_time' | 'excluded' | null (not stated / not recognised).
 * null is deliberately not 'full_time' — an unreadable posting should surface to
 * a human rather than pass as a verified match.
 */
export function employmentTypeOf(text) {
  const t = String(text ?? '');
  // A "Full-time/Part-time" field is a RANGE the employer may hire from, not a
  // statement that this posting is full-time. Reading it as full-time would let
  // a part-time vacancy through on the strength of a menu option.
  if (/employment type[^.]{0,60}full[- ]time\s*\/\s*part[- ]time/i.test(t)) return 'excluded';

  // The type is read from an explicit statement ABOUT THE ROLE, never from the
  // bare word appearing in the body. "Manages the procurement contract portfolio"
  // is a permanent job that happens to talk about contracts -- exactly the
  // subject-matter-vs-employment-type conflation this function exists to avoid,
  // and the same mistake the title filter made before the check moved here.
  const SENTENCE = [
    /\b(?:position|job|role|appointment|assignment|employment|opportunity)\b[^.]{0,40}\b(?:is|will be|as)\b[^.]{0,40}\b(?:contract|temporary|temp|per diem|seasonal|intermittent|part[- ]time)\b/i,
    /\b(?:contract|temporary|temp|per diem|seasonal|intermittent|part[- ]time)\b[^.]{0,30}\b(?:position|job|role|appointment|assignment|employment)\b/i,
    /\bemployment type\b[^.]{0,20}\bcontract\b/i,
    /\bthis (?:is a|role is a) contract\b/i,
    /\b1099\b/i,
  ];
  for (const re of SENTENCE) if (re.test(t)) return 'excluded';

  if (/\bfull[- ]time\b/i.test(t)) return 'full_time';
  return null;
}

/** 16-hex content fingerprint, matching what scan-history col 7 expects. */
function fingerprintOf(description) {
  const n = normalizeJdText(description || '');
  if (n.length < 120) return '';
  return createHash('sha256').update(n.slice(0, 4000)).digest('hex').slice(0, 16);
}

/** Most recent first_seen for this portal, or null. */
function loadLastScanDate() {
  if (!existsSync(SCAN_HISTORY)) return null;
  let latest = null;
  for (const line of readFileSync(SCAN_HISTORY, 'utf-8').split('\n').slice(1)) {
    const p = line.split('\t');
    if (p[2] !== SOURCE) continue;
    const d = new Date((p[1] || '') + 'T00:00:00Z');
    if (!isNaN(d) && (!latest || d > latest)) latest = d;
  }
  return latest;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'career-ops-scan/1.0 (personal job search; respects robots.txt)', accept: 'text/xml,text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Detail mode ─────────────────────────────────────────────────────────────

async function runDetail(jid) {
  const xml = await fetchText(SITEMAP_URL);
  const hit = parseSitemap(xml).find(v => v.jid === String(jid));
  if (!hit) {
    console.log(`  jid-${jid} is not in the current sitemap — the vacancy may be closed or filled.`);
    return;
  }
  const d = parseDetail(await fetchText(hit.url));
  console.log(`  ${hit.url}`);
  console.log(`  title       : ${titleFromSlug(hit.url)}`);
  console.log(`  salary      : ${d.salary || '(not stated on page)'}`);
  console.log(`  borough     : ${d.borough || locationFromSlug(hit.url) || '(not parsed)'}`);
  if (d.eligibilityNote) console.log(`  ELIGIBILITY : ${d.eligibilityNote}`);
  console.log(`  lastmod     : ${hit.lastmod || '(none)'}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (DETAIL_JID) return runDetail(DETAIL_JID);

  mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
  const { seen } = loadSeenUrls();
  const date = localToday();

  console.log('  Enumerating via sitemap (robots.txt disallows /jobs?*, which this scanner does not request)');
  const xml = await fetchText(SITEMAP_URL);
  const all = parseSitemap(xml);
  if (!all.length) {
    console.error('  ABORT: sitemap yielded 0 vacancies. Treating that as a parse failure, not an empty board — nothing written.');
    process.exit(1);
  }
  console.log(`  Vacancies in sitemap: ${all.length}`);

  const cutoff = NO_FRESHNESS ? null : Date.now() - SINCE_DAYS * 864e5;
  const lastScan = loadLastScanDate();

  const titleSkipped = [];
  const locationSkipped = [];
  const staleSkipped = [];
  const dupeSkipped = [];
  const candidates = [];

  for (const v of all) {
    const title = titleFromSlug(v.url);
    const location = locationFromSlug(v.url);
    const lastmod = v.lastmod ? new Date(v.lastmod) : null;

    if (cutoff && lastmod && lastmod.getTime() < cutoff) { staleSkipped.push(v); continue; }
    if (SINGLE_QUERY && !title.toLowerCase().includes(SINGLE_QUERY.toLowerCase())) continue;
    if (!matchesTitle(title)) { seen.add(v.url); titleSkipped.push(v); continue; }
    if (!matchesLocation(location)) { seen.add(v.url); locationSkipped.push(v); continue; }
    if (seen.has(v.url)) { dupeSkipped.push(v); continue; }
    candidates.push({ ...v, title, location });
  }

  // --list stops here: the sitemap alone answers "what is out there", and it
  // costs exactly one request. Nothing below runs, so no /job/ page is touched.
  if (LIST_ONLY) {
    printScanSummaryHeader('City Jobs Scan (sitemap, list only)', date);
    console.log(`Vacancies enumerated: ${all.length}`);
    console.log(`Freshness window:     ${NO_FRESHNESS ? 'disabled (--all)' : `${SINCE_DAYS} days`}`);
    console.log(`Filtered by title:    ${titleSkipped.length}`);
    console.log(`Filtered location:    ${locationSkipped.length}`);
    console.log(`Older than window:    ${staleSkipped.length}`);
    console.log(`Already seen:         ${dupeSkipped.length}`);
    console.log(`MATCHES:              ${candidates.length}`);
    console.log('\nDetail requests made: 0 (--list)');
    console.log(`\nMatching vacancies (${candidates.length}):`);
    for (const c of candidates) console.log(`  ${c.title} | ${c.location || 'location n/a'} | jid-${c.jid}`);
    console.log(`\nRe-run without --list and with --limit N to enrich the first N.`);
    return;
  }

  // Enrich only what survived, and only up to the cap. Deferred listings are
  // left un-seen on purpose so the next run picks them up.
  const enrich = candidates.slice(0, DETAIL_LIMIT);
  const deferred = candidates.slice(DETAIL_LIMIT);
  const newOffers = [];
  const shapeSkipped = [];
  const errors = [];
  for (const c of enrich) {
    try {
      const d = parseDetail(await fetchText(c.url));
      // Job-shape gate on the body, where the type is actually stated. A null
      // reading is NOT treated as full-time: it stays in the queue for a human.
      if (d.employmentType === 'excluded') {
        shapeSkipped.push(c);
        continue;
      }
      newOffers.push({
        url: c.url,
        company: 'NYC City Jobs',
        title: c.title,
        location: d.borough || c.location,
        source: SOURCE,
        description: d.description,
        fingerprint: fingerprintOf(d.description),
        eligibilityNote: d.eligibilityNote,
        employmentType: d.employmentType ?? 'not_stated',
      });
    } catch (err) {
      errors.push({ url: c.url, error: err.message });
      newOffers.push({
        url: c.url, company: 'NYC City Jobs', title: c.title,
        location: c.location, source: SOURCE, employmentType: 'unknown',
      });
    }
  }

  if (!DRY_RUN) {
    if (newOffers.length) await appendToPipeline(newOffers);
    if (newOffers.length) await appendToScanHistory(newOffers, date, 'added');
    if (titleSkipped.length) await appendToScanHistory(titleSkipped, date, 'skipped_title');
    if (locationSkipped.length) await appendToScanHistory(locationSkipped, date, 'skipped_location');
    if (shapeSkipped.length) await appendToScanHistory(shapeSkipped, date, 'skipped_job_shape');
    if (staleSkipped.length) await appendToScanHistory(staleSkipped, date, 'skipped_date');
    if (dupeSkipped.length) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  printScanSummaryHeader('City Jobs Scan (sitemap)', date);
  console.log(`Vacancies enumerated: ${all.length}`);
  console.log(`Freshness window:     ${NO_FRESHNESS ? 'disabled (--all)' : `${SINCE_DAYS} days`}`);
  console.log(`Filtered by title:    ${titleSkipped.length}`);
  console.log(`Filtered location:    ${locationSkipped.length}`);
  console.log(`Older than window:    ${staleSkipped.length}`);
  console.log(`Already seen:         ${dupeSkipped.length}`);
  console.log(`Detail pages fetched: ${enrich.length}`);
  console.log(`Excluded by job shape:${shapeSkipped.length}`);
  console.log(`Deferred (over limit): ${deferred.length}`);
  console.log(`NEW OFFERS:           ${newOffers.length}`);

  if (lastScan) console.log(`Last cityjobs scan:   ${lastScan.toISOString().slice(0, 10)}`);
  if (deferred.length) {
    console.log(`\n${deferred.length} matching listing(s) were not enriched because --limit is ${DETAIL_LIMIT}.`);
    console.log('They were NOT marked seen, so the next run reaches them. Raise the cap with --limit.');
    for (const d of deferred.slice(0, 5)) console.log(`  ⏸ ${d.title} | jid-${d.jid}`);
  }
  if (errors.length) {
    console.log(`\nDetail fetch errors (${errors.length}) — listing kept without a body:`);
    for (const e of errors.slice(0, 5)) console.log(`  ✗ ${e.url}: ${e.error}`);
  }

  if (newOffers.length) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      const flag = o.eligibilityNote ? '  ⚠ eligibility-restricted' : '';
      console.log(`  + ${o.title} | ${o.location || 'location n/a'} | jid-${/jid-(\d+)/.exec(o.url)?.[1] || '?'}${flag}`);
    }
    if (DRY_RUN) console.log('\n(dry run — nothing written)');
  }
  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

// Guarded like every sibling scanner (#3510): importing this module must not
// fetch from the network as a side effect of being loaded.
if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}