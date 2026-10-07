#!/usr/bin/env node
// build-cv-docx.mjs - render a CV payload to .docx with no dependencies.
//
// Why: Chromium's page.pdf() emits Identity-H CID fonts for EVERY font it
// embeds (verified: swapping Roboto for LiberationSans left Identity-H intact).
// Identity-H text layers are legal PDF but break several resume parsers - the
// SmartRecruiters parser behind cityjobs.nyc.gov drops the phone number and
// strands text in the wrong fields. A .docx carries plain XML instead, so the
// parser never has to resolve a font encoding at all.
//
// A .docx is a ZIP of XML parts, and zlib gives us raw deflate, so this needs
// no packages. Written to be readable: the ZIP layer is the fiddly part and is
// isolated below the document builder.
import { readFileSync, writeFileSync } from 'fs';
import { deflateRawSync } from 'zlib';
import { normalizeCandidateLink } from './lib/candidate-link.mjs';

// ---------- CRC32 (ZIP local/central headers) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- minimal ZIP writer ----------
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x2821, 12);     // mod date (2020-01-01, fixed: reproducible)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra len
    cd.writeUInt16LE(0, 32);             // comment len
    cd.writeUInt16LE(0, 34);             // disk number
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------- OOXML helpers ----------
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Every run names its font explicitly. A parser that cannot resolve an implicit
// font falls back to reading nothing useful, and several commercial resume
// parsers look for rFonts before they look at anything else.
const FONT = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>';
const rPrFor = (opts) => {
  const { bold = false, size = null } = opts;
  const bits = [FONT, bold ? '<w:b/>' : '', size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''];
  return bits.join('');
};

const p = (text, opts = {}) => {
  const { bold = false, size = null, after = 60, before = 0, asProse = false } = opts;
  const out = asProse ? prose(text) : text;
  const rPr = rPrFor(opts);
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:pPr>` +
    `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(out)}</w:t></w:r></w:p>`;
};
// Heading as an ALL-CAPS line on its own paragraph, with no border and no
// hanging indent anywhere in the document. Those are the two constructs
// third-party resume parsers most often mishandle: a pBdr makes the heading look
// like a table cell to a segmenter, and a hanging indent makes list items look
// like their own records. Plain one-line-per-field is the most legible shape a
// parser can be handed.
const heading = (text) => {
  const rPr = rPrFor({ bold: true, size: 20 });
  return `<w:p><w:pPr><w:spacing w:before="200" w:after="60"/><w:rPr>${rPr}</w:rPr></w:pPr>` +
    `<w:r><w:rPr>${rPr}</w:rPr><w:t>${esc(String(text).toUpperCase())}</w:t></w:r></w:p>`;
};
// One job = ONE paragraph.
//
// Observed against SmartRecruiters (cityjobs.nyc.gov, oneclick-ui) on
// 2026-09-30: it concatenates adjacent <w:p> text with no separator, so every
// paragraph boundary inside a job became a fused string - "…sole decision-
// makers" + "Delivered to each umpire" arrived as "…decision-makersDelivered",
// and one job's last bullet ran straight into the next job's company name.
// Nothing in the extracted text stream marks a paragraph break.
//
// So the fix is not a better delimiter, it is FEWER boundaries: put the header
// and every bullet in a single paragraph. Fields stay pipe-delimited and bullets
// stay glyph-separated, so a splitter still recovers them, but there is no
// internal paragraph boundary left to fuse. One boundary per job remains
// (between jobs) and it lands after a full stop, so a fused run still reads as
// complete sentences.
const BULLET = '\u2022 ';

// Terminal punctuation, applied here rather than trusted to the payload.
// SmartRecruiters strips trailing punctuation at a paragraph edge (a bullet
// ending "…classroom," arrived as "…classroomadapted"), so a fused run has no
// sentence boundary to fall back on. 12 of 12 bullets in the Ombuds payload
// shipped without one, which is why the earlier delimiter-only attempt did not
// help. Doing it in the builder means it cannot be forgotten per payload again.
const terminate = (s) => {
  const t = String(s ?? '').trim();
  return /[.!?]$/.test(t) ? t : t + '.';
};

// Prose only: turn the spaced hyphen used as a dash into a comma.
//
// SmartRecruiters splits a description on " - " and discards the first part, so
// "…throughout each session - managing inquiries…" arrived in the form with
// everything before the hyphen gone. Replacing the dash removes the token it
// splits on.
//
// Scoped deliberately. Date ranges use the same " - " ("Dec 2025 - Present"),
// and the experience header line carries those, so this must never run on a
// field that can hold a date. Callers below pass only free prose.
// Unwrap a bullet to its text before any string work. The payload contract
// carries every bullet as {text, source_anchor} so each line stays traceable to
// cv.md, and the HTML builder unwraps it (4c19657e added object-form bullets
// there). This builder did not, so `String(s)` produced "[object Object]" for
// EVERY bullet in the document - a DOCX that rendered with the right number of
// records and paragraphs and contained no readable prose at all. Unwrap once,
// here, so every caller is covered: experience bullets and project bullets both
// pass through prose().
// The array guard matters: skills entries pass an ARRAY of items to prose(), and
// a bare `typeof x === 'object'` test matched arrays too, so every skill
// category rendered its label followed by nothing.
const unwrap = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? (b.text ?? '') : b);

const prose = (s) => String(unwrap(s) ?? '')
  .replace(/\s+-\s+/g, ', ')          // the split token, gone
  .replace(/,\s*,+/g, ', ')            // no doubled commas if one was already there
  .replace(/\s+,/g, ',')
  .replace(/,\s*\./g, '.');            // "detail." not "detail,."

const bullet = (lead, rest) => {
  const leadRPr = rPrFor({ bold: true });
  return `<w:p><w:pPr><w:spacing w:after="40"/><w:rPr>${rPrFor({})}</w:rPr></w:pPr>` +
    `<w:r><w:rPr>${rPrFor({})}</w:rPr><w:t xml:space="preserve">${BULLET}</w:t></w:r>` +
    (lead ? `<w:r><w:rPr>${leadRPr}</w:rPr><w:t xml:space="preserve">${esc(prose(lead))}, </w:t></w:r>` : '') +
    `<w:r><w:rPr>${rPrFor({})}</w:rPr><w:t xml:space="preserve">${esc(prose(rest))}</w:t></w:r></w:p>`;
};

// ---------- payload -> document.xml ----------
function document(payload) {
  const c = payload.candidate || {};
  // Link fields may be an object ({url, display}) or a bare string. Joining the
  // raw value put a literal "[object Object]" in the contact line of every DOCX
  // built from an object-form payload -- which is the documented form, so this
  // was the common case, not an edge case. Same accept-both-shapes rule as
  // build-cv-html.mjs's normalizeLink().
  const link = normalizeCandidateLink(c.linkedin);
  const contact = [c.location, c.phone, c.email, link && link.display].filter(Boolean).join(' | ');
  const x = [];
  x.push(p(c.name || '', { bold: true, size: 34, after: 40 }));
  if (contact) x.push(p(contact, { size: 18, after: 30 }));
  if (c.ern) x.push(p(`ERN ${c.ern}`, { size: 18, after: 30 }));
// The payload contract carries the summary as {text, source_anchor} so it can
  // be cited to cv.md like every other line. Passing the object straight to p()
  // rendered the literal "[object Object]" under a Summary heading - a DOCX that
  // looked complete and read as broken. Accept both shapes: the HTML builder
  // already unwraps {text}, so this only removes a divergence between them.
  if (payload.summary) {
    const summaryText = typeof payload.summary === 'string'
      ? payload.summary
      : (payload.summary.text || '');
    if (summaryText) { x.push(heading('Summary')); x.push(p(summaryText, { asProse: true })); }
  }

  if (Array.isArray(payload.experience) && payload.experience.length) {
    x.push(heading('Experience'));
    for (const e of payload.experience) {
      // One paragraph for the whole record: header fields, then every bullet.
      // `period` first: it is the key the payload contract and the HTML builder
      // both use. Reading only `e.dates` meant every record rendered with an
      // employer and a role and NO DATES - the one field a CV cannot omit.
      const head = [e.company, e.role, e.location, e.period || e.dates].filter(Boolean).join(' | ');
      // prose() here, not in bullet(): this refactor inlines the bullets into the
      // record string, so bullet() is never called and prose() inside it would
      // never run. Dates stay untouched because head is built separately.
      const items = (e.bullets || []).map((bl) => BULLET + terminate(prose(bl)));
      x.push(p(items.length ? `${head} ${items.join(' ')}` : head, { bold: false, before: 100, after: 40 }));
    }
  }
  // Projects were absent entirely, so a payload carrying the curriculum-design
  // portfolio produced a DOCX with neither the portfolio link nor its
  // answer-keyed assessment bullet. Same entry shape the HTML builder reads
  // (name / badge / url / bullets), rendered in this file's own idioms.
  if (Array.isArray(payload.projects) && payload.projects.length) {
    x.push(heading('Projects'));
    for (const pr of payload.projects) {
      const label = [pr.name, pr.badge].filter(Boolean).join(' | ');
      x.push(p(label, { bold: true, before: 60, after: 10 }));
      if (pr.url) x.push(p(pr.url, { size: 18, after: 20 }));
      const items = (pr.bullets || []).map((bl) => BULLET + terminate(prose(bl)));
if (items.length) x.push(p(items.join(' '), { after: 40 }));
    }
  }

  if (Array.isArray(payload.education) && payload.education.length) {
    x.push(heading('Education'));
    for (const ed of payload.education) {
      x.push(p(ed.title || '', { bold: true, before: 60, after: 10 }));
      const meta = [ed.org, ed.year].filter(Boolean);
      if (meta.length) x.push(p(meta.join(' | '), { size: 18, after: 40 }));
    }
  }
  if (Array.isArray(payload.skills) && payload.skills.length) {
    x.push(heading('Skills'));
    for (const s of payload.skills) {
      x.push(s.category
        ? `<w:p><w:pPr><w:spacing w:after="40"/><w:rPr>${rPrFor({})}</w:rPr></w:pPr><w:r><w:rPr>${rPrFor({ bold: true })}</w:rPr><w:t xml:space="preserve">${esc(s.category)}: </w:t></w:r><w:r><w:rPr>${rPrFor({})}</w:rPr><w:t xml:space="preserve">${esc(prose(s.items))}</w:t></w:r></w:p>`
        : p(s.items, { asProse: true }));
    }
  }
  if (Array.isArray(payload.certifications) && payload.certifications.length) {
    x.push(heading('Certifications'));
    for (const ct of payload.certifications) {
      x.push(p([ct.title, ct.org, ct.year].filter(Boolean).join(' | '), { after: 30 }));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${x.join('')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

// ---------- package parts ----------
// A bare [Content_Types].xml + _rels + document.xml is the smallest legal
// package, but it is not what Word produces, and strict third-party parsers
// have been observed to choke on it. Ship the conventional part set so the file
// looks like every other .docx a parser has ever seen.
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;

const CORE = (name) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(name)} - CV</dc:title><dc:creator>${esc(name)}</dc:creator><cp:lastModifiedBy>${esc(name)}</cp:lastModifiedBy></cp:coreProperties>`;

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>career-ops build-cv-docx</Application></Properties>`;

// ---------- CLI ----------
const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('Usage: node build-cv-docx.mjs <payload.json> <out.docx>');
  process.exit(1);
}
const payload = JSON.parse(readFileSync(inPath, 'utf8'));
const who = payload.candidate?.name || 'Candidate';
const buf = zip([
  ['[Content_Types].xml', CONTENT_TYPES],
  ['_rels/.rels', RELS],
  ['docProps/core.xml', CORE(who)],
  ['docProps/app.xml', APP],
  ['word/document.xml', document(payload)],
  ['word/_rels/document.xml.rels', DOC_RELS],
  ['word/styles.xml', STYLES],
]);
writeFileSync(outPath, buf);
console.log(`docx written: ${outPath} (${Math.round(buf.length / 1024)} KB, ${buf.readUInt16LE(buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])) + 10)} parts)`);