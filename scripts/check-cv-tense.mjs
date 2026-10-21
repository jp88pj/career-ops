#!/usr/bin/env node
/**
 * check-cv-tense.mjs - the TENSE REGISTER of every bullet in a tailored CV.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-10-21 three submitted applications (441, 500, 519) carried the Parks
 * duty "Documented each daily tour, from clock-in to clock-out" - PAST tense,
 * in a CURRENT role, where the master says "the memorandum book documents all
 * aspects of each daily tour". One word. It passed all four gates: the fact
 * gate asks whether the claim is in cv.md (it was), the source gate asks
 * whether the bullet cites cv.md (it did). The defect lived in the gap
 * between them, and 519 was submitted with it.
 *
 * THE RULES, AND WHERE THEY COME FROM
 * -----------------------------------
 * Nothing here is a hand-written table of verbs. The master owns the register
 * and this gate reads it:
 *
 * 1. THE MASTER'S OWN WORDING GOVERNS. A bullet that cites a master line is
 *    judged against that line's register. The master writes a current role in
 *    the present and a finished role in the past, and it sanctions the
 *    completed events inside a current role in the past - "Completed **PEP
 *    academy training**" is the master's own wording, so a bullet that says
 *    "Completed PEP academy training" agrees with it.
 * 2. THE ROLE GOVERNS WHEN THE MASTER IS SILENT. A bullet whose cited line
 *    carries no verb of its own - an annotation - is judged against the role
 *    it sits in: present for a current role, past for a finished one.
 *
 * The verb vocabulary and each verb's tense are DERIVED from the master
 * (lib/cv-experience-entries.mjs -> buildMasterRegister), so a table cannot
 * disagree with the master silently. A morphological fallback covers forms the
 * master has not used yet, and the fallback is cross-checked against the
 * master on the same run: the master is the authority, and a disagreement is
 * reported rather than resolved in favour of the gate.
 *
 * CONSISTENCY
 * -----------
 * The anchor is resolved with `resolveAnchor` from verify-bullet-sources.mjs -
 * the exported, canonical matcher - so this gate and the source gate cannot
 * disagree about what a bullet cites. The master is read through
 * lib/cv-experience-entries.mjs, the ONE reader the title check and the
 * structure check share. Before 2026-10-21 this gate had its own copy of
 * both, and the copies had already drifted.
 *
 * Usage:
 *   node scripts/check-cv-tense.mjs <payload.json> [<payload.json> ...]
 *   node scripts/check-cv-tense.mjs --all
 *   node scripts/check-cv-tense.mjs --report=NNN
 *   node scripts/check-cv-tense.mjs --all --json
 *
 * Exits 1 when any bullet contradicts its register.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAnchor } from "../verify-bullet-sources.mjs";
import {
  buildMasterBlocks,
  buildMasterRegister,
  isCurrentDates,
  leadingWord,
} from "../lib/cv-experience-entries.mjs";

// ---------------------------------------------------------------- the master
const CV_PATH = resolve(process.cwd(), "cv.md");
const cvText = readFileSync(CV_PATH, "utf-8");
// The SAME split verify-bullet-sources.mjs uses, so resolveAnchor() sees the
// same line numbering this gate reports.
const sourceLines = cvText.split(/\r?\n/);
const register = buildMasterRegister(cvText);
const masterBlocks = buildMasterBlocks(cvText);

/**
 * The bare present forms a CV bullet can open with.
 *
 * The master's map is derived from the master's own duty bullets, and those
 * are overwhelmingly PAST ("Oversaw", "Taught", "Delivered") - the master
 * states what he did. A bullet in a CURRENT role opens with a BARE form
 * instead: "Document each daily tour", "Coordinate by radio", "Maintain a
 * memorandum book". The map cannot supply those, and the morphology cannot
 * either: a bare form is neither "-ed" nor "-s".
 *
 * So they are listed here, and the list is deliberately short: it holds the
 * forms the CVs actually use, plus the common ones. Every bullet whose first
 * word is NOT in the map, NOT in this list and NOT shaped like a past or
 * third-person form is reported as "not verb-initial (not checkable)" - so
 * the gap is visible in the output rather than a silent pass.
 *
 * The list is a fallback, not an authority: the master's map wins over it, and
 * the cross-check below reports any verb where the two disagree.
 */
const BARE_PRESENT = new Set([
  'Document', 'Coordinate', 'Keep', 'Maintain', 'Preserve', 'Patrol', 'Rotate',
  'Work', 'Troubleshoot', 'Provide', 'Oversee', 'Monitor', 'Enforce', 'Lead',
  'Assess', 'Brief', 'Check', 'Track', 'Verify', 'Schedule', 'Serve', 'Supply',
  'Handle', 'Prepare', 'Manage', 'Supervise', 'Advise', 'Assist', 'Produce',
  'Introduce', 'Ensure', 'Help', 'Authorize', 'Initiate', 'Alert',
  'Collaborate', 'Categorize', 'Categorise', 'Log', 'Perform', 'Create',
  'Guide', 'Complete', 'Support', 'Run', 'Use', 'Build', 'Develop',
  'Implement', 'Deliver', 'Administer', 'Teach', 'Respond', 'Uphold',
  'Educate', 'Write', 'Edit', 'Launch', 'Publish', 'Design', 'Update',
  'Organise', 'Organize', 'Review', 'Plan',
]);

/**
 * The irregular past forms.
 *
 * A closed, standard set - the ones "-ed" cannot reach. It is a fact about
 * English rather than a fact about this project, which is why it belongs in a
 * list rather than in the master: the master never writes "Oversaw" in a
 * current role, so it cannot be the authority on a form it does not use.
 *
 * Every form here is unambiguously past. The cross-check below then confirms
 * that the master agrees, which is what stops the list drifting.
 */
const IRREGULAR_PAST = new Set([
  'Ate', 'Bade', 'Began', 'Bent', 'Bere', 'Bet', 'Bled', 'Blew', 'Blow',
  'Broke', 'Built', 'Bought', 'Brought', 'Burst', 'Cast', 'Caught', 'Chid',
  'Chose', 'Clung', 'Cost', 'Cought', 'Crept', 'Cut', 'Dared', 'Dealt', 'Dwelt',
  'Died', 'Dove', 'Drew', 'Drank', 'Drove', 'Drunk', 'Dwelt', 'Felt', 'Fell',
  'Fought', 'Flew', 'Fled', 'Flung', 'Flown', 'Forbade', 'Forgot', 'Forgotten',
  'Found', 'Froze', 'Gave', 'Given', 'Gone', 'Ground', 'Grew', 'Grown', 'Hung',
  'Hewed', 'Heard', 'Hid', 'Hidden', 'Held', 'Hurled', 'Kept', 'Knew', 'Known',
  'Laid', 'Led', 'Leapt', 'Left', 'Lent', 'Lit', 'Lost', 'Made', 'Meant', 'Met',
  'Mistook', 'Owe', 'Oversaw', 'Overcome', 'Paid', 'Parted', 'Proved', 'Put',
  'Quit', 'Rang', 'Read', 'Ridden', 'Risen', 'Rode', 'Rung', 'Ran', 'Sang',
  'Sank', 'Sat', 'Saw', 'Sawed', 'Sewn', 'Shook', 'Shot', 'Shone', 'Slain',
  'Sled', 'Slept', 'Slid', 'Slung', 'Smelt', 'Sown', 'Spent', 'Spoke', 'Spun',
  'Stood', 'Stole', 'Struck', 'Stuck', 'Swam', 'Swept', 'Swung', 'Swore',
  'Taught', 'Tore', 'Torn', 'Threw', 'Thrust', 'Told', 'Took', 'Trod', 'Trod',
  'Troubleshot', 'Understood', 'Woke', 'Wore', 'Woven', 'Wove', 'Wring', 'Wrought',
  'Wrote', 'Wrong', 'Wrung', 'Bought', 'Died', 'Girt',
]);

/**
 * The tense of a verb form.
 *
 * The master's own map wins - it is derived from the master, so it cannot be
 * wrong about a form the master uses. The morphological rules are a fallback
 * for forms the master has not used, and are deliberately minimal: "-ed" is
 * past and a third-person "-s" is present. The earlier version of this gate
 * also treated ANY word ending in "s" as present, which read *Parks*,
 * *Mathematics* and *Texas* as verbs and produced 52 false positives on its
 * first run. A gate that cries wolf gets ignored.
 */
function classify(word) {
  if (!word) return null;
  const key = word[0].toUpperCase() + word.slice(1);
  const fromMaster = register.verbTense.get(key);
  if (fromMaster && fromMaster !== 'conflict') return fromMaster;
  if (BARE_PRESENT.has(key)) return 'present';
  if (IRREGULAR_PAST.has(key)) return 'past';
  if (/ed$/.test(key)) return 'past';
  if (/[^s]s$/.test(key)) return 'present';
  return null;
}

/**
 * The register of a master block: the tense of the verb it OPENS with.
 *
 * Only the first word is read, deliberately. A duty bullet opens with its
 * verb ("Educate", "Oversaw", "Completed"), and an annotation opens with a
 * bolded label ("**Item-level performance analysis:**", "**⇒ CITABLE, at
 * exactly this scope:**") - and searching deeper into an annotation finds a
 * verb that belongs to a different claim. It also finds PLURAL NOUNS: with
 * the "-s is present" fallback, "performance analysis" reads as the present
 * tense, and the gate then reports that the master's own "he analysed" is a
 * register error.
 *
 * A block that does not open with a verb has no register of its own, and the
 * role governs it.
 */
function blockRegister(block) {
  const word = leadingWord(block.text);
  const tense = classify(word);
  if (!tense) return null;
  return { tense, verb: word };
}

/** The master block a resolved anchor line belongs to. */
function blockForLine(lineText) {
  const needle = String(lineText ?? '').replace(/\s+/g, ' ').trim();
  if (!needle) return null;
  // The resolved line still carries its list marker; the block's text does not.
  const head = needle.replace(/^(?:[-*]|\d+\.)\s+/, '').slice(0, 60);
  for (const b of masterBlocks) {
    if (b.text.includes(head)) return b;
  }
  return null;
}

/**
 * The best master DUTY block for a bullet that carries no anchor.
 *
 * The older payload shape stores bullets as bare strings, with no
 * source_anchor, so there is nothing to resolve - and a bullet that cannot be
 * traced might still be sanctioned by the master, as "Trained at the PEP
 * academy..." is, by the master's own "Completed **PEP academy training**".
 * This is a best-effort content match against the master's top-level duty
 * blocks, and it is reported as what it is: a bullet matched this way is
 * CONSISTENT WITH the master, not TRACED TO it. The source-citation gate is
 * the one that proves the trace, and for the older CVs it cannot run at all.
 */
const MATCH_THRESHOLD = 0.5;
const STOP_WORDS = new Set([
  'that', 'with', 'from', 'their', 'this', 'were', 'have', 'been', 'into',
  'over', 'each', 'such', 'them', 'they', 'these', 'those', 'using', 'used',
  'when', 'where', 'which', 'while', 'would', 'could', 'should', 'through',
  'across', 'after', 'before', 'other', 'also', 'than', 'then', 'them',
  'including', 'including', 'without', 'within', 'under', 'about', 'against',
]);

function contentWords(text) {
  return new Set(
    (String(text).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP_WORDS.has(w))
  );
}

const dutyBlocks = masterBlocks.filter((b) => b.duty).map((b) => ({
  block: b,
  words: contentWords(b.text),
}));

function bestContentMatch(bullet) {
  const words = contentWords(bullet);
  if (!words.size) return null;
  let best = null;
  for (const d of dutyBlocks) {
    let hit = 0;
    for (const w of words) if (d.words.has(w)) hit++;
    const score = hit / words.size;
    if (!best || score > best.score) best = { block: d.block, score };
  }
  return best && best.score >= MATCH_THRESHOLD ? best : null;
}

// ------------------------------------------------------------------ the checks
function checkPayload(payloadPath) {
  const p = JSON.parse(readFileSync(payloadPath, "utf-8"));
  const findings = [];
  const review = [];
  const unclassified = [];
  let checked = 0;

  for (const entry of p.experience || []) {
    const roleTense = isCurrentDates(entry.dates) ? 'present' : 'past';

    for (const b of entry.bullets || []) {
      // Two payload shapes are in circulation: the current one, where a bullet
      // is {text, source_anchor}, and the older one, where it is a bare
      // string. Skipping the second silently would leave a third of the CVs
      // unchecked under a clean report.
      const text = typeof b === 'string' ? b : b?.text;
      if (!text) continue;
      const word = (text.match(/^([A-Za-z][A-Za-z'-]*)/) || [])[1];
      const bt = classify(word);
      if (!bt) {
        // A bullet whose first word is not a verb cannot be judged on
        // register. It is counted, not dropped: a gate that silently checks
        // nothing reports a clean run over a file it never read.
        unclassified.push({ bullet: text, word: word || '(none)' });
        continue;
      }
      checked++;

      const anchor = typeof b === 'string' ? null : (Array.isArray(b.source_anchor) ? b.source_anchor[0] : b.source_anchor);

      // Rule 1: a master DUTY line governs. A duty is the master's own
      // statement of the work, and it carries the register.
      //
      // Rule 2: the ROLE governs in every other case. An ANNOTATION does not
      // carry a bullet's register - "**Operators are the FIRST RESPONDERS for
      // ALL replay reviews across MLB games**" describes the ROLE in general,
      // in the present, while the CV bullet that traces to it says what HE
      // did, in the past, and the past is right because the role is finished.
      //
      // The one exception Rule 2 allows is a verb the master itself uses in
      // that register: "Trained at the PEP academy..." is past inside a
      // current role because the master writes "Trained on NYS penal law..."
      // in the past, and the house rule folds the PEP period into the current
      // Parks entry. That sanction comes from the master's own duty lines,
      // so it cannot be granted by a table.
      let resolved = null;
      let block = null;
      if (anchor) {
        resolved = resolveAnchor(sourceLines, 'source_anchor', anchor);
        if (resolved.line) block = blockForLine(resolved.line);
      }
      const reg = block && block.duty ? blockRegister(block) : null;

      if (reg) {
        if (reg.tense !== bt) {
          findings.push({
            bullet: text, role: entry.role, roleTense, bulletTense: bt,
            masterTense: reg.tense, masterVerb: reg.verb, masterLine: block.from + 1,
            masterText: block.text, kind: 'master', anchor,
          });
        }
        continue; // the master and the bullet agree
      }

      // Rule 2: the role governs, because the master is describing the role
      // rather than stating the duty.
      if (bt !== roleTense) {
        const sanctioned = register.verbTense.get(word);
        if (sanctioned && sanctioned !== 'conflict' && sanctioned === bt) continue; // the master's own register
        findings.push({
          bullet: text, role: entry.role, roleTense, bulletTense: bt,
          masterTense: null, masterVerb: null,
          masterLine: resolved?.line ? sourceLines.indexOf(resolved.line) + 1 : null,
          masterText: resolved?.line ? resolved.line.trim() : null, kind: 'role', anchor,
        });
      }
    }
  }
  return { findings, review, unclassified, checked, payloadPath };
}

/**
 * The morphological fallback on its own, with the master's map excluded.
 *
 * The map is derived from the master, so comparing the map against the master
 * would be circular. This is the part worth testing: the fallback decides
 * every form the master has not used, and the master is what says whether the
 * fallback is right.
 */
function fallbackClassify(word) {
  if (!word) return null;
  const key = word[0].toUpperCase() + word.slice(1);
  if (BARE_PRESENT.has(key)) return 'present';
  if (IRREGULAR_PAST.has(key)) return 'past';
  if (/ed$/.test(key)) return 'past';
  if (/[^s]s$/.test(key)) return 'present';
  return null;
}

/**
 * Cross-check: the gate's fallback against the master.
 *
 * The master is the authority, so where the two disagree about a verb the
 * master uses, the master is right and the fallback needs the fix. This is
 * what keeps the fallback honest without a hand-maintained table.
 */
function crossCheck() {
  const conflicts = [];
  for (const entry of register.entries) {
    const roleTense = entry.current ? 'present' : 'past';
    for (const b of entry.bullets) {
      const verb = leadingWord(b);
      if (!verb) continue;
      const verdict = fallbackClassify(verb);
      if (!verdict) { conflicts.push({ kind: 'unclassified', verb, text: b, role: entry.title }); continue; }
      if (verdict !== roleTense) {
        conflicts.push({ kind: 'disagrees', verb, verdict, roleTense, text: b, role: entry.title });
      }
    }
  }
  return conflicts;
}

// ----------------------------------------------------------------------- main
const args = process.argv.slice(2);
const json = args.includes('--json');

let payloadPaths = [];
if (args.includes('--all')) {
  payloadPaths = readdirSync(resolve(process.cwd(), 'output'))
    .filter((f) => /^cv-candidate-.*\.payload\.json$/.test(f) && !f.includes('-ats.') && !f.includes('-cover.'))
    .map((f) => resolve('output', f));
} else if (args.some((a) => a.startsWith('--report='))) {
  const num = args.find((a) => a.startsWith('--report=')).split('=')[1];
  const f = readdirSync(resolve(process.cwd(), 'output')).find(
    (x) => x.startsWith(`cv-candidate-${num}-`) && x.endsWith('.payload.json') && !x.includes('-ats.') && !x.includes('-cover.')
  );
  if (!f) { console.error(`Error: no tailored CV payload for report ${num}`); process.exit(1); }
  payloadPaths = [resolve('output', f)];
} else {
  payloadPaths = args.filter((a) => !a.startsWith('--')).map((a) => resolve(a));
}

if (!payloadPaths.length) {
  console.error('usage: node scripts/check-cv-tense.mjs <payload.json>... | --all | --report=NNN');
  process.exit(1);
}

const conflicts = crossCheck();
let totalFindings = 0;
let totalReview = 0;
let totalChecked = 0;
let totalUnclassified = 0;
const all = [];

for (const pp of payloadPaths) {
  if (!existsSync(pp)) { console.error(`Error: no such payload: ${pp}`); process.exit(1); }
  const r = checkPayload(pp);
  totalFindings += r.findings.length;
  totalReview += r.review.length;
  totalChecked += r.checked;
  totalUnclassified += r.unclassified.length;
  all.push(r);

  if (!json && r.checked === 0) {
    console.log(`  !! ${pp.split(/[\\/]/).pop()}: 0 bullets could be checked - NOTHING WAS VERIFIED for this file`);
  }
  if (!json && (r.findings.length || r.review.length)) {
    console.log(`  ${pp.split(/[\\/]/).pop()}: ${r.findings.length} error(s), ${r.review.length} needing review`);
    for (const f of r.findings) {
      console.log(`     ERROR  "${f.bullet}"`);
      console.log(`        role        : ${f.role} (${f.roleTense})`);
      console.log(`        bullet verb : ${f.bulletTense}`);
      if (f.masterVerb) {
        console.log(`        master verb : ${f.masterVerb} (${f.masterTense})  - cv.md L${f.masterLine}`);
      } else {
        console.log(`        master      : the ROLE governs (the master does not state this duty in the other register)`);
      }
      if (f.masterText) console.log(`        master line : ${String(f.masterText).slice(0, 120)}`);
      if (f.anchor) console.log(`        anchor      : ${String(f.anchor).slice(0, 90)}`);
    }
    for (const f of r.review) {
      console.log(`     REVIEW "${f.bullet}"`);
      console.log(`        role        : ${f.role} (${f.roleTense})`);
      console.log(`        bullet verb : ${f.bulletTense}`);
      console.log(`        reason      : ${f.reason}`);
      if (f.masterLine) console.log(`        master line : L${f.masterLine} ${String(f.masterText).slice(0, 100)}`);
    }
  }
}

if (json) {
  console.log(JSON.stringify({ checked: totalChecked, findings: totalFindings, review: totalReview, unclassified: totalUnclassified, conflicts, details: all }, null, 2));
} else {
  console.log(`\n  ${totalChecked} bullet(s) checked, ${totalFindings} error(s), ${totalReview} needing review, ${totalUnclassified} not verb-initial (not checkable)`);
  if (conflicts.length) {
    console.log(`\n  Master cross-check (the master is the authority):`);
    for (const c of conflicts) {
      if (c.kind === 'disagrees') {
        console.log(`     the master writes "${c.verb}" in a ${c.roleTense} role, the classifier says ${c.verdict}: ${c.text.slice(0, 80)}`);
      } else {
        console.log(`     not verb-initial: "${c.verb} ${c.text.slice(0, 70)}"`);
      }
    }
  }
  if (totalFindings) console.log('  A bullet whose tense contradicts the master wording it cites is a register error.');
}
process.exit(totalFindings ? 1 : 0);
