// tests/verify-pdf-text.test.mjs — the PDF text decoder must decode what
// Chromium actually emits, and must never report a clean bill of health off an
// empty read.
//
// The bug this exists to pin down: the first working version of the extractor
// read a Chromium PDF, found zero characters, and happily reported every
// forbidden term as ABSENT. A forbidden-term check that passes because it
// decoded nothing is worse than no check at all, so that case is asserted
// directly rather than left to inference.
//
// Run:  node --test tests/verify-pdf-text.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  extractPdfText,
  parseCmaps,
  checkPdf,
  buildSyntheticPdf,
} from '../verify-pdf-text.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A PDF whose content stream is split into many positioned runs, the way
// Chromium emits body text. "Administration" arriving as five runs is the
// normal case, not an edge case, and matching has to survive it.
function buildRunSplitPdf(phrase) {
  const chars = [...new Set(phrase.split('').filter((c) => c !== ' '))];
  const map = new Map(chars.map((c, i) => [0x0041 + i, c]));
  const codeOf = new Map([...map].map(([code, ch]) => [ch, code]));

  let cmap = 'begincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  cmap += `${map.size} beginbfchar\n`;
  for (const [code, ch] of map) {
    cmap += `<${code.toString(16).toUpperCase().padStart(4, '0')}> <${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>\n`;
  }
  cmap += 'endbfchar\nendcmap\n';

  // One glyph run per character, each followed by a Td move.
  const runs = [...phrase]
    .map((c) => {
      const code = codeOf.get(c);
      const hex = (code === undefined ? 0x0020 : code).toString(16).toUpperCase().padStart(4, '0');
      return `<${hex}> Tj 4 0 Td`;
    })
    .join('\n');
  const content = `BT /F1 11 Tf\n${runs}\nET`;

  const a = zlib.deflateSync(Buffer.from(cmap, 'latin1'));
  const b = zlib.deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from(`1 0 obj\n<< /Length ${a.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    a, Buffer.from('\nendstream\nendobj\n', 'latin1'),
    Buffer.from(`2 0 obj\n<< /Length ${b.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    b, Buffer.from('\nendstream\nendobj\ntrailer\n%%EOF\n', 'latin1'),
  ]);
}

test('decodes Identity-H glyph runs through the ToUnicode CMap', () => {
  const ex = extractPdfText(buildSyntheticPdf(['Jonathan', 'Presser', 'NJSLA']));
  assert.equal(ex.cmaps, 1, 'should find exactly one ToUnicode CMap');
  assert.ok(ex.codes > 0, 'should map glyph codes');
  assert.match(ex.text, /Jonathan/);
  assert.match(ex.text, /Presser/);
  assert.match(ex.text, /NJSLA/);
  assert.equal(ex.unmapped, 0, 'every glyph should resolve through the CMap');
});

test('steps 2 bytes per code, not 1, so glyphs stay in sync', () => {
  // A 1-byte step over 2-byte Identity-H codes desynchronises immediately and
  // renders each code's second byte as a bogus character ("Jonathan" -> "JAoBnC").
  const ex = extractPdfText(buildSyntheticPdf(['Jonathan']));
  const squeezed = ex.text.replace(/\s+/g, '');
  assert.ok(
    squeezed.includes('Jonathan'),
    `expected "Jonathan" in decoded text, got ${JSON.stringify(ex.text)}`,
  );
  assert.ok(!squeezed.includes('JAoBnC'), 'must not emit the second byte of each code');
});

test('matches a phrase split across many positioned runs', () => {
  // Chromium splits words across runs with Td moves between them, so
  // "Program Administration" can arrive as "Pr"+"og"+"ram" ...
  const pdf = buildRunSplitPdf('Program Administration');
  const ex = extractPdfText(pdf);
  assert.ok(ex.text.length > 0);
  const result = checkPdf(pdf, { must: ['Program Administration'], minChars: 5 });
  assert.equal(result.verdict, 'pass', `phrase should match across runs: ${JSON.stringify(result.missing)}`);
});

test('parseCmaps reads all three bfrange forms', () => {
  const cmap = [
    'begincmap',
    '2 beginbfrange',
    '<0001> <0002> <0041>',
    '<0003> <0004> [<0058> <0059>]',
    'endbfrange',
    '1 beginbfchar',
    '<0005> <005A>',
    'endbfchar',
    'endcmap',
  ].join('\n');
  const { map } = parseCmaps([cmap]);
  assert.equal(map.get('0001'), 'A');
  assert.equal(map.get('0002'), 'B');
  assert.equal(map.get('0003'), 'X');
  assert.equal(map.get('0004'), 'Y');
  assert.equal(map.get('0005'), 'Z');
});

test('passes when required text is present and forbidden text is absent', () => {
  const result = checkPdf(buildSyntheticPdf(['Jonathan', 'Presser']), {
    must: ['Jonathan Presser'],
    forbid: ['2033687'],
    minChars: 5,
  });
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.forbidden, []);
});

test('blocks when a forbidden term IS present', () => {
  const result = checkPdf(buildSyntheticPdf(['ERN', '2033687']), {
    forbid: ['2033687'],
    minChars: 5,
  });
  assert.equal(result.verdict, 'block');
  assert.ok(result.forbidden.includes('2033687'));
});

test('blocks when required text is absent', () => {
  const result = checkPdf(buildSyntheticPdf(['Jonathan']), {
    must: ['Grant Management'],
    minChars: 5,
  });
  assert.equal(result.verdict, 'block');
  assert.deepEqual(result.missing, ['Grant Management']);
});

test('BLOCKS rather than passing when nothing could be decoded', () => {
  // The regression. An undecodable PDF used to yield "no forbidden terms
  // found", which reads as a clean result for the wrong reason.
  const opaque = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n', 'latin1');
  const result = checkPdf(opaque, { forbid: ['2033687'], must: ['Jonathan Presser'] });
  assert.equal(result.verdict, 'block');
  assert.equal(result.forbidden.length, 0, 'must not claim any term was checked');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /were NOT run/);
});

test('honours --min-chars so a thin decode cannot pass as healthy', () => {
  const opaque = Buffer.from('%PDF-1.4\ntrailer\n%%EOF\n', 'latin1');
  assert.equal(checkPdf(opaque, { forbid: ['x'], minChars: 1 }).verdict, 'block');
  // A real document clears the bar.
  assert.equal(checkPdf(buildSyntheticPdf(['Jonathan', 'Presser']), { minChars: 5 }).verdict, 'pass');
});

test('reports an unmapped-glyph ratio so an encoding change is visible', () => {
  const ex = extractPdfText(buildSyntheticPdf(['Jonathan', 'Presser']));
  assert.equal(typeof ex.unmappedRatio === 'undefined', false);
  assert.equal(ex.unmappedRatio, 0);
});

test('rejects an invalid regex instead of throwing', () => {
  const result = checkPdf(buildSyntheticPdf(['Jonathan']), {
    mustRegex: ['([unclosed'],
    minChars: 5,
  });
  assert.equal(result.verdict, 'block');
  assert.match(result.errors.join(' '), /invalid --must-regex/);
});

// Real Chromium output. output/ is gitignored, so these skip in a clean
// checkout rather than failing CI -- the synthetic cases above are the
// guaranteed coverage.
const REAL = join(ROOT, 'output', 'cv-candidate-rfcuny-267-2026-10-07.pdf');
test('decodes a real Chromium-generated CV PDF', { skip: !existsSync(REAL) && 'output/ not present' }, () => {
  const ex = extractPdfText(readFileSync(REAL));
  assert.ok(ex.dense.length > 1000, `expected a full page of text, got ${ex.dense.length}`);
  assert.equal(ex.unmappedRatio, 0, 'a Chromium CV should decode every glyph');
  assert.match(ex.text, /Jonathan/);

  // Bidirectional: a term absent here must be reportable as absent, and the
  // ERN scope rule (cityjobs postings only) must be checkable against it.
  const forbiddenErn = checkPdf(readFileSync(REAL), { forbid: ['2033687'], minChars: 200 });
  assert.equal(forbiddenErn.verdict, 'pass', 'RFCUNY CV must not carry the Parks ERN');

  const required = checkPdf(readFileSync(REAL), { must: ['Jonathan Presser', 'NJSLA'], minChars: 200 });
  assert.equal(required.verdict, 'pass');
});