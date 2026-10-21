#!/usr/bin/env node
/**
 * check-cv-tense.mjs - the TENSE REGISTER of every bullet in a tailored CV.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-10-21 three submitted applications (441, 500, 519) carried the Parks
 * duty "Documented each daily tour, from clock-in to clock-out" - PAST tense,
 * in a CURRENT role, where the master says "the memorandum book documents all
 * aspects of each daily tour". One word, in three CVs, past the gates: the fact
 * gate checks that a claim exists in cv.md, and it DID; the source gate checks
 * that the bullet cites cv.md, and it DID. The bug lived in the gap between
 * them - a bullet that paraphrases a present-tense master line in the past.
 *
 * THE RULE
 * --------
 * 1. A bullet's leading verb carries the tense of its ROLE: a current role
 *    takes the present ("Educate", "Respond", "Uphold"), a finished role takes
 *    the past ("Oversaw", "Delivered", "Taught"). The master follows exactly
 *    this, so a deviation is a register error.
 * 2. The one legitimate exception is a COMPLETED EVENT inside a current role -
 *    "Completed PEP academy training" is the master's own wording, and the
 *    master sanctions it. It is recognised without special-casing: the bullet
 *    cites a master BULLET LINE, and that line's own verb carries the same
 *    tense. The master owns the wording, so the master owns the register.
 *
 * A master bullet line is a line of cv.md that starts with "- ". An annotation
 * line is not one, which is why the "Documented each daily tour" bullet is
 * flagged: its anchor quotes an ANNOTATION, and the role it sits in is current.
 *
 * Usage:
 *   node scripts/check-cv-tense.mjs <payload.json> [<payload.json> ...]
 *   node scripts/check-cv-tense.mjs --all
 *   node scripts/check-cv-tense.mjs --report=NNN
 *   node scripts/check-cv-tense.mjs --all --json
 *
 * Exits 1 when any bullet contradicts its role's register.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------- verb forms
// Explicit lists only. A rule like "a word ending in 's' is present" reads
// nouns as verbs - "Parks", "Mathematics", "Texas" - and produces findings
// that are noise, which is how a gate gets ignored.
const PRESENT_VERBS = new Set([
  "Educate", "Respond", "Uphold", "Document", "Coordinate", "Rotate", "Work",
  "Works", "Oversee", "Deliver", "Administer", "Teach", "Implement", "Develop",
  "Build", "Use", "Keep", "Run", "Support", "Complete", "Guide", "Create",
  "Perform", "Log", "Categorize", "Categorise", "Collaborate", "Update",
  "Alert", "Review", "Write", "Edit", "Launch", "Publish", "Design",
  "Authorize", "Initiate", "Ensure", "Help", "Provide", "Set", "Introduce",
  "Handle", "Supervise", "Manage", "Prepare", "Supply", "Operate", "Serve",
  "Schedule", "Organise", "Organize", "Assist", "Advise", "Plan", "Produce",
  "Enforce", "Brief", "Check", "Screen", "Track", "Verify", "Cover", "Fill",
  "Serve", "Maintain", "Record", "Report", "Sort", "Answer", "Attend",
  "Observe", "Greet", "Inform", "Direct", "Translate", "Interpret", "Type",
]);

const IRREGULAR_PAST = new Set([
  "Oversaw", "Ran", "Built", "Taught", "Wrote", "Kept", "Held", "Sold", "Sent",
  "Made", "Saw", "Felt", "Met", "Put", "Cut", "Read", "Paid", "Led", "Spoke",
  "Broke", "Chose", "Drove", "Fell", "Forgot", "Froze", "Gave", "Grew", "Hid",
  "Hung", "Knew", "Laid", "Lost", "Meant", "Rode", "Rose", "Said", "Shot",
  "Shone", "Shook", "Shut", "Sang", "Sank", "Sat", "Slept", "Sought", "Stole",
  "Struck", "Swam", "Swore", "Threw", "Tore", "Wore", "Won", "Wove",
  "Bought", "Brought", "Caught", "Thought", "Left", "Bent", "Bled", "Flew",
  "Blew", "Froze", "Grew", "Hid", "Hung", "Laid", "Led", "Rang", "Sang",
  "Shook", "Slid", "Spun", "Stole", "Swore", "Threw", "Tore", "Wore",
]);

/** @returns {"present"|"past"|null} */
function tenseOf(word) {
  if (!word) return null;
  const w = word[0].toUpperCase() + word.slice(1);
  if (PRESENT_VERBS.has(w)) return "present";
  if (IRREGULAR_PAST.has(w)) return "past";
  if (/ed$/.test(w)) return "past";
  return null;
}

/**
 * A COMPLETED EVENT inside a current role is correctly past tense, and the
 * master sanctions it: its own current-role bullet line reads "Completed
 * **PEP academy training**", and its annotation reads "Trained on NYS penal
 * law". Those are the master's words for a qualification he finished, so a
 * bullet written that way is the master's register, not a deviation.
 *
 * The list is deliberately small. A verb like "Developed" or "Coordinated" is
 * NOT in it: those are duties that continue, and a current-role bullet that
 * puts them in the past tense is exactly the error this gate exists to catch.
 */
const COMPLETED_EVENT_VERBS = new Set([
  "Completed", "Trained", "Graduated", "Passed", "Earned", "Certified",
  "Attended", "Enrolled", "Concluded", "Qualified",
]);

const stripMd = (s) => s.replace(/\*\*/g, "").replace(/`/g, "").replace(/^-\s+/, "").trim();

// ------------------------------------------------------------- master lookup
const CV_PATH = resolve(process.cwd(), "cv.md");

/**
 * The master line a bullet cites, and whether that line is a master BULLET
 * line (a cv.md list item) rather than an annotation.
 */
function masterLine(sourceLines, anchor) {
  if (!anchor) return { line: null, reason: "no source_anchor", isBullet: false };
  const needle = String(anchor).toLowerCase();
  const hits = [];
  sourceLines.forEach((l, i) => { if (l.toLowerCase().includes(needle)) hits.push({ line: l, n: i + 1 }); });
  if (!hits.length) return { line: null, reason: "anchor not found in cv.md", isBullet: false };
  if (hits.length > 1) {
    return { line: null, reason: `anchor is AMBIGUOUS (${hits.length} lines)`, isBullet: false };
  }
  const raw = hits[0].line;
  const isBullet = /^\s*[-*]\s+/.test(raw);
  const body = stripMd(raw);
  const first = (body.match(/^([A-Za-z]+)/) || [])[1] || null;
  return { line: raw.trim(), isBullet, firstWord: first, verbTense: tenseOf(first), reason: null };
}

/**
 * The master line for a bullet that carries no source_anchor - the older
 * payload shape, where `bullets` is an array of plain strings.
 *
 * The match is on the opening of the text against a cv.md list item, because
 * cv.md is hard wrapped and the bullet's first line is the part that carries
 * the verb.
 */
function masterLineForText(sourceLines, text) {
  const opening = String(text).slice(0, 40).toLowerCase();
  if (opening.length < 12) return { line: null, isBullet: false, firstWord: null, verbTense: null, reason: "text too short to match" };
  for (const raw of sourceLines) {
    if (!/^\s*[-*]\s+/.test(raw)) continue;
    const body = stripMd(raw).toLowerCase();
    if (body.startsWith(opening.slice(0, 30))) {
      const first = (stripMd(raw).match(/^([A-Za-z]+)/) || [])[1] || null;
      return { line: raw.trim(), isBullet: true, firstWord: first, verbTense: tenseOf(first), reason: null };
    }
  }
  return { line: null, isBullet: false, firstWord: null, verbTense: null, reason: "no master list item matches the bullet's opening" };
}

function roleTense(entry) {
  const d = String(entry.dates || entry.period || "");
  return /present|current/i.test(d) ? "present" : "past";
}

function checkPayload(payloadPath, sourceLines) {
  const p = JSON.parse(readFileSync(payloadPath, "utf-8"));
  const findings = [];
  let checked = 0;

  for (const entry of p.experience || []) {
    const rt = roleTense(entry);
    for (const b of entry.bullets || []) {
      // Two payload shapes are in circulation: the current one, where a bullet
      // is {text, source_anchor}, and the older one, where it is a bare
      // string. Skipping the second shape silently would leave a third of the
      // CVs unchecked and the gate reporting a clean run.
      const text = typeof b === "string" ? b : b?.text;
      if (!text) continue;
      const word = (String(text).match(/^([A-Za-z]+)/) || [])[1];
      const bt = tenseOf(word);
      if (!bt) continue;
      checked++;
      if (bt === rt) continue; // the role and the bullet agree: nothing to say

      // The one legitimate exception: a completed event inside a current role,
      // written as the master writes it. The master owns the register when the
      // bullet quotes a master bullet line whose own verb carries the same tense.
      const anchor = typeof b === "string" ? null : (Array.isArray(b.source_anchor) ? b.source_anchor[0] : b.source_anchor);
      const ml = anchor ? masterLine(sourceLines, anchor) : masterLineForText(sourceLines, text);
      if (ml.isBullet && ml.verbTense === bt) continue; // the master's own wording
      if (COMPLETED_EVENT_VERBS.has(word)) continue; // a qualification he finished

      findings.push({
        bullet: text,
        role: entry.role,
        roleTense: rt,
        bulletTense: bt,
        masterLine: ml.line,
        masterIsBullet: ml.isBullet,
        masterVerb: ml.firstWord,
        masterVerbTense: ml.verbTense,
        reason: ml.reason,
        anchor,
      });
    }
  }
  return { findings, checked, payloadPath };
}

// ----------------------------------------------------------------------- main
const args = process.argv.slice(2);
const json = args.includes("--json");
const sourceLines = readFileSync(CV_PATH, "utf-8").split("\n");

let payloadPaths = [];
if (args.includes("--all")) {
  payloadPaths = readdirSync(resolve(process.cwd(), "output"))
    .filter((f) => /^cv-candidate-.*\.payload\.json$/.test(f) && !f.includes("-ats.") && !f.includes("-cover."))
    .map((f) => resolve("output", f));
} else if (args.some((a) => a.startsWith("--report="))) {
  const num = args.find((a) => a.startsWith("--report=")).split("=")[1];
  const f = readdirSync(resolve(process.cwd(), "output")).find(
    (x) => x.startsWith(`cv-candidate-${num}-`) && x.endsWith(".payload.json") && !x.includes("-ats.") && !x.includes("-cover.")
  );
  if (!f) { console.error(`Error: no tailored CV payload for report ${num}`); process.exit(1); }
  payloadPaths = [resolve("output", f)];
} else {
  payloadPaths = args.filter((a) => !a.startsWith("--")).map((a) => resolve(a));
}

if (!payloadPaths.length) {
  console.error("usage: node scripts/check-cv-tense.mjs <payload.json>... | --all | --report=NNN");
  process.exit(1);
}

let totalFindings = 0;
let totalChecked = 0;
const all = [];

for (const pp of payloadPaths) {
  if (!existsSync(pp)) { console.error(`Error: no such payload: ${pp}`); process.exit(1); }
  const r = checkPayload(pp, sourceLines);
  totalFindings += r.findings.length;
  totalChecked += r.checked;
  all.push(r);
  if (!json && r.checked === 0) {
    // A payload that yields nothing to check is a silent skip, and a gate that
    // reports "clean" over a file it never read is worse than no gate.
    console.log(`  !! ${pp.split(/[\\/]/).pop()}: 0 bullets could be checked - NOTHING WAS VERIFIED for this file`);
  }
  if (!json && r.findings.length) {
    const name = pp.split(/[\\/]/).pop();
    console.log(`  ${name}: ${r.findings.length} register mismatch(es)`);
    for (const f of r.findings) {
      console.log(`     !! "${f.bullet}"`);
      console.log(`        role         : ${f.role}  (${f.roleTense})`);
      console.log(`        bullet verb  : ${f.bulletTense}`);
      console.log(`        master       : ${f.masterIsBullet ? "a master bullet line" : "an ANNOTATION line"}${f.masterVerb ? `, verb "${f.masterVerb}" (${f.masterVerbTense})` : ""}`);
      if (f.masterLine) console.log(`        master line  : ${f.masterLine.slice(0, 120)}`);
      if (f.reason) console.log(`        note         : ${f.reason}`);
      console.log(`        anchor       : ${String(f.anchor).slice(0, 90)}`);
    }
  }
}

if (json) console.log(JSON.stringify({ checked: totalChecked, findings: totalFindings, details: all }, null, 2));
else {
  console.log(`\n  ${totalChecked} bullet(s) checked, ${totalFindings} register mismatch(es)`);
  if (totalFindings) console.log("  A bullet whose tense contradicts its role is a register error.");
}
process.exit(totalFindings ? 1 : 0);
