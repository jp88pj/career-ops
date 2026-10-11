#!/usr/bin/env node
/**
 * check-anchor-collisions.mjs - preflight lint for source_anchor uniqueness.
 *
 * THE DEFECT THIS EXISTS TO CATCH
 * -------------------------------
 * Every twin bullet in `modes/_custom.md` cites a `source_anchor` - a phrase in
 * `cv.md` that must match EXACTLY ONE line. That uniqueness requirement is the
 * whole point of the anchor form over a loose one.
 *
 * It breaks in a specific, repeated way: **a new note in `cv.md` that quotes an
 * anchor verbatim makes that anchor match two lines.** The bullet then cites an
 * ambiguous source, and `verify-bullet-sources.mjs` blocks the role.
 *
 * MEASURED 2026-10-10 - five separate occurrences in one session, each costing a
 * manual repair cycle:
 *
 *   1. A soft-skills note quoted "radio dispatch to supervisors" -> P2 ambiguous.
 *   2. A note warning against anchor quoting QUOTED the anchor -> P1 ambiguous.
 *   3. A podcast note quoted the whole F3 bullet -> F3 ambiguous (the bullet
 *      contains its own anchor).
 *   4. Two more while writing the notes that document fixes 1-3.
 *
 * Every one was caught by hand, after the fact, by writing a throwaway script.
 * Twice the near-miss was worse than the bug: the *note warning against the
 * failure* is what reproduced it.
 *
 * WHY THIS IS A SEPARATE TOOL RATHER THAN A FLAG ON THE GATE
 * ----------------------------------------------------------
 * `verify-bullet-sources.mjs` checks a PAYLOAD. The failure above happens while
 * editing `cv.md` and `modes/_custom.md` - often for a twin that is NOT in the
 * current payload at all, and always before a rebuild exists. Waiting for the
 * payload means the collision is only ever found once it is already load-bearing.
 *
 * This reads the SOURCE PAIR directly: anchors out of `modes/_custom.md`, lines
 * out of `cv.md`. It runs in well under a second and is safe to run after any
 * edit to either file.
 *
 * SHARED MATCHER, NOT A REIMPLEMENTATION
 * ---------------------------------------
 * The resolution logic is IMPORTED from verify-bullet-sources.mjs. If this file
 * matched anchors its own way it would eventually disagree with the gate, and the
 * failure mode is the dangerous one: lint clean, gate blocking.
 *
 * USAGE
 * -----
 *     node check-anchor-collisions.mjs
 *     node check-anchor-collisions.mjs --json
 *     node check-anchor-collisions.mjs --source cv.md --custom modes/_custom.md
 *
 * Exit 0 when every anchor resolves uniquely, 1 otherwise. Reporting `missing`
 * as well as `ambiguous` is deliberate: both are defects, and they have different
 * fixes - an ambiguous anchor needs the new line reworded, a missing one needs
 * the anchor retyped. Conflating them sends you to the wrong repair.
 */

import { readFileSync } from 'node:fs';
import { resolveAnchor } from './verify-bullet-sources.mjs';

/**
 * Pull twin ids and their backticked anchors out of the anchor tables in
 * `modes/_custom.md`.
 *
 * Table row shape:  | P1 | what it covers | `anchor one` · `anchor two` |
 * Only rows whose FIRST cell is a twin id count, so the prose tables elsewhere in
 * that file (verification-failure registries, tool-name lists) are not misread as
 * citations.
 */
export function parseAnchors(customText) {
  const found = [];
  for (const line of customText.split(/\r?\n/)) {
    const row = line.match(/^\s*\|\s*([A-Z]{1,2}\d+)\s*\|/);
    if (!row) continue;
    const id = row[1];
    const anchors = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
    for (const a of anchors) found.push({ id, anchor: a });
  }
  return found;
}

export function checkAnchors(customText, sourceText) {
  const lines = sourceText.split(/\r?\n/);
  const entries = parseAnchors(customText);

  const ambiguous = [];
  const missing = [];
  let checked = 0;

  for (const { id, anchor } of entries) {
    checked += 1;
    const res = resolveAnchor(lines, 'source_anchor', anchor);
    if (res.line !== null) continue;

    // Classify using the same resolver, so this cannot disagree with the gate.
    const needle = anchor.toLowerCase();
    const hitCount = lines.filter((l) => l.toLowerCase().includes(needle)).length;
    const record = { id, anchor, lines: hitCount, detail: res.reason };
    if (hitCount > 1) ambiguous.push(record);
    else missing.push(record);
  }

  return { verdict: ambiguous.length === 0 && missing.length === 0 ? 'pass' : 'fail', checked, ambiguous, missing, totalAnchors: entries.length };
}

function parseArgs(argv) {
  const out = { json: false, source: 'cv.md', custom: 'modes/_custom.md' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--source') out.source = argv[++i];
    else if (a === '--custom') out.custom = argv[++i];
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const custom = readFileSync(args.custom, 'utf8');
  const source = readFileSync(args.source, 'utf8');
  const r = checkAnchors(custom, source);

  if (args.json) {
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.verdict === 'pass' ? 0 : 1);
  }

  console.log('');
  console.log('  anchor collision lint - cv.md  x  modes/_custom.md');
  console.log('  ====================================================');

  if (r.verdict === 'pass') {
    console.log(`  OK  ${r.checked} anchors, all resolve to exactly one line`);
  } else {
    if (r.ambiguous.length) {
      console.log(`  ${r.ambiguous.length} AMBIGUOUS (match >1 line - a note in cv.md is quoting the anchor):`);
      for (const a of r.ambiguous) {
        console.log(`     ${a.id}  matches ${a.lines} lines  "${a.anchor.slice(0, 64)}"`);
        console.log('        fix: reword the NEW cv.md line. Do not change the anchor -');
        console.log('        changing it re-points an approved bullet at a different sentence.');
      }
    }
    if (r.missing.length) {
      console.log(`  ${r.missing.length} MISSING (match no line - the anchor or cv.md moved):`);
      for (const m of r.missing) console.log(`     ${m.id}  "${m.anchor.slice(0, 64)}"`);
    }
  }
  console.log('');

  process.exit(r.verdict === 'pass' ? 0 : 1);
}