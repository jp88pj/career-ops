#!/usr/bin/env node

/**
 * Extract and verify the text of a GENERATED PDF, so content rules can be
 * enforced against what the employer actually receives.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other gate in the CV pipeline reads the HTML or the payload. The PDF is
 * the artifact that gets submitted, and until now nothing read it back. That gap
 * is not theoretical: the ERN scope rule in modes/_custom.md ("cityjobs.nyc.gov
 * postings only") has no automated check at all, because the only place the ERN
 * is rendered is the PDF.
 *
 * WHY THE EXTRACTION IS NOT A REGEX OVER THE FILE
 * ----------------------------------------------
 * Chromium (which generate-pdf.mjs drives) subsets fonts and emits Identity-H
 * content streams: the bytes inside `Tj` are glyph IDs, not characters. A naive
 * reader finds the literal strings absent from the file and reports them as
 * missing from the document -- the exact inversion of the truth.
 *
 * So this decodes properly:
 *   1. inflate every stream (FlateDecode / raw deflate / zip)
 *   2. parse each font's ToUnicode CMap (bfchar + bfrange, all three forms)
 *   3. pull `<hexglyphs> Tj` runs out of the content streams -- note the glyph
 *      string PRECEDES the operator -- and map each code through the CMap
 *
 * Word boundaries are positional, not textual: Chromium emits one `Tj` per
 * positioned run, so "Program Administration" can arrive as "Pr" + "og" + "ram"
 * across several runs with `Td` moves between them. Matching therefore also runs
 * against a whitespace-stripped copy, or every multi-word phrase reports absent
 * on a document that contains it.
 *
 * THE FAILURE MODE THIS IS BUILT TO SURFACE
 * ------------------------------------------
 * If extraction yields almost nothing, every `--forbid` check trivially passes
 * and every `--must` check fails, which reads like a clean bill of health for
 * the wrong reason. A silent empty extraction must never be reportable as
 * "nothing forbidden found". So a too-small extraction is a hard error with its
 * own message, and the unmapped-glyph ratio is always reported so an encoding
 * change surfaces as a number rather than as mysteriously empty text.
 *
 * Usage:
 *   node verify-pdf-text.mjs <file.pdf>
 *   node verify-pdf-text.mjs <file.pdf> --forbid "2033687,advanced,expert"
 *   node verify-pdf-text.mjs <file.pdf> --must "Jonathan Presser,NJSLA"
 *   node verify-pdf-text.mjs <file.pdf> --must-regex "NWEA MAP Growth" --min-chars 500
 *   node verify-pdf-text.mjs <file.pdf> --json
 *   node verify-pdf-text.mjs --self-test
 *
 * Exit 0 when the extraction is healthy and every check passes, else 1.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import zlib from 'zlib';
import { isMainModule } from './lib/is-main-module.mjs';

// Below this many characters of recovered text we refuse to report content
// checks at all. A real CV page is thousands of characters; anything under this
// means the decode failed, not that the document is sparse.
const DEFAULT_MIN_CHARS = 200;

// Try each inflate variant; PDF writers are inconsistent about which they use.
const INFLATORS = [zlib.inflateSync, zlib.inflateRawSync, zlib.unzipSync];

function tryInflate(bytes) {
  for (const fn of INFLATORS) {
    try {
      return fn(bytes);
    } catch {
      // next strategy
    }
  }
  return null;
}

// A CMap destination is a run of UTF-16BE code units, however many the writer
// chose to emit. Decoding 4 hex digits at a time covers the BMP and is what
// Chromium produces.
function hexToString(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (!Number.isNaN(code)) out += String.fromCharCode(code);
  }
  return out;
}

function padHex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

/**
 * Parse ToUnicode CMaps out of every stream body we have, compressed or not.
 * Returns a code -> string map plus a count of codes that different fonts
 * disagree about, which would make a decode ambiguous.
 */
export function parseCmaps(bodies) {
  const map = new Map();
  const conflicts = new Set();

  const add = (code, value) => {
    if (!code) return;
    if (map.has(code) && map.get(code) !== value) conflicts.add(code);
    else map.set(code, value);
  };

  for (const body of bodies) {
    if (!body || (!body.includes('beginbfchar') && !body.includes('beginbfrange'))) continue;

    for (const block of body.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const pair of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        add(pair[1].toUpperCase(), hexToString(pair[2].toUpperCase()));
      }
    }

    for (const block of body.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      // <lo> <hi> <dstStart>
      for (const t of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(t[1], 16);
        const hi = parseInt(t[2], 16);
        let base = parseInt(t[3], 16);
        const width = t[1].length;
        for (let c = lo; c <= hi && c - lo < 4096; c++, base++) {
          add(padHex(c, width), String.fromCharCode(base));
        }
      }
      // <lo> <hi> [ <d1> <d2> ... ]
      for (const t of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
        const lo = parseInt(t[1], 16);
        const width = t[1].length;
        const items = [...t[3].matchAll(/<([0-9A-Fa-f]+)>/g)];
        items.forEach((item, i) => {
          add(padHex(lo + i, width), hexToString(item[1].toUpperCase()));
        });
      }
    }
  }

  return { map, conflicts: conflicts.size };
}

/**
 * Decode a PDF buffer to text.
 *
 * @returns {{text: string, dense: string, streams: number, inflated: number,
 *            cmaps: number, codes: number, conflicts: number, codeWidth: number,
 *            glyphs: number, unmapped: number, unmappedRatio: number}}
 */
export function extractPdfText(buffer) {
  const raw = buffer.toString('latin1');

  const bodies = [];   // every stream body we could read, for CMap parsing
  const decoded = [];  // only the successfully inflated ones, for text
  let streams = 0;
  let inflated = 0;

  for (const m of raw.matchAll(/stream\r?\n?([\s\S]*?)endstream/g)) {
    streams++;
    const bytes = Buffer.from(m[1], 'latin1');
    const out = tryInflate(bytes);
    if (out) {
      inflated++;
      const text = out.toString('latin1');
      bodies.push(text);
      decoded.push(text);
    } else {
      // Uncompressed streams can still hold a CMap.
      bodies.push(m[1]);
    }
  }

  const { map, conflicts } = parseCmaps(bodies);
  const cmaps = bodies.filter((b) => b.includes('beginbfchar') || b.includes('beginbfrange')).length;

  // Code width is a property of the font, not of each string: Identity-H is
  // 2 bytes (4 hex chars), a simple font is 1 byte (2 hex chars). Stepping by
  // the wrong width desynchronises every glyph after the first and yields the
  // second byte of each code as a bogus character.
  let wide = 0;
  let narrow = 0;
  for (const key of map.keys()) {
    if (key.length >= 4) wide++;
    else narrow++;
  }
  const codeWidth = wide >= narrow ? 4 : 2;

  let text = '';
  let glyphs = 0;
  let unmapped = 0;

  for (const s of decoded) {
    if (s.includes('begincmap')) continue;      // a CMap, not a content stream
    if (!/T[jJ]/.test(s)) continue;

    // The glyph string precedes the operator: <hex> Tj / <hex> TJ
    for (const run of s.matchAll(/<([0-9A-Fa-f\s]+)>\s*T[jJ]/g)) {
      const hex = run[1].replace(/\s+/g, '');
      for (let i = 0; i + codeWidth <= hex.length; i += codeWidth) {
        const code = hex.slice(i, i + codeWidth).toUpperCase();
        if (map.has(code)) {
          glyphs++;
          text += map.get(code);
        } else {
          glyphs++;
          unmapped++;
          // Keep the low byte so the output stays legible and the ratio shows
          // up in the report rather than silently producing holes.
          const lo = parseInt(code.slice(-2), 16);
          if (!Number.isNaN(lo)) text += String.fromCharCode(lo);
        }
      }
      text += ' ';
    }
  }

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    dense: text.replace(/\s+/g, ''),
    streams,
    inflated,
    cmaps,
    codes: map.size,
    conflicts,
    codeWidth,
    glyphs,
    unmapped,
    unmappedRatio: glyphs ? Number((unmapped / glyphs).toFixed(4)) : 0,
  };
}

// Chromium splits words across positioned runs, so a phrase is matched against
// both the spaced text and a whitespace-free copy.
function matches(haystack, dense, needle, isRegex) {
  const squeeze = (s) => String(s).replace(/\s+/g, '');
  if (isRegex) {
    const re = new RegExp(needle.source.replace(/\s+/g, ''), needle.flags.replace('g', ''));
    return re.test(haystack) || re.test(dense);
  }
  return haystack.includes(needle) || dense.includes(squeeze(needle));
}

const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Run content checks against a decoded PDF.
 *
 * @param {Buffer} buffer
 * @param {{must?: string[], forbid?: string[], mustRegex?: string[],
 *          forbidRegex?: string[], minChars?: number}} opts
 */
export function checkPdf(buffer, opts = {}) {
  const {
    must = [],
    forbid = [],
    mustRegex = [],
    forbidRegex = [],
    minChars = DEFAULT_MIN_CHARS,
  } = opts;

  const ex = extractPdfText(buffer);

  const result = {
    verdict: 'pass',
    chars: ex.dense.length,
    words: ex.text.length,
    streams: ex.streams,
    inflated: ex.inflated,
    cmaps: ex.cmaps,
    codes: ex.codes,
    conflicts: ex.conflicts,
    glyphs: ex.glyphs,
    unmapped: ex.unmapped,
    unmappedRatio: ex.glyphs ? Number((ex.unmapped / ex.glyphs).toFixed(4)) : 0,
    minChars,
    missing: [],
    forbidden: [],
    warnings: [],
    errors: [],
  };

  // A decode that recovered almost nothing cannot support a content verdict.
  // Reporting "no forbidden terms found" off an empty read is the failure this
  // whole script exists to prevent, so it is a hard error, not a warning.
  if (ex.dense.length < minChars) {
    result.verdict = 'block';
    result.errors.push(
      `extraction recovered only ${ex.dense.length} chars (minimum ${minChars}); ` +
      'content checks were NOT run because an empty read would report every ' +
      'forbidden term as absent',
    );
    return result;
  }

  if (ex.conflicts > 0) {
    result.warnings.push(
      `${ex.conflicts} glyph code(s) map to different characters in different fonts; ` +
      'the decode may be ambiguous',
    );
  }
  if (ex.glyphs > 0 && ex.unmapped / ex.glyphs > 0.2) {
    result.warnings.push(
      `${Math.round((ex.unmapped / ex.glyphs) * 100)}% of glyphs were not in any ToUnicode ` +
      'CMap; the font encoding may have changed and matches may be unreliable',
    );
  }

  for (const needle of must) {
    if (!matches(ex.text, ex.dense, needle, false)) result.missing.push(needle);
  }
  for (const src of mustRegex) {
    let re;
    try {
      re = new RegExp(src, 'i');
    } catch (err) {
      result.errors.push(`invalid --must-regex ${JSON.stringify(src)}: ${err.message}`);
      continue;
    }
    if (!matches(ex.text, ex.dense, re, true)) result.missing.push(`re:${src}`);
  }
  for (const needle of forbid) {
    if (matches(ex.text, ex.dense, needle, false)) result.forbidden.push(needle);
  }
  for (const src of forbidRegex) {
    let re;
    try {
      re = new RegExp(src, 'i');
    } catch (err) {
      result.errors.push(`invalid --forbid-regex ${JSON.stringify(src)}: ${err.message}`);
      continue;
    }
    if (matches(ex.text, ex.dense, re, true)) result.forbidden.push(`re:${src}`);
  }

  if (result.missing.length || result.forbidden.length || result.errors.length) {
    result.verdict = 'block';
  }
  return result;
}

function parseArgs(argv) {
  const out = { file: null, must: [], forbid: [], mustRegex: [], forbidRegex: [], minChars: DEFAULT_MIN_CHARS, json: false };
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift();
    const value = () => rest.shift();
    switch (arg) {
      case '--must': out.must.push(...splitList(value())); break;
      case '--forbid': out.forbid.push(...splitList(value())); break;
      case '--must-regex': out.mustRegex.push(value()); break;
      case '--forbid-regex': out.forbidRegex.push(value()); break;
      case '--min-chars': out.minChars = Number(value()); break;
      case '--json': out.json = true; break;
      default:
        if (arg && !arg.startsWith('--') && !out.file) out.file = arg;
        break;
    }
  }
  return out;
}

function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) {
    return runSelfTest();
  }

  const args = parseArgs(argv);
  if (!args.file) {
    console.error('Usage: node verify-pdf-text.mjs <file.pdf> [--must "a,b"] [--forbid "x,y"] [--must-regex RE] [--forbid-regex RE] [--min-chars N] [--json]');
    return 1;
  }

  let buffer;
  try {
    buffer = readFileSync(args.file);
  } catch (err) {
    if (args.json) {
      console.log(JSON.stringify({ verdict: 'block', errors: [`cannot read ${args.file}: ${err.message}`] }));
    } else {
      console.error(`ERROR: cannot read ${args.file}: ${err.message}`);
    }
    return 1;
  }

  const result = checkPdf(buffer, args);

  if (args.json) {
    console.log(JSON.stringify(result));
    return result.verdict === 'pass' ? 0 : 1;
  }

  const name = basename(args.file);
  console.log(`PDF text check: ${name}`);
  console.log(`  recovered: ${result.chars} chars, ${result.streams} stream(s), ${result.inflated} inflated, ` +
    `${result.cmaps} CMap(s), ${result.codes} codes, ${result.glyphs} glyphs ` +
    `(${Math.round(result.unmappedRatio * 100)}% unmapped)`);

  for (const w of result.warnings) console.log(`  warning: ${w}`);
  for (const e of result.errors) console.error(`  ERROR: ${e}`);
  if (result.missing.length) {
    console.error('\nRequired text not found in the PDF:');
    for (const n of result.missing) console.error(`  - ${n}`);
  }
  if (result.forbidden.length) {
    console.error('\nForbidden text present in the PDF:');
    for (const n of result.forbidden) console.error(`  - ${n}`);
  }

  if (result.verdict === 'pass') {
    console.log('\nPDF text check passed.');
    return 0;
  }
  console.error('\nPDF text check FAILED.');
  return 1;
}

// Minimal synthetic PDF exercising the real decode path: a FlateDecode
// ToUnicode CMap plus a FlateDecode content stream of Identity-H glyph runs.
// Exported so tests/verify-pdf-text.test.mjs and --self-test share one builder
// rather than keeping two that can drift apart.
export function buildSyntheticPdf(words) {
  const chars = [...new Set(words.join(''))].filter((c) => c !== ' ');
  const map = new Map(chars.map((c, i) => [0x0041 + i, c]));
  // A real ToUnicode CMap wraps its pairs in beginbfchar/endbfchar. Keeping the
  // parser strict about that is deliberate: a bare-pair fallback would also
  // match the <hex> strings in an ordinary content stream and invent mappings.
  let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  cmap += `${map.size} beginbfchar\n`;
  for (const [code, ch] of map) {
    cmap += `<${code.toString(16).toUpperCase().padStart(4, '0')}> <${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>\n`;
  }
  cmap += 'endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';

  // The CMap is keyed by glyph CODE; the encoder has to look up a character and
  // get its code. Testing `map.has(charCode)` instead silently rewrites any
  // character whose ASCII happens to fall inside the code range.
  const codeOf = new Map([...map].map(([code, ch]) => [ch, code]));
  const enc = (word) =>
    [...word]
      .map((c) => {
        const code = codeOf.get(c);
        return code === undefined
          ? '0020'
          : code.toString(16).toUpperCase().padStart(4, '0');
      })
      .join('');
  const content = `BT /F1 11 Tf 1 0 0 1 0 0 Tm\n${words.map((w) => `<${enc(w)}> Tj 0 -14 Td`).join('\n')}\nET`;
  const cmapBuf = zlib.deflateSync(Buffer.from(cmap, 'latin1'));
  const contentBuf = zlib.deflateSync(Buffer.from(content, 'latin1'));

  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1'),
    Buffer.from(`2 0 obj\n<< /Length ${cmapBuf.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    cmapBuf,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
    Buffer.from(`3 0 obj\n<< /Length ${contentBuf.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    contentBuf,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
    Buffer.from('trailer\n%%EOF\n', 'latin1'),
  ]);
}

function runSelfTest() {
  const checks = [];
  const expect = (name, cond, detail = '') => {
    checks.push({ name, ok: !!cond, detail });
    console.log(`  ${cond ? 'pass' : 'FAIL'}  ${name}${cond || !detail ? '' : ` (${detail})`}`);
  };

  const words = ['Jonathan', 'Presser', 'NJSLA'];
  const pdf = buildSyntheticPdf(words);

  const ex = extractPdfText(pdf);
  expect('inflates both streams', ex.inflated === 2, `got ${ex.inflated}`);
  expect('finds the ToUnicode CMap', ex.cmaps === 1, `got ${ex.cmaps}`);
  expect('maps glyph codes', ex.codes > 0, `got ${ex.codes}`);
  expect('decodes words out of Identity-H glyph runs', /Jonathan/.test(ex.text) && /NJSLA/.test(ex.text), ex.text.slice(0, 80));

  const clean = checkPdf(pdf, { must: ['Jonathan Presser', 'NJSLA'], forbid: ['2033687'], minChars: 5 });
  expect('passes when must-present and forbid-absent', clean.verdict === 'pass', JSON.stringify({ missing: clean.missing, forbidden: clean.forbidden }));
  expect('does not report the absent forbid term', clean.forbidden.length === 0);

  const leaked = checkPdf(pdf, { forbid: ['NJSLA'], minChars: 5 });
  expect('blocks when a forbidden term is present', leaked.verdict === 'block' && leaked.forbidden.includes('NJSLA'));

  const missing = checkPdf(pdf, { must: ['Grant Management'], minChars: 5 });
  expect('blocks when required text is absent', missing.verdict === 'block' && missing.missing.length === 1);

  // The regression this script was written for: a PDF whose text cannot be
  // decoded must NOT come back as "nothing forbidden found".
  const opaque = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n', 'latin1');
  const blind = checkPdf(opaque, { forbid: ['2033687'], must: ['Jonathan Presser'] });
  expect('blocks instead of passing on an undecodable PDF', blind.verdict === 'block');
  expect('explains that content checks were not run', blind.errors.length === 1 && /were NOT run/.test(blind.errors[0]));
  expect('does not claim the forbidden term was checked', blind.forbidden.length === 0);

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n  ${checks.length - failed}/${checks.length} self-tests passed`);
  return failed === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli();
}