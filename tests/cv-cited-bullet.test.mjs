import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A CITED bullet must render in every builder.
//
// A bullet may be a plain string or an object carrying a citation
// (`source_anchor` / `source_line` / `source_text`). That object form is the
// shape verify-bullet-sources.mjs reads, and the shape the AGENTS.md's
// Document Construction Rules require ("A CV bullet carries a source_anchor...
// A bare string with no citation is unsourced and fails the build").
//
// MEASURED 2026-10-20: build-cv-html.mjs escaped bullets with a guard that
// blanks any object, so an object bullet rendered as an EMPTY <li> - the text
// vanished and the citation was the only way to see it had been there. The
// DOCX builder already unwrapped; the HTML, LaTeX and ATS-text builders did
// not, and the ATS text export went further and DROPPED object bullets
// outright, so the exported CV was shorter than the one the applicant read.
//
// These tests build through the shipped builders rather than asserting on
// source text, so they fail if any builder regresses.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'templates', 'cv-template.html');

const base = {
  lang: 'en',
  page_format: 'letter',
  candidate: {
    name: 'Test Person',
    email: 'a@b.co',
    phone: '(914) 433-5538',
    linkedin: { url: 'https://linkedin.com/in/testperson', display: 'linkedin.com/in/testperson' },
    location: 'New York, NY',
  },
  sections: { summary: 'Professional Summary', competencies: 'Core Competencies', experience: 'Work Experience' },
  summary: 'A summary string for the builder shape check.',
  competencies: ['One'],
  experience: [
    {
      company: 'City of New York Department of Parks & Recreation',
      role: 'Urban Park Service Security',
      location: 'New York, NY',
      dates: 'Dec 2025 - Present',
      bullets: [
        { text: 'A cited bullet, rendered from its text field.', source_anchor: ['a phrase from cv.md'] },
        'A bare string bullet, rendered as before.',
      ],
    },
  ],
};

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-cited-bullet-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the HTML builder renders a cited bullet in the EXPERIENCE path', () => {
  withTempDir((dir) => {
    const pj = join(dir, 'payload.json');
    const out = join(dir, 'out.html');
    writeFileSync(pj, JSON.stringify(base));
    execFileSync('node', [join(ROOT, 'build-cv-html.mjs'), pj, out, TEMPLATE], { cwd: ROOT, stdio: 'pipe' });
    const html = readFileSync(out, 'utf8');
    assert.ok(html.includes('A cited bullet, rendered from its text field.'), 'the cited bullet was dropped from the HTML');
    assert.ok(html.includes('A bare string bullet, rendered as before.'), 'the bare string bullet was dropped');
    // The empty <li> the old guard produced: an <li> with no text at all.
    assert.ok(!/<li>\s*<\/li>/.test(html), 'an empty <li> rendered - a cited bullet lost its text');
    // The citation must NOT leak into the rendered CV.
    assert.ok(!html.includes('source_anchor'), 'the citation field leaked into the document');
  });
});

test('the LaTeX builder renders a cited bullet', () => {
  withTempDir((dir) => {
    const pj = join(dir, 'payload.json');
    const out = join(dir, 'out.tex');
    writeFileSync(pj, JSON.stringify(base));
    execFileSync('node', [join(ROOT, 'build-cv-latex.mjs'), pj, out], { cwd: ROOT, stdio: 'pipe' });
    const tex = readFileSync(out, 'utf8');
    assert.ok(tex.includes('A cited bullet, rendered from its text field.'), 'the cited bullet was dropped from the LaTeX');
    assert.ok(!tex.includes('source_anchor'), 'the citation field leaked into the LaTeX');
  });
});

test('the ATS text export keeps a cited bullet instead of dropping it', () => {
  withTempDir((dir) => {
    // The ATS exporter takes its experience from the profile's own
    // `experience:` key when there is one, so that is where a cited bullet can
    // reach it.
    const pj = join(dir, 'profile.yml');
    const out = join(dir, 'out.txt');
    writeFileSync(pj, [
      'candidate:',
      '  full_name: Test Person',
      '  email: a@b.co',
      "  phone: '(914) 433-5538'",
      '  location: New York, NY',
      '  linkedin: linkedin.com/in/testperson',
      'experience:',
      '  - company: Test Company',
      '    role: Test Role',
      '    bullets:',
      '      - text: A cited bullet in the ATS export.',
      '        source_anchor:',
      '          - a phrase from cv.md',
      '      - A bare string bullet in the ATS export.',
      '',
    ].join('\n'));
    execFileSync('node', [join(ROOT, 'scripts', 'export-ats-text.mjs'), '--profile', pj, '--section', 'experience', '--out', out], { cwd: ROOT, stdio: 'pipe' });
    const text = readFileSync(out, 'utf8');
    assert.ok(text.includes('A cited bullet in the ATS export.'), 'the ATS text export dropped a cited bullet');
    assert.ok(text.includes('A bare string bullet in the ATS export.'), 'the ATS text export dropped a bare bullet');
  });
});

test('the source-citation gate reads a cited bullet rather than calling it unsourced', () => {
  withTempDir((dir) => {
    // A real cv.md line, used verbatim as the bullet, with an anchor that
    // matches exactly one line of cv.md. The gate must accept it; only the
    // BARE string bullet is uncited.
    const anchored = 'Educate members of the public on parks and playgrounds rules and regulations';
    const payload = {
      ...base,
      experience: [
        {
          ...base.experience[0],
          bullets: [
            { text: anchored, source_anchor: [anchored] },
            'A bare string bullet, rendered as before.',
          ],
        },
      ],
    };
    const pj = join(dir, 'payload.json');
    writeFileSync(pj, JSON.stringify(payload));
    let out = '';
    try {
      execFileSync('node', [join(ROOT, 'verify-bullet-sources.mjs'), pj], { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    // The cited bullet must not be reported as unsourced, and its anchor must
    // resolve. Only the BARE string bullet is uncited.
    assert.ok(!out.includes(anchored), `the gate listed the cited bullet as unsourced: ${out.slice(-400)}`);
    assert.ok(!/not found in cv\.md/.test(out), `the gate could not resolve the anchor: ${out.slice(-400)}`);
    // Exactly one bullet is uncited: the bare string.
    assert.ok(/1 bullet\(s\) not traceable/.test(out), `expected 1 uncited bullet, got: ${out.slice(-400)}`);
  });
});
