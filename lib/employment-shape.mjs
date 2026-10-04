/**
 * Employment SHAPE — annotate, never veto.
 *
 * A job's employment type (full-time / part-time / seasonal / contract) is
 * frequently absent from its TITLE, so a title-word negative cannot see it.
 * Workday carries it in the detail payload's `timeType`; only 3 of the 11
 * part-time roles on the RFCUNY board name it in the title, so 7 are invisible
 * to title filtering entirely.
 *
 * The failure this replaces, measured 2026-10-04: "Math Curriculum Developer"
 * reads $40-50/hour, `timeType: Part time`. Annualising $50 x 2080 produced a
 * confident "$104,000 flat — best lead on the board". It is roughly $52K at
 * 25 h/wk. A hard veto has the opposite problem: it SILENTLY DROPS a $65K role
 * at 30 h/wk in the same breath as a $20K one, which is the anti-pattern
 * portals.yml already warns about ("a title-level veto silently HIDES a role
 * rather than flagging it"; "Seniority is scored, not filtered").
 *
 * So shape is a FLAG:
 *   - never removes a posting
 *   - attaches the real figure, so the decision is made on a number
 *   - surfaces below `surfaceMin` only as a receipt counter, never silently
 *
 * @module lib/employment-shape
 */

/**
 * Negative-list entries that describe EMPLOYMENT SHAPE rather than subject.
 * These are the exact strings portals.yml uses, so the strip below is provably
 * exhaustive against the shipped config rather than a hand-picked guess.
 * 'Contract' is deliberately absent: portals.yml removed word:Contract on
 * 2026-10-01 because it vetoed 17 permanent civil-service roles whose SUBJECT
 * is contracts, and the real contract signal lives in the posting body.
 */
export const SHAPE_TITLE_NEGATIVES = [
  'Part Time',
  'Part-time',
  'P/T',
  'Per Diem',
  'Seasonal',
  'Intermittent',
  'Temp',
  '1099',
];

/** Shape words held in a title filter config, lowercased, for stripping. */
const SHAPE_SET = new Set(SHAPE_TITLE_NEGATIVES.map((s) => s.toLowerCase()));

/**
 * Return a copy of a title_filter config with the employment-shape negatives
 * removed, so those postings survive the TITLE gate and reach the shape
 * annotator, which reports them with their real figure instead of hiding them.
 *
 * A shallow copy is safe and sufficient: only `.negative` is replaced, and the
 * caller never mutates the original (the config object is read-only downstream
 * and is shared across every company in the run).
 *
 * @param {{negative?: unknown, positive?: unknown}} [titleFilter]
 * @returns {{negative?: unknown, positive?: unknown}|undefined}
 */
export function stripShapeNegatives(titleFilter) {
  if (!titleFilter || typeof titleFilter !== 'object') return titleFilter;
  const neg = Array.isArray(titleFilter.negative) ? titleFilter.negative : [];
  const kept = neg.filter((k) => !(typeof k === 'string' && SHAPE_SET.has(k.trim().toLowerCase())));
  if (kept.length === neg.length) return titleFilter;
  return { ...titleFilter, negative: kept };
}

/**
 * Classify employment shape from free text (a Workday `timeType`, a Greenhouse
 * title, a Lever category, or a posting body).
 *
 * Order matters: CONTRACT is checked before TEMP because "Temporary Contract"
 * should not read as merely temp, and TEMP is checked with a word boundary so
 * it does not fire on "Temperature". UNKNOWN is a real answer — it means the
 * platform did not say, which is materially different from "full-time".
 *
 * @param {string} text
 * @returns {'full-time'|'part-time'|'contract'|'seasonal'|'per-diem'|'intermittent'|'temp'|'unknown'}
 */
export function classifyEmploymentType(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return 'unknown';
  if (/\bcontract(?:or)?\b|\b1099\b|\bfreelance\b/.test(t)) return 'contract';
  if (/\bpart[ -]?time\b|\bparttime\b|\bpt\b/.test(t)) return 'part-time';
  if (/\bper[ -]?diem\b/.test(t)) return 'per-diem';
  if (/\bseasonal\b/.test(t)) return 'seasonal';
  if (/\bintermittent\b|\bas needed\b|\bon[ -]?call\b/.test(t)) return 'intermittent';
  if (/\btemporary\b|\btemp\b/.test(t)) return 'temp';
  if (/\bfull[ -]?time\b|\bfulltime\b/.test(t)) return 'full-time';
  return 'unknown';
}

/** Shapes that are not a permanent full-time seat. */
export const NON_FULL_TIME = new Set(['part-time', 'contract', 'seasonal', 'per-diem', 'intermittent', 'temp']);

/**
 * Pull an hourly rate out of posting prose. Returns null when there is none.
 * Handles "$40-50 per hour", "$40-50/hour", "$22.50 an hour", "$40 - $50 / hr".
 *
 * @param {string} description
 * @returns {{lo: number, hi: number}|null}
 */
export function parseHourlyRate(description) {
  const t = String(description ?? '').replace(/\s+/g, ' ');
  // "\/\s*" not "\/": postings write both "$50/hr" and "$50 / hr", and the
  // missing \s* made the spaced form silently return null.
  const re = /\$\s?([\d]{1,3}(?:\.\d{1,2})?)\s*(?:-|–|—|to)\s*\$?\s?([\d]{1,3}(?:\.\d{1,2})?)?\s*(?:\/\s*|per\s+)(?:hour|hr)\b/gi;
  let best = null;
  for (const m of t.matchAll(re)) {
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (!Number.isFinite(lo) || lo <= 0) continue;
    if (lo > 400) continue;               // guard: a "rate" above $400/hr is a year salary misparsed
    const cand = { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
    if (!best || cand.hi > best.hi) best = cand;
  }
  if (best) return best;
  const single = t.match(/\$\s?([\d]{1,3}(?:\.\d{1,2})?)\s*(?:\/\s*|per\s+)(?:hour|hr)\b/i);
  if (single) {
    const v = Number(single[1]);
    if (Number.isFinite(v) && v > 0 && v <= 400) return { lo: v, hi: v };
  }
  return null;
}

/**
 * Annualise an hourly rate at an explicit weekly schedule.
 *
 * 2080 is the FULL-TIME year and must never be applied to a non-full-time role:
 * that multiplication is what produced the phantom $104,000. Callers pass the
 * schedule, or leave hoursPerWeek null when the posting does not state one — in
 * which case the rate is reported WITHOUT a salary, because an assumed schedule
 * would be a fabricated figure.
 *
 * @param {{lo:number,hi:number}} rate
 * @param {number|null} hoursPerWeek
 * @returns {{lo:number,hi:number}|null} null when hoursPerWeek is unknown
 */
export function annualize(rate, hoursPerWeek) {
  if (!rate || !Number.isFinite(hoursPerWeek) || hoursPerWeek <= 0) return null;
  const weeks = 52;
  return { lo: Math.round(rate.lo * hoursPerWeek * weeks), hi: Math.round(rate.hi * hoursPerWeek * weeks) };
}

/**
 * Read a declared weekly schedule from posting prose ("21 hours a week",
 * "20 hrs/wk"). Returns null when unstated.
 *
 * @param {string} description
 * @returns {number|null}
 */
export function parseDeclaredHours(description) {
  const t = String(description ?? '');
  const m = t.match(/(\d{1,2})\s*(?:hours?|hrs?)\s*(?:a|per)\s*week\b/i)
    || t.match(/(\d{1,2})\s*(?:hours?|hrs?)\s*\/\s*week\b/i)
    || t.match(/\b(\d{1,2})\s*hours?\s+weekly\b/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 && v <= 60 ? v : null;
}

/**
 * Build the shape policy from portals.yml.
 *
 * Absent config, or a config with `flag_not_veto` off, yields `active: false`
 * and every caller behaves exactly as before — that is what keeps this
 * backward compatible.
 *
 * @param {unknown} raw the `employment_shape` block
 * @returns {{active: boolean, flagNotVeto: boolean, surfaceMin: number, detailPlatforms: Set<string>, assumeFullTimeHours: number}}
 */
export function buildShapePolicy(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const flagNotVeto = cfg.flag_not_veto === true;
  const surfaceMin = Number.isFinite(Number(cfg.surface_min)) ? Number(cfg.surface_min) : 0;
  const platforms = Array.isArray(cfg.detail_platforms)
    ? cfg.detail_platforms.filter((p) => typeof p === 'string').map((p) => p.trim().toLowerCase()).filter(Boolean)
    : ['workday'];
  const assumeFullTimeHours = Number.isFinite(Number(cfg.full_time_hours_per_week))
    ? Number(cfg.full_time_hours_per_week)
    : 40;
  return {
    active: flagNotVeto || surfaceMin > 0,
    flagNotVeto,
    surfaceMin,
    detailPlatforms: new Set(platforms),
    assumeFullTimeHours,
  };
}

/**
 * Decide whether a flagged shape should be surfaced for human triage.
 *
 * Surfacing is deliberately NOT a second filter with its own opinions: a flagged
 * role clears the bar when its BEST case (the top of its band) reaches
 * surfaceMin. Anything below is counted in the receipt rather than queued, so
 * the row exists in the stats even though it does not reach the tracker.
 *
 * @param {{shape:string, annualLo:number|null, annualHi:number|null, rateHi:number|null}} info
 * @param {{surfaceMin:number, active:boolean}} policy
 * @returns {boolean}
 */
export function shouldSurfaceFlagged(info, policy) {
  if (!policy.active) return false;
  if (!info || info.shape === 'full-time' || info.shape === 'unknown') return false;
  if (policy.surfaceMin <= 0) return true;
  const best = info.annualHi ?? info.annualLo ?? null;
  if (best != null) return best >= policy.surfaceMin;
  // No annualisable figure at all: fall back to the top hourly rate x a full
  // week, so a well-paid part-time role is not hidden merely for lacking a
  // stated schedule. This is an UPPER bound, deliberately generous, and the
  // receipt records that it was an upper bound.
  if (info.rateHi != null) return info.rateHi * policy.assumeFullTimeHours * 52 >= policy.surfaceMin;
  return false;
}

/**
 * One-line, human-readable note attached to the offer so the flag travels with
 * the row into pipeline.md instead of living only in the run summary.
 *
 * @param {{shape:string, rateLo:number|null, rateHi:number|null, hoursPerWeek:number|null, annualLo:number|null, annualHi:number|null, source:string}} info
 * @returns {string}
 */
export function describeShape(info) {
  const rate = info.rateLo == null ? ''
    : info.rateHi && info.rateHi !== info.rateLo ? `$${info.rateLo}-$${info.rateHi}/hr` : `$${info.rateLo}/hr`;
  const sched = info.hoursPerWeek != null ? `${info.hoursPerWeek} h/wk` : 'schedule not stated';
  const salary = info.annualLo == null ? 'not annualised'
    : info.annualHi && info.annualHi !== info.annualLo
      ? `~$${info.annualLo.toLocaleString()}-$${info.annualHi.toLocaleString()}`
      : `~$${info.annualLo.toLocaleString()}`;
  return `[shape: ${info.shape} via ${info.source}; ${rate || 'rate not stated'}; ${sched}; ${salary}]`;
}

// ── Platform readers ──────────────────────────────────────────────────────
// Each reader returns a raw shape string plus any extra evidence. A reader that
// cannot reach its endpoint returns null, which classifies as 'unknown' rather
// than guessing — 'unknown' is a reportable answer, a guess is not.

const workdayCache = new Map();

/**
 * Split a portal's Workday `api` endpoint into the parts a per-posting detail
 * read needs.
 *
 * The tenant and site are NOT derivable from a posting URL. A posting lives at
 * `https://<host>/job/<City>/<Slug>_JR1234`, while its detail lives at
 * `https://<host>/wday/cxs/<tenant>/<site>/job/<City>/<Slug>_JR1234` -- and
 * `<tenant>`/`<site>` appear only in the portal's configured `api` value. Taking
 * them from the posting URL is a category error: the first attempt did exactly
 * that and silently classified every role as 'unknown'.
 *
 * @param {string} apiUrl e.g. https://rfcuny.wd108.myworkdayjobs.com/wday/cxs/rfcuny/RFCUNY/jobs
 * @returns {{origin:string, host:string, tenant:string, site:string}|null}
 */
export function parseWorkdayApi(apiUrl) {
  const m = String(apiUrl ?? '').match(/^(https?:\/\/([^/?#]+))\/wday\/cxs\/([^/?#]+)\/([^/?#]+)/);
  if (!m) return null;
  return { origin: m[1], host: m[2], tenant: m[3], site: m[4] };
}

/**
 * Is this posting URL served by a Workday board at all? Matches the `/job/`
 * and `/wday/cxs/.../job/` forms, and deliberately nothing else.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isWorkdayUrl(url) {
  const u = String(url ?? '');
  return /^https?:\/\/[^/?#]*myworkdayjobs\.com\//i.test(u) && /\/job\//.test(u);
}

/**
 * Read `timeType` and the posting body from a Workday posting.
 *
 * The wday/cxs DETAIL payload exposes `jobPostingInfo.timeType` and
 * `jobPostingInfo.jobDescription`. The LIST summary exposes neither — it carries
 * only title/externalPath/locationsText/postedOn/bulletFields — so a list-only
 * scan structurally CANNOT see employment type. That asymmetry is why this
 * exists, and why it is opt-in per platform rather than unconditional.
 *
 * @param {string} url the posting URL
 * @param {{api?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [opts]
 *   `api` is the portal's configured Workday endpoint, which carries tenant+site.
 * @returns {Promise<{timeType:string, description:string, reqId:string}|null>}
 */
export async function readWorkdayDetail(url, opts = {}) {
  const parts = parseWorkdayApi(opts.api);
  if (!parts || !isWorkdayUrl(url)) return null;
  // Recover externalPath from the PUBLIC posting URL rather than rebuilding it.
  //
  // The provider composes `jobBase + externalPath`, and jobBase is host+site
  // ("https://rfcuny.wd108.myworkdayjobs.com/RFCUNY"), so the public URL already
  // contains the site segment. Re-applying the cxs prefix to that whole URL
  // produced ".../wday/cxs/rfcuny/RFCUNY/RFCUNY/job/..." and a silent 404 --
  // which surfaced as every role classifying as 'unknown'. The externalPath is
  // always the tail from the LAST "/job/", on both myworkdayjobs and
  // myworkdaysite, so slice from there instead of composing.
  const clean = String(url).replace(/[?#].*$/, '');
  const idx = clean.lastIndexOf('/job/');
  if (idx < 0) return null;
  const path = clean.slice(idx);
  const cacheKey = parts.origin + path;
  if (workdayCache.has(cacheKey)) return workdayCache.get(cacheKey);

  const doFetch = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  try {
    const r = await doFetch(`${parts.origin}/wday/cxs/${parts.tenant}/${parts.site}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'career-ops/1.34' },
      signal: ctrl.signal,
    });
    if (!r.ok) { workdayCache.set(cacheKey, null); return null; }
    const j = await r.json();
    const info = j?.jobPostingInfo || {};
    const out = {
      timeType: String(info.timeType || ''),
      description: String(info.jobDescription || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' '),
      reqId: String(info.jobReqId || ''),
    };
    workdayCache.set(cacheKey, out);
    return out;
  } catch {
    workdayCache.set(cacheKey, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: drop the memoised Workday detail between cases. */
export function __clearWorkdayCache() { workdayCache.clear(); }

/**
 * Resolve a posting's employment shape and its defensible salary figure.
 *
 * Resolution order, cheapest and most authoritative first:
 *   1. a platform-reported type (Workday detail, Greenhouse metadata, Lever
 *      categories, SmartRecruiters typeOfEmployment) — authoritative
 *   2. the title or body, as corroboration only
 *
 * A full-time role with an hourly rate is annualised at the configured
 * full-time week. A NON-full-time role is annualised ONLY at a schedule the
 * posting actually states — otherwise the salary is reported as null and the
 * caller sees "not annualised" rather than a number nobody earned.
 *
 * @param {object} job normalized posting
 * @param {{surfaceMin:number, assumeFullTimeHours:number}} policy
 * @param {{api?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<{shape:string, source:string, rateLo:number|null, rateHi:number|null,
 *   hoursPerWeek:number|null, annualLo:number|null, annualHi:number|null, reqId:string}>}
 */
export async function detectEmploymentShape(job, policy, opts = {}) {
  const title = String(job?.title || '');
  const url = String(job?.url || '');
  let body = String(job?.description || '');

  // 1. Platform-reported type.
  let shape = 'unknown';
  let source = 'title';
  let reqId = '';
  let detail = null;
  if (policy.detailPlatforms?.has('workday') && isWorkdayUrl(url)) {
    detail = await readWorkdayDetail(url, opts);
    if (detail?.timeType) {
      shape = classifyEmploymentType(detail.timeType);
      source = 'workday timeType';
      reqId = detail.reqId || '';
      if (detail.description && !body) body = detail.description;
    }
  }
  if (shape === 'unknown') {
    const declared = job.metadata?.employmentType || job.categories?.commitment
      || job.typeOfEmployment || job.employmentType || job.type;
    if (declared) { shape = classifyEmploymentType(declared); source = 'platform field'; }
  }
  if (shape === 'unknown') {
    const fromTitle = classifyEmploymentType(title);
    if (fromTitle !== 'unknown') { shape = fromTitle; source = 'title'; }
  }
  if (shape === 'unknown') {
    const fromBody = classifyEmploymentType(body);
    if (fromBody !== 'unknown') { shape = fromBody; source = 'body'; }
  }

  const out = finish(job, body, shape, source, policy);
  out.reqId = reqId;
  return out;
}


function finish(job, description, shape, source, policy) {
  const rate = parseHourlyRate(description);
  const declaredHours = parseDeclaredHours(description);
  const isFullTime = shape === 'full-time';
  // The 2080 multiplication happens ONLY for a confirmed full-time role, or for
  // a non-full-time role that states its own schedule. Never as a default.
  const hoursPerWeek = isFullTime ? policy.assumeFullTimeHours : declaredHours;
  const annual = rate ? annualize(rate, hoursPerWeek) : null;
  return {
    shape,
    source,
    rateLo: rate?.lo ?? null,
    rateHi: rate?.hi ?? null,
    hoursPerWeek: hoursPerWeek ?? null,
    annualLo: annual?.lo ?? null,
    annualHi: annual?.hi ?? null,
  };
}

