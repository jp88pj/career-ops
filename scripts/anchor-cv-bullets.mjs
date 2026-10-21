#!/usr/bin/env node
/**
 * anchor-cv-bullets.mjs - give every bullet in a tailored CV a source anchor.
 *
 * WHY
 * ---
 * The 35 CVs from the September batch carry their bullets as plain strings,
 * with no `source_anchor`. The source-citation gate therefore reports every
 * one of their bullets as unsourced, and each of those CVs sits at 3/4 gates
 * however good the CV itself is. The gate is right: a bullet that cites
 * nothing cannot be checked.
 *
 * The anchor has to be a phrase in cv.md that resolves to EXACTLY ONE line -
 * the resolver calls an ambiguous anchor a loud failure rather than guessing,
 * because a bullet that cites the wrong role is worse than an uncited one.
 *
 * HOW IT PICKS
 * ------------
 * For each bullet it finds the cv.md line that supports it best, measured with
 * THE GATE'S OWN TOKENIZER (`words` and `resolveAnchor`, both imported from
 * verify-bullet-sources.mjs). A second copy of the tokenizer would be a
 * second definition of "supported", and the two would drift - the split brain
 * this repo refuses to have anywhere else.
 *
 * The anchor is then the shortest word-window of that line which resolves to
 * that line and no other: a phrase a human would recognise, and one that
 * survives an upstream line that grew around it.
 *
 * Usage:
 *   node scripts/anchor-cv-bullets.mjs --report=NNN [--dry-run]
 *   node scripts/anchor-cv-bullets.mjs --all [--dry-run]
 *
 * Exits 1 if any bullet could NOT be anchored, so an unanchored bullet is
 * reported rather than quietly left behind.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { words, resolveAnchor } from '../verify-bullet-sources.mjs';
import { isMainModule } from "../lib/is-main-module.mjs";

const ROOT = resolve(process.cwd());
const SOURCE = join(ROOT, 'cv.md');
const SUPPORT_RATIO = 0.6;
const MAX_NOVEL_WORDS = 2;
const MAX_CITATIONS = 6;

const sourceText = readFileSync(SOURCE, 'utf-8');
const sourceLines = sourceText.split(/\r?\n/);
const allSourceWords = new Set();
for (const l of sourceLines) for (const w of words(l)) allSourceWords.add(w);

/** How much of the bullet's vocabulary the cited lines cover. */
function support(bulletWords, citedLines) {
  if (!bulletWords.length) return 1;
  const src = new Set();
  for (const l of citedLines) for (const w of words(l)) src.add(w);
  return bulletWords.filter((w) => src.has(w)).length / bulletWords.length;
}

/** The shortest window of `line` that resolves to that line and no other. */
function uniquePhrase(line, lineNo) {
  // word start positions in the RAW line, so the phrase is a literal
  // substring of the file - the resolver matches raw lines.
  const starts = [];
  const re = /[A-Za-z0-9]/g;
  let m;
  while ((m = re.exec(line)) !== null) starts.push(m.index);
  const ends = [];
  for (let i = 0; i < starts.length; i++) {
    let e = starts[i];
    while (e < line.length && /[A-Za-z0-9]/.test(line[e])) e++;
    ends.push(e);
  }
  for (let len = 3; len <= Math.min(12, starts.length); len++) {
    for (let i = 0; i + len <= starts.length; i++) {
      const phrase = line.slice(starts[i], ends[i + len - 1]);
      if (!phrase.trim()) continue;
      const r = resolveAnchor(sourceLines, 'source_anchor', phrase);
      if (r.line !== null && r.line === line) return phrase;
    }
  }
  return null;
}

/** The best supporting lines for a bullet, greedily, until support clears the bar. */
function supportingLines(bulletWords) {
  const scored = sourceLines
    .map((line, i) => {
      const lw = new Set(words(line));
      let hit = 0;
      for (const w of bulletWords) if (lw.has(w)) hit++;
      return { line, i, score: bulletWords.length ? hit / bulletWords.length : 0 };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen = [];
  for (const c of scored) {
    if (chosen.length >= MAX_CITATIONS) break;
    if (support(bulletWords, chosen.map((x) => x.line) .concat(c.line)) >= SUPPORT_RATIO) {
      chosen.push(c);
      break;
    }
  }
  // If one line is not enough, add the best complementary lines until the bar
  // is met or nothing more helps.
  let guard = 0;
  while (support(bulletWords, chosen.map((c) => c.line)) < SUPPORT_RATIO && guard++ < MAX_CITATIONS) {
    let best = null;
    for (const c of scored) {
      if (chosen.some((x) => x.i === c.i)) continue;
      const s = support(bulletWords, chosen.map((x) => x.line).concat(c.line));
      if (!best || s > best.s) best = { c, s };
    }
    if (!best || best.s <= support(bulletWords, chosen.map((x) => x.line))) break;
    chosen.push(best.c);
  }
  return chosen;
}

function anchorBullet(text) {
  const bw = words(text);
  const novel = bw.filter((w) => !allSourceWords.has(w));
  const chosen = supportingLines(bw);
  const anchors = [];
  for (const c of chosen) {
    const phrase = uniquePhrase(c.line, c.i);
    if (phrase) anchors.push(phrase);
  }
  const cited = chosen.map((c) => c.line);
  const ratio = support(bw, cited);
  return {
    anchors,
    ratio,
    novel: novel.length,
    ok: anchors.length > 0 && ratio >= SUPPORT_RATIO && novel.length <= MAX_NOVEL_WORDS,
    lines: chosen.map((c) => c.i + 1),
  };
}


// The CLI tail is guarded: 122 of the repo's .mjs files do this, and a
// hand-rolled `process.argv[1]` comparison silently no-ops through a
// symlinked checkout - the process exits 0 having done nothing, which
// every caller reads as success.
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  let payloads = [];
  if (args.includes('--all')) {
    payloads = readdirSync(join(ROOT, 'output'))
      .filter((f) => /^cv-candidate-.*\.payload\.json$/.test(f) && !f.includes('-ats.') && !f.includes('-cover.'))
      .map((f) => join(ROOT, 'output', f));
  } else if (args.some((a) => a.startsWith('--report='))) {
    const num = args.find((a) => a.startsWith('--report=')).split('=')[1];
    const f = readdirSync(join(ROOT, 'output')).find(
      (x) => x.startsWith(`cv-candidate-${num}-`) && x.endsWith('.payload.json') && !x.includes('-ats.') && !x.includes('-cover.')
    );
    if (!f) { console.error(`Error: no tailored CV payload for report ${num}`); process.exit(1); }
    payloads = [join(ROOT, 'output', f)];
  } else {
    console.error('usage: node scripts/anchor-cv-bullets.mjs --report=NNN | --all [--dry-run]');
    process.exit(1);
  }

  let anchored = 0;
  let alreadyHad = 0;
  const failed = [];

  for (const p of payloads) {
    const payload = JSON.parse(readFileSync(p, 'utf-8'));
    let changed = false;
    for (const group of [...(payload.experience || []), ...(payload.projects || [])]) {
      if (!Array.isArray(group.bullets)) continue;
      const out = [];
      for (const b of group.bullets) {
        if (typeof b === 'object' && b && b.source_anchor) { alreadyHad++; out.push(b); continue; }
        const text = typeof b === 'string' ? b : b?.text;
        if (!text) { out.push(b); continue; }
        const r = anchorBullet(text);
        if (!r.ok) {
          failed.push({ file: p.split(/[\\/]/).pop(), text, ratio: r.ratio, novel: r.novel, lines: r.lines });
          out.push(b);
          continue;
        }
        anchored++;
        changed = true;
        out.push({ text, source_anchor: r.anchors });
      }
      group.bullets = out;
    }
    if (changed && !dryRun) writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  }

  console.log(`  ${anchored} bullet(s) anchored, ${alreadyHad} already had one`);
  if (failed.length) {
    console.log(`  ${failed.length} bullet(s) could NOT be anchored - each is a claim cv.md does not carry:`);
    for (const f of failed.slice(0, 30)) {
      console.log(`    ${f.file}: "${f.text.slice(0, 90)}"`);
      console.log(`       support ${f.ratio.toFixed(2)} (needs ${SUPPORT_RATIO}), ${f.novel} novel word(s) (max ${MAX_NOVEL_WORDS}), best lines ${f.lines.join(',') || '-'}`);
    }
    if (failed.length > 30) console.log(`    ... and ${failed.length - 30} more`);
  }
  process.exit(failed.length ? 1 : 0);

}

if (isMainModule(import.meta.url)) {
  main();
}
