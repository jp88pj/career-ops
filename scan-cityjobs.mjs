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
import { buildTitleFilterBySource } from './title-keywords.mjs';
import { buildLocationFilter } from './scan.mjs';
import { buildShapePolicy, stripShapeNegatives } from './lib/employment-shape.mjs';

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

// The CIVIL-SERVICE TITLE CODES that count as in-lane on this board, read from
// this board's own source_title_filters rule.
//
// There is no tracked_companies entry for cityjobs - it is a standalone
// scanner - so the list lives on its rule, and the gate and the config are one
// thing. An empty list means no code gate, which is the old behaviour.
//
// WHY A CODE GATE AT ALL: the business title in a cityjobs slug cannot decide
// whether a posting is in-lane. The 2026-10-20 measurement on the tenant: the
// 131 postings bound to COMMUNITY COORDINATOR (56058) carry 124 DISTINCT
// business titles, and a posting bound to one code can carry any title at all.
// The code is what governs eligibility, and it is on the detail page - which
// this scanner already fetches for every candidate.
const CITYJOBS_RULE = (config.source_title_filters || [])
  .find((r) => Array.isArray(r?.match_hosts) && r.match_hosts.some((h) => /cityjobs\.nyc\.gov/i.test(String(h))));
const CITYJOBS_TITLE_CODES = (CITYJOBS_RULE?.title_codes || []).map((c) => String(c).trim()).filter(Boolean);

// REWIRED 2026-10-18. This file hand-rolled its own title matcher from the
// GLOBAL positive/negative lists only:
//
//     if (negativeKw.some(k => lower.includes(k))) return false;
//     return positiveKw.some(k => lower.includes(k));
//
// That made 29 of the 75 global negatives INERT, because they carry a `word:`
// prefix -- word:Intern, word:Part Time, word:Seasonal, word:Temp, word:Sales,
// word:Marketing, word:Accounting, word:Account Executive, word:Accountant and
// the rest. A naive `lower.includes("word:intern")` searches a JOB TITLE for
// that literal prefix, never finds it, and returns false, so the veto silently
// never fires. The shipped compiler in title-keywords.mjs strips the prefix and
// matches the whole word, which is what every `word:` entry was written to mean.
//
// This is the highest-converting board in the tracker -- 35.7% of its rows
// pursued against 18.2% overall -- so the defect cost more here than anywhere
// else: part-time, seasonal, temp, sales, marketing and accounting roles were
// all reaching triage on the one board where they should never have landed.
//
// It also could not consult `source_title_filters` at all, so any host-scoped
// rule for cityjobs.nyc.gov would have been advertised and then ignored.
// scan-mta.mjs, scan-teamworkonline.mjs and (as of 2026-10-18) scan-bandana.mjs
// all use the shipped matcher. scan-interamt.mjs still carries this defect.
const HOSTS = ['cityjobs.nyc.gov'];
const titleFilter = config.title_filter || {};
// Honour employment_shape.flag_not_veto, as scan.mjs does. Without this the
// shape words stay in the title negatives and part-time / seasonal / per-diem
// postings are HARD VETOED on this board -- the opposite of the configured
// policy, and the opposite of the user's stated preference that a role below
// full time should be priced rather than excluded.
const shapePolicy = buildShapePolicy(config.employment_shape);
const matchesTitle = buildTitleFilterBySource(
  shapePolicy.flagNotVeto ? stripShapeNegatives(titleFilter) : titleFilter,
  config.source_title_filters
);

// FIXED 2026-10-20. This file hand-rolled its own location matcher:
//
//     const locAllow = (locFilter.allow || []).map(k => k.toLowerCase());
//     const locBlock = (locFilter.block || []).map(k => k.toLowerCase());
//     if (locBlock.some(k => lower.includes(k))) return false;
//     if (locAllow.length === 0) return true;
//     return locAllow.some(k => lower.includes(k));
//
// It consulted `allow` and `block` ONLY. `always_allow` -- the tier that
// actually names the boroughs -- was never read, and `block_hard` (the
// non-US tier) was never read either.
//
// The consequence was severe and silent. `locationFromSlug` returns "NYC" for
// an all-boros posting but "Manhattan, NY" / "Brooklyn, NY" / "Queens, NY" /
// "Bronx, NY" / "Staten Island, NY" for a borough-specific one, and NONE of
// those substrings matches `allow` ("Remote", "United States", "USA", "New
// York", "NYC", "New Jersey"). Measured against the seven slug shapes: 6 of 7
// were DROPPED. Only all-boros survived. So the cityjobs scanner had been
// admitting essentially nothing except citywide postings, and every
// borough-specific NYC vacancy was filtered out before anyone could score it.
//
// Three evaluation workers hit this independently and reported it: report 359's
// posting was dropped 9x on `skipped_location`; report 378's was dropped twice
// "despite being a Manhattan posting"; report 353's was "previously skipped by
// the cityjobs scanner six times". The bug was not a drop in coverage -- it
// was a drop in every posting that named a borough.
//
// The fix is to use the SAME matcher every other scanner uses, so the global
// policy is applied by one implementation rather than two that disagree.
// `buildLocationFilter` checks block_hard first, then always_allow, then
// block, then allow -- which is the order the global `location_filter` in
// portals.yml was written for.
//
// The URL is deliberately NOT passed to the matcher: this scanner derives the
// location from the slug, and the cityjobs host string would satisfy the
// "NYC" always_allow entry for every posting, making the check a no-op.
//
// Exported so the regression test can exercise it directly: this filter is
// the one that silently dropped every borough-specific NYC posting.
export const matchesLocation = buildLocationFilter(config.location_filter);

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
 * Extract the machine-readable posting metadata from schema.org JSON-LD.
 *
 * The comp figure is NOT in the rendered text. Measured 2026-10-01: a full
 * posting page contains exactly one `$` in its markup, and it sits inside
 * `<script type="application/ld+json">` as "jobBenefits". Stripping tags and
 * scanning for `$X-Y` therefore found salary on 1 of 45 postings -- the one that
 * happened to restate it in prose. Every other posting LOOKED like it had no
 * salary at all, which reads as "unpaid" rather than "not scraped".
 *
 * JSON-LD is the structured half of the page and is present on every posting
 * checked, with a stable shape:
 *   jobBenefits     "$70,653.00 – $74,955.00"   <- the range, verbatim
 *   employmentType  ["Full-time"]                <- note: an ARRAY
 *   title           canonical title
 *
 * Returns null when the block is absent or unparseable, so the caller can fall
 * back to the visible text rather than reporting a fabricated zero.
 */
export function parseJsonLd(html) {
  const blocks = String(html ?? '').matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of blocks) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    // A single posting may ship an @graph array rather than one object.
    const nodes = Array.isArray(data) ? data
      : Array.isArray(data['@graph']) ? data['@graph']
      : [data];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const type = node.jobBenefits || node.baseSalary || node.salary || '';
      const raw = typeof type === 'string' ? type
        : type?.value?.minValue != null ? moneyRange(type.value)
        : type?.value != null ? String(type.value)
        : '';
      const salary = parseSalaryRange(raw);
      if (!salary && !node.employmentType) continue;
      return {
        salary: salary || '',
        salaryMin: salary ? Number(salary.min) : null,
        salaryMax: salary ? Number(salary.max) : null,
        // employmentType is an array on this site, and the join separator is
        // load-bearing: joining with "," made ["Full-time","Part-time"] into
        // "Full-time,Part-time", which classifyEmploymentType reads as
        // full-time -- admitting a part-time vacancy. A unit test caught it.
        // " / " keeps a multi-value range visibly a range, and the slash is the
        // character classifyEmploymentType() already treats as disqualifying.
        employmentType: Array.isArray(node.employmentType)
          ? node.employmentType.map(String).join(' / ')
          : node.employmentType ? String(node.employmentType) : '',
        title: node.title ? String(node.title) : '',
      };
    }
  }
  return null;
}

function moneyRange(value) {
  const lo = value?.minValue != null ? Number(value.minValue) : NaN;
  const hi = value?.maxValue != null ? Number(value.maxValue) : NaN;
  if (!Number.isFinite(lo)) return '';
  return Number.isFinite(hi) ? `${lo} - ${hi}` : `${lo}`;
}

/**
 * Pull a numeric range out of the comp string. Accepts the site's en-dash
 * ("$70,653.00 – $74,955.00"), a hyphen, or a single figure. Returns an object
 * rather than a display string so the comp gate can compare against a floor
 * numerically instead of re-parsing formatted text.
 */
/**
 * Lowest plausible ANNUAL salary for a single full-time US municipal role.
 *
 * Used only to reject a figure that is arithmetically impossible as an annual
 * salary, not to normalise one. Found 2026-10-06: jid-33840 "Supervisor
 * Dockbuilder" publishes `Salary range: $469.44` in its annual field — that is a
 * daily or per-shift rate. It happened to be excluded by the $60K comp floor
 * anyway, but by luck rather than by logic: a per-diem rate multiplied by
 * nothing is small, so the floor catches most of them, while a role publishing
 * something like "$1,000 per week" would sail through a $60K floor and be
 * filed as a $1,000 SALARY. Returning null makes the absence explicit instead
 * of letting an implausible number be stored as fact.
 */
const MIN_PLAUSIBLE_ANNUAL = 10000;

export function parseSalaryRange(raw) {
  const s = String(raw ?? '');
  if (!s.includes('$') && !/\d/.test(s)) return null;
  const nums = [...s.matchAll(/\$?\s?([\d]{1,3}(?:,[\d]{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  // Every figure in the string is implausible as an annual salary, so this is a
  // daily/hourly/per-shift rate in an annual field - not a salary.
  if (max < MIN_PLAUSIBLE_ANNUAL) return null;
  return { min: String(min), max: String(max) };
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

  const ld = parseJsonLd(html);
  // JSON-LD first: it is the structured field. The text scan stays as a
  // fallback for a posting that omits the block, and is labelled as such.
  const fromText = parseSalaryRange(text);
  // The WHOLE object, not `fromText?.min`. That took the bare min string, and
  // the two lines below then read `salary.min` / `salary.max` off it - which is
  // `undefined` on a string, so any posting resolved through the page-text
  // fallback produced the literal salary "undefined-undefined" and
  // salaryMax: NaN. Same class of error as the `detectEmploymentShape` read in
  // the CUNY triage: taking one field off an object that is not there. Both
  // shapes are {min, max}, so hand the object through unchanged.
  const salary = ld?.salary || fromText;
  const eligibility = /only open to[^.]{0,160}\./i.exec(text)?.[0]?.trim() || '';
  const borough = /in\s+([A-Z][a-z]+),\s*(?:NY|New York)/.exec(text)?.[1] || '';

  // JSON-LD employmentType is authoritative when present -- it is a field, not
  // a phrase mined from prose, so it cannot trip the subject-matter problem.
  const jobShape = ld?.employmentType ? classifyEmploymentType(ld.employmentType) : employmentTypeOf(text);

  // The CIVIL-SERVICE TITLE CODE, read off the detail page.
  //
  // This is the field that actually governs eligibility, and it is the reason
  // this board needs a lane rule of its own. A posting bound to title code
  // 56058 can carry ANY business title -- "Program Counselor", "Capital
  // Analyst", "EAP Counselor", "MOU Agreement Planner" -- so matching on the
  // business title alone can never decide whether a posting is in-lane. The
  // 2026-10-20 measurement: the tenant's 131 COMMUNITY COORDINATOR postings
  // carry 124 DISTINCT business titles.
  //
  // The sitemap slug carries only the business title and the division, so the
  // code is available here and nowhere earlier -- and this page is fetched for
  // every candidate anyway, so the gate costs no extra request.
  const titleCode = (/Title\s*Code[^0-9]{0,200}?([0-9]{4,6})/i.exec(text) || [])[1] || '';

  return {
    description: text,
    salary: salary ? `${formatMoney(salary.min)}–${formatMoney(salary.max)}` : '',
    salaryMin: salary ? Number(salary.min) : null,
    salaryMax: salary ? Number(salary.max) : null,
    salarySource: ld?.salary ? 'json-ld' : fromText ? 'page-text' : 'absent',
    eligibilityNote: eligibility,
    borough,
    employmentType: jobShape,
    employmentTypeRaw: ld?.employmentType || '',
    internalOnly: internalOnlyOf(text),
    titleCode,
  };
}

function formatMoney(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * Classify a structured employmentType field.
 *
 * "Full-time" -> full_time. Anything carrying a slash ("Full-time/Part-time"),
 * or naming a part-time/per-diem/temporary/contract shape, -> excluded. The
 * range case is the reason this exists: the site publishes a single-element
 * array whose value can be a menu, and reading that as full-time would admit a
 * part-time vacancy on the strength of an option.
 */
export function classifyEmploymentType(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  if (/\//.test(v)) return 'excluded';
  if (/full[- ]?time/i.test(v)) return 'full_time';
  if (/part[- ]?time|per diem|seasonal|intermittent|temporary|temp|contract|part-time/i.test(v)) return 'excluded';
  return null;
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

/**
 * Is this posting restricted to current City employees?
 *
 * cityjobs publishes no `posting_type` field, and the Open Data mirror's
 * `posting_type` column cannot be joined to this board at all (it uses a
 * 6-digit id where every sitemap URL carries a 5-digit `jid-N`; measured
 * 2026-10-15, 0 of 1233 Internal ids appear in scan-history and 0 of 2047
 * sitemap ids appear in the mirror). So the signal has to come from the page.
 *
 * The phrase to trust is the ERN instruction. Measured 2026-10-15 on jid-45212
 * (Parks Enforcement Patrol): "*Current City Employees please include your ERN
 * on your cover letter and resume.*"
 *
 * The generic apply block is NOT a signal in either direction: every posting
 * carries "City Employees - click here to log in to ESS. Non-City Employees -
 * go to a127-jobs.nyc.gov/", internal or not. Matching that block would mark
 * every vacancy internal.
 *
 * Returns true | false | null, where null is deliberately not false. Same
 * reasoning as employmentTypeOf: a page whose eligibility sentence cannot be
 * read should surface to a human rather than pass as verified-external.
 *
 * Why it matters here: the ERN is the artifact that clears internal-candidate
 * gates, and cv.md scopes it to cityjobs postings only. So an internal-only
 * posting is the one case where the ERN belongs on the CV - and until this
 * existed nothing in the pipeline could tell one apart.
 */
export function internalOnlyOf(text) {
  const t = String(text ?? '');

  // Positive: the posting states an internal eligibility condition.
  const INTERNAL = [
    /\bcurrent (?:city )?employees?\b[^.]{0,140}\b(?:only|eligible|please|must|ERN)\b/i,
    /\b(?:only|exclusively)\b[^.]{0,60}\b(?:open|available|eligible)\b[^.]{0,60}\b(?:to|for)\b[^.]{0,50}\b(?:current )?(?:city )?employees\b/i,
    /\b(?:include|provide|enter)\s+(?:your\s+)?ERN\b/i,
  ];
  for (const re of INTERNAL) if (re.test(t)) return true;

  // Negative: an explicit external-only gate. Distinct from the generic apply
  // block, which names both audiences on every posting.
  const EXTERNAL = [
    /\bopen (?:only )?to (?:the )?(?:public|external|external candidates)\b/i,
    /\bexternally (?:available|open|posted)\b/i,
    /\bnot eligible (?:for|to)\b[^.]{0,40}\bcurrent employees\b/i,
    /\bcurrent (?:city )?employees?\b[^.]{0,40}\b(?:are|is) not eligible\b/i,
  ];
  for (const re of EXTERNAL) if (re.test(t)) return false;

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
    // ctx is REQUIRED: buildTitleFilterBySource keys every rule off ctx.hosts /
    // ctx.company and falls through to the GLOBAL filter when neither is given.
    // Passing the title alone would reproduce the bug just fixed above, one
    // layer down. cityjobs slugs carry no agency name, so company is empty.
    if (!matchesTitle(title, { hosts: HOSTS, company: '' })) { seen.add(v.url); titleSkipped.push(v); continue; }
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
  const codeSkipped = [];
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
      // CIVIL-SERVICE TITLE CODE gate. The exact filter, on the page already
      // fetched, so it costs no extra request.
      //
      // A posting whose code could not be read is KEPT, not dropped: an
      // unreadable field is missing data, and dropping on missing data is the
      // same failure the location filter had. The code list comes from this
      // board's own source_title_filters rule, so the config and the gate
      // cannot drift.
      if (CITYJOBS_TITLE_CODES.length && d.titleCode && !CITYJOBS_TITLE_CODES.includes(d.titleCode)) {
        codeSkipped.push({ ...c, titleCode: d.titleCode });
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
        // true = the posting gates on current-employee status (the ERN line);
        // false = it states an external gate; null = not stated either way.
        // This is the one field that decides whether cv.md's ERN scope rule
        // puts the municipal employee ID on the CV, so it is surfaced rather
        // than folded into the description text.
        internalOnly: d.internalOnly === null ? 'not_stated' : String(d.internalOnly),
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
    if (codeSkipped.length) await appendToScanHistory(codeSkipped, date, 'skipped_title_code');
    if (staleSkipped.length) await appendToScanHistory(staleSkipped, date, 'skipped_date');
    if (dupeSkipped.length) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  printScanSummaryHeader('City Jobs Scan (sitemap)', date);
  console.log(`Vacancies enumerated: ${all.length}`);
  console.log(`Freshness window:     ${NO_FRESHNESS ? 'disabled (--all)' : `${SINCE_DAYS} days`}`);
  console.log(`Filtered by title:    ${titleSkipped.length}`);
  console.log(`Filtered location:    ${locationSkipped.length}`);
  console.log(`Filtered by title code:${String(codeSkipped.length).padStart(4)}${CITYJOBS_TITLE_CODES.length ? `  (in-lane codes: ${CITYJOBS_TITLE_CODES.join(', ')})` : '  (no code list configured - gate inactive)'}`);
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
    const internalOnly = newOffers.filter((o) => o.internalOnly === 'true');
    if (internalOnly.length) {
      console.log(`\nInternal-only (current-employee gate; the ERN belongs on the CV for these): ${internalOnly.length}`);
      for (const o of internalOnly.slice(0, 12)) {
        console.log(`  🔒 ${o.title} | ${o.location || 'location n/a'} | jid-${/jid-(\d+)/.exec(o.url)?.[1] || '?'}`);
      }
      if (internalOnly.length > 12) console.log(`  … and ${internalOnly.length - 12} more`);
    }

    console.log('\nNew offers:');
    for (const o of newOffers) {
      const flag = o.eligibilityNote ? '  ⚠ eligibility-restricted' : '';
      const lock = o.internalOnly === 'true' ? '  🔒 internal-only' : '';
      console.log(`  + ${o.title} | ${o.location || 'location n/a'} | jid-${/jid-(\d+)/.exec(o.url)?.[1] || '?'}${flag}${lock}`);
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