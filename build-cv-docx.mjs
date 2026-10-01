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

const p = (text, opts = {}) => {
  const { bold = false, size = null, after = 60, before = 0 } = opts;
  const rPr = [bold ? '<w:b/>' : '', size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''].join('');
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:pPr>` +
    `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
};
// Heading with a rule under it, mirroring the CV's section bars.
const heading = (text) =>
  `<w:p><w:pPr><w:spacing w:before="200" w:after="70"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="9AA0A6"/></w:pBdr><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:pPr>` +
  `<w:r><w:rPr><w:b/><w:sz w:val="20"/></w:rPr><w:t>${esc(text)}</w:t></w:r></w:p>`;
const bullet = (lead, rest) =>
  `<w:p><w:pPr><w:ind w:left="288" w:hanging="144"/><w:spacing w:after="40"/></w:pPr>` +
  `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(lead)}, </w:t></w:r>` +
  `<w:r><w:t xml:space="preserve">${esc(rest)}</w:t></w:r></w:p>`;

// ---------- payload -> document.xml ----------
function document(payload) {
  const c = payload.candidate || {};
  const contact = [c.location, c.phone, c.email, c.linkedin].filter(Boolean).join(' | ');
  const x = [];
  x.push(p(c.name || '', { bold: true, size: 34, after: 40 }));
  if (contact) x.push(p(contact, { size: 18, after: 30 }));
  if (c.ern) x.push(p(`ERN ${c.ern}`, { size: 18, after: 30 }));
  if (payload.summary) { x.push(heading('Summary')); x.push(p(payload.summary)); }

  if (Array.isArray(payload.experience) && payload.experience.length) {
    x.push(heading('Experience'));
    for (const e of payload.experience) {
      const meta = [e.role, e.location, e.dates].filter(Boolean).join(' | ');
      x.push(p(e.company || '', { bold: true, before: 100, after: 10 }));
      if (meta) x.push(p(meta, { size: 18, after: 40 }));
      for (const bl of e.bullets || []) x.push(bullet('', bl).replace('<w:t xml:space="preserve">, </w:t>', '<w:t xml:space="preserve"></w:t>'));
    }
  }
  if (Array.isArray(payload.education) && payload.education.length) {
    x.push(heading('Education'));
    for (const ed of payload.education) {
      x.push(p(ed.title || '', { bold: true, before: 60, after: 10 }));
      x.push(p([ed.org, ed.year].filter(Boolean).join(' | '), { size: 18, after: 40 }));
    }
  }
  if (Array.isArray(payload.skills) && payload.skills.length) {
    x.push(heading('Skills'));
    for (const s of payload.skills) {
      x.push(s.category
        ? `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(s.category)}: </w:t></w:r><w:r><w:t xml:space="preserve">${esc(s.items)}</w:t></w:r></w:p>`
        : p(s.items));
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

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

// ---------- CLI ----------
const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('Usage: node build-cv-docx.mjs <payload.json> <out.docx>');
  process.exit(1);
}
const payload = JSON.parse(readFileSync(inPath, 'utf8'));
const buf = zip([
  ['[Content_Types].xml', CONTENT_TYPES],
  ['_rels/.rels', RELS],
  ['word/document.xml', document(payload)],
]);
writeFileSync(outPath, buf);
console.log(`docx written: ${outPath} (${Math.round(buf.length / 1024)} KB)`);