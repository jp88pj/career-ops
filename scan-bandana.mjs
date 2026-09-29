#!/usr/bin/env node

/**
 * scan-bandana.mjs — Bandana.com scanner via Playwright
 *
 * Bandana (workwise-solutions.com) is a Next.js SPA with no public REST API:
 * /search returns an SSR shell and job cards load client-side. Playwright
 * keeps a real browser session, so the default NYC metro geo-cluster and the
 * remote filter (both exposed as stable client state / query params) render
 * job cards we can extract.
 *
 * Card DOM is stable and testid-anchored:
 *   [data-testid="job-card"]   the card
 *   [data-job-uuid]            wrapper carrying the job UUID (canonical id)
 *   URL: https://bandana.com/jobs/{uuid}  (renders standalone, BSSR)
 *
 * The logged-in "For You" personalized feed (bandana.com/for-you) is gated
 * behind the account session: anonymous sessions only receive a login shell.
 * Add an authenticated pass that reuses a locally-saved session:
 *   - node scan-bandana.mjs --login       one-time visible-browser sign-in,
 *                                         saves session to
 *                                         output/bandana-storage-state.json
 *   - node scan-bandana.mjs --personal    adds the "For You" feed to the run
 *                                         (session file is local-only, deletable)
 *
 * Reads `bandana_searches` from portals.yml. Each entry:
 *   - name:      label used in output (optional)
 *   - location:  metro to type into the location box; omitted/empty = site
 *                default (geo-centers on NYC, JC — "New York, NY" pins it)
 *   - remote:    true adds ?wt=Remote (remote-first query)
 *
 * Fallback without config: one NYC-metro pass + one remote pass.
 *
 * Usage:
 *   node scan-bandana.mjs
 *   node scan-bandana.mjs --dry-run
 *   node scan-bandana.mjs --debug          # dump screenshot + html to output/
 *   node scan-bandana.mjs --all            # skip date filter (use for first scan)
 *   node scan-bandana.mjs --login          # sign in once (visible browser)
 *   node scan-bandana.mjs --personal       # scan the logged-in For You feed
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, PORTALS_PATH, SCAN_HISTORY_PATH } from './scan.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

// ── Config ───────────────────────────────────────────────────────────

const SCAN_HISTORY = SCAN_HISTORY_PATH;
const DATA_ROOT    = getCareerOpsRoot();

const SEARCH_BASE  = 'https://bandana.com/search';
const JOBS_BASE    = 'https://bandana.com/jobs/';
// Remote-first query — the URL Bandana itself produces after toggling the
// Remote/Onsite filter, so it is stable without driving the dropdown.
const REMOTE_QUERY = `${SEARCH_BASE}?r=Anytime&s=relevance&wt=Remote`;
// The personalized "For You" feed and the local session file that --login
// writes and --personal reuses. The nav's "JOBS FOR YOU" resolves to the
// /profile/tracker/lineup page, which client-side redirects to /search?fy=1 —
// that final URL renders the feed with the same job-card markup as /search.
const FOR_YOU_URL = 'https://bandana.com/search?fy=1';
const PERSONAL_STATE = join(DATA_ROOT, 'output', 'bandana-storage-state.json');

const DEFAULT_SEARCHES = [
  { name: 'NYC metro', location: 'New York, NY', remote: false },
  { name: 'Remote (US)', remote: true },
];

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const DEBUG      = args.includes('--debug');
const NO_DATE_FILTER = args.includes('--all');
const LOGIN      = args.includes('--login');
const PERSONAL   = args.includes('--personal');

// ── Load portals.yml ─────────────────────────────────────────────────

let config = {};
if (existsSync(PORTALS_PATH)) {
  config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
}

// `enabled: false` switches a single pass off without deleting it, matching how
// tracked_companies entries are skipped elsewhere (scan.mjs resolveEntries).
// Entries without the key stay enabled, so existing configs are unaffected.
const bandanaSearches = Array.isArray(config.bandana_searches)
  ? config.bandana_searches.filter(s => s && typeof s === 'object' && s.enabled !== false)
  : DEFAULT_SEARCHES;

// ── Filters (same contract as scan-interamt.mjs) ─────────────────────

const titleFilter = config.title_filter || {};
const positiveKw = (titleFilter.positive || []).map(k => k.toLowerCase());
const negativeKw = (titleFilter.negative || []).map(k => k.toLowerCase());

function matchesTitle(title) {
  const lower = title.toLowerCase();
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

// ── Date helpers ─────────────────────────────────────────────────────

// Relative Bandana labels: "16h", "2d", "26d". Approximate to an epoch the
// same way any continuous posting fed to a pipeline should be: a card posted
// today (~ "Xh"/"Xd") should survive a same-day re-scan.
function parseRelative(str) {
  if (!str) return undefined;
  const m = String(str).trim().match(/^(\d+)\s*(h|d|w|mo)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const hours = unit === 'h' ? n : unit === 'd' ? n * 24 : unit === 'w' ? n * 24 * 7 : n * 24 * 30;
  return Date.now() - hours * 3600 * 1000;
}

function loadLastScanDate() {
  if (!existsSync(SCAN_HISTORY)) return null;
  let latest = null;
  readFileSync(SCAN_HISTORY, 'utf-8').split('\n').slice(1).forEach(line => {
    const parts = line.split('\t');
    if (parts[2] !== 'bandana') return;
    const d = new Date((parts[1] || '') + 'T00:00:00Z');
    if (!isNaN(d) && (!latest || d > latest)) latest = d;
  });
  return latest;
}

// ── Card extraction ──────────────────────────────────────────────────

// Card innerText layout (verified on prod 2026-09-18):
//   <title>
//   <Company>
//    · <Neighborhood>
//    · <16h | 2d | 26d>
//   <$ pay | Pay not disclosed>
//   [Promoted]
//   <Full-time | Part-time | Internship>
//   <Entry-Level | Mid-Level | Senior-Level>
//   <Industry>
function parseCardText(text) {
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  let idx = 0;
  let title = lines[0] || '';
  const expired = /^Expired\b/i.test(title);
  if (expired) {
    // Two layouts: "Expired | <title>" or "Expired\n<title>\n<Company>".
    title = title.replace(/^Expired\s*\|?\s*/i, '').trim();
    if (!title) { idx = 1; title = lines[1] || ''; }
  }

  const company = lines[idx + 1] || '';
  const neighborhood = (lines.find(l => l.startsWith('·')) || '').replace(/^·\s*/, '').trim();
  const postedRel = (lines.filter(l => l.startsWith('·'))[1] || '').replace(/^·\s*/, '').trim();
  const pay = lines.find(l => /^(\$\d|Pay not disclosed)/i.test(l)) || '';

  return { title, company, neighborhood, postedRel, pay, expired };
}

async function extractCards(page) {
  return page.$$eval('[data-testid="job-card"]', cards =>
    cards.map(card => {
      const wrapper = card.closest('[data-job-uuid]');
      return {
        uuid: wrapper ? wrapper.getAttribute('data-job-uuid') : null,
        text: card.innerText || '',
      };
    }).filter(c => c.uuid && c.text)
  );
}

// ── Search driver ────────────────────────────────────────────────────

async function searchInput(page) {
  return page.locator(
    'input[aria-label*="location" i], input[placeholder*="city" i], input[placeholder*="ZIP" i], input[placeholder*="Search by" i]'
  ).first();
}

async function runSearch(page, search, isFirst) {
  const url = search.remote ? REMOTE_QUERY : SEARCH_BASE;
  const found = [];

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // The openbox SPA hydrates client-side after SSR — give it a moment before
  // interacting, or input events are swallowed and no cards ever render.
  await page.waitForTimeout(4000);

  // Dismiss the onboarding tooltip — it has a backdrop that blocks clicks.
  const gotIt = page.locator('button:has-text("Got it")').first();
  const gotItShown = await gotIt.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (gotItShown) {
    await gotIt.click().catch(() => null);
    await page.waitForTimeout(1000);
  }

  // For the on-site pass, pin the metro by typing the location. The remote
  // query already scopes to Remote so no location typing is needed.
  if (!search.remote && search.location) {
    const input = await searchInput(page);
    const inputReady = await page.waitForSelector(
      'input[aria-label*="location" i], input[placeholder*="city" i], input[placeholder*="ZIP" i], input[placeholder*="Search by" i]',
      { state: 'visible', timeout: 15000 }
    ).then(() => true).catch(() => false);
    if (inputReady) {
      await input.fill(search.location);
      await input.press('Enter');
    } else if (DEBUG) {
      console.log('  [debug] location input not found');
    }
  }

  // Cards render after the initial client fetch; wait for them.
  await page.waitForSelector('[data-testid="job-card"]', { timeout: 30000 }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(3000);

  if (DEBUG) {
    const debugDir = join(DATA_ROOT, 'output');
    mkdirSync(debugDir, { recursive: true });
    const slug = (search.name || 'bandana').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bandana';
    await page.screenshot({ path: join(debugDir, `debug-bandana-${slug}.png`), fullPage: true });
    const { writeFileSync: wf } = await import('fs');
    wf(join(debugDir, `debug-bandana-${slug}.html`), await page.content());
    console.log(`  [debug] url: ${page.url()}`);
  }

  const rows = await extractCards(page);
  if (DEBUG) {
    const withExpired = rows.filter(r => /^Expired\b/i.test(r.text.trim())).length;
    console.log('  [debug] rows extracted:', rows.length, 'expired-flagged:', withExpired);
  }
  for (const row of rows) {
    const card = parseCardText(row.text);
    if (!card.title || !row.uuid) continue;
    found.push({
      title:         card.title,
      url:           `${JOBS_BASE}${row.uuid}`,
      company:       card.company || 'Bandana',
      neighborhood:  card.neighborhood,
      postedRel:     card.postedRel,
      pay:           card.pay,
      expired:       card.expired,
      remote:        !!search.remote,
    });
  }

  return found;
}

// ── Authenticated "For You" pass ──────────────────────────────────────

// Saves a real login session to output/bandana-storage-state.json so the
// personal pass can run headless afterwards. Runs in a visible browser: the
// candidate types their own credentials — nothing here holds or stores them.
async function loginPersonal() {
  mkdirSync(join(DATA_ROOT, 'output'), { recursive: true });

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geoLocation: { latitude: 40.73061, longitude: -73.93524 },
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  console.log('\n------------------------------------------------------------');
  console.log('Sign in to Bandana.com in the window that just opened.');
  console.log('Navigate to the "For You" section if you are not auto-redirected.');
  console.log('Once the feed loads (job cards visible), I will save the session.');
  console.log('Close the window anytime to abort without saving.');
  console.log('------------------------------------------------------------\n');

  await page.goto(FOR_YOU_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);

  // Wait for the REAL authenticated signal: a NextAuth session token cookie.
  // (CSRF + callback tokens exist before login — detecting those, or just seeing
  // cards on the anonymous shell, saves a logged-out session. The session token
  // only appears once the account is actually signed in.)
  const hasSessionCookie = async () => {
    const cookies = await context.cookies('https://bandana.com');
    // NextAuth v4 names its signed-in cookie __Secure-next-auth.session-token.
    // The __Host-next-auth.csrf-token and __Secure-next-auth.callback-url
    // cookies are present BEFORE login and must not count.
    return cookies.some(c => /session[-_.]token/i.test(c.name));
  };

  let saved = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline && !saved) {
    const loggedIn = await hasSessionCookie();
    if (loggedIn) {
      // Give the personalized feed a beat to render before snapshotting.
      await page.waitForTimeout(3000);
      await context.storageState({ path: PERSONAL_STATE });
      saved = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (saved) {
    console.log(`\n✅ Session saved to ${PERSONAL_STATE}`);
    console.log('Now run: node scan-bandana.mjs --personal');
  } else {
    console.log('\nSession was not saved (no For You cards detected before timeout).');
    console.log('The window is still open — if you see the feed, tell me and I can retry,');
    console.log('or you can close the window now.');
  }

  await browser.close();
  return saved;
}

// Pulls the personalized feed using the saved session. Card DOM is expected to
// reuse the same testids as search (job-card + data-job-uuid); the For You
// feed swaps which jobs are shown, not how a card is rendered.
async function runForYou(page) {
  const found = [];
  await page.goto(FOR_YOU_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);

  // For You is a swipe feed; cards may not carry the search-page testid. Fall
  // back to data-job-uuid wrappers directly when the job-card testid is absent.
  const rows = await page.evaluate(() => {
    const out = [];
    const cards = document.querySelectorAll('[data-testid="job-card"]');
    if (cards.length > 0) {
      cards.forEach(card => {
        const wrapper = card.closest('[data-job-uuid]');
        if (wrapper) out.push({ uuid: wrapper.getAttribute('data-job-uuid'), text: card.innerText || '' });
      });
    } else {
      document.querySelectorAll('[data-job-uuid]').forEach(w => {
        out.push({ uuid: w.getAttribute('data-job-uuid'), text: w.innerText || '' });
      });
    }
    return out.filter(c => c.uuid && c.text);
  });

  if (DEBUG) {
    const withExpired = rows.filter(r => /^Expired\b/i.test(r.text.trim())).length;
    console.log('  [debug] for-you rows extracted:', rows.length, 'expired-flagged:', withExpired);
  }

  for (const row of rows) {
    const card = parseCardText(row.text);
    if (!card.title || !row.uuid) continue;
    found.push({
      title:         card.title,
      url:           `${JOBS_BASE}${row.uuid}`,
      company:       card.company || 'Bandana',
      neighborhood:  card.neighborhood,
      postedRel:     card.postedRel,
      pay:           card.pay,
      expired:       card.expired,
      remote:        false,
    });
  }
  return found;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });

  // One-time login flow: saves the session, then exits. No scan happens here.
  if (LOGIN) {
    const ok = await loginPersonal();
    process.exit(ok ? 0 : 1);
  }

  const { seen } = loadSeenUrls();
  const date = localToday();

  const lastScanDate = NO_DATE_FILTER ? null : loadLastScanDate();
  if (NO_DATE_FILTER) {
    console.log(`  --all: date filter disabled — accepting every rendered card`);
  } else if (lastScanDate) {
    console.log(`  Last Bandana scan: ${lastScanDate.toISOString().slice(0, 10)} — skipping older postings`);
  }

  let totalFound = 0;
  const newOffers = [];
  const titleSkipped = [];
  const locationSkipped = [];
  const dateSkipped = [];
  const dupeSkipped = [];
  const expiredSkipped = [];
  const errors = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geoLocation: { latitude: 40.73061, longitude: -73.93524 },
  });
  const page = await context.newPage();

  const acceptHit = async (hit, opts = {}) => {
    const bypassTitle = !!opts.bypassTitle;
    const bypassEngagement = !!opts.bypassEngagement; // skip location + date, used by For You
    const locParts = [hit.neighborhood, hit.remote ? 'Remote' : ''].filter(Boolean);
    const loc = [...new Set(locParts)].join(' ');
    const location = [loc, hit.pay, hit.postedRel ? `(${hit.postedRel})` : ''].filter(Boolean).join(' ');
    const postedAt = parseRelative(hit.postedRel);
    const canonical = {
      url: hit.url,
      company: hit.company,
      title: hit.title,
      location,
      source: 'bandana',
    };
    if (postedAt !== undefined) canonical.postedAt = postedAt;

    if (hit.expired) { seen.add(canonical.url); expiredSkipped.push(canonical); return; }
    if (!bypassTitle && !matchesTitle(hit.title)) { seen.add(canonical.url); titleSkipped.push(canonical); return; }
    if (!bypassEngagement && !matchesLocation(location)) { seen.add(canonical.url); locationSkipped.push(canonical); return; }
    // Same-day cards pass: lastScanDate is the day of the last run, and a
    // card posted later that same day should not be treated as stale.
    if (!bypassEngagement && lastScanDate && postedAt !== undefined && postedAt < lastScanDate) { seen.add(canonical.url); dateSkipped.push(canonical); return; }
    if (seen.has(canonical.url)) { dupeSkipped.push(canonical); return; }
    seen.add(canonical.url);
    newOffers.push(canonical);
  };

  try {
    for (let i = 0; i < bandanaSearches.length; i++) {
      const search = bandanaSearches[i];
      const label = search.name || (search.remote ? 'Remote' : search.location || SEARCH_BASE);
      process.stdout.write(`  Searching "${label}"... `);
      try {
        const hits = await runSearch(page, search, i === 0);
        totalFound += hits.length;
        process.stdout.write(`${hits.length} found\n`);
        for (const hit of hits) await acceptHit(hit);
      } catch (err) {
        process.stdout.write(`ERROR\n`);
        errors.push({ search: label, error: err.message });
      }
    }

    if (PERSONAL) {
      let personalTitle = '  Searching "For You" (personal)... ';
      process.stdout.write(personalTitle);
      try {
        if (!existsSync(PERSONAL_STATE)) {
          throw new Error(`no saved session at ${PERSONAL_STATE} — run \`node scan-bandana.mjs --login\` first`);
        }
        const pContext = await browser.newContext({
          locale: 'en-US',
          timezoneId: 'America/New_York',
          geoLocation: { latitude: 40.73061, longitude: -73.93524 },
          storageState: PERSONAL_STATE,
        });
        const pPage = await pContext.newPage();
        const hits = await runForYou(pPage);
        await pContext.close();
        totalFound += hits.length;
        process.stdout.write(`${hits.length} found\n`);
        // For You is curated by the candidate's own swipes/saves, and Bandana
        // geo-centers the whole feed on the saved location — so its titles,
        // bare-neighborhood labels, and posting dates all legitimately diverge
        // from the configured filters. Bypass title, location, and date for
        // this pass; keep expired + dedup.
        for (const hit of hits) await acceptHit(hit, { bypassTitle: true, bypassEngagement: true });
      } catch (err) {
        process.stdout.write(`ERROR\n`);
        errors.push({ search: 'For You (personal)', error: err.message });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (!DRY_RUN) {
    if (newOffers.length > 0) await appendToPipeline(newOffers);
    if (newOffers.length > 0) await appendToScanHistory(newOffers, date, 'added');
    if (titleSkipped.length > 0) await appendToScanHistory(titleSkipped, date, 'skipped_title');
    if (locationSkipped.length > 0) await appendToScanHistory(locationSkipped, date, 'skipped_location');
    if (dateSkipped.length > 0) await appendToScanHistory(dateSkipped, date, 'skipped_date');
    if (dupeSkipped.length > 0) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
    if (expiredSkipped.length > 0) await appendToScanHistory(expiredSkipped, date, 'skipped_expired');
  }

  // Summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Bandana Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Searches run:       ${bandanaSearches.length}`);
  console.log(`Total found:        ${totalFound}`);
  console.log(`Skipped expired:    ${expiredSkipped.length}`);
  console.log(`Filtered by title:  ${titleSkipped.length}`);
  console.log(`Filtered location:  ${locationSkipped.length}`);
  console.log(`Filtered by date:   ${dateSkipped.length}`);
  console.log(`Duplicates:         ${dupeSkipped.length}`);
  console.log(`New offers:         ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ "${e.search}": ${e.error}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (DRY_RUN) {
      console.log('\n(dry run — not saved)');
    } else {
      console.log(`\nSaved to data/pipeline.md`);
    }
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

// Guarded like every sibling scanner (scan-interamt.mjs:378): importing this
// module must never drive a live browser scan or touch pipeline/history as a
// side effect of being loaded (#3510).
if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}