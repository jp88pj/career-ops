#!/usr/bin/env node
// Retrofit Roboto + letter-spacing fix into already-built CV HTML files.
// Inserts @font-face after the first <style> and appends an override block
// before its closing </style>. Idempotent (skips files already patched).
import { readFileSync, writeFileSync } from 'fs';

const FONTFACE = `
  /* Roboto legibility retrofit 2026-09-23 (inlined as data: URLs at PDF time). */
  @font-face {
    font-family: 'Roboto'; font-style: normal; font-weight: 400; font-display: swap;
    src: url('./fonts/roboto-latin-400-normal.woff2') format('woff2');
  }
  @font-face {
    font-family: 'Roboto'; font-style: normal; font-weight: 700; font-display: swap;
    src: url('./fonts/roboto-latin-700-normal.woff2') format('woff2');
  }
  @font-face {
    font-family: 'Roboto'; font-style: normal; font-weight: 400; font-display: swap;
    src: url('./fonts/roboto-latin-ext-400-normal.woff2') format('woff2');
  }
  @font-face {
    font-family: 'Roboto'; font-style: normal; font-weight: 700; font-display: swap;
    src: url('./fonts/roboto-latin-ext-700-normal.woff2') format('woff2');
  }`;
const OVERRIDE = `
  /* Roboto legibility + extractor-spacing retrofit 2026-09-23: wins over any
     baked-in stack/tracking via cascade order + !important. */
  body, .header h1, .section-title, p, li, div, span, td, a, h1, h2, h3 {
    font-family: "Roboto", "Liberation Sans", "Helvetica Neue", Arial, sans-serif !important;
    letter-spacing: normal !important;
  }`;

const files = process.argv.slice(2);
let patched = 0, skipped = 0;
for (const f of files) {
  let html;
  try { html = readFileSync(f, 'utf-8'); } catch { console.log('MISS ' + f); continue; }
  if (html.includes('Roboto legibility retrofit')) { skipped++; continue; }
  const open = html.indexOf('<style>');
  const close = html.indexOf('</style>');
  if (open === -1 || close === -1 || close < open) { console.log('NOSTYLE ' + f); continue; }
  html = html.slice(0, open + 7) + FONTFACE + html.slice(open + 7, close) + OVERRIDE + html.slice(close);
  writeFileSync(f, html);
  patched++;
  console.log('PATCHED ' + f);
}
console.log(`done: ${patched} patched, ${skipped} already-patched`);
