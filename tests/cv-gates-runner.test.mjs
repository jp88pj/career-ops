import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
