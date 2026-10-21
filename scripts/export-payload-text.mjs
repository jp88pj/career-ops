#!/usr/bin/env node
// export-payload-text.mjs - a tailored CV as paste-ready plain text.
//
// WHY THIS EXISTS
// --------------
// SmartRecruiters' application form auto-parses an uploaded PDF into its own
// fields, and its parser is crude. Measured on the City postings on
// 2026-10-20, uploading the styled CV produced three failures:
//
//   1. the bullet structure and the line breaks were lost in the
//      description fields - the entries arrived as one run-on paragraph;
//   2. the education fields were mangled, because a parser looking at
//      "Master of Education, Education Studies University at Buffalo Graduate
//      School of Education Applied to standards-aligned curriculum
//      development..." has to guess where the degree ends and the school
//      begins;
//   3. the LinkedIn URL did not appear in the form's LinkedIn field.
//
// (1) and (2) are not a PDF problem, they are a text problem: the bullets in
// the PDF are CSS list markers, which a text extractor that ignores CSS
// cannot see, and the education block is four fields the parser has to
// guess at. Plain text has neither problem - the bullet character is a
// character, the line break is a newline, and each education entry is one
// line.
//
// This is the payload-based counterpart of scripts/export-ats-text.mjs, which
// exports the PROFILE and the master cv.md. This one exports the TAILORED
// payload - the version whose bullets and emphasis were chosen for one
// posting - because an application is made with the tailored CV or not at all.
//
// WHAT IT PRODUCES
// ----------------
// Standard ATS headings, one bullet per line with a LITERAL bullet
// character, one education entry per line, and the contact line carrying the
// FULL profile URLs (https:// linkedin.com/...) so a matcher that wants a
// scheme finds one.
//
// Usage:
//   node scripts/export-payload-text.mjs <payload.json> [--out <path>]
//   node scripts/export-payload-text.mjs --report=NNN [--out <path>]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
let payloadPath = '';
let outPath = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') outPath = argv[++i] || '';
  else if (a.startsWith('--out=')) outPath = a.slice(6);
  else if (a.startsWith('--report=')) {
    const num = a.slice(9);
    const hit = readdirSync(join(ROOT, 'output')).find((f) => f.startsWith(`cv-candidate-${num}-`) && f.endsWith('.payload.json') && !f.includes('-cover.'));
    if (!hit) { console.error(`No payload in output/ for report ${num}`); process.exit(2); }
    payloadPath = join(ROOT, 'output', hit);
  } else payloadPath = a;
}

if (!payloadPath) {
  console.error('Usage: node scripts/export-payload-text.mjs <payload.json> [--out <path>]');
  console.error('       node scripts/export-payload-text.mjs --report=NNN [--out <path>]');
  process.exit(2);
}
if (!existsSync(payloadPath)) { console.error(`No such payload: ${payloadPath}`); process.exit(2); }

const p = JSON.parse(readFileSync(payloadPath, 'utf8'));
const c = p.candidate || {};
const L = [];

/** A contact line, with the FULL URLs: a parser that wants a scheme finds one. */
const contact = [
  c.name,
  c.location,
  c.phone,
  c.email,
  c.linkedin?.url || c.linkedin,
  c.portfolio?.url || c.portfolio,
].filter(Boolean);
L.push(contact.join(' | '));
L.push('');

if (p.summary) { L.push('PROFESSIONAL SUMMARY', '', p.summary, ''); }

const SEC = p.sections || {};
if (Array.isArray(p.competencies) && p.competencies.length) {
  L.push((SEC.competencies || 'CORE COMPETENCIES').toUpperCase(), '', ...p.competencies.map((x) => `- ${x}`), '');
}

if (Array.isArray(p.experience) && p.experience.length) {
  L.push((SEC.experience || 'WORK EXPERIENCE').toUpperCase(), '');
  for (const e of p.experience) {
    // One line per role: the header a parser can split on, then the bullets.
    L.push([e.company, e.role, e.location, e.dates || e.period].filter(Boolean).join(' | '));
    for (const b of e.bullets || []) {
      const t = typeof b === 'object' ? b.text : b;
      if (t) L.push(`• ${t}`);
    }
    L.push('');
  }
}

if (Array.isArray(p.projects) && p.projects.length) {
  L.push((SEC.projects || 'PROJECTS').toUpperCase(), '');
  for (const pr of p.projects) {
    L.push([pr.name, pr.url].filter(Boolean).join(' | '));
    if (pr.description) L.push(pr.description);
    for (const b of pr.bullets || []) {
      const t = typeof b === 'object' ? b.text : b;
      if (t) L.push(`• ${t}`);
    }
    L.push('');
  }
}

if (Array.isArray(p.education) && p.education.length) {
  L.push((SEC.education || 'EDUCATION').toUpperCase(), '');
  for (const e of p.education) {
    // ONE line per entry. A four-field block is what the parser mangled.
    L.push([e.title, e.org, e.location, e.year].filter(Boolean).join(' | '));
    if (e.description) L.push(e.description);
    L.push('');
  }
}

if (Array.isArray(p.certifications) && p.certifications.length) {
  L.push((SEC.certifications || 'CERTIFICATIONS').toUpperCase(), '');
  for (const x of p.certifications) {
    L.push([x.title, x.org, x.year].filter(Boolean).join(' | '));
  }
  L.push('');
}

if (Array.isArray(p.skills) && p.skills.length) {
  L.push((SEC.skills || 'SKILLS').toUpperCase(), '');
  for (const s of p.skills) {
    L.push(`${s.category}: ${s.items}`);
  }
  L.push('');
}

const text = L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

if (outPath) {
  writeFileSync(outPath, text, 'utf8');
  const bullets = (text.match(/^• /gm) || []).length;
  const lines = text.split('\n').length;
  console.log(`  wrote ${outPath}  (${lines} lines, ${bullets} literal bullets)`);
} else {
  process.stdout.write(text);
}
