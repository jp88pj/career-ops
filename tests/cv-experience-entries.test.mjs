import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExperienceEntries, buildMasterBlocks, buildMasterRegister, formTense } from '../lib/cv-experience-entries.mjs';

// The one reader for a CV's Experience entries.
//
// WHY THIS IS PINNED
// ------------------
// Two gates read the master through this module, and both were reading it
// wrong before it existed:
//
//   - the tense gate had its own parser, and its copy had already drifted
//     from the source gate's anchor matcher;
//   - the TITLE CHECK had a copy too, and that copy parsed ZERO entries out
//     of cv.md - because the master writes an entry's title, location and
//     dates on one line, and the canonical boldLineText() accepts only a line
//     that is bold from end to end. So the title check had never run on any
//     tailored CV: every one reported "cv.md entries could not be parsed".
//
// A reader that cannot read the master is the failure these cases pin: the
// roles the master actually has, the two shapes that are easy to miss, and
// the documented shape that must keep working.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cv = readFileSync(join(ROOT, 'cv.md'), 'utf-8');

test('the master yields all of its roles', () => {
  const entries = parseExperienceEntries(cv);
  const titles = entries.map((e) => e.title);

  // The roles the master declares, in order.
  for (const title of [
    'Urban Park Service Security',
    'Special Examiner - Physical Tests (Part-Time)',
    'Test Administrator (Part-Time)',
    'Freelance Curriculum Designer (Self-Employed)',
    'Mathematics Teacher',
    'Data Science Teacher',
    'Replay Operator',
    'Video Scouting Assistant',
    'Major League Baseball Video Scout',
    'Freelance Writer',
    'Staff Writer, Brooklyn Nets & Virtual News Desk Correspondent',
    'Summer Camp Counselor',
    'Counselor-in-Training',
    'TEFL Practicum Volunteer, then Freelance TEFL Tutor (Self-Employed)',
  ]) {
    assert.ok(titles.includes(title), `missing role: ${title}`);
  }
});

test('a second role under the same employer is its own entry', () => {
  const entries = parseExperienceEntries(cv);
  const dataScience = entries.find((e) => e.title === 'Data Science Teacher');
  assert.ok(dataScience, 'the Data Science Teacher entry is missing');
  // The Data Science Teacher line follows the Newark Public Schools heading
  // with no heading of its own.
  assert.equal(dataScience.company, 'Newark Public Schools');
  assert.equal(dataScience.dates, 'Aug 2021 - Jun 2022');
  assert.ok(dataScience.bullets.length > 0, 'the entry has no bullets of its own');
});

test('a nested, indented entry is read', () => {
  const entries = parseExperienceEntries(cv);
  const replay = entries.find((e) => e.title === 'Replay Operator');
  assert.ok(replay, 'the Replay Operator entry is missing');
  assert.equal(replay.company, 'Major League Baseball');
  assert.equal(replay.dates, 'Mar 2016 - Nov 2022');
});

test('exactly one role is current, and it is the Parks one', () => {
  const entries = parseExperienceEntries(cv);
  const current = entries.filter((e) => e.current);
  assert.equal(current.length, 1, `expected one current role, got ${current.length}`);
  assert.equal(current[0].title, 'Urban Park Service Security');
});

test('an entry carries the role, the dates and the location', () => {
  const entries = parseExperienceEntries(cv);
  const parks = entries.find((e) => e.title === 'Urban Park Service Security');
  assert.equal(parks.company, 'City of New York Department of Parks & Recreation');
  assert.equal(parks.dates, 'Dec 2025 - Present');
  assert.equal(parks.location, 'New York, NY');
});

test("an entry's own bullets are its duties, not the master's annotations", () => {
  const entries = parseExperienceEntries(cv);
  const parks = entries.find((e) => e.title === 'Urban Park Service Security');
  assert.equal(parks.bullets.length, 3);
  assert.match(parks.bullets[0], /^Educate /);
  assert.match(parks.bullets[1], /^Respond /);
  assert.match(parks.bullets[2], /^Uphold /);
  // Not one annotation: the master's record for this role runs to dozens of
  // indented lines, and none of them is a duty.
  for (const b of parks.bullets) {
    assert.doesNotMatch(b, /User-stated|CORRECTED|Provenance/i);
  }
});

test('the documented example shape still parses', () => {
  const example = readFileSync(join(ROOT, 'examples/cv-example.md'), 'utf-8');
  const entries = parseExperienceEntries(example);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].company, 'TechFin Corp');
  assert.equal(entries[0].location, 'Austin, TX');
  assert.equal(entries[0].title, 'Senior ML Engineer / ML Platform Lead');
  assert.equal(entries[0].dates, '2020-2024');
  assert.equal(entries[0].bullets.length, 5);
  assert.equal(entries[1].company, 'DataStartup Inc');
  assert.equal(entries[1].location, 'Remote');
});

test('the master register derives the tense of a verb from the role', () => {
  const { verbTense } = buildMasterRegister(cv);
  // The master's current role is in the present...
  assert.equal(verbTense.get('Educate'), 'present');
  assert.equal(verbTense.get('Respond'), 'present');
  assert.equal(verbTense.get('Uphold'), 'present');
  // ...and its finished roles are in the past.
  assert.equal(verbTense.get('Oversaw'), 'past');
  assert.equal(verbTense.get('Taught'), 'past');
  // The master's own completed qualification sanctions a past verb inside the
  // current role, and the register says so.
  assert.equal(verbTense.get('Completed'), 'past');
  assert.equal(verbTense.get('Trained'), 'past');
});

test('a master block is a duty at the top level and an annotation below it', () => {
  const blocks = buildMasterBlocks(cv);
  const educate = blocks.find((b) => b.text.startsWith('Educate members'));
  assert.ok(educate, 'the Parks duty is missing');
  assert.equal(educate.duty, true);
  const radio = blocks.find((b) => b.text.includes('FIRST RESPONDERS'));
  assert.ok(radio, 'the replay-role annotation is missing');
  assert.equal(radio.duty, false, 'a description of the role is not a duty');
});

test('the morphological fallback is minimal', () => {
  assert.equal(formTense('Documented'), 'past');
  assert.equal(formTense('Documents'), 'present');
  assert.equal(formTense('Educate'), null, 'a bare form needs the explicit list');
  // The "-s" rule DOES read a plural noun as a verb. What keeps that from
  // mattering is WHERE it is applied: to a bullet's first word and to a
  // master duty block's first word, never searched through the master's
  // prose. The first version of the tense gate searched the prose, read
  // "Parks", "Mathematics" and "Texas" as verbs, and produced 52 false
  // positives on its first run.
});
