#!/usr/bin/env node
// verify-cv-gates.mjs - run the four CV gates, in the order that matters.
//
// WHY THIS EXISTS
// ---------------
// The AGENTS.md is explicit: "Run all four CV gates, every time, in order. The
// order is load-bearing, not stylistic: a fact gate on generated HTML, then a
// source-citation gate, then a rendered-PDF text gate, then an ATS
// parseability check. Each catches what the previous one structurally cannot.
// A green run on any single one is not a clean document."
//
// Until now that sequence existed only as prose in modes/pdf.md and in the CV
// worker's spec, so it was run by hand - and a hand-run sequence is a sequence
// that can be run out of order, or partially, or with a gate forgotten. The
// 35 CVs built on 2026-10-20 pass three of the four: the source-citation gate
// was skipped, and the payload shape that gate requires is the one the HTML
// builder could not render until 2026-10-20 (patch #22).
//
// WHAT EACH GATE CATCHES
// ----------------------
//   1. verify-cv-facts        a CLAIM absent from cv.md
//   2. verify-bullet-sources  a bullet that does not trace to the cv.md line
//                             it cites - including one whose anchor is
//                             ambiguous, which the fact gate cannot see
//   3. verify-pdf-text        the RENDERED PDF, not the HTML: a phrase that
//                             did not survive the render, or one that should
//                             not be there at all
//   4. verify-ats             parseability of the generated HTML
//
// Usage:
//   node verify-cv-gates.mjs <payload.json> [<html>] [<pdf>] [options]
//   node verify-cv-gates.mjs --report=NNN [options]
//
// Options:
//   --must "a,b"        phrases that MUST appear in the rendered PDF
//   --forbid "x,y"      phrases that must NOT appear in the rendered PDF
//   --min-score N       ATS threshold (default 70)
//   --min-chars N       minimum decoded characters for the PDF gate (default 500)
//   --json              machine-readable output
//
// The --must and --forbid sets are POSTING-SPECIFIC, so they are arguments
// rather than defaults: the same CV can be clean for one posting and wrong for
// another. With neither given, the PDF gate still runs on the default minimum
// character count, so a PDF that renders to nothing is caught.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

const flags = { must: [], forbid: [], minScore: 70, minChars: 500, json: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--must') flags.must = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a.startsWith('--must=')) flags.must = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--forbid') flags.forbid = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a.startsWith('--forbid=')) flags.forbid = a.slice(9).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a.startsWith('--min-score=')) flags.minScore = Number(a.slice(12));
  else if (a.startsWith('--min-chars=')) flags.minChars = Number(a.slice(12));
  else if (a === '--json') flags.json = true;
  else if (a.startsWith('--report=')) {
    const num = a.slice(9);
    const dir = join(ROOT, 'output');
    // The PAYLOAD is the anchor: readdirSync order is not alphabetical, and
    // picking the .html would have the source-citation gate try to parse HTML.
    //
    // The cover letter's payload is named for the same report and sorts first
    // ("...-cover.payload.json" before "...-office-emergency-management..."),
    // so it has to be excluded or the CV gates would run against the LETTER.
    const all = readdirSync(dir).filter((l) => l.startsWith(`cv-candidate-${num}-`) && l.endsWith('.payload.json'));
    const hit = all.find((l) => !l.includes('-cover.')) || all[0];
    if (!hit) {
      console.error(`No payload in output/ for report ${num}`);
      process.exit(2);
    }
    positional.push(join(dir, hit), join(dir, hit.replace('.payload.json', '.html')), join(dir, hit.replace('.payload.json', '.pdf')));
  } else positional.push(a);
}

const [payloadPath, htmlPath, pdfPath] = positional;
if (!payloadPath) {
  console.error('Usage: node verify-cv-gates.mjs <payload.json> [<html>] [<pdf>] [options]');
  console.error('       node verify-cv-gates.mjs --report=NNN [options]');
  process.exit(2);
}
const html = htmlPath || payloadPath.replace(/\.payload\.json$/, '.html').replace(/\.json$/, '.html');
const pdf = pdfPath || payloadPath.replace(/\.payload\.json$/, '.pdf').replace(/\.json$/, '.pdf');

/**
 * Run one gate. Every gate is a separate process, because each is a shipped
 * tool with its own exit code and its own output format; a gate that cannot
 * run is a gate that did not pass.
 */
function gate(name, script, args) {
  if (!existsSync(script)) {
    return { name, ran: false, pass: false, detail: `missing gate script: ${basename(script)}` };
  }
  try {
    const out = execFileSync('node', [script, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { name, ran: true, pass: true, detail: summarise(out) };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim();
    return { name, ran: true, pass: false, detail: summarise(out) };
  }
}

function summarise(out) {
  const lines = String(out || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const verdict = lines.find((l) => /^(CV fact check passed|.*bullet\(s\) (?:not )?traceable|.*\d+ bullet\(s\) checked|verdict|\{)/i.test(l));
  return (verdict || lines[0] || '').slice(0, 220);
}

const results = [];

// 1. fact gate, on the generated HTML
results.push(gate('fact', join(ROOT, 'verify-cv-facts.mjs'), [html]));

// 2. source-citation gate, on the payload
results.push(gate('sources', join(ROOT, 'verify-bullet-sources.mjs'), [payloadPath]));

// 3. rendered-PDF text gate
if (!existsSync(pdf)) {
  results.push({ name: 'pdf-text', ran: false, pass: false, detail: `no rendered PDF at ${pdf}` });
} else {
  const args = [pdf, '--min-chars', String(flags.minChars)];
  if (flags.must.length) args.push('--must', flags.must.join(','));
  if (flags.forbid.length) args.push('--forbid', flags.forbid.join(','));
  results.push(gate('pdf-text', join(ROOT, 'verify-pdf-text.mjs'), args));
}

// 4. ATS parseability, on the generated HTML
results.push(gate('ats', join(ROOT, 'verify-ats.mjs'), [html, '--min-score', String(flags.minScore)]));

const failed = results.filter((r) => !r.pass);

if (flags.json) {
  console.log(JSON.stringify({
    payload: payloadPath, html, pdf,
    results, passed: results.length - failed.length, total: results.length,
    ok: failed.length === 0,
  }, null, 2));
} else {
  console.log(`  CV gates for ${basename(payloadPath).replace('.payload.json', '')}`);
  for (const r of results) {
    console.log(`    ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(9)} ${r.detail}`);
  }
  console.log(`    ${results.length - failed.length}/${results.length} gates passed`);
}

process.exit(failed.length ? 1 : 0);
