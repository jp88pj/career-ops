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
// cv.md). The defect lived in the gap between them, and it shipped.
//
// A gate that only ever passes is not a gate, so each case asserts the exit
// code, not the message. And the last two cases pin the failure mode that
// would make the gate WORTHLESS while looking green: a bullet the gate
// cannot classify is skipped, so the correct form of the defect ("Document
// each daily tour", a bare present form) would never be verified at all -
// only the wrong form would be caught.

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

function run(file, extra = []) {
  const r = spawnSync(process.execPath, [TOOL, file, ...extra], { encoding: 'utf-8', cwd: ROOT });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function runJson(file) {
  const r = spawnSync(process.execPath, [TOOL, file, '--json'], { encoding: 'utf-8', cwd: ROOT });
  return { code: r.status, data: JSON.parse(r.stdout || '{}') };
}

// The anchor points at a real line of the real cv.md, so the gate resolves it
// through the same canonical matcher the source gate uses.
const ANCHOR = ['of each daily tour, from clock-in time to clock-out time'];

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
        bullets: [{ text: bulletText, source_anchor: ANCHOR }],
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
    assert.match(r.out, /ERROR/);
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

test('a bare present form is CHECKED, not skipped as unclassifiable', () => {
  withPayload((write) => {
    // "Document" is a bare form: the master's own duty bullets are
    // overwhelmingly past, so the map cannot supply it, and the morphology
    // cannot either. If the gate skipped it, the CORRECT form of the defect
    // would go unverified while the wrong form was still caught - a gate that
    // looks like it works.
    const f = write(payload('Urban Park Service Security', 'Dec 2025 - Present', 'Document each daily tour, from clock-in to clock-out'));
    const { data } = runJson(f);
    assert.equal(data.checked, 1, `expected the bullet to be checked, got:\n${JSON.stringify(data)}`);
    assert.equal((data.unclassified || []).length, 0, `expected no unclassified bullets, got:\n${JSON.stringify(data.unclassified)}`);
  });
});

test('a payload with no bullets at all is reported as unchecked, not as clean', () => {
  withPayload((write) => {
    const f = write({ lang: 'en', candidate: { name: 'Test Person' }, experience: [] });
    const r = run(f);
    assert.match(r.out, /0 bullets could be checked|NOTHING WAS VERIFIED/);
  });
});
