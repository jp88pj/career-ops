import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Project bullets must render as a list, not one joined run.
//
// MEASURED 2026-10-09: buildProjects did
//     e.bullets.map(bulletText).filter(Boolean).join(' ')
// and dropped the result into .project-desc, so a three-bullet project rendered as
// a single space-separated paragraph. The user read the result as "bullet
// uncertainty" on the page. Experience bullets never hit this because they always
// went through the `<li>` path; projects had no equivalent.
//
// These tests build real HTML through the shipped builder rather than asserting on
// source text, so they fail if either the builder or the template regress.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'templates', 'cv-template.html');

function build(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-proj-bullets-'));
  try {
    const pj = join(dir, 'payload.json');
    const out = join(dir, 'out.html');
    writeFileSync(pj, JSON.stringify(payload));
    execFileSync('node', [join(ROOT, 'build-cv-html.mjs'), pj, out, TEMPLATE], { cwd: ROOT, stdio: 'pipe' });
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// build-cv-html hard-requires name, email, phone AND linkedin (it refuses to emit a
// CV nobody can be contacted or identity-checked on), so every fixture carries all four.
const base = {
  candidate: {
    name: 'Test Person',
    email: 'a@b.co',
    phone: '(914) 433-5538',
    linkedin: 'linkedin.com/in/testperson',
    location: 'New York, NY',
  },
  experience: [],
};

test('project bullets render as <li>, not a joined run', () => {
  const html = build({ ...base, projects: [{ name: 'The Good Press', url: 'https://example.com', bullets: ['First bullet', 'Second bullet', 'Third bullet'] }] });
  const section = html.slice(html.indexOf('Projects'), html.indexOf('>Education<'));
  const lis = (section.match(/<li>/g) || []).length;
  assert.equal(lis, 3, `expected 3 <li>, got ${lis}`);
  assert.ok(!/First bullet Second bullet/.test(section), 'bullets were joined into one run');
});

test('each bullet appears exactly once, in order', () => {
  const html = build({ ...base, projects: [{ name: 'P', bullets: ['Alpha one', 'Beta two', 'Gamma three'] }] });
  for (const t of ['Alpha one', 'Beta two', 'Gamma three']) {
    assert.equal(html.split(t).length - 1, 1, `"${t}" should appear exactly once`);
  }
  assert.ok(html.indexOf('Alpha one') < html.indexOf('Beta two'));
  assert.ok(html.indexOf('Beta two') < html.indexOf('Gamma three'));
});

test('a description still renders as ONE paragraph — the prose case is intact', () => {
  const html = build({ ...base, projects: [{ name: 'P', description: 'A single prose sentence.', bullets: ['ignored one', 'ignored two'] }] });
  const section = html.slice(html.indexOf('Projects'), html.indexOf('>Education<'));
  assert.ok(section.includes('A single prose sentence.'));
  assert.equal((section.match(/<li>/g) || []).length, 0, 'bullets must not render when description is present');
});

test('a project with no bullets and no description renders without an empty <ul>', () => {
  const html = build({ ...base, projects: [{ name: 'Bare project' }] });
  const section = html.slice(html.indexOf('Projects'), html.indexOf('>Education<'));
  assert.ok(!/<ul>\s*<\/ul>/.test(section), 'an empty <ul> rendered');
  assert.ok(section.includes('Bare project'));
});

test('a bare-string bullet and an object bullet both render', () => {
  const html = build({
    ...base,
    projects: [{ name: 'P', bullets: ['A bare string', { text: 'An object bullet', source_line: 1 }] }],
  });
  assert.ok(html.includes('A bare string'));
  assert.ok(html.includes('An object bullet'));
});

test('the project url still wraps the title, and the badge still renders', () => {
  const html = build({ ...base, projects: [{ name: 'Linked project', url: 'https://example.com/x', badge: '64 issues', bullets: ['One'] }] });
  assert.ok(html.includes('href="https://example.com/x"'));
  assert.ok(html.includes('64 issues'));
});

test('multiple projects each get their own list', () => {
  const html = build({
    ...base,
    projects: [
      { name: 'First', bullets: ['a', 'b'] },
      { name: 'Second', bullets: ['c', 'd', 'e'] },
    ],
  });
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  assert.equal((html.match(/<li>/g) || []).length, 5);
});

test('the projects partial declares BULLETS_BLOCK', () => {
  const partial = join(ROOT, 'templates', 'sections', 'projects.html');
  assert.ok(existsSync(partial));
  assert.ok(readFileSync(partial, 'utf8').includes('BULLETS_BLOCK'));
});

test('the base template styles .project li so the list is not unstyled', () => {
  assert.ok(readFileSync(TEMPLATE, 'utf8').includes('.project li'));
});
