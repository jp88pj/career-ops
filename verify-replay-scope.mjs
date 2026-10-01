#!/usr/bin/env node
// verify-replay-scope.mjs - assert the Replay Operator scope correction actually
// landed in the artifacts, not just in a banner.
//
// WHY THIS EXISTS
// ---------------
// The correction note in modes/_custom.md originally read "All 138 now carry a
// REPLAY OPERATOR SCOPE CORRECTED banner", which was accurate about a banner and
// misleading about everything else. A banner is a WARNING LABEL. It marks a file
// as contaminated; it does not rewrite a payload, and it cannot reach a PDF that
// has already gone to an employer.
//
// The consequence was measured on 2026-10-01: with 61 bullets across 33
// payloads still asserting the false scope, 78 generated PDFs, and 83 reports
// containing a live claim - 58 of those reports carrying the banner AND the
// false text simultaneously. The payloads are now clean. These are not.
//
// WHY THE SCAN IS DELICATE
// ------------------------
// Two failure modes, both hit while building this:
//
// 1. A banner QUOTES the false phrasing in order to warn about it ("any phrasing
//    about reviews and rulings is void"). A naive grep matches the warning and
//    reports a file as dirty when it is clean - or worse, reports a dirty file as
//    clean after the warning is the only match. Every line is classified before
//    it is counted.
// 2. Chromium emits Identity-H fonts, so extracted PDF text arrives as
//    "sole decision-mak ers" with a space inside the word. Comparing the literal
//    string "sole decision-makers" reports absent and makes a corrected artifact
//    look broken. Text is flattened to alphanumerics before matching.
//
// Usage:
//   node verify-replay-scope.mjs [--payloads <dir>] [--json]
//   node verify-replay-scope.mjs --scan          # read-only, report only
//
// Exit 1 when a violation is found, 0 when clean.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, extname } from 'path';

const DEFAULT_PAYLOAD_DIR = process.env.CAREER_OPS_PAYLOAD_DIR || '';

// The false scope, in every phrasing found in the corpus. Each asserts that the
// candidate reviewed, ruled on, or decided replay matters.
const FALSE_PATTERNS = [
  'thousands of reviews and rulings',
  'reviews and rulings',
  'thousands of successful reviews and rulings',
  'thousands of instant-replay reviews',
  'thousands of live reviews',
  'thousands of reviews',
  'instant-replay review of rules',
  'performing instant-replay review',
  'performed instant-replay review',
  'instant replay rulings',
  'documenting decisions',
  'communicated rulings',
  're-rulings',
  'accurate rulings',
  'applying rules with precision',
];

// The corrected scope, from cv.md. Absence of the false patterns is the primary
// signal; this is a positive confirmation that a replacement actually landed.
const CORRECTED_MARKERS = [
  'sole decision-makers',
  'sole decisionmaker',
];

// A line that warns ABOUT the false phrasing rather than asserting it.
const BANNER_RE =
  /\bvoid\b|\bread before\b|any phrasing|absent from|corrected\s*[-—]?\s*read|do not reuse|is \*\*void\*\*|\bnever\b.*\brulings\b|\bnot\b.*\bmaking\b.*\brulings\b/i;

const flat = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const FALSE_FLAT = FALSE_PATTERNS.map(flat);
const CORRECTED_FLAT = CORRECTED_MARKERS.map(flat);

/** True when a line merely warns about the false phrasing. */
const isBanner = (line) => BANNER_RE.test(line);

/**
 * Classify one line of text.
 * @returns {'clean'|'banner'|'violation'}
 */
export function classifyLine(line) {
  if (isBanner(line)) return 'banner';
  const g = flat(line);
  return FALSE_FLAT.some((k) => g.includes(k)) ? 'violation' : 'clean';
}

/** Classify a whole document, reporting per-line detail. */
export function classifyText(text) {
  const violations = [];
  let banners = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    const kind = classifyLine(line);
    if (kind === 'banner') banners++;
    else if (kind === 'violation') violations.push({ line: i + 1, text: line.trim() });
  });
  const g = flat(text);
  const corrected = CORRECTED_FLAT.some((k) => g.includes(k));
  return { violations, banners, corrected };
}

// ---- PDF text extraction (Identity-H aware) -------------------------------
// A local copy rather than a dependency: the extractor resolves each font's
// ToUnicode CMap and tracks the current font across Tf operators. Kept here so
// the check works in a fresh clone with only Node.
import { inflateSync } from 'zlib';

export function pdfText(path) {
  const s = readFileSync(path).toString('latin1');
  const objs = new Map();
  for (const m of s.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) objs.set(+m[1], m[2]);
  const streamOf = (body) => {
    const m = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(body);
    if (!m) return null;
    try { return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { return m[1]; }
  };
  const hexToStr = (h) => {
    let out = '';
    for (let i = 0; i + 3 < h.length + 1; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4).padEnd(4, '0'), 16));
    return out;
  };
  // A CMap encodes a glyph range either as discrete entries (beginbfchar) or as
  // a start/end pair plus a base (beginbfrange). Parsing only bfchar decodes
  // almost nothing and yields a short, empty-looking text layer - which reads as
  // CLEAN. That is the worst possible failure for this check: an extractor bug
  // disguises itself as a passing result. Both forms must be handled.
  const parseCMap = (cmap) => {
    const map = new Map();
    for (const blk of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
        map.set(parseInt(m[1], 16), m[2] ? hexToStr(m[2]) : '');
      }
    }
    for (const blk of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
        const lo = parseInt(m[1], 16);
        const hi = parseInt(m[2], 16);
        if (hi < lo || hi - lo > 65535) continue;
        if (m[3].startsWith('<')) {
          const base = m[3].slice(1, -1);
          const startCode = parseInt(base, 16);
          const width = Math.max(base.length, 2);
          for (let c = lo; c <= hi; c++) {
            map.set(c, hexToStr((startCode + (c - lo)).toString(16).padStart(width, '0')));
          }
        } else {
          (m[3].match(/<[0-9A-Fa-f]*>/g) || []).forEach((it, i) => map.set(lo + i, hexToStr(it.slice(1, -1))));
        }
      }
    }
    return map;
  };
  const out = [];
  for (const [, body] of objs) {
    if (!/\/Type\s*\/Page\b/.test(body)) continue;
    const fonts = new Map();
    for (const fr of (body.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] || '').match(/\/F\d+\s+\d+\s+0\s+R/g) || []) {
      const fbody = objs.get(+fr.match(/(\d+)\s+0\s+R$/)[1]);
      const tu = fbody?.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      const cm = tu && objs.get(+tu[1]);
      const data = cm && streamOf(cm);
      if (data) fonts.set(fr.match(/\/(F\d+)/)[1], parseCMap(data));
    }
    let text = '';
    for (const cn of [...body.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)].map((m) => +m[1])) {
      const data = streamOf(objs.get(cn) || '');
      if (!data) continue;
      let cur = null;
      for (const m of data.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*(?:Tj|TJ)|(T\*|Td|TD|TL)/g)) {
        if (m[1]) { cur = fonts.get(m[1]) || null; continue; }
        if (m[3]) { text += ' '; continue; }
        if (m[2] && cur) for (let i = 0; i < m[2].length; i += 4) text += cur.get(parseInt(m[2].substr(i, 4), 16)) ?? '';
      }
    }
    if (text.trim()) out.push(text);
  }
  return out.join('\n');
}

function walk(dir, exts) {
  const acc = [];
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) acc.push(...walk(p, exts));
    else if (exts.includes(extname(e.name))) acc.push(p);
  }
  return acc;
}

function scan() {
  const report = { payloads: [], markdown: [], pdfs: [] };

  for (const f of walk(DEFAULT_PAYLOAD_DIR, ['.json'])) {
    let j;
    try { j = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const texts = [];
    const walkJson = (o) => {
      if (typeof o === 'string') { texts.push(o); return; }
      if (Array.isArray(o)) { o.forEach(walkJson); return; }
      if (o && typeof o === 'object') Object.values(o).forEach(walkJson);
    };
    walkJson(j);
    const v = texts.flatMap((t) => classifyText(t).violations.map((x) => x.text));
    if (v.length) report.payloads.push({ file: f, count: v.length, samples: v.slice(0, 2) });
  }

  for (const f of walk('reports', ['.md'])) {
    const r = classifyText(readFileSync(f, 'utf8'));
    if (r.violations.length) report.markdown.push({ file: f, count: r.violations.length, banners: r.banners, corrected: r.corrected, samples: r.violations.slice(0, 2).map((v) => v.text) });
  }

  for (const f of walk('output', ['.pdf'])) {
    let t;
    try { t = pdfText(f); } catch { continue; }
    const r = classifyText(t);
    if (r.violations.length) report.pdfs.push({ file: f, count: r.violations.length, corrected: r.corrected });
  }

  return report;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  if (!existsSync(DEFAULT_PAYLOAD_DIR) && !asJson && !args.includes('--scan')) {
    console.log(`Usage: node verify-replay-scope.mjs [--payloads <dir>] [--json]`);
    console.log('');
    console.log('Scans reports/*.md and output/*.pdf. Set the payload directory to also');
    console.log('check working payloads.');
    return 1;
  }
  const r = scan();
  const totals = {
    payloads: r.payloads.reduce((a, b) => a + b.count, 0),
    markdown: r.markdown.reduce((a, b) => a + b.count, 0),
    pdfs: r.pdfs.reduce((a, b) => a + b.count, 0),
  };
  const files = r.payloads.length + r.markdown.length + r.pdfs.length;

  if (asJson) {
    console.log(JSON.stringify({ totals, files, ...r }, null, 2));
  } else {
    console.log(`  payloads : ${r.payloads.length} file(s), ${totals.payloads} false line(s)`);
    console.log(`  reports  : ${r.markdown.length} file(s), ${totals.markdown} false line(s)`);
    console.log(`  PDFs     : ${r.pdfs.length} file(s), ${totals.pdfs} false line(s)`);
    console.log('');
    if (files) {
      console.log('  Bannered-but-still-wrong (the failure mode this check exists for):');
      for (const m of r.markdown.filter((x) => x.banners > 0).slice(0, 8)) {
        console.log(`    ! ${m.file}  ${m.count} live claim(s), ${m.banners} banner line(s)`);
      }
      if (r.markdown.filter((x) => x.banners > 0).length > 8) console.log(`    ... and ${r.markdown.filter((x) => x.banners > 0).length - 8} more`);
    } else {
      console.log('  Clean: no artifact asserts the false replay scope.');
    }
  }
  return files ? 1 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  process.exit(main());
}
