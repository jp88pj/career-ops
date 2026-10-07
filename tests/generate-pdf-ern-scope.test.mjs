// generate-pdf.mjs now reads the built PDF back and enforces the ERN scope rule
// against the document itself, rather than the HTML.
//
// Found 2026-10-07 wiring verify-pdf-text.mjs in. The rule had no automated
// check at all before: cv.md allows the ERN on cityjobs.nyc.gov postings ONLY,
// the ERN is never mentioned in prose, and it is only ever rendered into the
// PDF — so no HTML-side gate could ever have seen it.
//
// Two real PDFs in output/ make the whole matrix testable without a browser: one
// built for an RFCUNY posting (no ERN) and one built for a cityjobs posting (ERN
// present). Both directions are asserted for each, because a gate that only
// reports absence has proven nothing — and that is precisely the bug this
// wiring shipped with: verifyBuiltPdf() checked result.forbidden but never
// result.missing, so `--ern-scope=cityjobs` logged "ERN present" for a CV
// containing no ERN. Test 3 below is the regression for it.
//
// Run:  node --test tests/generate-pdf-ern-scope.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBuiltPdf } from '../generate-pdf.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The user's cv.md is the only source of the identifier. Nothing hardcodes it.
const CV = readFileSync(join(ROOT, 'cv.md'), 'utf8');
const ERN = (CV.match(/\*\*ERN:\*\*\s*([0-9]{3,})/) || [])[1];

const NO_ERN_PDF = join(ROOT, 'output', 'cv-candidate-rfcuny-267-2026-10-07.pdf');
const WITH_ERN_PDF = join(ROOT, 'output', 'cv-candidate-parks-pdc-238-2026-09-30.pdf');

const skipNoErn = !existsSync(NO_ERN_PDF) && 'output/ CV PDFs not present';
const skipBoth = (!existsSync(NO_ERN_PDF) || !existsSync(WITH_ERN_PDF)) && 'output/ CV PDFs not present';

describe('generate-pdf ERN scope gate', () => {
  it('reads the ERN out of cv.md', { skip: !ERN && 'cv.md has no ERN' }, () => {
    assert.match(ERN, /^[0-9]{3,}$/);
  });

  it('PASSES when a non-cityjobs CV has no ERN', { skip: skipNoErn }, async () => {
    await verifyBuiltPdf({
      pdfPath: NO_ERN_PDF,
      cvMarkdown: CV,
      ernScope: 'other',
      label: 'test.pdf',
    });
  });

  it('BLOCKS when a cityjobs CV is missing the ERN it needs', { skip: skipNoErn }, async () => {
    await assert.rejects(
      verifyBuiltPdf({ pdfPath: NO_ERN_PDF, cvMarkdown: CV, ernScope: 'cityjobs', label: 'test.pdf' }),
      /required on a cityjobs/,
    );
  });

  it('PASSES when a cityjobs CV carries the ERN', { skip: skipBoth }, async () => {
    await verifyBuiltPdf({
      pdfPath: WITH_ERN_PDF,
      cvMarkdown: CV,
      ernScope: 'cityjobs',
      label: 'test.pdf',
    });
  });

  it('BLOCKS when the ERN leaks onto a non-cityjobs CV', { skip: skipBoth }, async () => {
    // The direction that matters: cv.md warns that an unexplained municipal
    // employee ID "reads as irrelevant" off-platform. This is the leak the gate
    // exists to stop, and it is invisible on inspection — the CV looks correct.
    await assert.rejects(
      verifyBuiltPdf({ pdfPath: WITH_ERN_PDF, cvMarkdown: CV, ernScope: 'other', label: 'test.pdf' }),
      /appears in/,
    );
  });

  it('no-ops with a warning when cv.md carries no ERN', async () => {
    // No identifier means no rule. It must not invent one.
    await verifyBuiltPdf({
      pdfPath: NO_ERN_PDF,
      cvMarkdown: '# CV\nNo employee number here.',
      ernScope: 'other',
      label: 'test.pdf',
    });
  });
});