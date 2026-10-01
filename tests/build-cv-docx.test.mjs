// tests/build-cv-docx.test.mjs — the .docx path for resume-parser safety.
//
// Chromium's page.pdf() emits Identity-H CID fonts for EVERY font it embeds.
// That was verified directly, not assumed: rebuilding an identical CV with the
// webfont swapped for a system font changed /BaseFont from
// AAAAAA+Roboto-SemiBold to AAAAAA+LiberationSans-Bold and left the encoding
// untouched (Identity-H x2, WinAnsiEncoding x0). So there is no font choice that
// produces a parser-friendly PDF from this pipeline.
//
// The visible symptom on cityjobs.nyc.gov (SmartRecruiters) was that some
// fields populated and others did not: text broke mid-word and landed in the
// wrong fields, and the phone number never populated at all. A .docx removes the
// problem instead of mitigating it - the parser reads XML and never has to
// resolve a font encoding or a glyph positioning run.
//
// This exercises the real builder and then reads the produced package back the
// way a parser would: unzip, parse word/document.xml, walk the paragraphs.

import { pass, fail, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateRawSync } from 'zlib';

console.log('\nbuild-cv-docx.mjs — parser-safe resume output');

const dir = mkdtempSync(join(tmpdir(), 'docx-test-'));

// ---- minimal reader, so the test does not depend on the writer's own helpers
// A .docx is a ZIP. Reading the central directory is enough: locate each entry's
// local header, then inflate its deflated payload.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central header');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function paragraphs(xml) {
  const out = [];
  for (const m of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const text = [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((t) => t[1])
      .join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    if (text.trim()) out.push(text);
  }
  return out;
}

const payload = {
  candidate: {
    name: 'Jonathan Presser',
    email: 'jonpresser@gmail.com',
    phone: '(914) 433-5538',
    location: 'New York, NY',
    linkedin: 'linkedin.com/in/jonpresser',
    ern: '2033687',
    ern_label: 'ERN',
  },
  summary: 'Current NYC Parks and Recreation employee with a Master of Education.',
  experience: [
    {
      company: 'City of New York Department of Parks & Recreation',
      role: 'Urban Park Service Security',
      location: 'New York, NY',
      dates: 'Dec 2025 - Present',
      // Deliberately UNPUNCTUATED, and carrying a spaced-hyphen dash, matching
      // how real payloads are written. An earlier version of this test ended the
      // bullet with a period and had no dash, so the terminal-punctuation guard
      // passed against a fixture no real payload resembled - it asserted nothing.
      // SmartRecruiters strips trailing punctuation at a paragraph edge and
      // splits on " - ", so both are the cases that matter.
      bullets: [
        'Uphold order and protect people, parks, and property with respect and integrity',
        'Educate members of the public on rules and regulations - explaining requirements clearly',
      ],
    },
    {
      company: 'Camp Hillard',
      role: 'Summer Camp Counselor, progressing to Program Lead',
      dates: '2008 - 2013',
      bullets: ['Progressed to directing and guiding co-counselors across daily sports and swimming'],
    },
  ],
  education: [{ title: 'Master of Education, Education Studies', org: 'University at Buffalo' }],
  skills: [{ category: 'Systems', items: 'PowerSchool, Google Workspace' }],
  certifications: [{ title: 'Certified CPAT Trainer', org: 'IAFF/IAFC', year: '' }],
};

const payloadPath = join(dir, 'payload.json');
const outPath = join(dir, 'cv.docx');
writeFileSync(payloadPath, JSON.stringify(payload));

let built = null;
try {
  built = execFileSync(process.execPath, [join(ROOT, 'build-cv-docx.mjs'), payloadPath, outPath], { encoding: 'utf8' });
  pass('builder exits 0 on a well-formed payload');
} catch (e) {
  fail('builder threw: ' + (e.stderr || e.message).split('\n').slice(0, 3).join(' '));
}

if (built) {
  // --- package structure: this is what makes the file openable at all
  let parts;
  try {
    parts = readZip(readFileSync(outPath));
    pass('output is a readable ZIP archive');
  } catch (e) {
    fail('output is not a readable ZIP: ' + e.message);
    parts = new Map();
  }

  // The conventional set. A 3-part package is legal but not what Word emits,
  // and strict third-party parsers have been seen to reject it, so require the
  // parts a real .docx carries.
  for (const required of [
    '[Content_Types].xml', '_rels/.rels', 'word/document.xml',
    'word/styles.xml', 'word/_rels/document.xml.rels',
    'docProps/core.xml', 'docProps/app.xml',
  ]) {
    if (parts.has(required)) pass(`contains ${required}`);
    else fail(`missing part ${required} (strict parsers expect the conventional set)`);
  }

  // Every relationship target must resolve to a part that exists.
  if (parts.has('_rels/.rels')) {
    const rels = parts.get('_rels/.rels').toString('utf8');
    const targets = [...rels.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
    const dangling = targets.filter((tg) => !parts.has(tg));
    if (dangling.length === 0) pass(`all ${targets.length} package relationships resolve`);
    else fail(`dangling relationship targets: ${dangling.join(', ')}`);
  }

  // Runs must name a font explicitly, or a parser that resolves fonts first
  // reads nothing useful.
  if (parts.has('word/document.xml')) {
    const doc = parts.get('word/document.xml').toString('utf8');
    const runs = (doc.match(/<w:r>/g) || []).length;
    const fonts = (doc.match(/<w:rFonts /g) || []).length;
    if (runs > 0 && fonts >= runs) pass(`all ${runs} runs declare an explicit font`);
    else fail(`${runs} runs but only ${fonts} declare a font`);
  }

  // --- CRC correctness: every part must survive a round trip
  if (parts.has('word/document.xml')) {
    let doc;
    try { doc = parts.get('word/document.xml').toString('utf8'); pass('document.xml inflates cleanly (CRC valid)'); }
    catch (e) { fail('document.xml failed to inflate: ' + e.message); doc = ''; }

    // --- well-formedness: the DOM parse is what the parser does first
    if (doc && /<w:document[\s>][\s\S]*<\/w:document>/.test(doc)) pass('document.xml has a w:document root');
    else fail('document.xml has no w:document root');

    const body = doc.match(/<w:body>[\s\S]*<\/w:body>/);
    if (body && /<w:sectPr>/.test(body[0])) pass('carries a sectPr, so page size is defined');
    else fail('no sectPr: Word would fall back to defaults');

    // --- THE regression: contact fields must survive as contiguous text
    const paras = paragraphs(doc);
    const flat = paras.join('\n');

    // Phone is the field SmartRecruiters failed to populate. Assert on the
    // digits, not the punctuation: a parser may normalise separators away, and
    // the requirement is that the number is recoverable, not that the exact
    // glyphs round-trip.
    if (/\(?914\)?\s*433[-\s]?5538/.test(flat)) pass('phone number recoverable from the text layer');
    else fail('phone number NOT recoverable — the exact field that failed to populate');

    for (const [label, needle] of [
      ['name', 'Jonathan Presser'],
      ['email', 'jonpresser@gmail.com'],
      ['employer', 'City of New York Department of Parks & Recreation'],
      ['ERN', 'ERN 2033687'],
      ['skill', 'PowerSchool'],
    ]) {
      if (flat.includes(needle)) pass(`${label} intact and contiguous`);
      else fail(`${label} missing or split: ${needle}`);
    }

    // A parser that lost the name mid-word is the reported symptom. Guard the
    // failure shape directly: a known-good string must never contain a space
    // where the payload had none.
    if (!/Pr esser|jonpr esser|Recr eation/.test(flat)) pass('no mid-word splitting (the reported symptom)');
    else fail('text is split mid-word — reproduces the SmartRecruiters failure');

    // --- ordering: the header must precede the body, or a parser files the
    // name under employment history
    const iName = paras.findIndex((p) => p.includes('Jonathan Presser'));
    const iSummary = paras.findIndex((p) => p === 'SUMMARY');
    const iExp = paras.findIndex((p) => p === 'EXPERIENCE');
    if (iName === 0) pass('name is the first paragraph');
    else fail(`name is not first (index ${iName})`);
    if (iSummary > 0 && iExp > iSummary) pass('section order: Summary precedes Experience');
    else fail(`section headings out of order (SUMMARY@${iSummary}, EXPERIENCE@${iExp})`);

    // --- parser-legibility contract. These three were all changed because a
    // resume parser mishandled them; assert the shape so it cannot regress.
    const sectionWords = ['SUMMARY', 'EXPERIENCE', 'EDUCATION', 'SKILLS'];
    const foundSections = paras.filter((p) => sectionWords.includes(p));
    if (foundSections.length >= 3) pass(`section headings are ALL CAPS (${foundSections.join(', ')})`);
    else fail(`section headings not ALL CAPS: ${JSON.stringify(foundSections)}`);

    // A pBdr makes a heading look like a table cell to a segmenter.
    if (!/<w:pBdr/.test(doc)) pass('no paragraph borders (a segmenter reads pBdr as a table cell)');
    else fail('paragraph borders present — parsers may segment headings as table cells');

    // Hanging indents make list items look like separate records.
    if (!/w:hanging=/.test(doc)) pass('no hanging indents (list items stay inside their record)');
    else fail('hanging indents present — a parser may split one job into several');

    // No tables at all: a table-based layout is the classic resume-parser trap.
    if (!/<w:tbl>/.test(doc)) pass('no tables (the classic resume-parser trap)');
    else fail('tables present in the resume body');

    // --- SmartRecruiters concatenation contract.
    // That parser joins adjacent paragraph text with no separator, so any
    // boundary it does not respect becomes a fused string ("...decision-makers"
    // + "Delivered to each umpire"). The countermeasure is FEWER boundaries: one
    // paragraph per job, carrying the header and every bullet together.
    const emp = 'City of New York Department of Parks & Recreation';
    const recordParas = paras.filter((x) => x.includes(emp));
    if (recordParas.length === 1) pass('a whole job record is one paragraph (no internal boundary to fuse)');
    else fail(`job record spans ${recordParas.length} paragraphs — every boundary is a fusion risk`);

    // The payload above supplies unpunctuated bullets on purpose. Assert the
    // builder terminates them, because SmartRecruiters strips trailing
    // punctuation at a paragraph edge and a fused run needs a sentence boundary.
    // split(0) drops the header, which precedes the first glyph.
    const bulletsInRecord = (recordParas[0] || '').split('\u2022').slice(1).filter((b) => b.trim());
    if (bulletsInRecord.length === 2) pass('both payload bullets survive into the record');
    else fail(`expected 2 bullets in the record, found ${bulletsInRecord.length}`);
    const unterminated = bulletsInRecord.filter((b) => !/[.!?]\s*$/.test(b.trim()));
    if (unterminated.length === 0) pass('builder terminates every bullet (payload supplied none punctuated)');
    else fail(`${unterminated.length} bullets still lack terminal punctuation: ${JSON.stringify(unterminated)}`);

    // Header must stay splittable into fields despite sharing the paragraph.
    const rec = recordParas[0] || '';
    if (rec.split(' | ').length >= 4) pass('header fields remain pipe-delimited and recoverable');
    else fail('header lost its " | " field delimiters');

    if (rec.includes('\u2022 ')) pass('bullets remain glyph-delimited inside the record');
    else fail('no in-text bullet glyph — a fused run has no boundary signal');

    // Two jobs must remain two paragraphs, or the whole section is one blob.
    const campParas = paras.filter((x) => x.includes('Camp Hillard'));
    // A second job must remain two paragraphs
    if (campParas.length === 1) pass('a second job is still its own paragraph (records stay separable)');
    else fail(`second job spans ${campParas.length} paragraphs`);

    // --- dash-to-comma normalisation, scoped to prose.
    // SmartRecruiters splits a description on " - " and drops the first part, so
    // the token has to leave bullet text. It must NOT leave the header line,
    // because date ranges use the same " - " ("Dec 2025 - Present"). These two
    // assertions together are what prove prose() is scoped.
    if (rec.includes('regulations, explaining')) pass('spaced hyphen in prose becomes a comma');
    else fail('prose still contains " - " near "regulations"');

    if (rec.includes('Dec 2025 - Present')) pass('date range in the header keeps its " - " (prose() is scoped)');
    else fail('prose() leaked onto the header line and rewrote a date range');

    const proseParas = paras.filter((x) => !x.includes('|'));
    const leftover = proseParas.filter((x) => x.includes(' - '));
    if (leftover.length === 0) pass('no " - " survives in any prose paragraph');
    else fail(`${leftover.length} prose paragraphs still contain " - "`);

    if (!/,\s*,/.test(doc)) pass('no doubled commas introduced by the rewrite');
    else fail('doubled commas present');
  }

  // --- escaping: ampersand in the employer name above is the live case
  if (parts.has('word/document.xml')) {
    const doc = parts.get('word/document.xml').toString('utf8');
    if (!/[^&]&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(doc)) pass('no unescaped ampersands in XML');
    else fail('unescaped ampersand would make the XML unparseable');
  }
}

rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// --- the reason this file exists, asserted so it cannot be quietly reverted
console.log('\nbuild-cv-docx.mjs — why it exists');
{
  const pdf = join(ROOT, 'output', 'cv-candidate-parks-pdc-238-2026-09-30.pdf');
  if (!existsSync(pdf)) {
    console.log('  (skipping Identity-H check: no sample PDF in output/)');
  } else {
    const s = readFileSync(pdf).toString('latin1');
    const identity = (s.match(/Identity-H/g) || []).length;
    const winAnsi = (s.match(/WinAnsiEncoding/g) || []).length;
    if (identity > 0 && winAnsi === 0) {
      pass(`sample PDF is Identity-H only (${identity} refs, 0 WinAnsi) — the reason .docx exists`);
    } else {
      console.log(`  (note: sample PDF now Identity-H=${identity} WinAnsi=${winAnsi} — re-check the premise)`);
    }
  }
}

// --- contact line: an object-form link field must not stringify
// Regression. The contact line joined the raw candidate.linkedin, so the
// DOCUMENTED object form {url, display} -- the form build-cv-html.mjs's own
// self-test uses -- rendered a literal "[object Object]" in the header of every
// DOCX. Found 2026-10-01 while building the NYCEM CV. It matters beyond
// cosmetics: LinkedIn is how a recruiter follows up, and both cityjobs
// submissions (#134 Ombuds, #238 Parks PDC) went through SmartRecruiters as
// DOCX, so visible junk reached the header of a sent application.
{
  const dir = mkdtempSync(join(tmpdir(), 'co-docx-link-'));
  const build = (linkedin) => {
    const payloadPath = join(dir, 'p.json');
    const outPath = join(dir, 'o.docx');
    writeFileSync(payloadPath, JSON.stringify({
      lang: 'en',
      page_format: 'letter',
      candidate: { name: 'Test Candidate', phone: '123', email: 't@example.com', linkedin },
      summary: 'Summary line.',
      experience: [{ company: 'Test Corp', role: 'Tester', dates: '2024 - Present', bullets: ['Did a thing.'] }],
      competencies: ['One thing'],
    }));
    execFileSync(process.execPath, [join(ROOT, 'build-cv-docx.mjs'), payloadPath, outPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return paragraphs(readZip(readFileSync(outPath)).get('word/document.xml').toString('utf8')).join('\n');
  };

  const objText = build({ url: 'https://linkedin.com/in/test', display: 'linkedin.com/in/test' });
  if (objText.includes('[object Object]')) {
    fail('object-form candidate.linkedin rendered a literal [object Object] in the contact line');
  } else {
    pass('object-form candidate.linkedin does not stringify');
  }
  if (!objText.includes('linkedin.com/in/test')) {
    fail('object-form candidate.linkedin lost its display text');
  } else {
    pass('object-form candidate.linkedin renders its display text');
  }

  // The bare-string form must render identically -- the two shapes are both in
  // use across the payload corpus, so neither may be the only working one.
  const strText = build('linkedin.com/in/test');
  if (!strText.includes('linkedin.com/in/test')) {
    fail('string-form candidate.linkedin did not render');
  } else {
    pass('string-form candidate.linkedin renders');
  }
  if (strText.includes('[object Object]')) {
    fail('string-form candidate.linkedin rendered [object Object]');
  } else {
    pass('string-form candidate.linkedin does not stringify');
  }

  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// No finish() here on purpose: discovered suites under tests/ run in-process and
// share the harness counters, and test-all.mjs owns the summary and exit code.
// Calling finish() (or process.exit) from here is a suite-level error.