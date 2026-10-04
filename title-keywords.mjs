// title-keywords.mjs — one definition of how a `title_filter` keyword matches a
// job title, imported by every path that filters titles.
//
// It lives in its own module because there are two such paths and they must not
// drift: scan.mjs (the main pipeline) and openrouter-runner.mjs (the no-Claude
// path, which deliberately does not import scan.mjs because scan.mjs creates
// data/ at import time). Same reason user-agent.mjs and profile-language.mjs
// are separate modules rather than exports of a bigger one.
//
// The repo has already paid for a mirror once: tests/profile-keywords-parity
// exists because web/ carries a copy of the keyword logic and the copy was
// wrong. A second copy of THIS logic would repeat that, so there is one.

// Opt-in whole-word matching for a keyword too long to get it automatically.
// Chosen over widening the 2-3 char rule to every single-word keyword, because
// the right-hand boundary is exactly what a NEGATIVE usually wants to keep:
// "crypto" is meant to catch "Cryptocurrency" and "fellows" to catch
// "Fellowship", and anchoring the whole list would silently stop both. So the
// list says which entries want it, one entry at a time.
//
// The prefix cannot collide with a real keyword: a job title never contains a
// colon-suffixed "word", and an entry is one keyword, not a sentence.
export const WORD_PREFIX = 'word:';

// `stem:` is the other half of the same question, and it exists because the two
// halves are NOT the same setting seen from two sides.
//
// `word:agent` says "agent, and nothing longer" — it rejects Agentforce.
// `stem:agent` says "a word that STARTS with agent" — it keeps Agentforce and
// Agentic, and drops Reagents, where the keyword lands mid-word.
// A bare `agent`, today's default, keeps all three.
//
// So a plain substring is not "the loose option"; it is two loosenesses at once,
// and only one of them is usually wanted. `stem:` lets an entry ask for the one
// it means. Under today's substring default that is already a narrowing rather
// than a no-op: it is what separates Agentforce from Reagents (#3103).
export const STEM_PREFIX = 'stem:';

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One definition of "inside a word", used by BOTH branches below. Anything else
// reintroduces, inside this module, exactly the drift the module exists to
// prevent: the acronym branch used ASCII \b while the `word:` branch had been
// made Unicode-aware, so `vp` still matched inside an accented word.
//
// String.raw, not a plain template literal: `\p` is not a recognised string
// escape, so an ordinary template drops the backslash and the class degenerates
// to the literal characters p, {, L, } — no error, and the anchor is simply off.
const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
const anchoredPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'u');
// Same left boundary, no right one: the keyword must start a word, and the word
// may continue past it.
const stemPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}`, 'u');

// `word:` and `stem:` mean the same thing wherever a keyword list is matched
// against text, so their handling lives here once rather than being copied into
// each compiler — the drift this module exists to prevent. Returns a matcher
// when `kw` carries a recognised prefix, or null when it is an ordinary keyword
// the caller compiles its own way (the title filter auto-anchors short
// acronyms and falls back to substring; the content filter goes straight to
// substring — see #3103, #3274).
//
// Explicit alphanumeric lookarounds rather than \b, because \b's meaning
// depends on the characters at the keyword's own edges: for `word:c++` a
// trailing \b would sit after "+" and assert the opposite of the intent.
// WORD_CHAR rather than [a-z0-9_]: an ASCII-only lookaround treats every
// accented letter as a separator, so `word:intern` matched inside "preintern"
// spelled with an accent and vetoed exactly the international titles this
// prefix exists to protect. \p{M} covers combining marks, so a decomposed "é"
// does not split a word either.
function compilePrefixedKeyword(kw) {
  if (kw.startsWith(WORD_PREFIX)) {
    const bare = kw.slice(WORD_PREFIX.length).trim();
    // A bare `word:` is a config typo. Matching NOTHING is the safe reading: as
    // a positive it simply contributes no match, while the alternative — an
    // empty pattern matching everything — would veto an entire scan from one
    // stray colon. Same trade as the "C++" note on scan.mjs's AND_SEPARATOR:
    // prefer a silent drop of one entry over a silent flood.
    if (!bare) return () => false;
    const re = anchoredPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  if (kw.startsWith(STEM_PREFIX)) {
    const bare = kw.slice(STEM_PREFIX.length).trim();
    // Same reading as a bare `word:`: a stray prefix with nothing after it is a
    // typo, and matching nothing is the safe half of that trade.
    if (!bare) return () => false;
    const re = stemPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  return null;
}

/**
 * Compile a lowercased keyword into a matcher.
 *
 * Short all-letter acronyms (2-3 chars: cfo, coo, sdr, bdr, gsi…) match on WORD
 * BOUNDARIES so "COO" does not match "Coordinator". A `word:` prefix asks for
 * the same treatment explicitly, at any length: `word:intern` rejects
 * "Operations Intern" and leaves "Internal Tools" and "International
 * Partnerships Manager" alone. Multi-word phrases and keywords containing
 * non-letters (".NET", "SAP ", "L&D") keep fast, permissive substring matching.
 *
 * @param {string} kw - already trimmed and lowercased.
 * @returns {(lower: string) => boolean}
 */
// Fold diacritics so a keyword and a title compare equal regardless of accents.
// Spanish/Portuguese boards routinely publish titles in UPPERCASE WITHOUT
// accents ("TECNICO CONTROL DE PRODUCCION") while portals.yml is written with
// them ("Producción"); with toLowerCase() alone they never match, and every
// such posting is silently counted as filtered_title. BOTH sides are folded,
// so the comparison stays symmetric.
// Not lib/ascii-fold.mjs: that one deletes everything outside [a-z0-9]
// (spaces, ".NET", "L&D"), and here those characters are part of the keyword.
export function foldAccents(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function compileKeyword(kw) {
  const prefixed = compilePrefixedKeyword(kw);
  if (prefixed) return prefixed;
  if (/^[a-z]{2,3}$/.test(kw)) {
    // The same boundary as above, not \b: \b is ASCII-only, so "vp" matched
    // inside an accented word while `word:vp` did not. Two spellings of one
    // rule in one file is the drift this module was extracted to end.
    const re = anchoredPattern(kw);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

/**
 * Compile a lowercased `content_filter` keyword into a matcher.
 *
 * `content_filter` matches against the job DESCRIPTION, not the title, and its
 * default has always been a plain case-insensitive substring. That default is
 * why a bare negative `java` rejects every posting that merely mentions
 * "JavaScript", and `ios` rejects "curiosity" (#3274). Flipping the default is
 * a breaking change for every configured install — the same conclusion #3103
 * reached for `title_filter` — so the fix is opt-in: a `word:` or `stem:`
 * prefix asks for boundary-anchored matching on that one entry (identical
 * semantics to the title filter), and every other entry keeps the substring
 * behaviour byte-for-byte.
 *
 * Unlike compileKeyword(), there is no automatic anchoring of short keywords.
 * The title filter anchors 2-3 letter acronyms because "COO" inside
 * "Coordinator" is always wrong; a 2-3 letter run inside a paragraph of
 * description prose is routinely intended ("aws", "gcp", "sql", "go").
 *
 * @param {string} kw - already trimmed and lowercased.
 * @returns {(lower: string) => boolean}
 */
export function compileContentKeyword(kw) {
  return compilePrefixedKeyword(kw) ?? ((lower) => lower.includes(kw));
}

// An AND-group: " + " (whitespace-delimited) between terms means EVERY term
// must appear in the title, in any order. `title_filter.positive` is otherwise
// matched by compileKeyword — a plain substring, EXCEPT for a 2-3 letter
// keyword ("AI", "ML", "VP") or a `word:`-prefixed one, both of which are
// anchored so they cannot hit inside another word. Either way an entry
// expresses one exact spelling and nothing else, and real titles vary in
// separator and word order:
//
//   "Director of Engineering" misses  Director - Software Engineering
//                                     Director Engineering (Mobile Platform)
//                                     Senior Director, Platform Engineering
//
// The combinations are {level} x {, - of none} x {optional domain word}: no
// hand-maintained list of literal spellings converges, and every miss is
// silent — the summary reports one "filtered by title" count that cannot tell
// a well-tuned filter from a leaking one (#2544).
//
// The separator REQUIRES surrounding whitespace on purpose. A bare split('+')
// would turn the perfectly ordinary keyword "C++" into "c", which matches
// almost every title — trading a silent drop for a silent flood.
// Exported because a caller that must reason about the TERMS of a group — the
// dead-positive guard in tests/title-filter-word-prefix.test.mjs — has to split
// them exactly as this file does, and a second copy of the rule is the drift
// this module was extracted to end.
export const AND_SEPARATOR = /\s+\+\s+/;

/**
 * Compile one `positive` entry into a matcher.
 *
 * Entries without " + " keep their exact previous behaviour, so existing
 * configs are unaffected.
 *
 * @param {string} keyword - already trimmed and lowercased.
 * @returns {(lower: string) => boolean}
 */
export function compilePositiveKeyword(keyword) {
  if (!AND_SEPARATOR.test(keyword)) return compileKeyword(keyword);
  const terms = keyword.split(AND_SEPARATOR).map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return compileKeyword(keyword);
  // Each term keeps compileKeyword's own rule, so a short term like "vp" is
  // still matched on a word boundary and cannot hit "vp" inside another word.
  const matchers = terms.map(compileKeyword);
  return (lower) => matchers.every(m => m(lower));
}

/**
 * Compile a whole `title_filter` into one predicate.
 *
 * This lives here, rather than in scan.mjs beside its main caller, because
 * openrouter-runner.mjs filters titles too and cannot import scan.mjs. It used
 * to keep a second implementation, and the two had drifted in three separate
 * ways: an empty positive list meant "accept everything" here and "reject
 * everything" there, AND-groups worked only here, and a non-string YAML entry
 * was dropped here but coerced into a real keyword there. One shared predicate
 * removes the class rather than those three instances.
 *
 * @param {{positive?: unknown, negative?: unknown}} [titleFilter]
 * @returns {(title: string) => boolean}
 */
export function buildTitleFilter(titleFilter) {
  // Normalize defensively: a malformed title_filter (a null, numeric, or otherwise
  // non-string entry in the YAML) must not crash the scan via k.toLowerCase().
  const normalize = (arr, compile) => (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(k => foldAccents(k.trim().toLowerCase()))
    .filter(k => k.length > 0)
    .map(compile);
  // AND-groups are a POSITIVE-side feature only. On the negative side an entry
  // is a veto, and " + " there would read as "reject when both appear", which
  // is a different and much easier thing to write as two entries.
  const positive = normalize(titleFilter?.positive, compilePositiveKeyword);
  const negative = normalize(titleFilter?.negative, compileKeyword);

  return (title) => {
    // String(), not `title || ''`: openrouter-runner used String(title ?? '')
    // before both paths were merged here, and scan.mjs threw on a truthy
    // non-string. Consolidating on scan.mjs's version would have carried that
    // throw onto a path that never had it, where it aborts jobs.filter and
    // drops a whole company's results for one malformed title.
    const lower = foldAccents(String(title ?? '').toLowerCase());
    // An empty positive list is "no positive constraint", not "match nothing":
    // a negative-only title_filter is a legitimate config that rejects a few
    // roles and keeps the rest.
    const hasPositive = positive.length === 0 || positive.some(m => m(lower));
    const hasNegative = negative.some(m => m(lower));
    return hasPositive && !hasNegative;
  };
}

/**
 * Compile one host pattern from a `source_title_filters[].match_hosts` entry.
 * Accepts an exact host ("jobs.lever.co"), a leading-dot suffix (".lever.co"),
 * or a `*.` wildcard ("*.recruitee.com"). Anything else is matched literally.
 *
 * @param {string} pattern
 * @returns {(host: string) => boolean}
 */
function compileHostMatcher(pattern) {
  const p = String(pattern || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!p) return () => false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return (host) => host === base || host.endsWith('.' + base);
  }
  if (p.startsWith('.')) {
    const base = p.slice(1);
    return (host) => host === base || host.endsWith(p);
  }
  // Exact host, or any subdomain of it. "boards.greenhouse.io" therefore matches
  // "job-boards.greenhouse.io" too, which is what an ATS host rule intends.
  return (host) => host === p || host.endsWith('.' + p);
}

/**
 * Per-SOURCE title filter. One global `title_filter` cannot serve two populations.
 *
 * The problem this solves, measured 2026-10-03: the global positive list contains
 * bare function nouns (Manager, Specialist, Director, Officer, Representative) and
 * bare domain nouns (Product, Data, Services, Affairs, Design, Research) that were
 * each measured against cityjobs' own vacancy sitemap, where "Operations Manager"
 * and "Management Analyst" are real civil-service titles. The same nouns on a
 * private AI/tech board resolve overwhelmingly to commercial or engineering roles:
 * a single scan returned 38 postings from one board, every one of them sales,
 * marketing, engineering, data science, or product, for a candidate whose
 * archetypes are L&D, training, instructional design and program coordination.
 *
 * A rule can therefore REPLACE the positive list for the sources it matches. What
 * it cannot do is widen past the global negatives: `title_filter.negative` is
 * re-applied on every path, so a rule can only ever be stricter than the global
 * filter. That is the safety property that makes this safe to add to a config
 * someone else tuned -- the worst outcome is a role being hidden, never a globally
 * vetoed shape being admitted.
 *
 * Config shape (all keys optional except the matcher and one of positive/negative):
 *   source_title_filters:
 *     - name: Private-sector ATS boards
 *       match_hosts: ["jobs.ashbyhq.com", "boards.greenhouse.io", "*.recruitee.com"]
 *       match_companies: ["Elise AI"]
 *       positive: ["Instructional Designer"]   # replaces the global positive list
 *       negative: ["word:Engagement"]          # adds to the global negatives
 *
 * Backward compatible by construction: with no `source_title_filters` (or none that
 * compile) the returned predicate is the plain buildTitleFilter() result, so every
 * existing caller and test behaves exactly as before.
 *
 * @param {{positive?: unknown, negative?: unknown}} [titleFilter] global config
 * @param {unknown} sourceRules the `source_title_filters` array
 * @returns {(title: string, ctx?: {company?: unknown, hosts?: unknown}) => boolean}
 */
export function buildTitleFilterBySource(titleFilter, sourceRules) {
  const base = buildTitleFilter(titleFilter);
  if (!Array.isArray(sourceRules) || sourceRules.length === 0) return base;

  const normalize = (arr, compile) => (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(k => foldAccents(k.trim().toLowerCase()))
    .filter(k => k.length > 0)
    .map(compile);

  // Global negatives are re-applied on EVERY path, matched or not.
  const globalNegative = normalize(titleFilter?.negative, compileKeyword);

  const rules = [];
  for (const rule of sourceRules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
    const hostMatchers = (Array.isArray(rule.match_hosts) ? rule.match_hosts : [])
      .filter(h => typeof h === 'string' && h.trim())
      .map(compileHostMatcher);
    const companyMatchers = (Array.isArray(rule.match_companies) ? rule.match_companies : [])
      .filter(c => typeof c === 'string' && c.trim())
      .map(c => foldAccents(c.trim().toLowerCase()));
    const positive = normalize(rule.positive, compilePositiveKeyword);
    const negative = normalize(rule.negative, compileKeyword);
    // A rule with no matcher can never fire; one with neither list is a no-op.
    // Skip both rather than carrying a rule that cannot change an outcome.
    if (hostMatchers.length === 0 && companyMatchers.length === 0) continue;
    if (positive.length === 0 && negative.length === 0) continue;
    rules.push({ hostMatchers, companyMatchers, positive, negative });
  }
  if (rules.length === 0) return base;

  // Hosts the caller supplied, lowercased once per call site rather than per rule.
  const hostList = (hosts) => (Array.isArray(hosts) ? hosts : [])
    .filter(h => typeof h === 'string' && h.trim())
    .map(h => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));

  return (title, ctx) => {
    const lower = foldAccents(String(title ?? '').toLowerCase());
    const hosts = hostList(ctx?.hosts);
    const company = foldAccents(String(ctx?.company ?? '').trim().toLowerCase());

    for (const rule of rules) {
      const hostHit = hosts.length > 0 && rule.hostMatchers.some(m => hosts.some(h => m(h)));
      const companyHit = company.length > 0 && rule.companyMatchers.some(c => company === c);
      if (!hostHit && !companyHit) continue;

      const hasPositive = rule.positive.length === 0 || rule.positive.some(m => m(lower));
      const vetoed = globalNegative.some(m => m(lower)) || rule.negative.some(m => m(lower));
      return hasPositive && !vetoed;
    }
    return base(title);
  };
}
