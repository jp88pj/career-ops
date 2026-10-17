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
// --no-exam restricts to postings hireable WITHOUT a competitive examination,
// which is the mode this candidate needs while his own list membership is
// unconfirmed. It costs one detail fetch per lane+grade survivor, because
// 55-b/c and salary exist ONLY on the detail page — the listing has neither.
const NO_EXAM = flag('--no-exam');
// --audit reports the exam-eligibility distribution across every lane+grade
// survivor, ignoring dedup and writing nothing. Needed because once the earlier
// runs recorded those postings, an ordinary scan reports "already seen" for all
// of them and cannot answer "how many of these are exam-free?".
const AUDIT = flag('--audit');
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

/**
 * Detail-page fields.
 *
 * MEASURED 2026-10-17, and this is the important part: the "(NY HELPS)" marker
 * in a posting TITLE is NOT a reliable proxy for being hireable without a
 * competitive exam. Sampling the board:
 *     "Environmental Analyst 1 (NY HELPS)"   -> 55-b/c Eligible: No
 *     "Training Specialist 1" (no HELPS)     -> 55-b/c Eligible: Yes
 * The marker and the actual mechanism run opposite ways, so a title-based
 * HELPS filter is worse than useless — it would drop the roles that are open.
 *
 * `55-b/c Eligible` is the field that matters: it is the civil-service
 * provision letting an agency appoint without a competitive examination, which
 * is exactly what this candidate needs while his own list membership is
 * UNCONFIRMED (config/profile.yml -> state_employment).
 *
 * The same page also yields the real salary range, which the LISTING never
 * carries — grade "NS" rows had no way to check comp before this.
 */
export function parseDetail(text) {
  const g = (label) => {
    const m = new RegExp(label + '\\s+(Yes|No|\\d{2}|[A-Za-z][A-Za-z /&.-]{2,44}?)(?=\\s{1,3}(?:Agency|Title|Occupational|Salary|Bargaining|Employment|Appointment|Internship|Jurisdictional|Travel|Workday|Hours|Telecommuting|County|Street|City|State|Zip|Duties|\\d))', 'i').exec(text);
    return m ? m[1].trim() : '';
  };
  const range = /Salary Range From \$([\d,]+) to \$([\d,]+)/i.exec(text);
  const lo = range ? Number(range[1].replace(/,/g, '')) : null;
  const hi = range ? Number(range[2].replace(/,/g, '')) : null;
  return {
    helps: g('NY HELPS'),
    b55c: g('55-b/c Eligible'),
    salaryLo: lo, salaryHi: hi,
    salary: lo && hi ? `$${range[1]} - $${range[2]}` : '',
    appointment: g('Appointment Type'),
    juris: g('Jurisdictional Class'),
    telecommute: /Telecommuting allowed\?\s*Yes/i.test(text),
    travel: g('Travel Percentage'),
  };
}

/**
 * Eligible without a confirmed civil-service list?
 *
 * True when the posting is 55-b/c eligible OR is flagged NY HELPS. Anything
 * else means an exam or an existing list is in play, which is unanswerable
 * until config/profile.yml -> state_employment.exams is filled in — so those
 * are reported separately rather than silently mixed in.
 */
export function examFree(d) {
  return d.b55c?.toLowerCase() === 'yes' || d.helps?.toLowerCase() === 'yes';
}

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
  const closedSkipped = [], staleSkipped = [], gradeSkipped = [], laneSkipped = [], dupeSkipped = [], licensedSkipped = [], examGated = [];
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
    if (!AUDIT && seen.has(normalizeUrlForDedup(v.url))) { dupeSkipped.push(v); continue; }
    passing.push({ ...v, lane, gradeFlag: g.flag });
  }

  console.log(`  Lane-relevant + grade in band + open: ${passing.length}`);

  // Detail enrichment: 55-b/c eligibility, real salary, telecommuting.
  // Required under --no-exam because the listing carries none of these.
  let detailed = 0;
  if (ENRICH || NO_EXAM) {
    for (const v of passing) {
      try {
        const d = await get(v.url);
        if (d.status === 200) {
          const meta = parseDetail(strip(d.body));
          v.helps = meta.helps; v.b55c = meta.b55c; v.salary = meta.salary;
          v.salaryLo = meta.salaryLo; v.appointment = meta.appointment;
          v.telecommute = meta.telecommute; v.examFree = examFree(meta);
          detailed++;
        }
      } catch { /* best-effort */ }
      await sleep(150);
    }
    const free = passing.filter((v) => v.examFree).length;
    console.log(`  Detail fetched: ${detailed}/${passing.length}   hireable WITHOUT an exam (55-b/c or NY HELPS): ${free}`);
    if (NO_EXAM) {
      const keep = passing.filter((v) => v.examFree);
      for (const v of passing) if (!v.examFree) examGated.push(v);
      passing.length = 0;
      passing.push(...keep);
      console.log(`  --no-exam: kept ${passing.length}, set aside ${examGated.length} that need an exam or an existing list`);
    }
  }

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

  if (AUDIT) {
    const free = passing.filter((v) => v.examFree);
    const gated = passing.filter((v) => !v.examFree);
    const withSalary = passing.filter((v) => v.salary);
    const inBand = (v) => { const g = Number(v.grade); return g >= 14 && g <= 20; };
    const COMMUTABLE = /^(Kings|Queens|New York|Bronx|Richmond|Nassau|Suffolk|Westchester|Rockland)/i;

    console.log('\n  === EXAM-ELIGIBILITY AUDIT ===\n');
    console.log(`  lane + grade + open            : ${passing.length}`);
    console.log(`  detail fetched (55-b/c + pay)  : ${passing.filter((v) => v.b55c || v.salary).length}`);
    console.log(`  HIREABLE WITHOUT AN EXAM       : ${free.length}   (55-b/c Eligible=Yes OR NY HELPS=Yes)`);
    console.log(`  exam / existing list required  : ${gated.length}`);
    console.log(`  with a published salary        : ${withSalary.length}`);
    console.log(`  ...and exam-free AND grade 14-20: ${free.filter(inBand).length}`);
    console.log(`  ...and exam-free AND commutable: ${free.filter((v) => COMMUTABLE.test(v.county)).length}`);

    const b55 = {};
    passing.forEach((v) => { const k = v.b55c || '(unparsed)'; b55[k] = (b55[k] || 0) + 1; });
    console.log('\n  55-b/c Eligible distribution: ' + Object.entries(b55).map(([k, n]) => `${k}=${n}`).join('  '));
    const h = {};
    passing.forEach((v) => { const k = v.helps || '(unparsed)'; h[k] = (h[k] || 0) + 1; });
    console.log('  NY HELPS distribution       : ' + Object.entries(h).map(([k, n]) => `${k}=${n}`).join('  '));

    const inBandRows = passing.filter((v) => Number(v.grade) >= 14 && Number(v.grade) <= 20);
    const salaries = inBandRows.map((v) => v.salaryLo).filter((x) => typeof x === 'number');
    if (salaries.length) {
      salaries.sort((a, b) => a - b);
      console.log(`\n  salary floor across grade 14-20: min $${salaries[0].toLocaleString()}  median $${salaries[Math.floor(salaries.length / 2)].toLocaleString()}  max $${salaries[salaries.length - 1].toLocaleString()}`);
      const clears = salaries.filter((x) => x >= 60000).length;
      console.log(`  rows whose salary floor clears the $60K preference: ${clears}/${salaries.length}`);
    }

    console.log('\n  --- EXAM-FREE, grade 14-20, commutable (the shortlist) ---');
    passing.filter((v) => v.examFree && inBand(v) && COMMUTABLE.test(v.county))
      .sort((a, b) => (a.salaryLo || 0) - (b.salaryLo || 0))
      .forEach((v) => console.log(`   g${String(v.grade).padEnd(4)}${String(v.salary || 'salary?').padEnd(24)}${v.title.slice(0, 46).padEnd(48)}${v.county}`));

    console.log('\n  --- EXAM-FREE, grade 14-20, upstate (relocation cost) ---');
    passing.filter((v) => v.examFree && inBand(v) && !COMMUTABLE.test(v.county))
      .slice(0, 20)
      .forEach((v) => console.log(`   g${String(v.grade).padEnd(4)}${String(v.salary || 'salary?').padEnd(24)}${v.title.slice(0, 46).padEnd(48)}${v.county}`));
    return;
  }

  if (DRY) {
    console.log('\n  --dry-run: nothing written\n');
    for (const v of accepted) {
      console.log(`  • ${v.title}`);
      console.log(`    ${v.agency} | grade ${v.grade} | ${v.county} | lane ${v.lane} | deadline ${v.deadline}`);
      if (v.salary) console.log(`    salary ${v.salary}${v.telecommute ? '  | TELECOMMUTE ALLOWED' : ''}${v.appointment ? '  | ' + v.appointment : ''}`);
      if (v.b55c || v.helps) console.log(`    55-b/c=${v.b55c || '?'}  NY HELPS=${v.helps || '?'}${v.examFree ? '  -> EXAM-FREE' : '  -> exam/list may apply'}`);
      if (v.gradeFlag) console.log(`    FLAG: ${v.gradeFlag}`);
      if (v.examNote) console.log(`    EXAM: ${v.examNote}`);
      console.log(`    ${v.url}`);
    }
  } else {
    if (accepted.length) await appendToPipeline(accepted);
    if (accepted.length) await appendToScanHistory(accepted, date, 'added');
    if (laneSkipped.length) await appendToScanHistory(laneSkipped, date, 'skipped_title');
    if (licensedSkipped.length) await appendToScanHistory(licensedSkipped, date, 'skipped_credentials');
    if (examGated.length) await appendToScanHistory(examGated, date, 'skipped_exam_gated');
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
