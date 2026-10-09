// Multi-anchor citations: a fused bullet may draw on several source lines.
//
// WHY THIS EXISTS (measured 2026-10-08): the approved MLB presentation set is
// hand-authored twins, and a twin deliberately fuses several cv.md bullets into
// one sentence — that fusion is what makes a bullet informative. Support against
// a single cited line was 0.42-0.56 against a 0.60 threshold for B2/B3/B4, which
// blocked them. That was the gate working as designed, not a defect in the twins:
// one line cannot support a sentence stating four facts from four lines.
//
// THESE TESTS RUN AGAINST THE REAL cv.md, not a fixture, because the novelty
// backstop is document-wide by nature: a trimmed fixture lacks vocabulary the
// real file has, and an earlier version of this file blocked the legitimate B2
// twin purely because its toy cv.md had never heard of "build", "five" or "pitch".
// Anchors below are the real ones, so an ambiguity introduced by a future edit to
// cv.md fails these tests rather than passing silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyBulletSources } from '../verify-bullet-sources.mjs';

const CV = readFileSync(new URL('../cv.md', import.meta.url), 'utf8');

const B1 = "Operated the replay operations process from MLB's New York City-based Replay Operations Center, through seven seasons of regular season baseball games, as well as postseason games including the World Series, All-Star games, and the 2017 World Baseball Classic";
const B2 = "Began each game's build about five hours before first pitch, syncing all camera angles to a blinking beacon light with frame-by-frame offset adjustments so multiple angles shared the exact same timestamp.";
const B3 = 'Acted as first line of detection for a potential review: announced a "Close Play" alert, marked the Point of Challenge to sync across the VTR system for engineers and supervisors, and while monitoring multiple live games at once delivered the correct game, angle and playback speed to the umpire who had to rule.';
const B4 = 'Delivered a vast majority of operated reviews in under two minutes, from initiation to final verdict, while driving a multiscreen layout in synchronicity with internal replay software on a DNF ST400 VTR/DDR controller.';
const B5 = "Reviewed other operators work for quality control and gave informal guidance on the equipment to newer employees.";

// Real, uniqueness-verified anchors. An ambiguous one makes these tests fail,
// which is the point: they are the canary for cv.md gaining a second match.
const ANCHORS = {
  B1: ['operating the replay operations process', 'regular season baseball games', 'multiple playoff games in every round of the MLB playoffs'],
  B2: ['synced the camera feeds to a blinking beacon light', 'starting up to 5 hours before the start of the game'],
  B3: ['acted as first line of defense', 'routing feeds to deliver the', 'synced across the VTR system', 'The ruling is made by the umpires'],
  B4: ['vast majority of operated reviews ran under two minutes', 'internal proprietary replay software'],
  B5: ["reviewed other operators' work and gave feedback for quality-control purposes"],
};

const ALL = { B1, B2, B3, B4, B5 };
const wrap = (bullets) => ({ experience: [{ company: 'MLB', role: 'Replay Operator', bullets }] });
const bullet = (text, source_anchor) => ({ text, source_anchor });

// --- the approved set passes -------------------------------------------------

test('every approved twin passes with its real anchors', () => {
  for (const id of Object.keys(ALL)) {
    const r = verifyBulletSources(wrap([bullet(ALL[id], ANCHORS[id])]), CV);
    assert.equal(r.verdict, 'pass', `${id} blocked: ${r.unsourced.map((u) => `${u.reason} (support ${u.support})`).join('; ')}`);
  }
});

test('the anchors are unique against cv.md as it stands', () => {
  const lines = CV.split(/\r?\n/);
  for (const [id, list] of Object.entries(ANCHORS)) {
    for (const a of list) {
      const hits = lines.filter((l) => l.toLowerCase().includes(a.toLowerCase())).length;
      assert.equal(hits, 1, `${id} anchor "${a}" matches ${hits} lines`);
    }
  }
});

// --- regression: the single-citation path is untouched ------------------------

test('single citation still behaves exactly as before', () => {
  const r = verifyBulletSources(
    wrap([bullet('a vast majority of operated reviews ran under two minutes, from initiation of the review to delivery of the final verdict.', 'vast majority of operated reviews ran under two minutes')]),
    CV,
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.checked, 1);
});

test('a single-citation block reports the singular "the cited line"', () => {
  // Every word below is already in cv.md, so the novelty backstop stays quiet and
  // the SUPPORT check is what reports — which is the distinction being asserted.
  const r = verifyBulletSources(
    wrap([bullet('Coordinated with in-stadium workers and reviewed available video feeds before every game.', 'synced across the VTR system')]),
    CV,
  );
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /not supported by the cited line$/);
});

test('a multi-citation block reports the plural "the cited lines"', () => {
  const r = verifyBulletSources(
    wrap([bullet('Coordinated with in-stadium workers and reviewed available video feeds before every game.', ['synced across the VTR system', 'acted as first line of defense'])]),
    CV,
  );
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /not supported by the cited lines$/);
});

// Pooling measures VOCABULARY COVERAGE, not citation completeness. Omitting one
// of three sources does not automatically fail: B1 still clears 0.60 on the two
// remaining anchors, because a bullet may legitimately restate only part of a
// line it cites. What must fail is citing sources that do not cover the bullet.
test('omitting one of three sources can still pass — coverage, not completeness', () => {
  const r = verifyBulletSources(wrap([bullet(B1, ANCHORS.B1.slice(1))]), CV);
  assert.equal(r.verdict, 'pass');
});

test('citing only irrelevant sources BLOCKS', () => {
  const r = verifyBulletSources(
    wrap([bullet(B1, ['acted as first line of defense', 'routing feeds to deliver the'])]),
    CV,
  );
  assert.equal(r.verdict, 'block');
});

// --- THE HONESTY GUARD, AND ITS LIMIT ---------------------------------------
//
// Measured 2026-10-08 on this file: clean twins scored 0.667-0.973 support, and
// a fabricated B1 scored 0.827 — HIGHER than the clean B2 at 0.759. No overlap
// threshold separates them, because the invented clause is built from genuine
// vocabulary: "umpiring" stems to "umpir" and matches "umpire", already present.
// The test below is a permanent, executable statement of that limit so nobody
// later reads a green run as proof of honesty.

test('DOCUMENTS THE LIMIT: fabrication from real vocabulary is NOT caught', () => {
  const fabricated = `${B1}, while also running the umpires' scoring system and training the umpiring crew before every game.`;
  const r = verifyBulletSources(wrap([bullet(fabricated, ANCHORS.B1)]), CV);
  // Asserting the limit, not the absence of a failure: if this ever flips, the
  // scoring changed and the reasoning above has to be revisited.
  assert.equal(r.verdict, 'pass');
});

test('an invented named system, tool or credential IS caught', () => {
  const r = verifyBulletSources(
    wrap([bullet(`${B1}, and personally rebuilt the Kubernetes orchestration layer and the Splunk telemetry stack in-house.`, ANCHORS.B1)]),
    CV,
  );
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /absent from the whole document/);
});

test('heavily invented content blocks on support alone', () => {
  const r = verifyBulletSources(
    wrap([bullet('Implemented a fully automated Kubernetes orchestration layer with Splunk telemetry, Terraform provisioning and Kafka streaming across the entire district.', ANCHORS.B1)]),
    CV,
  );
  assert.equal(r.verdict, 'block');
});

// --- failure modes stay loud -------------------------------------------------

test('an ambiguous anchor fails the bullet even when other citations are fine', () => {
  const dup = CV.replace('## Work Experience', '## Work Experience\n- announced a "Close Play" alert in an unrelated section');
  const r = verifyBulletSources(
    wrap([bullet(B3, ['Close Play', ...ANCHORS.B3.slice(1)])]),
    dup,
  );
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /AMBIGUOUS/);
});

test('a missing anchor fails the bullet even when other citations are fine', () => {
  const r = verifyBulletSources(
    wrap([bullet(B1, [...ANCHORS.B1, 'a phrase that appears nowhere in the document'])]),
    CV,
  );
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /not found in cv\.md/);
});

test('an empty array is an uncited bullet, not a citation that passes', () => {
  const r = verifyBulletSources(wrap([{ text: B1, source_anchor: [] }]), CV);
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /no source_line, source_anchor or source_text citation/);
});

test('citing more than the cap is rejected, so citing everything is not a bypass', () => {
  const seven = Array.from({ length: 7 }, (_, i) => `anchor number ${i}`);
  const r = verifyBulletSources(wrap([{ text: B1, source_anchor: seven }]), CV);
  assert.equal(r.verdict, 'block');
  assert.match(r.unsourced[0].reason, /at most 6 are allowed/);
});

test('mixed citation fields pool together', () => {
  const r = verifyBulletSources(
    wrap([{ text: B1, source_line: 69, source_anchor: ANCHORS.B1.slice(1) }]),
    CV,
  );
  assert.equal(r.verdict, 'pass');
});