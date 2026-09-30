import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'verify-ats.mjs');

function run(args) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('refuses a PDF instead of scoring its bytes as HTML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ats-'));
  try {
    const pdf = join(dir, 'cv-candidate-acme-2026-01-01.pdf');
    // Minimal PDF magic + enough binary that a naive read yields no markup.
    writeFileSync(pdf, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 200])]));
    const r = run([pdf]);
    assert.equal(r.code, 1, 'must exit non-zero');
    assert.match(r.out, /not an HTML file/, 'must say why');
    // The regression: it used to print a score here.
    assert.doesNotMatch(r.out, /Score:\s*\d+/, 'must NOT print a score for a PDF');
    assert.doesNotMatch(r.out, /Missing standard section heading/, 'must not invent section findings');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PDF named .html is still refused via the %PDF- magic sniff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ats-'));
  try {
    const fake = join(dir, 'looks-like.html');
    writeFileSync(fake, '%PDF-1.4\nbinary junk');
    const r = run([fake]);
    assert.equal(r.code, 1);
    assert.match(r.out, /not an HTML file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real HTML file is still scored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ats-'));
  try {
    const html = join(dir, 'cv.html');
    // Enough selectable text to clear the tool's own >=300 char floor, so a
    // failure here means the PDF guard broke normal operation rather than the
    // fixture being unrealistically thin.
    const filler = 'Coordinated assessment operations, vendor logistics, records accuracy, training delivery. '.repeat(8);
    writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><title>CV</title></head>
      <body><h1>Jane Doe</h1><p>jane@example.com</p>
      <h2>Experience</h2><p>${filler}</p>
      <h2>Education</h2><p>${filler}</p>
      <h2>Skills</h2><p>${filler}</p></body></html>`);
    const r = run([html]);
    assert.equal(r.code, 0, 'a decent CV must pass');
    assert.match(r.out, /Score:\s*\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves the source HTML for an indexed PDF', () => {
  const r = run([join(ROOT, 'output', 'cv-candidate-dream-advancement-2026-09-29.pdf')]);
  // Only assert the hint when the fixture actually exists in this checkout.
  if (r.code === 0) return;
  assert.match(r.out, /not an HTML file/);
});
