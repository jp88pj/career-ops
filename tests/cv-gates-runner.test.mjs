import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// The four CV gates, as one command.
//
// The AGENTS.md mandates the four gates "every time, in order", and until
// verify-cv-gates.mjs existed that sequence lived only as prose - so it was run
// by hand, and a hand-run sequence is one that can be run partially or out of
// order. These tests pin the two properties that make the tool trustworthy
// rather than decorative: it reports EVERY gate, and a gate that cannot run
// counts as a gate that did not pass.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'verify-cv-gates.mjs');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-gates-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const PAYLOAD = {
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
  summary: 'A summary string for the gate runner test.',
  competencies: ['One'],
  experience: [
    {
      company: 'Test Company',
      role: 'Test Role',
      location: 'New York, NY',
      dates: 'Jan 2020 - Present',
      bullets: ['A bare string bullet, with no citation at all.'],
    },
  ],
};

function run(dir) {
  const pj = join(dir, 'payload.json');
  const html = join(dir, 'payload.html');
  writeFileSync(pj, JSON.stringify(PAYLOAD), 'utf8');
  writeFileSync(html, '<!DOCTYPE html><html><body><h1>Test Person</h1></body></html>', 'utf8');
  try {
    const out = execFileSync('node', [TOOL, pj], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('every gate is reported, in the order the AGENTS.md fixes', () => {
  withDir((dir) => {
    const { out } = run(dir);
    const order = ['fact', 'sources', 'pdf-text', 'ats'];
    const at = order.map((g) => out.indexOf(g));
    for (let i = 0; i < order.length; i++) {
      assert.ok(at[i] > -1, `the ${order[i]} gate was not reported: ${out}`);
      if (i > 0) assert.ok(at[i] > at[i - 1], `the ${order[i]} gate was reported before ${order[i - 1]}`);
    }
  });
});

test('an uncited bullet fails the source-citation gate and the run', () => {
  withDir((dir) => {
    const { code, out } = run(dir);
    assert.notEqual(code, 0, 'the run must exit non-zero');
    assert.match(out, /FAIL\s+sources/, `the source gate should have failed: ${out}`);
    assert.match(out, /bullet\(s\) (not )?traceable|unsourced/i, `the failure should name the reason: ${out}`);
  });
});

test('a missing PDF is a gate that did not run, and that counts as a failure', () => {
  withDir((dir) => {
    const { code, out } = run(dir);
    assert.notEqual(code, 0, 'the run must exit non-zero');
    assert.match(out, /FAIL\s+pdf-text/, `the PDF gate should have failed: ${out}`);
    assert.match(out, /no rendered PDF/i, `the failure should say the PDF is absent: ${out}`);
  });
});

test('--json reports each gate as structured data', () => {
  withDir((dir) => {
    const pj = join(dir, 'payload.json');
    writeFileSync(pj, JSON.stringify(PAYLOAD), 'utf8');
    writeFileSync(join(dir, 'payload.html'), '<!DOCTYPE html><html><body></body></html>', 'utf8');
    let out = '';
    try {
      out = execFileSync('node', [TOOL, pj, '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = `${e.stdout || ''}`;
    }
    const j = JSON.parse(out);
    assert.equal(j.total, 4);
    assert.equal(j.results.length, 4);
    assert.equal(j.ok, false, 'this fixture is not clean, so ok must be false');
    for (const r of j.results) {
      assert.ok(typeof r.pass === 'boolean', 'each gate reports a pass boolean');
      assert.ok(typeof r.name === 'string' && r.name, 'each gate reports its name');
    }
  });
});

test('--report picks the CV, not a sibling artefact named for the same report', () => {
  // Two sibling artefacts carry the same report number and sort first:
  // the cover letter's payload and the ATS variant's payload. A runner that
  // gates the wrong one reports a result about the wrong document - and this
  // is exactly what happened on 2026-10-20, twice, in two different forms.
  const out = [];
  for (const n of ['418', '441', '496', '500', '519']) {
    const dir = join(ROOT, 'output');
    const files = readdirSync(dir).filter((l) => l.startsWith(`cv-candidate-${n}-`) && l.endsWith('.payload.json'));
    if (!files.length) continue;
    const chosen = files.find((l) => !l.includes('-cover.') && !l.includes('-ats.')) || files[0];
    const res = spawnSync('node', [TOOL, `--report=${n}`, '--json'], { cwd: ROOT, encoding: 'utf8' });
    const j = JSON.parse(res.stdout || '{}');
    const gated = basename(j.payload || '');
    out.push(`    ${n}: gated ${gated}`);
    assert.equal(gated, chosen, `--report=${n} gated ${gated} instead of ${chosen}`);
    assert.ok(!gated.includes('-cover.'), `--report=${n} gated the cover letter`);
    assert.ok(!gated.includes('-ats.'), `--report=${n} gated the ATS variant`);
  }
  console.log(out.join('\n'));
});
