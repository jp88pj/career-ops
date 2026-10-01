// verify-bullet-sources.mjs - check that every generated bullet traces to a
// specific line in cv.md.
//
// WHY THIS EXISTS
// ---------------
// Three bullets were shipped in applications that appear nowhere in cv.md:
//
//   "holding a large group to plan and scheduling staff"                        (Camp Hillard)
//   "accurately across administrations, reconciling results against procedure"  (DCAS)
//   "explaining requirements clearly and professionally to people who did not
//    ask for them"                                                              (Parks)
//
// All three read well, all three were mine, and the existing fact check caught
// none of them: no invented metric, no named tool, no entity. It is built to
// catch claims that are checkable in isolation, and a whole invented duty
// sentence is not one.
//
// WHY A POINTER AND NOT A SIMILARITY SCORE
// ----------------------------------------
// The first attempt scored a bullet against the WHOLE of cv.md and flagged
// 88 of 88 existing CVs - including "Uphold order and protect people, parks,
// and property with respect and integrity", which is a verbatim source line.
// Reformatting a duty and inventing one are the same operation at different
// intensities, so no threshold separates them.
//
// This compares each bullet against THE ONE LINE IT CITES. That is a pointer
// comparison, not a fuzzy one: a bullet either substantially restates the line
// it points at or it does not, and where the line is short the comparison is
// correspondingly strict. The author does the judging by choosing the citation;
// the tool only verifies the citation is honest. That is a check a human can
// pass, which is the only kind worth having.
//
// A missing or unresolvable citation is a FAILURE, not a skip. Silence is the
// failure mode that let the original three through.
//
// Usage:
//   node verify-bullet-sources.mjs <payload.json> [--source cv.md] [--json]
//
// Payload shape: bullets are either plain strings, or objects carrying a
// `source_line` (1-indexed into cv.md) and/or `source_text` (a phrase to locate
// in cv.md when line numbers are fragile).

import { readFileSync, existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_SOURCE = 'cv.md';
const SUPPORT_RATIO = 0.6;

const stem = (w) => w.replace(/(?:ing|ed|es|s|ion|ions)$/, '');
const words = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .map(stem)
  .filter((w) => w.length > 2);

/** Parse `--flag value` pairs out of argv. */
function parseArgs(argv) {
  const out = { positional: [], source: DEFAULT_SOURCE, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.positional.push(a);
  }
  return out;
}

function resolvePath(p, cwd) {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Locate the source line for a citation.
 * `source_line` wins; `source_text` finds the first line containing the phrase.
 * Returns null when neither resolves, which the caller treats as a failure.
 */
function resolveCitation(sourceLines, cite) {
  if (cite.source_line != null) {
    const n = Number(cite.source_line);
    if (!Number.isInteger(n) || n < 1 || n > sourceLines.length) return null;
    return sourceLines[n - 1];
  }
  if (cite.source_text) {
    const needle = String(cite.source_text).toLowerCase();
    const hit = sourceLines.find((l) => l.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return null;
}

/** Fraction of a bullet's content words that appear in its cited line. */
function support(bullet, sourceLine) {
  const b = words(bullet);
  if (!b.length) return 1;
  const src = new Set(words(sourceLine));
  if (!src.size) return 0;
  return b.filter((w) => src.has(w)).length / b.length;
}

/**
 * @param {object} payload parsed CV payload
 * @param {string} sourceText contents of cv.md
 * @returns {{verdict:'pass'|'block', checked:number, unsourced:object[]}}
 */
export function verifyBulletSources(payload, sourceText) {
  const sourceLines = String(sourceText).split(/\r?\n/);
  const unsourced = [];
  let checked = 0;

  for (const entry of payload.experience || []) {
    const where = `${entry.company || '?'} — ${entry.role || '?'}`;
    (entry.bullets || []).forEach((raw, i) => {
      // A bullet is either a bare string (no citation - always a failure) or an
      // object with text plus a citation.
      const text = typeof raw === 'string' ? raw : raw?.text;
      if (!text) return;
      checked++;

      if (typeof raw === 'string' || raw.source_line == null && raw.source_text == null) {
        // Reported here rather than left to fall through to resolveCitation(),
        // which rejects it too but as "source_text not found in cv.md" - true,
        // yet it describes a missing citation as a failed search, which is the
        // wrong diagnosis to hand someone fixing a payload.
        unsourced.push({
          where,
          index: i,
          text,
          reason: 'no source_line or source_text citation',
          support: null,
        });
        return;
      }

      const line = resolveCitation(sourceLines, raw);
      // `line === null` is the failure signal, not `!line`. A citation can
      // legitimately resolve to an empty line - an empty or minimal cv.md, or a
      // blank line the author cited - and testing truthiness there reported a
      // successful resolution as "does not exist", which is a different defect
      // with a different fix. Mutation-testing is what surfaced it: the range
      // check was reachable, but the empty-line path was not distinguishable.
      if (line === null) {
        unsourced.push({
          where,
          index: i,
          text,
          reason: raw.source_line != null
            ? `source_line ${raw.source_line} does not exist in cv.md`
            : 'source_text not found in cv.md',
          support: null,
        });
        return;
      }

      const ratio = support(text, line);
      if (ratio < SUPPORT_RATIO) {
        unsourced.push({ where, index: i, text, reason: 'not supported by the cited line', support: Number(ratio.toFixed(2)) });
      }
    });
  }

  return { verdict: unsourced.length ? 'block' : 'pass', checked, unsourced };
}

/** Collect experience bullets from every payload path given. */
function loadPayloads(paths, cwd) {
  const out = [];
  for (const p of paths) {
    const abs = resolvePath(p, cwd);
    if (!existsSync(abs)) { out.push({ path: p, error: 'file not found', payload: null }); continue; }
    try {
      out.push({ path: p, error: null, payload: JSON.parse(readFileSync(abs, 'utf8').replace(/^﻿/, '')) });
    } catch (e) {
      out.push({ path: p, error: `invalid JSON: ${e.message}`, payload: null });
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.positional.length) {
    console.log('Usage: node verify-bullet-sources.mjs <payload.json...> [--source cv.md] [--json]');
    console.log('');
    console.log('Each bullet must be an object: { "text": "...", "source_line": 28 }');
    console.log('A bare string bullet is reported as unsourced - citations are required.');
    return args.help ? 0 : 1;
  }

  const cwd = process.cwd();
  const sourcePath = resolvePath(args.source, cwd);
  if (!existsSync(sourcePath)) {
    console.error(`Source not found: ${sourcePath}`);
    return 2;
  }
  const sourceText = readFileSync(sourcePath, 'utf8');
  const results = loadPayloads(args.positional, cwd).map(({ path, error, payload }) => {
    if (error) return { path, error, verdict: 'error', checked: 0, unsourced: [] };
    const r = verifyBulletSources(payload, sourceText);
    return { path, error: null, ...r };
  });

  if (args.json) {
    console.log(JSON.stringify({ source: args.source, results }, null, 2));
  } else {
    let totalUnsourced = 0;
    for (const r of results) {
      if (r.error) { console.log(`  ERROR ${r.path}: ${r.error}`); continue; }
      totalUnsourced += r.unsourced.length;
      const mark = r.unsourced.length ? 'BLOCK' : 'pass ';
      console.log(`  [${mark}] ${r.path} — ${r.checked} bullet(s) checked, ${r.unsourced.length} unsourced`);
      for (const u of r.unsourced) {
        const sup = u.support == null ? '' : ` (support ${u.support})`;
        console.log(`      ${u.where} #${u.index}: ${u.reason}${sup}`);
        console.log(`        "${String(u.text).slice(0, 100)}"`);
      }
    }
    console.log(totalUnsourced
      ? `\n  ${totalUnsourced} bullet(s) not traceable to cv.md — fix the citation or the wording.`
      : '\n  All bullets trace to a cited cv.md line.');
  }
  return results.some((r) => r.error || r.verdict === 'block') ? 1 : 0;
}

// Run only when invoked as a script, never when imported. A `basename` match is
// not enough: an ad-hoc probe named verify-bullet-sources.mjs that imports this
// file would trip it, and the process would exit before the caller read
// anything. Compare resolved paths instead.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
