// build-cv-latex.mjs silently rendered every object-form bullet as an EMPTY
// \resumeItem{}. Found 2026-10-07 verifying the LaTeX builder while building the
// JR178 package.
//
// This is the LaTeX twin of the DOCX bug pinned down in
// tests/build-cv-docx-object-bullets.test.mjs, and it fails the same way the
// LaTeX way is worse: the DOCX at least printed the literal "[object Object]",
// which is ugly but visible. escapeLatex() over a plain object yields no
// characters at all, so each bullet became \resumeItem{} — the .tex still
// compiled, still listed the right employers, roles and dates, and contained no
// prose whatsoever, with nothing in the output to say so.
//
// That combination is what makes it dangerous rather than merely broken. The
// payload contract REQUIRES object bullets: verify-bullet-sources.mjs reports a
// bare string bullet as UNSOURCED, so a selection-only, traceable CV cannot be
// expressed with strings. An agent that built a properly traceable payload and
// ran the `latex` mode would get a CV with zero bullets and a clean-looking
// artifact, and the only signal would be the missing content itself.
//
// The other LaTeX divergences found alongside this one are NOT covered here,
// because they are documented design rather than defects: modes/latex.md
// specifies its own payload shape (top-level name/contact_line, education as
// institution/degree, experience as dates), and build-cv-latex.mjs reports those
// loudly — valid:false and a per-entry "unrecognised key period" warning — rather
// than dropping them silently. This suite pins the one case that was silent.
//
// Run:  node --test tests/build-cv-latex-object-bullets.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILDER = join(ROOT, 'build-cv-latex.mjs');

// LaTeX-schema payload (modes/latex.md), carrying bullets in the object form
// verify-bullet-sources.mjs demands. A string bullet is included as a control:
// it already worked, so if it ever breaks the suite will say so.
const PAYLOAD = {
  name: 'Jonathan Presser',
  contact_line: 'New York, NY | (914) 433-5538',
  email: { url: 'jonpresser@gmail.com', display: 'jonpresser@gmail.com' },
  experience: [
    {
      company: 'Newark Public Schools',
      role: 'Mathematics Teacher',
      location: 'Newark, NJ',
      dates: 'Aug 2022 - Jun 2023',
      bullets: [
        { text: 'OBJECT BULLET ONE', source_anchor: 'OBJECT BULLET ONE' },
        { text: 'OBJECT BULLET TWO', source_anchor: 'OBJECT BULLET TWO' },
      ],
    },
    {
      company: 'Major League Baseball',
      role: 'Replay Operator',
      location: 'New York, NY',
      dates: 'Mar 2016 - Nov 2022',
      bullets: ['STRING BULLET CONTROL'],
    },
  ],
  projects: [
    {
      name: 'Volume of Prisms',
      url: 'bit.ly/JPresserPortfolio',
      bullets: [{ text: 'PROJECT OBJECT BULLET', source_anchor: 'PROJECT OBJECT BULLET' }],
    },
  ],
  education: [
    { institution: 'University at Buffalo', degree: 'Master of Education, Education Studies' },
  ],
  skills: [{ category: 'Spreadsheets & Data', items: ['Microsoft Excel and Google Sheets'] }],
};

describe('build-cv-latex.mjs object bullets', () => {
  let dir;
  let tex;
  let src;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cv-latex-'));
    const payloadPath = join(dir, 'payload.json');
    const texPath = join(dir, 'out.tex');
    writeFileSync(payloadPath, JSON.stringify(PAYLOAD, null, 2), 'utf8');
    execFileSync(process.execPath, [BUILDER, payloadPath, texPath], { cwd: ROOT });
    tex = readFileSync(texPath, 'utf8');
    src = readFileSync(BUILDER, 'utf8');
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the payload as valid', () => {
    // If this regresses to valid:false the suite fails here first, which is the
    // loud failure mode; the empty-bullet bug was the quiet one.
    assert.ok(!tex.includes('\\resumeItem{}'), 'no bullet may render empty');
  });

  it('renders object-form experience bullets with their text', () => {
    assert.match(tex, /\\resumeItem\{OBJECT BULLET ONE\}/);
    assert.match(tex, /\\resumeItem\{OBJECT BULLET TWO\}/);
  });

  it('renders object-form project bullets with their text', () => {
    assert.match(tex, /\\resumeItem\{PROJECT OBJECT BULLET\}/);
  });

  it('still renders plain string bullets', () => {
    assert.match(tex, /\\resumeItem\{STRING BULLET CONTROL\}/);
  });

  it('emits no empty \\resumeItem at all', () => {
    const empties = tex.match(/\\resumeItem\{\s*\}/g) || [];
    assert.deepEqual(empties, [], `found ${empties.length} empty resume items`);
  });

  it('escapes LaTeX metacharacters in bullet text', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'cv-latex-esc-'));
    try {
      const p = join(dir2, 'p.json');
      const t = join(dir2, 'o.tex');
      const payload = {
        name: 'X',
        experience: [{
          company: 'C',
          role: 'R',
          location: 'L',
          dates: 'D',
          bullets: [{ text: '100% & $5 #1 _x_ ~tilde^', source_anchor: 'x' }],
        }],
      };
      writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
      execFileSync(process.execPath, [BUILDER, p, t], { cwd: ROOT });
      const out = readFileSync(t, 'utf8');
      assert.match(out, /\\%/);
      assert.match(out, /\\&/);
      assert.match(out, /\$5/);
      // A raw unescaped & or # would break the LaTeX compile.
      assert.ok(!/\\resumeItem\{[^}]*[^\\]%/.test(out), '% must be escaped');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('keeps the bullet-unwrapping guard in the source', () => {
    // A future edit that reintroduces `typeof b === 'object'` without the
    // array guard would break skills items, which are arrays.
    assert.match(src, /Array\.isArray\(b\)/);
  });

  it('passes its own --test suite', () => {
    execFileSync(process.execPath, [BUILDER, '--test'], { cwd: ROOT });
  });
});