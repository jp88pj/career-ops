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
 *
 * Three forms, tried in this order:
 *   source_line  — 1-indexed into cv.md. Precise but BRITTLE: inserting or
 *                  deleting any line above it silently repoints every citation
 *                  below. Measured 2026-10-04, one source line drifted 71 → 106
 *                  → 107 across two ordinary edits to cv.md.
 *   source_anchor — a phrase that must match EXACTLY ONE line. Durable, because
 *                  it survives any amount of editing above the content. The
 *                  uniqueness requirement is the whole point: the loose form
 *                  below takes the first match, which is how "Taught between 75
 *                  and 90 students" silently resolved to Hudson's line when the
 *                  bullet belonged to Newark.
 *   source_text  — the loose legacy form, first match wins. Kept working, not
 *                  recommended.
 *
 * Returns { line, reason } so the caller can distinguish "not found" from
 * "ambiguous" — those are different defects with different fixes, and reporting
 * an ambiguous anchor as a missing one sends someone to re-typing a citation
 * that was never wrong.
 */
function resolveCitation(sourceLines, cite) {
  if (cite.source_line != null) {
    const n = Number(cite.source_line);
    if (!Number.isInteger(n) || n < 1 || n > sourceLines.length) {
      return { line: null, reason: `source_line ${cite.source_line} does not exist in cv.md` };
    }
    return { line: sourceLines[n - 1], reason: null };
  }
  for (const key of ['source_anchor', 'source_text']) {
    const raw = cite[key];
    if (!raw) continue;
    const needle = String(raw).toLowerCase();
    const hits = [];
    sourceLines.forEach((l, i) => { if (l.toLowerCase().includes(needle)) hits.push({ line: l, n: i + 1 }); });
    if (hits.length === 0) {
      return { line: null, reason: `${key} "${String(raw).slice(0, 60)}" not found in cv.md` };
    }
    if (hits.length > 1 && key === 'source_anchor') {
      // Loud, because the alternative is silently citing the wrong role.
      return {
        line: null,
        reason: `source_anchor "${String(raw).slice(0, 60)}" is AMBIGUOUS — matches ${hits.length} lines (${hits.map((h) => h.n).join(', ')}). Make the anchor unique.`,
      };
    }
    return { line: hits[0].line, reason: null };
  }
  return { line: null, reason: null };
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
  // Roles that would render as a job header with nothing under it.
  //
  // Measured 2026-10-04: build-cv-html.mjs only ever handled string bullets, so
  // every `{text, source_line}` bullet rendered as an EMPTY `<li></li>`. The CV
  // carried 21 blank bullets and still passed verify-cv-facts.mjs (no claims, so
  // nothing invented) and scored 100/100 on verify-ats.mjs (no text left to
  // score). A blank CV with a perfect score is the worst failure mode a gate
  // can have, and nothing caught it -- the bullets here were skipped by the
  // `if (!text) return` below before any count was taken.
  const emptyRoles = [];
  let checked = 0;

  for (const entry of payload.experience || []) {
    const where = `${entry.company || '?'} — ${entry.role || '?'}`;
    const bullets = Array.isArray(entry.bullets) ? entry.bullets : [];
    let usable = 0;
    bullets.forEach((raw, i) => {
      // A bullet is either a bare string (no citation - always a failure) or an
      // object with text plus a citation.
      const text = typeof raw === 'string' ? raw : raw?.text;
      // A present-but-textless bullet is a FINDING, not a skip. It renders as
      // nothing, so it is the same defect as an empty role one level down.
      if (!text) {
        if (raw != null && (bullets.length > usable)) {
          unsourced.push({
            where,
            index: i,
            text: '',
            reason: raw === '' || raw == null
              ? 'bullet has no text (renders as an empty list item)'
              : 'bullet object has no text field (renders as an empty list item)',
            support: null,
          });
        }
        return;
      }
      usable++;
      checked++;

      if (typeof raw === 'string'
        || (raw.source_line == null && raw.source_text == null && raw.source_anchor == null)) {
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

      const resolved = resolveCitation(sourceLines, raw);
      // `resolved.line === null` is the failure signal, not `!line`. A citation can
      // legitimately resolve to an empty line - an empty or minimal cv.md, or a
      // blank line the author cited - and testing truthiness there reported a
      // successful resolution as "does not exist", which is a different defect
      // with a different fix. Mutation-testing is what surfaced it: the range
      // check was reachable, but the empty-line path was not distinguishable.
      if (resolved.line === null) {
        unsourced.push({
          where,
          index: i,
          text,
          reason: resolved.reason
            || (raw.source_line != null
              ? `source_line ${raw.source_line} does not exist in cv.md`
              : 'source_text not found in cv.md'),
          support: null,
        });
        return;
      }

      const ratio = support(text, resolved.line);
      if (ratio < SUPPORT_RATIO) {
        unsourced.push({ where, index: i, text, reason: 'not supported by the cited line', support: Number(ratio.toFixed(2)) });
      }
    });
    // A role whose header would print with nothing beneath it. Reported apart
    // from `unsourced` because the fix is different: drop the role from the
    // selection, rather than cite a line for it.
    if (usable === 0) {
      emptyRoles.push({ where, bullets: bullets.length });
    }
  }

  return { verdict: (unsourced.length || emptyRoles.length) ? 'block' : 'pass', checked, unsourced, emptyRoles };
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
    let totalEmptyRoles = 0;
    for (const r of results) {
      if (r.error) { console.log(`  ERROR ${r.path}: ${r.error}`); continue; }
      totalUnsourced += r.unsourced.length;
      const empties = r.emptyRoles?.length || 0;
      totalEmptyRoles += empties;
      const mark = (r.unsourced.length || empties) ? 'BLOCK' : 'pass ';
      const emptyNote = empties ? `, ${empties} empty role(s)` : '';
      console.log(`  [${mark}] ${r.path} — ${r.checked} bullet(s) checked, ${r.unsourced.length} unsourced${emptyNote}`);
      for (const e of (r.emptyRoles || [])) {
        console.log(`      ${e.where}: renders as a job header with NO bullets (${e.bullets} present) — drop the role from the selection, don't cite it`);
      }
      for (const u of r.unsourced) {
        const sup = u.support == null ? '' : ` (support ${u.support})`;
        console.log(`      ${u.where} #${u.index}: ${u.reason}${sup}`);
        console.log(`        "${String(u.text).slice(0, 100)}"`);
      }
    }
    if (totalUnsourced) {
      console.log(`\n  ${totalUnsourced} bullet(s) not traceable to cv.md — fix the citation or the wording.`);
    }
    if (totalEmptyRoles) {
      console.log(`  ${totalEmptyRoles} role(s) would render with no bullets — a role with nothing under it is worse than no role.`);
    }
    if (!totalUnsourced && !totalEmptyRoles) {
      console.log('\n  All bullets trace to a cited cv.md line.');
    }
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
