#!/usr/bin/env node
// One-shot: apply the 2026-09-24 type change (600 SemiBold +1px ladder) to
// already-built CV HTML files, then re-render their PDFs per the manifest.
// Idempotent: files already carrying the 600 face + 12px base are skipped.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const FACE600 = `
  /* SemiBold 600 (single file covers latin + latin-ext). */
  @font-face {
    font-family: 'Roboto';
    font-style: normal;
    font-weight: 600;
    font-display: swap;
    src: url('./fonts/roboto-latin-600-normal.woff2') format('woff2');
  }`;

// Largest-first so replacements never double-bump.
const LADDER = [
  ['12.5px', '13.5px'], ['11.5px', '12.5px'], ['12px', '13px'],
  ['10.5px', '11.5px'], ['--font-size: 11px', '--font-size: 12px'],
  ['10px', '11px'], ['9.5px', '10.5px'], ['9px', '10px'], ['28px', '29px'],
];

function patchFile(f) {
  let html;
  try { html = readFileSync(f, 'utf-8'); } catch { console.log('MISS ' + f); return 'miss'; }
  if (html.includes('roboto-latin-600-normal.woff2') && html.includes('--font-size: 12px')) {
    console.log('SKIP ' + f); return 'skip';
  }
  if (!html.includes('roboto-latin-600-normal.woff2')) {
    const open = html.indexOf('<style>');
    if (open === -1) { console.log('NOSTYLE ' + f); return 'nostyle'; }
    html = html.slice(0, open + 7) + FACE600 + html.slice(open + 7);
  }
  // Body copy to SemiBold (only when the body rule has no explicit weight).
  html = html.replace(/(body\s*\{[^}]*?font-size:\s*var\(--font-size\);)(\s*\n)/, '$1\n    font-weight: 600;$2');
  html = html.split('font-weight: 500;').join('font-weight: 600;');
  for (const [from, to] of LADDER) html = html.split(from).join(to);
  writeFileSync(f, html);
  console.log('PATCHED ' + f);
  return 'patched';
}

const manifest = JSON.parse(readFileSync('batch/roboto-regen-manifest.json', 'utf-8'));
let patched = 0, skipped = 0, rendered = 0, failed = 0;
const results = [];
for (const entry of manifest) {
  const st = patchFile(entry.input);
  if (st === 'patched') patched++;
  else if (st === 'skip') skipped++;
  if (!existsSync(entry.input)) { results.push({ ...entry, ok: false, error: 'missing-input' }); failed++; continue; }
  try {
    execFileSync('node', ['generate-pdf.mjs', entry.input, entry.output, '--format=' + (entry.format || 'letter')], { stdio: 'pipe' });
    const bytes = readFileSync(entry.output).length;
    results.push({ outputPath: entry.output, ok: true, size: bytes });
    rendered++;
    console.log('RENDERED ' + entry.output);
  } catch (e) {
    results.push({ ...entry, ok: false, error: String(e.message).slice(0, 160) });
    failed++;
    console.log('FAIL ' + entry.output);
  }
}
writeFileSync('batch/regen-type-manifest-2026-09-24.results.json', JSON.stringify(results, null, 2));
console.log(`done: ${patched} patched, ${skipped} skipped, ${rendered} rendered, ${failed} failed`);
