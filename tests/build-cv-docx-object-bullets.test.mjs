// build-cv-docx.mjs silently produced a structurally valid DOCX containing no
// readable content. Found 2026-10-07 generating the JR4215 application package:
// every bullet rendered as the literal "[object Object]", the Summary rendered as
// "[object Object]", every experience record rendered with an employer and a role
// but NO DATES, and the projects section did not exist at all - so the portfolio
// link and the answer-keyed assessment bullet were absent from the document.
//
// The DOCX was 3.7KB and 7 parts: it looked fine and read as broken. Nothing
// failed loudly, because the builder was doing exactly what it was written to do
// with the shape it expected - the payload contract had moved on and the builder
// had not.
//
// Note the array guard in unwrap(): a first attempt used `typeof x === 'object'`
// alone, which also matched the ARRAY that skills entries pass to prose(), so
// every skill category rendered its label followed by nothing. That regression
// was caught only because this suite asserts on extracted document.xml.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BULLETS = [
  {
    company: 'City of New York Department of Parks & Recreation',
    role: 'Urban Park Service Security',
    location: 'New York, NY',
    period: 'Dec 2025 - Present',
    bullets: [
      { text: 'Educate members of the public on parks and playgrounds rules and regulations', source_anchor: 'x' },
      { text: 'Respond to a wide range of quality of life conditions with professionalism and care', source_anchor: 'x' },
    ],
  },
  {
    company: 'Newark Public Schools',
    role: 'Data Science Teacher',
    location: 'Newark, NJ',
    period: 'Aug 2021 - Jun 2022',
    bullets: [
      { text: 'Employed data-driven methodologies to monitor student progress, creating comprehensive formative and summative assessments to enhance learning outcomes', source_anchor: 'x' },
    ],
  },
];

let visible = '';

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'docx-test-'));
  const payload = {
    candidate: { name: 'Test Person', email: 't@example.com', phone: '555-0100', location: 'New York, NY' },
    // Object form, as the payload contract carries it for traceability.
    summary: { text: 'A summary sentence that must reach the document.', source_anchor: 'y' },
    experience: BULLETS,
    projects: [
      {
        name: 'Volume of Prisms | Curriculum Design Portfolio',
        url: 'bit.ly/JPresserPortfolio',
        badge: 'CCSS 5.MD.C',
        bullets: [
          { text: 'Authored the full instructional package: lesson launch problems, slideshow materials, practice worksheets, and exit-ticket assessments with answer keys', source_anchor: 'z' },
        ],
      },
    ],
    skills: [
      { category: 'Spreadsheets & Data', items: ['Microsoft Excel and Google Sheets, VLOOKUP/XLOOKUP'] },
      { category: 'EdTech', items: ['PowerSchool', 'Schoology'] },
    ],
  };
  const pj = join(dir, 'payload.json');
  const dx = join(dir, 'out.docx');
  writeFileSync(pj, JSON.stringify(payload), 'utf8');
  execFileSync('node', ['build-cv-docx.mjs', pj, dx], { encoding: 'utf8' });

  // A DOCX is a ZIP: its text is deflated, so a raw byte scan finds nothing.
  // Unpack word/document.xml, which is what an ATS actually reads.
  const xml = join(dir, 'document.xml');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${dx.replace(/\//g, '\\')}'); ` +
    `$e=$z.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }; ` +
    `$sr=New-Object System.IO.StreamReader($e.Open()); $sr.ReadToEnd() | Set-Content -NoNewline '${xml.replace(/\//g, '\\')}'; $z.Dispose()`],
  );
  visible = readFileSync(xml, 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
});

describe('build-cv-docx: object-form bullets', () => {
  it('renders bullet text, never [object Object]', () => {
    assert.ok(!visible.includes('[object Object]'), `document contains [object Object]: ${visible.slice(0, 200)}`);
    assert.match(visible, /Educate members of the public/);
    assert.match(visible, /Employed data-driven methodologies/);
  });

  it('renders the summary text from its {text, source_anchor} form', () => {
    assert.match(visible, /A summary sentence that must reach the document\./);
  });
});

describe('build-cv-docx: dates', () => {
  it('renders the period on every experience record', () => {
    assert.match(visible, /Dec 2025 - Present/);
    assert.match(visible, /Aug 2021 - Jun 2022/);
  });
});

describe('build-cv-docx: projects', () => {
  it('renders a Projects section that was previously absent entirely', () => {
    assert.match(visible, /PROJECTS/i);
    assert.match(visible, /Volume of Prisms/);
    assert.match(visible, /bit\.ly\/JPresserPortfolio/);
    assert.match(visible, /answer keys/i);
  });
});

describe('build-cv-docx: skill arrays survive the bullet unwrap', () => {
  it('renders the items of every skill category', () => {
    // Regression: `typeof x === 'object'` also matches the array a skill entry
    // passes to prose(), so each category rendered its label and nothing else.
    assert.match(visible, /VLOOKUP\/XLOOKUP/);
    assert.match(visible, /PowerSchool/);
    assert.match(visible, /Schoology/);
  });
});
