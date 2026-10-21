import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The tense register of a bullet, checked against the role it sits in.
//
// WHY THIS IS PINNED
// ------------------
// On 2026-10-21 three submitted applications carried "Documented each daily
// tour" - past tense - inside a CURRENT role, where the master says "the
// memorandum book documents all aspects of each daily tour". The fact gate
// passed (the claim is in cv.md) and the source gate passed (the bullet cites
// cv.md). The defect lived between them, and it shipped. This test pins the
// property that would have caught it: a bullet whose tense contradicts its
// role is a failure, and the check is not vacuous - the same bullet in the
// right tense passes.
//
// A gate that only ever passes is not a gate, so each case below asserts the
// exit code, not the message.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'scripts/check-cv-tense.mjs');

function withPayload(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-tense-'));
  try {
    return fn((payload) => {
      const file = join(dir, 'p.payload.json');
      writeFileSync(file, JSON.stringify(payload, null, 2));
      return file;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(file) {
  const r = spawnSync(process.execPath, [TOOL, file], { encoding: 'utf-8', cwd: ROOT });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function payload(role, dates, bulletText) {
  return {
    lang: 'en',
    candidate: { name: 'Test Person' },
    experience: [
      {
        company: 'City of New York Department of Parks & Recreation',
        role,
        location: 'New York, NY',
        dates,
        bullets: [{ text: bulletText, source_anchor: ['of each daily tour, from clock-in time to clock-out time'] }],
      },
    ],
  };
}

test('a current role in the present tense passes', () => {
  withPayload((write) => {
    const f = write(payload('Urban Park Service Security', 'Dec 2025 - Present', 'Document each daily tour, from clock-in to clock-out'));
    const r = run(f);
    assert.equal(r.code, 0, `expected a clean run, got:\n${r.out}`);
  });
});

test('a current role in the past tense FAILS - the defect that shipped', () => {
  withPayload((write) => {
    const f = write(payload('Urban Park Service Security', 'Dec 2025 - Present', 'Documented each daily tour, from clock-in to clock-out'));
    const r = run(f);
    assert.equal(r.code, 1, `expected a failure, got:\n${r.out}`);
    assert.match(r.out, /register mismatch/);
  });
});

test('a finished role in the past tense passes', () => {
  withPayload((write) => {
    const f = write(payload('Special Examiner - Physical Tests (Part-Time)', 'Jun 2025 - Dec 2025', 'Oversaw physical assessment events, ensuring candidates were properly equipped for testing'));
    const r = run(f);
    assert.equal(r.code, 0, `expected a clean run, got:\n${r.out}`);
  });
});

test('a finished role in the present tense FAILS', () => {
  withPayload((write) => {
    const f = write(payload('Special Examiner - Physical Tests (Part-Time)', 'Jun 2025 - Dec 2025', 'Oversee physical assessment events, ensuring candidates were properly equipped for testing'));
    const r = run(f);
    assert.equal(r.code, 1, `expected a failure, got:\n${r.out}`);
  });
});

test('a completed event inside a current role is past and is allowed', () => {
  withPayload((write) => {
    const f = write(payload('Urban Park Service Security', 'Dec 2025 - Present', 'Completed PEP academy training, covering New York State penal law and Parks Rules & Regulations'));
    const r = run(f);
    assert.equal(r.code, 0, `expected a clean run, got:\n${r.out}`);
  });
});

test('a payload with no bullets at all is reported as unchecked, not as clean', () => {
  withPayload((write) => {
    const f = write({ lang: 'en', candidate: { name: 'Test Person' }, experience: [] });
    const r = run(f);
    assert.match(r.out, /0 bullets could be checked|NOTHING WAS VERIFIED/);
  });
});
