#!/usr/bin/env node
/**
 * scan-usajobs.mjs — US federal jobs via the USAJobs public API.
 *
 * WHY THIS SOURCE IS WORTH A KEY (measured 2026-10-17):
 *   Keyword=assessment alone returns SearchResultCountAll = 7,993 federal jobs.
 *   With LocationName=New York, 538. The federal government is the single
 *   densest concentration of assessment/testing work in the US market, and it
 *   is the one part of the search space that is genuinely NATIONAL and largely
 *   REMOTE — structurally different from every other board in this tracker,
 *   which are NYC-onsite or metro-commutable.
 *
 *   Compare against the yield table measured 2026-10-17: builtinnyc converted
 *   2.6% of rows into applications, ATS boards 22.6%, public sector 40%. This
 *   source is the "public sector" shape at national scale.
 *
 * CREDENTIALS — never logged, never printed, never committed:
 *   Reads USAJOBS_API_KEY and USAJOBS_USER_AGENT from process.env first, then
 *   from the repo-root `.env`, which `.gitignore:126` excludes. The key is only
 *   ever placed in a request header. If it is missing, the script says how to
 *   supply it and exits; it never echoes any part of it.
 *
 * NO DETAIL FETCHES NEEDED, which is unusual and worth keeping:
 *   /api/search returns PositionFormattedDescription AND QualificationSummary
 *   inline, plus PositionRemuneration, JobGrade and ApplicationCloseDate. The
 *   usual pattern here is "search cheap, then fetch each survivor"; federal
 *   needs neither, so one request per 500 postings covers the whole keyword set.
 *
 * RATE LIMITING: one request per 500 postings per keyword. The key's hourly
 * budget is the only real constraint, so request count is printed per run.
 *
 * SIBLING: scan-cityjobs.mjs · scan-nystate.mjs · scan-mta.mjs · scan-builtinnyc.mjs
 *
 * Usage:
 *   node scan-usajobs.mjs                     # lane keywords, New York
 *   node scan-usajobs.mjs --location ""       # nationwide (no location filter)
 *   node scan-usajobs.mjs --location "New York, NY"
 *   node scan-usajobs.mjs --keyword "test administrator"   # single keyword
 *   node scan-usajobs.mjs --dump              # print without writing
 *   node scan-usajobs.mjs --limit N           # cap accepted (default 40)
 */

import https from 'node:https';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, normalizeUrlForDedup } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const API_HOST = 'data.usajobs.gov';

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
// `--nationwide` rather than `--location ""`: an empty string argument does not
// survive a shell, so `node scan-usajobs.mjs --location "" --dump` silently
// consumed the NEXT flag as the location and searched for jobs in "--dump",
// returning a clean 0 across every keyword that looked like a working scan.
const LOCATION = flag('--nationwide') ? '' : val('--location', 'New York');
const LIMIT = Number(val('--limit', '40'));
const DUMP = flag('--dump');
const SINGLE = val('--keyword', null);

// ── Credentials ──────────────────────────────────────────────────────────────
function loadSecret(name) {
  if (process.env[name]) return process.env[name].trim();
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = new RegExp('^' + name + '\\s*=\\s*(.+)$').exec(line.trim());
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}
const API_KEY = loadSecret('USAJOBS_API_KEY');
const USER_AGENT = loadSecret('USAJOBS_USER_AGENT') || 'career-ops scan';

// ── Lane keywords ────────────────────────────────────────────────────────────
// Phrase-anchored, never bare substrings. See scan-builtinnyc.mjs: "resident"
// is inside "pre|SIDENT" and matched every Vice President title.
const DEFAULT_KEYWORDS = [
  'assessment specialist', 'test administrator', 'testing specialist',
  'instructional designer', 'curriculum specialist', 'training specialist',
  'program coordinator', 'compliance specialist', 'quality assurance',
  'examiner', 'records management', 'education specialist', 'training coordinator',
];
const KEYWORDS = SINGLE ? [SINGLE] : DEFAULT_KEYWORDS;

// GS band. GS-07 is the floor because GS-05 nationwide measured 2026-10-17 runs
// $38,791-$50,428 — below the $60K preference floor, so it cannot clear comp
// however well the rest of the role reads. GS-13 is the ceiling: it asks 4+
// years of specialised experience the record does not have.
const GS_MIN = 7, GS_MAX = 13, GS_FLAG_ABOVE = 11;
// Used only to ORDER and FLAG, never to veto — comp is a preference per
// modes/_custom.md, not a gate.
const COMP_FLOOR = 60000;

function gsLevel(d) {
  const hay = String(d.QualificationSummary || '') + ' ' + String(d.PositionFormattedDescription || '');
  const m = /GS-(\d{2})/.exec(hay);
  return m ? Number(m[1]) : null;
}

/**
 * Phrase-anchored lane test. TITLE ONLY — deliberately.
 *
 * The first version also matched against PositionFormattedDescription and
 * QualificationSummary, reasoning that a lane role might be titled something
 * bland. Measured, that admitted "X-Ray Technologist", "Clinical Laboratory
 * Scientist", "Diagnostic Radiologic Technologist" and "Information Technology
 * Specialist (INFOSEC)" — every federal JD mentions training, records and
 * testing somewhere, so a body-text test matches nearly everything. This is the
 * same lesson as "resident" ⊂ "pre|SIDENT" on builtinnyc: match on a narrow,
 * anchored surface, never on the widest text available.
 *
 * Consequence accepted: a genuinely on-lane role with a bland title
 * ("Program Specialist") is admitted only via the /program specialist/ arm
 * below, and one titled something outside every phrase is missed. Recall is
 * traded for precision deliberately, because the alternative was a 40% false
 * positive rate on a 249-posting set.
 */
/**
 * Hard exclusions measured on the 2026-10-17 nationwide run (3,436 postings,
 * 309 in-band).
 *
 * TITLE 32 / (MILITARY): Title 32 positions are filled by MILITARY RESERVISTS,
 * not civilian applicants, and they dominate a keyword search on training,
 * programme and HR. None is open to him and none should be queued.
 *
 * SUPERVISORY: requires demonstrated supervisory experience plus team
 * leadership over a full grade band. He has co-supervised camp counselors but
 * has never held a supervisory position; same reasoning that dropped the Met's
 * "Supervisory Program Manager (Assistant Director)".
 *
 * CLINICAL: doctoral or licensure requirement, same as the Clinical Psychologist
 * drops in the New York slice.
 */
// The `u?` in `su?pervis` is not a typo: federal postings mis-spell it as
// "Supvervisory Medical Records Technician" (Bureau of Naval Personnel — it is
// in their own published title), which a plain /supervis/ does not match.
const EXCLUDED_TITLE = /(\(\s*military\s*\)|title\s*32|\bsu?pervis)/i;
const CLINICAL_TITLE = /(clinical psychologist|psychiatrist|physician|dentist|nurse practitioner|pharmacist|medical records technician|\bcoder\b)/i;
export function excludedTitle(t) {
  const s = String(t || '');
  if (EXCLUDED_TITLE.test(s)) return 'military/Title-32 or supervisory';
  if (CLINICAL_TITLE.test(s)) return 'clinical/licensure';
  return '';
}

function inLane(d) {
  const t = String(d.PositionTitle || '');
  return /(assessment specialist|test administrator|testing (specialist|technician|manager)|psychometric|examiner)/i.test(t)
    || /(instructional designer|curriculum (specialist|developer|designer)|training (specialist|coordinator|manager))/i.test(t)
    || /program (coordinator|manager|specialist|administrator)/i.test(t)
    || /(compliance (specialist|officer|analyst)|quality (assurance|control))/i.test(t)
    || /(records (management|officer|technician)|librar(y|ian)|museum|archiv)/i.test(t)
    || /(youth|human resources specialist|case (management|coordinator))/i.test(t)
    || /(education (specialist|program|services)|learning (and development|experience))/i.test(t);
}

// ── API ──────────────────────────────────────────────────────────────────────
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API_HOST, path, method: 'GET',
      headers: { Host: API_HOST, 'User-Agent': USER_AGENT, 'Authorization-Key': API_KEY, Accept: 'application/json' },
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const body = d.slice(0, 160);
          reject(new Error('HTTP ' + res.statusCode + (res.statusCode === 401 || res.statusCode === 403
            ? ' — key rejected. Check USAJOBS_API_KEY and USAJOBS_USER_AGENT (must be a real email).'
            : ' — ' + body)));
          return;
        }
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('unparseable response: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

let requests = 0;
async function search(keyword, page = 1, perPage = 500) {
  const params = new URLSearchParams({
    Keyword: keyword, ResultsPerPage: String(perPage), Page: String(page),
    PositionScheduleCode: '1', // full-time only; the record wants FT
  });
  if (LOCATION) params.set('LocationName', LOCATION);
  requests++;
  const j = await apiGet('/api/search?' + params.toString());
  return {
    total: j?.SearchResult?.SearchResultCountAll ?? 0,
    items: j?.SearchResult?.SearchResultItems || [],
  };
}

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error('USAJOBS_API_KEY not found.\n');
    console.error('Set it in a .env file at the repo root (already gitignored):\n');
    console.error('  USAJOBS_API_KEY=<your key>\n  USAJOBS_USER_AGENT=<your email>\n');
    console.error('Request a key at https://developer.usajobs.gov (the old');
    console.error('data.usajobs.gov/api-request/index.cfm returns 404).');
    process.exit(1);
  }

  console.log(`Keywords : ${KEYWORDS.length}  (${SINGLE ? SINGLE : 'lane default set'})`);
  console.log(`Location : ${LOCATION || 'nationwide'}\n`);

  // Union across keywords, deduped on the matched object id.
  const byId = new Map();
  let totalAll = 0;
  for (const kw of KEYWORDS) {
    const pages = Math.max(1, Math.ceil(2000 / 500));
    for (let p = 1; p <= pages; p++) {
      let r;
      try { r = await search(kw, p); }
      catch (e) { console.error(`  keyword "${kw}" p${p}: ${e.message}`); break; }
      totalAll = Math.max(totalAll, r.total);
      let fresh = 0;
      for (const it of r.items) {
        const id = String(it.MatchedObjectId);
        if (byId.has(id)) continue;
        byId.set(id, it.MatchedObjectDescriptor);
        fresh++;
      }
      if (p === 1) console.log(`  "${kw}" -> ${r.total} total, page 1 added ${fresh}`);
      if (r.items.length < 500 || fresh === 0) break;
    }
  }
  console.log(`\n  Unique federal postings across keywords: ${byId.size}`);
  console.log(`  API requests used this run: ${requests}`);

  const { seen } = loadSeenUrls();
  const laneHits = [], offLane = [], seenSkip = [], gradeSkip = [], staleSkip = [], closedSkip = [], gatedSkip = [], duplicateTitle = [];
  const now = Date.now();

  for (const d of byId.values()) {
    const url = String(d.PositionURI || '').replace(':443', '');
    if (!inLane(d)) { offLane.push(d); continue; }
    const gate = excludedTitle(d.PositionTitle);
    if (gate) { gatedSkip.push({ d, gate }); continue; }
    const gs = gsLevel(d);
    if (gs !== null && (gs < GS_MIN || gs > GS_MAX)) { gradeSkip.push(d); continue; }
    const close = Date.parse(String(d.ApplicationCloseDate || '').replace(/[^0-9T:.\-Z]/g, (c) => (c === 'Z' ? 'Z' : '')) || '');
    if (!Number.isNaN(close) && close < now) { closedSkip.push(d); continue; }
    if (seen.has(normalizeUrlForDedup(url))) { seenSkip.push(d); continue; }
    laneHits.push({ d, gs, url });
  }

  // Order by what actually decides whether a posting is worth an application:
  // a salary that clears the preference floor first, then the GS level closest
  // to his band. Sorting on GS alone put GS-07 overseas unit-coordinator roles
  // ahead of GS-12 roles in his own city.
  const salOf = (d) => Number((d.PositionRemuneration || [])[0]?.MinimumRange) || 0;
  laneHits.sort((a, b) => {
    const af = salOf(a.d) >= COMP_FLOOR ? 0 : 1;
    const bf = salOf(b.d) >= COMP_FLOOR ? 0 : 1;
    if (af !== bf) return af - bf;
    const ab = (a.gs ?? 99), bb = (b.gs ?? 99);
    if (ab !== bb) return ab - bb;
    return salOf(b.d) - salOf(a.d);
  });
  // Title diversity cap. Measured: the nationwide run queued 40 offers of which
  // 20+ were "Staff Operations and Training Specialist / U.S. Army Reserve
  // Command" — the same role posted at many units. Individually valid, but no
  // one applies to fifteen of them, and it buries everything else. Cap at
  // MAX_PER_TITLE_ORG per (normalised title, organisation) so breadth survives.
  const MAX_PER_TITLE_ORG = 2;
  const tally = new Map();
  const spread = [];
  for (const h of laneHits) {
    const key = (strip(h.d.PositionTitle).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|'
      + strip(h.d.OrganizationName).toLowerCase());
    const n = (tally.get(key) || 0) + 1;
    tally.set(key, n);
    if (n <= MAX_PER_TITLE_ORG) spread.push(h); else duplicateTitle.push(h);
  }

  const accepted = spread.slice(0, LIMIT);
  const deferred = spread.slice(LIMIT);

  const rows = accepted.map(({ d, gs, url }) => ({
    url,
    title: strip(d.PositionTitle),
    company: strip(d.OrganizationName) || strip(d.DepartmentName) || 'US Federal',
    department: strip(d.DepartmentName),
    subagency: strip(d.SubAgency),
    location: strip(d.PositionLocationDisplay),
    grade: gs !== null ? 'GS-' + String(gs).padStart(2, '0') : '',
    // PositionRemuneration entries are FLAT objects — {MinimumRange,
    // MaximumRange, RateIntervalCode, Description} — not the nested
    // PositionRemuneration[0].Value shape assumed by the first version of this
    // line, which crashed on every posting that carried a pay range.
    // The range often spans several grades at once (e.g. 61722-280243), which is
    // normal for a multi-grade announcement, not a data error.
    salary: (d.PositionRemuneration || [])
      .map((x) => {
        const lo = x?.MinimumRange ? Number(x.MinimumRange).toLocaleString('en-US') : '';
        const hi = x?.MaximumRange ? Number(x.MaximumRange).toLocaleString('en-US') : '';
        return lo && hi ? `$${lo} - $${hi}` : '';
      })
      .filter(Boolean).join(' | '),
    closeDate: String(d.ApplicationCloseDate || '').slice(0, 10),
    qualifications: strip(d.QualificationSummary).slice(0, 1200),
    description: strip(d.PositionFormattedDescription).slice(0, 4000),
    source: 'usajobs',
  }));

  if (DUMP) {
    console.log(`\n  Lane + grade + open: ${laneHits.length}\n`);
    rows.slice(0, 25).forEach((r) => {
      console.log(`  ${String(r.grade).padEnd(7)}${r.title.slice(0, 50).padEnd(52)}${r.location.slice(0, 22).padEnd(24)}closes ${r.closeDate}`);
      console.log(`         ${r.company.slice(0, 66)}${r.salary ? ' | ' + r.salary : ''}`);
    });
    return;
  }

  if (rows.length) {
    await appendToPipeline(rows);
    await appendToScanHistory(rows.map((r) => ({ url: r.url, title: r.title, company: r.company, location: r.location })), localToday(), 'added');
    if (offLane.length) await appendToScanHistory(offLane.map((d) => ({ url: String(d.PositionURI || ''), title: strip(d.PositionTitle), company: strip(d.OrganizationName) })), localToday(), 'skipped_title');
    if (gradeSkip.length) await appendToScanHistory(gradeSkip.map((d) => ({ url: String(d.PositionURI || ''), title: strip(d.PositionTitle), company: strip(d.OrganizationName) })), localToday(), 'skipped_seniority');
    if (gatedSkip.length) await appendToScanHistory(gatedSkip.map((g) => ({ url: String(g.d.PositionURI || ''), title: strip(g.d.PositionTitle), company: strip(g.d.OrganizationName) })), localToday(), 'skipped_inaccessible');
    if (duplicateTitle.length) await appendToScanHistory(duplicateTitle.map((h) => ({ url: String(h.d.PositionURI || ''), title: strip(h.d.PositionTitle), company: strip(h.d.OrganizationName) })), localToday(), 'skipped_duplicate_title');
    if (closedSkip.length) await appendToScanHistory(closedSkip.map((d) => ({ url: String(d.PositionURI || ''), title: strip(d.PositionTitle), company: strip(d.OrganizationName) })), localToday(), 'skipped_closed');
    if (seenSkip.length) await appendToScanHistory(seenSkip.map((d) => ({ url: String(d.PositionURI || ''), title: strip(d.PositionTitle), company: strip(d.OrganizationName) })), localToday(), 'skipped_dup');
  }

  printScanSummaryHeader('USAJobs (federal)', localToday());
  console.log('─'.repeat(56));
  console.log(`Postings enumerated: ${byId.size} across ${KEYWORDS.length} keyword(s), ${requests} API request(s)`);
  console.log(`Filtered off-lane:  ${offLane.length}`);
  console.log(`Filtered by grade:  ${gradeSkip.length}   (band GS-${GS_MIN}-GS-${GS_MAX})`);
  console.log(`Filtered inaccessible:${String(gatedSkip.length).padStart(3)}   (Title 32 / military-reserve, supervisory, or licensure-gated)`);
  console.log(`Closed (past date): ${closedSkip.length}`);
  console.log(`Already seen:       ${seenSkip.length}`);
  console.log(`Duplicate title/org:${String(duplicateTitle.length).padStart(3)}   (same role at many units — capped at 2 each)`);
  console.log(`Deferred (over cap):${deferred.length}`);
  console.log(`NEW OFFERS:         ${rows.length}`);
  console.log('');
  for (const r of rows.slice(0, 25)) console.log(`  • [${r.grade || 'GS?'}] ${r.title} — ${r.company}`);
  if (rows.length > 25) console.log(`  … and ${rows.length - 25} more`);
  console.log('\n→ Federal postings are subject to an ApplicationCloseDate; confirm it has not');
  console.log('  passed, and check the announcement for a required security clearance or');
  console.log('  citizenship statement that the API does not surface.');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
