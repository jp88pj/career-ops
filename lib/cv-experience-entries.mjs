/**
 * lib/cv-experience-entries.mjs - ONE reader for a CV's Experience entries.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three separate checks need to read the same thing - the entries of a CV's
 * Experience section, with their company, title, location, dates and bullets:
 *
 *   - cv-title-check.mjs, which pairs a tailored CV's {company, dates} against
 *     the master's canonical entry and flags a job-title mismatch;
 *   - scripts/check-cv-tense.mjs, which needs each bullet's role and the
 *     master's own bullets to know which tense a bullet should carry;
 *   - verify-cv-structure.mjs, which checks that a rendered CV keeps the
 *     master's entries in order.
 *
 * When each of them parsed the master its own way, they disagreed, and the
 * disagreement was SILENT. The concrete cost, measured on 2026-10-21:
 * `parseCvExperience` returned **zero** entries for cv.md, because cv.md
 * writes an entry's title, location and dates on one line
 *
 *     **Urban Park Service Security** | New York, NY | Dec 2025 - Present
 *
 * while the canonical `boldLineText()` accepts only a line that is bold FROM
 * END TO END - a partly bold line is deliberately not a title line. So the
 * title check had never run on any tailored CV: every one of them reported
 * "cv.md entries could not be parsed - title check did not run", with 11 to 13
 * entries unchecked. A gate that cannot read its input reports nothing, and
 * nothing reads as a pass.
 *
 * THE TWO SHAPES
 * --------------
 * The documented shape (examples/cv-example.md, and what AGENTS.md asks for):
 *
 *     ### TechFin Corp -- Austin, TX
 *
 *     **Senior ML Engineer / ML Platform Lead**
 *     2020-2024
 *
 *     - Led ML platform team (3 engineers) ...
 *
 * The master's shape (cv.md): the title line carries the location and the
 * dates as pipe-separated fields, and the entry has no blank lines.
 *
 * Both are read here, and both are read by the SAME function, so a check that
 * uses this reader and a check that does not cannot disagree about what an
 * entry is. Adding a third shape means adding it here, once.
 *
 * The primitives - `findExperienceSections`, `headingText`, `boldLineText`,
 * `toPlainText`, `parseCompanyHeading` - come from lib/cv-markdown.mjs, so
 * this reader inherits the Pandoc handling and the accepted section names
 * rather than re-implementing them.
 */

import {
  findExperienceSections,
  headingText,
  boldLineText,
  toPlainText,
  parseCompanyHeading,
} from './cv-markdown.mjs';

/** A role whose dates say it is still running. */
const CURRENT_DATES_RE = /\b(present|current|ongoing)\b/i;

/** A year, which is what distinguishes a dates field from a location field. */
const YEAR_RE = /\b(19|20)\d{2}\b/;

/** A list item, at any indentation. */
const LIST_ITEM_RE = /^(?:[-*]|\d+\.)\s+/;

/**
 * Is this line a DATES line on its own?
 *
 * It has to be a date range and nothing else. The looser test - "contains a
 * year" - matched a paragraph of prose that happened to mention 2026-10-11,
 * and a paragraph is not a date.
 */
function looksLikeDatesLine(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 40) return false;
  if (/[.,:;]/.test(t)) return false;
  if (!YEAR_RE.test(t)) return false;
  return /[-–—]/.test(t) || /^\(?\d{4}\)?$/.test(t);
}

/**
 * Is this role current? The tense of a bullet follows its role, so every
 * register check needs the same answer to this question.
 *
 * @param {string} dates
 * @returns {boolean}
 */
export function isCurrentDates(dates) {
  return CURRENT_DATES_RE.test(String(dates ?? ''));
}

/**
 * Split a title line that carries extra pipe-separated fields:
 * `**Title** | Location | Dec 2025 - Present`.
 *
 * The field carrying a 4-digit year is the dates; any other field is the
 * location. Deciding by the year rather than by position means a line with
 * only a title and a dates field (`**Title** | 2020-2024`) works too, and one
 * whose order differs works as well.
 */
function splitTitleLine(line) {
  const m = String(line ?? '').match(/^(\*\*|__)(.+?)\1\s*(.*)$/);
  if (!m) return null;
  // The bold run must close before the pipes: `**Title** | Location`.
  const afterBold = m[3].trim();
  // A SECOND bold run means this is not a title line at all. The canonical
  // rule (lib/cv-markdown.mjs's boldLineText) is that a line which is only
  // partly bold is not a title line, and the master's own title line carries
  // plain location and dates: `**Title** | New York, NY | Dec 2025 - Present`.
  // A line like `**Senior Engineer** | **Acme**` is not a title, and an entry
  // that cannot be read is skipped rather than guessed at - a checker that
  // invents a comparison side is worse than one that reports nothing.
  if (/(\*\*|__)/.test(afterBold)) return null;
  const title = toPlainText(m[2]);
  if (!title) return null;
  const fields = afterBold ? afterBold.split('|').map((f) => toPlainText(f)).filter(Boolean) : [];
  let dates = null;
  let location = null;
  for (const f of fields) {
    if (YEAR_RE.test(f) && !dates) dates = f;
    else if (!location) location = f;
  }
  return { title, dates, location };
}

/**
 * An ATX heading of the given level, tolerating indentation.
 *
 * cv.md nests one role INSIDE another (the Major League Baseball entry is
 * indented two spaces under Newark Public Schools, because the two roles
 * overlap), so a heading that is not at column 0 is still a heading. The
 * canonical headingText() requires column 0, which is right for a document
 * and wrong for this one.
 */
function headingTextIndented(line, level) {
  const m = String(line ?? '').match(new RegExp(`^\\s*#{${level}}\\s+(.+?)\\s*$`));
  if (!m) return null;
  const text = m[1].replace(/\s*\{[^}]*\}\s*$/, '').replace(/\s+#+\s*$/, '');
  return toPlainText(text);
}

/** The indentation of a line, in spaces. */
function indentOf(line) {
  const m = String(line ?? '').match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/**
 * The entries of a CV's Experience sections.
 *
 * Each entry is:
 *   { company, title, location, dates, current, bullets: [string] }
 * where `current` is whether the role is still running, and `bullets` are the
 * entry's OWN bullets.
 *
 * THREE SHAPES, all of them the master's:
 *
 * 1. The documented shape (examples/cv-example.md): a `### Company -- Location`
 *    heading, a bold `**Title**` line, a dates line, then the bullets.
 * 2. The master's shape: the title, location and dates share one line,
 *    `**Title** | Location | Dates`.
 * 3. A SECOND ROLE under the same employer, with no heading of its own - the
 *    Data Science Teacher line under Newark Public Schools - and a NESTED
 *    entry, indented under its parent - the Major League Baseball entry.
 *
 * An entry's own bullets are the list items at the entry's own indentation.
 * An annotation is a list item that is indented further, or that opens with a
 * bolded provenance label (`**User-stated 2026-10-08 (what this period
 * was):**`), and an annotation is never a duty.
 *
 * @param {string} cvText raw cv.md content
 */
export function parseExperienceEntries(cvText) {
  const entries = [];
  const sections = findExperienceSections(cvText);

  for (const lines of sections) {
    let company = null;
    let heading = null;
    let headingLocation = null;
    let entry = null;

    const startEntry = (title, location, dates) => {
      entry = {
        company: company ?? title,
        // The FULL heading, for a heading whose dash is part of the employer's
        // name - "### TEFL — Practicum (My Culture Connect) and Freelance
        // Tutoring" - which the canonical split reads as a company/location
        // pair.
        heading,
        title,
        // The location the HEADING carries wins over the one the title line
        // carries: "### TechFin Corp -- Austin, TX" puts it in the heading,
        // and the title line's own field is the employer's name.
        location: headingLocation ?? location ?? null,
        dates,
        current: isCurrentDates(dates),
        bullets: [],
        indent: null,
      };
      entries.push(entry);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // A level-3 heading opens a new employer, at any indentation.
      const h = headingTextIndented(line, 3);
      if (h !== null) {
        const info = parseCompanyHeading(line.trim());
        company = info ? info.company : h.split(/\s+[—–-]{1,2}\s+/)[0].trim();
        headingLocation = info ? info.location : null;
        heading = h;
        entry = null;
        continue;
      }

      // A list item is never a title or a dates line. Trimming the marker
      // first would make an annotation such as "- **User-stated 2026-10-08
      // (what this period was):** ..." look exactly like a bold title, and an
      // annotation read as a title is how the reader ends up with a role
      // called "Recorded gaps in this role (stated 2026-10-08, not inferred)".
      if (LIST_ITEM_RE.test(line.trim())) {
        // ...but a list item at the entry's own indentation is one of its
        // bullets, and an annotation is not.
        if (entry) {
          const indent = indentOf(line);
          const atEntryLevel = entry.indent === null || indent === entry.indent;
          if (atEntryLevel && !isAnnotationLine(line)) {
            entry.bullets.push(toPlainText(line.trim().replace(LIST_ITEM_RE, '')));
          }
        }
        continue;
      }

      // A title line: bold alone, or bold with pipe-separated fields.
      const piped = splitTitleLine(line.trim());
      const bold = boldLineText(line.trim());
      const title = piped && piped.title ? piped.title : bold;
      if (title) {
        let location = piped ? piped.location : null;
        let dates = piped ? piped.dates : null;
        // The documented shape puts the dates on the NEXT line.
        if (!dates) {
          for (let k = i + 1; k < lines.length && k <= i + 3; k++) {
            const next = lines[k].trim();
            if (!next) continue;
            if (LIST_ITEM_RE.test(next) || headingTextIndented(next, 3) !== null) break;
            if (looksLikeDatesLine(next)) { dates = toPlainText(next); break; }
            break;
          }
        }
        if (dates) {
          startEntry(title, location, dates);
          entry.indent = indentOf(line);
        }
        continue;
      }

      // A dates line on its own (the documented shape) belongs to the entry
      // above it.
      if (looksLikeDatesLine(line) && entry) {
        entry.dates = toPlainText(line);
        entry.current = isCurrentDates(entry.dates);
      }
    }
  }

  return entries;
}

/**
 * Is this list line an ANNOTATION rather than a duty bullet?
 *
 * The master marks every annotation with a bolded label - the provenance
 * ("**User-stated 2026-10-08 (what this period was):**", "**CAMERA COUNT -
 * user-confirmed figure:**", "**CORRECTED 2026-10-08 by the user:**") - and a
 * duty bullet never starts that way. Measured across cv.md on 2026-10-21: of
 * the 39 column-0 list items inside the Experience sections, **none** begins
 * with `**`; of the 137 column-0 list items in the whole file, 80 do.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isAnnotationLine(line) {
  return /^(?:[-*]|\d+\.)\s+\*\*/.test(String(line ?? ''));
}

/**
 * The first word of a line, stripped of list markers and emphasis.
 *
 * @param {string} line
 * @returns {string}
 */
export function leadingWord(line) {
  const t = toPlainText(String(line ?? '').replace(/^(?:[-*]|\d+\.)\s+/, ''));
  return (t.match(/^([A-Za-z]+)/) || [])[1] || '';
}

/**
 * The morphological fallback: the tense of a verb FORM, with no master
 * involved.
 *
 * Deliberately minimal - "-ed" is past, a third-person "-s" is present. A
 * looser rule ("any word ending in 's' is present") reads *Parks* and
 * *Mathematics* as verbs, and a gate that cries wolf gets ignored.
 *
 * @param {string} word
 * @returns {'present'|'past'|null}
 */
export function formTense(word) {
  if (!word) return null;
  const key = word[0].toUpperCase() + word.slice(1);
  if (/ed$/.test(key)) return 'past';
  if (/[^s]s$/.test(key)) return 'present';
  return null;
}

/**
 * The master's own register: its duty bullets, the tense each one carries, and
 * the verb vocabulary that implies.
 *
 * WHY IT IS BUILT HERE AND NOT IN A GATE
 * ---------------------------------------
 * The tense of a duty follows the role it sits in - the master writes a
 * current role in the present ("Educate", "Respond", "Uphold") and a finished
 * role in the past ("Oversaw", "Taught", "Delivered"). That rule lives in the
 * master, so the vocabulary of verb forms and their tense is DERIVED from the
 * master rather than kept in a hand-written table beside it. A table can
 * disagree with the master and the disagreement is invisible; a table
 * derived from the master cannot.
 *
 * A gate that uses this gets two things for free: the sanctioned
 * completed-event verbs (the master's own "Completed PEP academy training" is
 * past, in a role it also writes in the present), and a cross-check - if a
 * gate's own classifier disagrees with the master about a verb, the master is
 * right and the classifier is reported.
 *
 * @param {string} cvText raw cv.md content
 * @returns {{entries: Array, duties: Array<{text: string, verb: string, tense: string, role: string|null, inEntry: boolean}>, verbTense: Map<string, string>}}
 */
export function buildMasterRegister(cvText) {
  const entries = parseExperienceEntries(cvText);
  const duties = [];
  const verbTense = new Map();

  for (const entry of entries) {
    for (const text of entry.bullets) {
      const verb = leadingWord(text);
      if (!verb) continue;
      const tense = entry.current ? 'present' : 'past';
      duties.push({ text, verb, tense, role: entry.title, inEntry: true });
      // The master is the authority: a form it writes in two registers is a
      // conflict to report, not a definition to pick from.
      const prior = verbTense.get(verb);
      if (prior && prior !== tense) verbTense.set(verb, 'conflict');
      else if (!prior) verbTense.set(verb, tense);
    }
  }

  // The master's duty lines OUTSIDE the Experience sections sanction a
  // completed event that the house rule folds into a current role - "Completed
  // **PEP academy training**", "Trained on NYS penal law". Their tense comes
  // from the form itself, because there is no role line beside them.
  for (const block of buildMasterBlocks(cvText)) {
    if (!block.duty) continue;
    const verb = leadingWord(block.text);
    if (!verb || verbTense.has(verb)) continue;
    const tense = formTense(verb);
    if (!tense) continue;
    verbTense.set(verb, tense);
    duties.push({ text: block.text, verb, tense, role: null, inEntry: false });
  }

  return { entries, duties, verbTense };
}

/**
 * The master document as list-item BLOCKS: a list item plus the continuation
 * lines that belong to it.
 *
 * A block is the unit a bullet can be traced to, and it carries the one
 * distinction the master itself makes:
 *
 *   - a DUTY: the master's own statement of what the work was. "Educate
 *     members of the public...", "Completed **PEP academy training**...". A
 *     duty opens with its verb, sits at the top level of the list, and the
 *     tailored CV takes its register from it.
 *   - an ANNOTATION: the record - a note to the reader of cv.md, usually
 *     opening with a bolded provenance label, and usually indented under the
 *     duty it annotates. "**Operators are the FIRST RESPONDERS for ALL replay
 *     reviews across MLB games**" describes the ROLE in general, in the
 *     present, and a CV bullet about what HE did is correctly in the past.
 *     An annotation therefore does not carry a bullet's register; the bullet's
 *     ROLE does.
 *
 * @param {string} cvText raw cv.md content
 * @returns {Array<{text: string, from: number, to: number, indent: number, duty: boolean, annotation: boolean}>}
 */
export function buildMasterBlocks(cvText) {
  const lines = String(cvText ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    if (!LIST_ITEM_RE.test(lines[i].trim())) { i++; continue; }
    const parts = [lines[i].trim().replace(LIST_ITEM_RE, '')];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].trim();
      if (!next) break;
      if (LIST_ITEM_RE.test(next)) break;
      if (/^#{1,6}\s+/.test(next)) break;
      parts.push(next);
      j++;
    }
    const indent = indentOf(lines[i]);
    const startsBold = /^(?:[-*]|\d+\.)\s+\*\*/.test(lines[i].trim());
    blocks.push({
      text: parts.join(' ').replace(/\s+/g, ' ').trim(),
      from: i,
      to: j,
      indent,
      // A duty is a top-level list item. An indented item is the record, not
      // the work. A top-level item that opens with a bolded label is still a
      // duty when the master states the work in it - "- **Trained on NYS penal
      // law, ...** so that a summons narrative **holds up if challenged by
      // the respondent**" is a claim, and the record's own provenance note
      // follows it.
      duty: indent === 0,
      annotation: indent > 0,
    });
    i = j;
  }
  return blocks;
}
