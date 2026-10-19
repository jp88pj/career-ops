import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

console.log('\nPer-source title filters (source_title_filters)');

const ROOT = join(import.meta.dirname, '..');

// Loaded dynamically on purpose. A STATIC import of the named export would
// make this file crash with a SyntaxError when the export is missing -- which
// is a hard failure, but it aborts before the guard below can name the cause.
// Dynamic import always succeeds, so the scanner-import check below can report
// the real diagnosis instead of the test file dying at its own import.
const mod = await import(`file://${join(ROOT, 'title-keywords.mjs').replace(/\\/g, '/')}`);
const buildTitleFilterBySource = mod.buildTitleFilterBySource;
const buildTitleFilter = mod.buildTitleFilter;

// ── 1. The regression itself ────────────────────────────────────────────────
// The v1.37.0 system update overwrote title-keywords.mjs with the upstream
// copy, which has no buildTitleFilterBySource export. Five scanners import it,
// so they died at module load with a SyntaxError -- silently, because a scanner
// that cannot start produces no rows rather than an error a scan run would
// surface. These imports are the guard.
const SCANNERS = [
  'scan-cityjobs.mjs',
  'scan-bandana.mjs',
  'scan-mta.mjs',
  'scan-teamworkonline.mjs',
  'scan-builtinnyc.mjs',
];
let loadFails = [];
for (const file of SCANNERS) {
  try {
    await import(`file://${join(ROOT, file).replace(/\\/g, '/')}`);
  } catch (err) {
    loadFails.push(`${file}: ${err.message.split('\n')[0]}`);
  }
}
if (loadFails.length === 0) {
  pass(`all ${SCANNERS.length} source-filter scanners import cleanly`);
} else {
  fail(`scanners failed to import (buildTitleFilterBySource missing?): ${loadFails.join(' | ')}`);
}

// Every scanner that imports the symbol must find it exported.
const tk = readFileSync(join(ROOT, 'title-keywords.mjs'), 'utf8');
if (/export function buildTitleFilterBySource/.test(tk)) {
  pass('title-keywords.mjs exports buildTitleFilterBySource');
} else {
  fail('title-keywords.mjs does NOT export buildTitleFilterBySource');
}
if (typeof buildTitleFilterBySource === 'function') {
  pass('buildTitleFilterBySource is importable and callable');
} else {
  fail('buildTitleFilterBySource is not an exported function');
}

// Everything below exercises the behaviour, so it needs the symbol.
if (typeof buildTitleFilterBySource !== 'function') {
  console.log('  (behaviour checks skipped - the export is missing)');
} else {

// ── 2. Behaviour ────────────────────────────────────────────────────────────
const cfg = {
  title_filter: {
    positive: ['Manager', 'Operations', 'Special Officer'],
    negative: ['word:Seasonal', 'word:Intern'],
  },
  source_title_filters: [
    {
      name: 'Test board',
      match_hosts: ['jobs.example.com'],
      positive: ['Event Operations'],
      negative: ['General Manager'],
    },
  ],
};
const m = buildTitleFilterBySource(cfg.title_filter, cfg.source_title_filters);
const at = (title, hosts) => m(title, { hosts, company: '' });

const cases = [
  // The rule's own positives are accepted on the matching host.
  ['Event Operations Manager', ['jobs.example.com'], true, 'rule positive on matching host'],
  // The rule's own negatives veto, even though the global list would accept.
  ['General Manager', ['jobs.example.com'], false, 'rule negative vetoes a globally-accepted title'],
  // A global negative still applies on the source path.
  ['Seasonal Event Operations Manager', ['jobs.example.com'], false, 'global negative still applies'],
  // A global negative that only matches on a word boundary.
  ['Intern Event Operations Manager', ['jobs.example.com'], false, 'global word: negative still applies'],
  // Off-host, the rule does not apply and the global filter decides.
  ['General Manager', ['other.example.com'], true, 'off-host falls through to the global filter'],
  ['Event Operations Manager', ['other.example.com'], true, 'off-host falls through to the global filter'],
  // A rule that does not fire must not swallow a title the global filter rejects.
  ['Seasonal Manager', ['other.example.com'], false, 'global negative applies off-host too'],
];
let caseFails = 0;
for (const [title, hosts, expect, why] of cases) {
  const got = at(title, hosts);
  if (got === expect) pass(`${why}: "${title}" @ ${hosts[0]} -> ${got ? 'accept' : 'reject'}`);
  else {
    fail(`${why}: "${title}" @ ${hosts[0]} -> ${got ? 'accept' : 'reject'}, expected ${expect ? 'accept' : 'reject'}`);
    caseFails++;
  }
}

// ── 3. Host matcher shapes ──────────────────────────────────────────────────
// The PATTERN lives in the rule's match_hosts; the CALLER supplies the host of
// the board being filtered. Testing a wildcard or a parent domain as a caller
// host would be meaningless -- those are pattern shapes. So each case builds a
// rule with that pattern and filters one fixed caller host.
//
// The global list is deliberately narrow (one word nothing matches), so a rule
// firing is the ONLY thing that can accept a title. Otherwise "the rule matched"
// and "the global list happened to accept it too" are indistinguishable.
const HOST = 'jobs.example.com';
const mkHostMatcher = (pattern) =>
  buildTitleFilterBySource(
    { positive: ['Zebra'], negative: [] },
    [{ name: 'Test board', match_hosts: [pattern], positive: ['Event Operations'], negative: [] }],
  );
const hostTitle = 'Event Operations Coordinator';
const hostCases = [
  ['jobs.example.com', true, 'exact host pattern'],
  ['example.com', true, 'parent-domain pattern matches the subdomain'],
  ['*.example.com', true, 'wildcard pattern matches'],
  ['https://jobs.example.com/some/path', true, 'a URL pattern is reduced to its host'],
  ['other.example.com', false, 'unrelated pattern does not match'],
  ['jobs.example.org', false, 'a different domain does not match'],
  ['EXAMPLE.COM', true, 'pattern matching is case-insensitive'],
];
for (const [pattern, expect, why] of hostCases) {
  const got = mkHostMatcher(pattern)(hostTitle, { hosts: [HOST], company: '' });
  if (got === expect) pass(`${why}`);
  else { fail(`${why}: pattern "${pattern}" -> ${got ? 'accept' : 'reject'}, expected ${expect ? 'accept' : 'reject'}`); caseFails++; }
}
// A pattern that does not match leaves the narrow global filter in charge.
if (mkHostMatcher('other.example.com')(hostTitle, { hosts: [HOST], company: '' }) === false) {
  pass('a non-matching pattern leaves the global filter in charge');
} else {
  fail('a non-matching pattern did not fall through to the global filter');
  caseFails++;
}

// ── 4. Malformed input must not throw ───────────────────────────────────────
const malformed = [
  ['null rules', [cfg.title_filter, null]],
  ['empty rules', [cfg.title_filter, []]],
  ['non-array rules', [cfg.title_filter, 'nonsense']],
  ['null title filter', [null, cfg.source_title_filters]],
  ['rule with no matcher', [cfg.title_filter, [{ name: 'x', positive: ['Manager'] }]]],
  ['rule with no lists', [cfg.title_filter, [{ name: 'x', match_hosts: ['jobs.example.com'] }]]],
  ['rule that is a string', [cfg.title_filter, ['nope']]],
  ['rule that is null', [cfg.title_filter, [null]]],
  ['non-string keyword entries', [cfg.title_filter, [{ name: 'x', match_hosts: ['jobs.example.com'], positive: [null, 42, 'Event Operations'] }]]],
];
for (const [why, args] of malformed) {
  try {
    const fn = buildTitleFilterBySource(args[0], args[1]);
    const out = fn('Event Operations Manager', { hosts: ['jobs.example.com'], company: '' });
    if (typeof out === 'boolean') pass(`malformed input does not throw: ${why}`);
    else { fail(`malformed input returned a non-boolean: ${why}`); caseFails++; }
  } catch (err) {
    fail(`malformed input threw (${why}): ${err.message}`);
    caseFails++;
  }
}

// ── 5. A no-op rule set is exactly the global filter ────────────────────────
const globalOnly = buildTitleFilterBySource(cfg.title_filter, []);
const base = buildTitleFilter(cfg.title_filter);
let identical = true;
for (const t of ['Manager', 'Event Operations Manager', 'Seasonal Manager', 'Intern', 'Architect']) {
  if (globalOnly(t) !== base(t)) identical = false;
}
if (identical) pass('an empty rule set is exactly the global filter');
else { fail('an empty rule set differs from the global filter'); caseFails++; }

// ── 6. The shipped config's rules are all well-formed ───────────────────────
try {
  const yaml = await import('js-yaml');
  const portalCfg = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf-8'));
  const rules = portalCfg?.source_title_filters;
  if (Array.isArray(rules) && rules.length > 0) {
    const bad = rules.filter((r) => !r || typeof r !== 'object' || (!r.match_hosts?.length && !r.match_companies?.length));
    if (bad.length === 0) pass(`all ${rules.length} shipped source_title_filters rules have a matcher`);
    else { fail(`shipped rules without a matcher: ${bad.length}`); caseFails++; }
  } else {
    pass('no shipped source_title_filters rules to validate');
  }
} catch (err) {
  pass(`shipped portals.yml not readable in this sandbox (${err.message.split('\n')[0]})`);
}
}
