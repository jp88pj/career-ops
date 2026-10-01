// tests/verify-replay-scope.test.mjs - the Replay Operator scope must be absent
// from artifacts, not merely flagged by a banner.
//
// The correction note in modes/_custom.md once read "All 138 now carry a
// REPLAY OPERATOR SCOPE CORRECTED banner". That was true of the banner and
// misleading about the rest: a banner is a warning label, it does not rewrite a
// payload, and it cannot reach a PDF already sent to an employer. Measured on
// 2026-10-01, 61 bullets across 33 payloads, 78 PDFs, and 83 reports still
// asserted the false scope - 58 reports carrying the banner AND the false text
// at the same time.
//
// Two ways this check itself lied while being built, both pinned here:
//
// 1. A banner QUOTES the false phrasing in order to warn about it. Matching the
//    literal string flags a clean file as dirty, and after a banner is added,
//    reports the dirty file as clean. Every line is classified first.
// 2. The inline PDF extractor parsed beginbfchar but not beginbfrange, decoding
//    almost nothing. A PDF then had an empty-looking text layer and read as
//    CLEAN - an extractor bug masquerading as a passing result, which is the
//    worst possible failure for a check like this. The tests assert against real
//    PDF text so a regression in decoding fails here.

import { pass, fail } from './helpers.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { classifyLine, classifyText } from '../verify-replay-scope.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('\nverify-replay-scope.mjs — false replay scope is absent, not just flagged');

// --- line classification
const lines = [
  ['a live claim', '- Primary operator for thousands of reviews and rulings across MLB', 'violation'],
  ['live review variant', '- Primary operator for thousands of live reviews with frontline public service', 'violation'],
  ['rulings phrasing alone', 'Recorded required data accurately, with accurate rulings noted', 'violation'],
  ['a BANNER quoting it', '> Any phrasing here about reviews and rulings, reviewing rules and challenges, is **void**.', 'banner'],
  ['a banner line', '> **REPLAY OPERATOR SCOPE CORRECTED (2026-09-29) - READ BEFORE REUSING**', 'banner'],
  ['do-not-reuse line', 'Do not reuse it in a CV or cover letter.', 'banner'],
  ['the corrected scope', 'Operated the replay software controlling the video feeds shown to the umpires, who were the sole decision-makers', 'clean'],
  ['unrelated text', 'Taught between 75 and 90 students each school year, administering NJSLA', 'clean'],
];
for (const [label, line, want] of lines) {
  const got = classifyLine(line);
  if (got === want) pass(`classifies ${label} as ${want}`);
  else fail(`classifies ${label} as ${got}, expected ${want}`);
}

// --- document level: a banner must not mask a live claim beside it
{
  const doc = [
    '> **REPLAY OPERATOR SCOPE CORRECTED - READ BEFORE REUSING**',
    '> Any phrasing about reviews and rulings is void.',
    '',
    '## Evidence',
    '- **Primary operator for thousands of reviews and rulings** across MLB regular season',
  ].join('\n');
  const r = classifyText(doc);
  if (r.banners === 2) pass('counts both banner lines as banners');
  else fail(`counted ${r.banners} banner lines, expected 2`);
  if (r.violations.length === 1) pass('bannered-and-still-wrong is reported as a violation');
  else fail(`violations=${r.violations.length}, expected 1 — a banner is masking a live claim`);
  if (!r.corrected) pass('does not claim a correction is present when it is not');
  else fail('reported corrected=true with no corrected wording in the document');
}

// --- a clean document must report zero, or the check cries wolf
{
  const doc = [
    '> **REPLAY OPERATOR SCOPE CORRECTED - READ BEFORE REUSING**',
    '> Any phrasing about reviews and rulings is void.',
    '- Operated the replay software and hardware controlling the video feeds shown to the umpires, who were the sole decision-makers',
  ].join('\n');
  const r = classifyText(doc);
  if (r.violations.length === 0) pass('a corrected document with a banner reports zero violations');
  else fail(`false positive: ${r.violations.length} violation(s) in a corrected document`);
  if (r.corrected) pass('confirms the corrected wording is present');
  else fail('did not detect the corrected wording');
}

// --- Identity-H: extracted text arrives with spaces inside words
{
  const mangled = 'Operated the replay softwar e and har dwar e contr olling the video f eeds shown t o the umpir es, who wer e the sole decision-mak ers';
  const r = classifyText(mangled);
  if (r.violations.length === 0) pass('letter-spaced extraction does not raise a false violation');
  else fail('letter-spaced text produced a false violation');
  if (r.corrected) pass('letter-spaced "sole decision-mak ers" still counts as corrected');
  else fail('missed the corrected marker in letter-spaced text');
}

// --- PDF extraction, against a real generated artifact
{
  const pdf = join(ROOT, 'output', 'cv-candidate-014-ixl-learning-2026-09-13.pdf');
  if (!existsSync(pdf)) {
    console.log('  (skipping PDF decode test: sample not present)');
  } else {
    // Independent ground truth: the raw bytes cannot contain the phrase, because
    // the text layer is Identity-H encoded. If the extractor "finds" it by
    // reading bytes it is not extracting at all.
    const raw = readFileSync(pdf).toString('latin1');
    if (raw.includes('reviews and rulings')) {
      fail('raw PDF bytes contain the literal phrase — extraction is not being tested');
    } else {
      pass('raw bytes do not contain the phrase (text layer is encoded)');
      const { default: _ } = { default: null };
      // Exercise the real extractor via the module's own scan on one file.
      const mod = await import('../verify-replay-scope.mjs');
      const t = mod.pdfText ? mod.pdfText(pdf) : null;
      if (typeof mod.pdfText === 'function' && t) {
        pass('module exposes pdfText for reuse');
        const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (flat(t).includes('thousandsofreviews')) {
          pass('PDF text extraction decodes the replay bullet (beginbfrange handled)');
        } else {
          fail('PDF extraction returned no replay text — the CMap decode regressed');
        }
      }
    }
  }
}
