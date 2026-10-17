#!/usr/bin/env node
/**
 * scan-nystate.mjs — NY State Civil Service, general-public vacancies.
 *
 * SOURCE: https://statejobsny.com/public/vacancyTable.cfm
 * (reached from statejobs.ny.gov). Plain HTTPS, no browser, no key.
 * Measured 2026-10-17: 1,727 vacancies, ~146 lane-relevant, all on ONE page —
 * there is no pagination, the table is simply large (726KB).
 *
 * WHY THIS IS A GOOD SOURCE, measured rather than assumed:
 *   - Posted AND Deadline dates are published, so a real freshness window is
 *     possible — unlike builtinnyc, which publishes no date at all.
 *   - Deadline is a LIVENESS SIGNAL. A vacancy whose deadline has passed is
 *     closed, and that is decidable from the board's own data. This is the
 *     first source in the tracker where "is it still open?" is answerable
 *     without a second fetch.
 *   - Grade is published (09-29 professional, 6xx executive, NS/Hourly
 *     non-numeric), which is a seniority filter that costs nothing.
 *   - Agency and County are published, so triage can be scoped before reading
 *     a single JD.
 *
 * MATCHING IS PHRASE-BASED, NOT SUBSTRING. Learned the hard way on
 * builtinnyc, where "resident" matched every "Vice President" title
 * ("pre|SIDENT") and bare "Learning" matched "Machine Learning" engineering
 * roles. Every pattern here is anchored on a multi-word phrase.
 *
 * ELIGIBILITY IS UNVERIFIED AND FLAGGED, NOT GATED. The user has taken NY
 * State civil service exams and is on waiting lists, but has not yet confirmed
 * which. NY competitive postings commonly require a specific exam or an
 * eligible title, and the board does not expose that on the list — it is on the
 * detail page, fetched by --enrich. So every role this scanner emits is marked
 * eligibility-unverified. See modes/_custom.md -> NY State civil service.
 *
 * SIBLING: scan-cityjobs.mjs · scan-mta.mjs · scan-builtinnyc.mjs · scan-nystate.mjs
 *
 * Usage:
 *   node scan-nystate.mjs              # scan, using portals.yml filters
 *   node scan-nystate.mjs --dump       # print parsed rows, write nothing
 *   node scan-nystate.mjs --enrich     # fetch detail pages for exam requirements
 *   node scan-nystate.mjs --all        # disable the freshness window
 *   node scan-nystate.mjs --limit N    # cap accepted (default 25)
 *   node scan-nystate.mjs --dry-run    # print only, write nothing
 */

import https from 'node:https';
import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, normalizeUrlForDedup, PORTALS_PATH } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const BASE = 'https://statejobsny.com/public/';
const TABLE = BASE + 'vacancyTable.cfm?searchResults=Yes&Keywords=&title=&JurisClassID=&AgID=';
const DETAIL = BASE + 'vacancyDetailsView.cfm?id=';
const FRESHNESS_DAYS = 30;

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DUMP = flag('--dump');
const ENRICH = flag('--enrich');
const useFreshness = !flag('--all');
const LIMIT = Number(val('--limit', '25'));
const DRY = flag('--dry-run');
if (!Number.isInteger(LIMIT) || LIMIT < 1) { console.error('Error: --limit takes a whole number'); process.exit(1); }

// ── Config ───────────────────────────────────────────────────────────────────
let config = {};
if (existsSync(PORTALS_PATH)) config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};

// Grade band. Professional NY grades run 09-29; 6xx are executive.
const GRADE_MIN = 12, GRADE_MAX = 26, GRADE_FLAG_ABOVE = 20;

// ── HTTP ─────────────────────────────────────────────────────────────────────
const get = (u, depth = 0) => new Promise((res, rej) => {
  const req = https.get(u, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops)' } }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 3) {
      r.resume(); return res(get(new URL(r.headers.location, u).toString(), depth + 1));
    }
    let d = ''; r.setEncoding('utf8');
    r.on('data', (c) => { d += c; });
    r.on('end', () => res({ status: r.statusCode, body: d }));
  });
  req.on('error', rej);
  req.setTimeout(45000, () => req.destroy(new Error('timeout')));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Parsing ──────────────────────────────────────────────────────────────────
const strip = (s) => String(s)
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#x23;/g, '#').replace(/&#x9;/g, ' ').replace(/&#x2f;|\//gi, '/')
  .replace(/&#x28;/g, '(').replace(/&#x29;/g, ')')
  // Hex entities generally, not just the handful named above — the board also
  // emits &#x23; and &#x9; inside titles, which leaked into the output as
  // literal entity text until this was generalised.
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/\s+/g, ' ').trim();

/** Board dates are MM/DD/YY. Two-digit years are 20xx here. */
export function parseBoardDate(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(s || ''));
  if (!m) return null;
  let [, mo, da, yr] = m;
  if (yr.length === 2) yr = '20' + yr;
  const d = new Date(Number(yr), Number(mo) - 1, Number(da));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseTable(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((x) => /vacancyDetailsView/.test(x));
  const out = [];
  for (const row of rows) {
    const id = (/vacancyDetailsView\.cfm\?id=(\d+)/.exec(row) || [])[1];
    if (!id) continue;
    const c = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    out.push({
      id,
      url: DETAIL + id,
      item: c[0] || '',
      title: c[1] || '',
      grade: c[2] || '',
      posted: c[3] || '',
      deadline: c[4] || '',
      agency: c[5] || '',
      county: c[6] || '',
      company: (c[5] || 'NY State').replace(/,\s*$/, ''),
      location: (c[6] || 'New York') + ', New York',
      source: 'nystate',
    });
  }
  return out;
}

/**
 * Lane patterns. Every one is a multi-word phrase — see the header note on why
 * bare substrings are banned here.
 */
const LANE = [
  [/(training specialist|training coordinator|workforce training|training and development)/i, 'training'],
  [/(instructional (designer|services|coordinator|support)|curriculum (designer|specialist|developer))/i, 'instructional'],
  // "Examiner" is NY's title for a lot of unrelated work. Measured: a bare
  // /examiner/ admitted four "Motor Vehicle License Examiner" (DMV driver
  // licensing) plus "Hearing Examiner", none of which is assessment work. The
  // forms that DO belong to the lane are the examining-of-records roles:
  // Budget, Payroll, Eligibility, Retirement System.
  [/(assessment specialist|test administrator|testing technician|psychometric|testing services|(budget|payroll|eligibility|retirement system|benefits)\s+examiner)/i, 'assessment'],
  [/(program (coordinator|manager|specialist|administrator|assistant)|program director)/i, 'program'],
  [/(compliance (specialist|officer|analyst|manager)|quality (assurance|control))/i, 'compliance'],
  [/(coordinator)/i, 'coordinator'],
  [/(case (management|coordinator)|caseworker|social (worker|service))/i, 'casework'],
  [/(youth|human (resources|services)|children and family|family services)/i, 'youth'],
  [/(records (management|officer)|legal (assistant|specialist)|paralegal)/i, 'records'],
  [/(museum|librar|archive)/i, 'museum'],
  [/(learning and development|professional development|learning experience)/i, 'learning'],
];
export function laneOf(title) { for (const [re, lane] of LANE) if (re.test(title)) return lane; return null; }

/**
 * Credentials the record does not hold.
 *
 * Measured: without these, "Licensed Clinical Social Worker", "Licensed Master
 * Social Worker" and the psychiatrist/psychologist/nurse-practitioner titles
 * dominated the social-work bucket — 157 lane hits but a large share of them
 * require a licence or a clinical degree that `cv.md` does not show. These are
 * hard exclusions, not flags: no amount of evaluation changes the answer.
 */
const LICENSED = /(licensed\s+(clinical\s+|master\s+)?social\s+worker|licensed\s+mental\s+health\s+counselor|psychiatrist|psychologist|nurse\s+practitioner|physician|physician\s+assistant|registered\s+nurse|dentist|attorney\s+2?\b|law\s+degree)/i;
export function isLicensed(title) { return LICENSED.test(title); }

/** Grades outside the band are excluded; above GRADE_FLAG_ABOVE is a stretch. */
export function gradeStatus(grade) {
  if (/^6\d\d$/.test(grade)) return { ok: false, why: 'executive grade' };
  if (/^(NS|Hourly)$/i.test(grade)) return { ok: true, flag: 'non-numeric grade (' + grade + ')' };
  const n = Number(grade);
  if (!Number.isInteger(n)) return { ok: false, why: 'unparseable grade' };
  if (n < GRADE_MIN) return { ok: false, why: 'below grade ' + GRADE_MIN + ' (grade ' + n + ')' };
  if (n > GRADE_MAX) return { ok: false, why: 'above grade ' + GRADE_MAX + ' (grade ' + n + ')' };
  return { ok: true, flag: n > GRADE_FLAG_ABOVE ? 'senior for his band (grade ' + n + ')' : '' };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const date = localToday();
  const r = await get(TABLE);
  if (r.status !== 200) { console.error(`Board returned HTTP ${r.status}; refusing to report a zero.`); process.exit(1); }

  const all = parseTable(r.body);
  if (!all.length) { console.error('Parsed 0 vacancies from a 200 response — refusing to report a zero.'); process.exit(1); }
  console.log(`  Parsed vacancies: ${all.length}`);

  if (DUMP) {
    // Apply the same filters the real run applies, so the dump previews the
    // actual outcome rather than a looser superset that invites tuning against
    // roles this scanner would never emit.
    const dl0 = (x) => parseBoardDate(x.deadline);
    const now0 = Date.now();
    const withLane = all
      .filter((v) => !(dl0(v) && dl0(v).getTime() < now0))
      .map((v) => ({ ...v, lane: laneOf(v.title) }))
      .filter((v) => v.lane);
    const lic = withLane.filter((v) => isLicensed(v.title));
    const survivors = withLane.filter((v) => !isLicensed(v.title) && gradeStatus(v.grade).ok);
    console.log(`\n  Lane-relevant (deadline open):        ${withLane.length}`);
    console.log(`  Removed as licensed/clinical:         ${lic.length}`);
    console.log(`  SURVIVORS the scan would emit:        ${survivors.length}\n`);
    survivors.slice(0, 40).forEach((v) => {
      const g = gradeStatus(v.grade);
      console.log(`  g${String(v.grade).padEnd(5)} ${v.lane.padEnd(13)} ${v.title.slice(0, 48).padEnd(50)} ${v.county.slice(0, 11).padEnd(12)} dl ${v.deadline}${g.flag ? '  [' + g.flag + ']' : ''}`);
    });
    return;
  }

  const { seen } = loadSeenUrls();
  const closedSkipped = [], staleSkipped = [], gradeSkipped = [], laneSkipped = [], dupeSkipped = [], licensedSkipped = [];
  const passing = [];

  const cutoff = useFreshness ? Date.now() - FRESHNESS_DAYS * 864e5 : null;
  const now = Date.now();

  for (const v of all) {
    // Deadline is the board's own liveness statement. A past deadline is closed.
    const dl = parseBoardDate(v.deadline);
    if (dl && dl.getTime() < now) { closedSkipped.push(v); continue; }

    if (cutoff) {
      const po = parseBoardDate(v.posted);
      if (po && po.getTime() < cutoff) { staleSkipped.push(v); continue; }
    }

    const lane = laneOf(v.title);
    if (!lane) { laneSkipped.push(v); continue; }
    if (isLicensed(v.title)) { licensedSkipped.push(v); continue; }

    const g = gradeStatus(v.grade);
    if (!g.ok) { gradeSkipped.push(v); continue; }

    // Dedup key MUST go through normalizeUrlForDedup — the same function
    // loadSeenUrls() uses to populate the set. That function lowercases the
    // WHOLE url including the path segment, so this board's
    // `.../vacancyDetailsView.cfm?id=227123` is stored as
    // `.../vacancydetailsview.cfm?id=227123`. Comparing the raw mixed-case URL
    // against the set never matches, so every run re-added all 25 offers and
    // doubled the pipeline. Measured: 50 pending rows for 25 distinct ids.
    if (seen.has(normalizeUrlForDedup(v.url))) { dupeSkipped.push(v); continue; }
    passing.push({ ...v, lane, gradeFlag: g.flag });
  }

  console.log(`  Lane-relevant + grade in band + open: ${passing.length}`);

  // Optional detail fetch: the exam requirement lives here, not on the list.
  let enriched = 0;
  if (ENRICH) {
    for (const v of passing) {
      try {
        const d = await get(v.url);
        if (d.status === 200) {
          const txt = strip(d.body);
          const exam = (/(?:must (?:have|hold|possess)|requires?)\s+(?:be\s+)?(?:on|for)\s+[^.]{0,120}?(?:exam\w*|list|eligib\w*)[^.]{0,120}/i.exec(txt) || [])[0]
            || (/(exam\w*[^.]{0,80}(?:required|required to|applicants must))[^.]{0,120}/i.exec(txt) || [])[0]
            || (/(?:civil service|competitive|non-competitive)[^.]{0,140}/i.exec(txt) || [])[0]
            || '';
          if (exam) { v.examNote = strip(exam).slice(0, 220); enriched++; }
        }
      } catch { /* enrichment is best-effort */ }
      await sleep(200);
    }
    console.log(`  Enriched with exam/eligibility text: ${enriched}/${passing.length}`);
  }

  const accepted = passing.slice(0, LIMIT);
  const deferred = passing.slice(LIMIT);

  if (DRY) {
    console.log('\n  --dry-run: nothing written\n');
    for (const v of accepted) {
      console.log(`  • ${v.title}`);
      console.log(`    ${v.agency} | grade ${v.grade} | ${v.county} | lane ${v.lane} | posted ${v.posted} deadline ${v.deadline}`);
      if (v.gradeFlag) console.log(`    FLAG: ${v.gradeFlag}`);
      if (v.examNote) console.log(`    EXAM: ${v.examNote}`);
      console.log(`    ${v.url}`);
    }
  } else {
    if (accepted.length) await appendToPipeline(accepted);
    if (accepted.length) await appendToScanHistory(accepted, date, 'added');
    if (laneSkipped.length) await appendToScanHistory(laneSkipped, date, 'skipped_title');
    if (licensedSkipped.length) await appendToScanHistory(licensedSkipped, date, 'skipped_credentials');
    if (gradeSkipped.length) await appendToScanHistory(gradeSkipped, date, 'skipped_seniority');
    if (staleSkipped.length) await appendToScanHistory(staleSkipped, date, 'skipped_date');
    if (closedSkipped.length) await appendToScanHistory(closedSkipped, date, 'skipped_closed');
    if (dupeSkipped.length) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  printScanSummaryHeader('NY State Civil Service (general public)', date);
  console.log('─'.repeat(56));
  console.log(`Vacancies on board:   ${all.length}`);
  console.log(`Filtered off-lane:    ${laneSkipped.length}`);
  console.log(`Filtered credentials: ${licensedSkipped.length}   (licensed/clinical roles the record cannot satisfy)`);
  console.log(`Filtered by grade:    ${gradeSkipped.length}   (band ${GRADE_MIN}-${GRADE_MAX}; 6xx executive excluded)`);
  console.log(`Filtered stale:       ${staleSkipped.length}   (${useFreshness ? FRESHNESS_DAYS + 'd from Posted' : 'disabled'})`);
  console.log(`Closed (past deadline):${closedSkipped.length}   ← board's own liveness signal`);
  console.log(`Already seen:         ${dupeSkipped.length}`);
  console.log(`Deferred (over cap):  ${deferred.length}`);
  console.log(`NEW OFFERS:           ${accepted.length}`);
  console.log('');
  for (const v of accepted) console.log(`  • ${v.title} — ${v.agency} (g${v.grade}, ${v.county})`);
  console.log('\n→ ELIGIBILITY UNVERIFIED. The user holds NY State exam eligibility but has not');
  console.log('  confirmed which exams. NY competitive postings usually require a specific');
  console.log('  exam or an eligible title. Confirm per posting before investing.');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
