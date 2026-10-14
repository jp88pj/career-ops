// tests/cv-payload-shape-and-section-order.test.mjs — regression coverage for the
// two silent-failure classes found while building a tailored CV on 2026-10-13.
//
// WHY THIS EXISTS
//
// 1. TYPE BLINDNESS. build-cv-html.mjs substitutes `escapeHtml(payload.summary || '')`.
//    A payload that sets `summary` to `{text, source_anchor}` stringifies to
//    "[object Object]" — or, in the observed case, rendered as nothing at all. The
//    build exited 0 and the fact check PASSED, because the fact check inspects HTML
//    that never contained the prose. Three payloads had it; two of them (#261, #267)
//    were Applied to an employer with no Professional Summary section on the page.
//    Nothing in the pipeline complained.
//
// 2. SECTION REORDER LOSING MARKUP. Slicing the template's <div class="section">
//    blocks and rejoining them dropped everything before the first section — doctype,
//    <html>, <head>, the style block and the name/contact header — and let the final
//    block run to EOF, swallowing </body></html>. Both produced a "successful" build
//    with a destroyed document.
//
// Neither class can be caught by exit code alone, so each asserts on OUTPUT.

import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\ncv payload shape guard + section_order — silent-failure regression coverage');

const work = mkdtempSync(join(tmpdir(), 'cops-shape-'));

const CANDIDATE = {
  name: 'Test Person',
  email: 't@example.com',
  phone: '555-0100',
  location: 'New York, NY',
  linkedin: 'linkedin.com/in/test',
  portfolio: '',
  github: '',
};

const BASE = {
  candidate: CANDIDATE,
  summary: 'A plain string summary that should render as prose.',
  competencies: ['Communication', 'Records Management'],
  experience: [
    {
      company: 'Acme',
      role: 'Coordinator',
      location: 'New York, NY',
      period: '2020 - Present',
      bullets: [{ text: 'Did a documented thing.', source_anchor: 'anchor' }],
    },
  ],
  projects: [],
  education: [],
  certifications: [],
  skills: [{ category: 'Tools', items: ['Excel'] }],
};

function build(payload, outName = 'out.html') {
  const pj = join(work, 'p.json');
  const out = join(work, outName);
  writeFileSync(pj, JSON.stringify(payload, null, 2), 'utf8');
  const res = spawnSync(NODE, [join(ROOT, 'build-cv-html.mjs'), pj, out], {
    encoding: 'utf-8',
    timeout: 60000,
  });
  return { res, out };
}

try {
  // ---------------------------------------------------------------- 1
  // A summary object must STOP the build, naming the fix.
  const bad = build({ ...BASE, summary: { text: 'prose', source_anchor: 'x' } });
  const badErr = `${bad.res.stdout || ''}${bad.res.stderr || ''}`;

  if (bad.res.status !== 0) {
    pass('object summary exits non-zero');
  } else {
    fail(`object summary exited 0 — a type-blind build that ships a broken document (status ${bad.res.status})`);
  }
  if (/summary must be a string/i.test(badErr)) {
    pass('object summary is named in the error');
  } else {
    fail(`error does not name the summary type problem; got: ${JSON.stringify(badErr.slice(0, 300))}`);
  }
  if (/source_anchor/i.test(badErr) && /_meta/i.test(badErr)) {
    pass('error points at the {text, source_anchor} -> _meta fix');
  } else {
    fail('error does not tell the caller where provenance belongs');
  }

  // ---------------------------------------------------------------- 2
  // A correct string summary must actually reach the document.
  const good = build({ ...BASE });
  const fsmod = await import('node:fs');
  const okHtml = fsmod.existsSync(good.out) ? fsmod.readFileSync(good.out, 'utf8') : '';

  if (good.res.status === 0 && /A plain string summary that should render as prose\./.test(okHtml)) {
    pass('string summary renders as prose in the document');
  } else {
    fail('string summary did not render — substitution may be type-blind again');
  }
  if (!/\[object Object\]/.test(okHtml)) {
    pass('no [object Object] anywhere in the output');
  } else {
    fail('document contains "[object Object]"');
  }

  // ---------------------------------------------------------------- 3
  // section_order must move a section WITHOUT destroying the document.
  const ordered = build(
    {
      ...BASE,
      summary: 'SUMMARYMARKER prose.',
      section_order: ['summary', 'experience', 'skills', 'competencies'],
    },
    'ordered.html',
  );
  const orderedHtml = fsmod.existsSync(ordered.out) ? fsmod.readFileSync(ordered.out, 'utf8') : '';

  if (ordered.res.status === 0) {
    pass('section_order build exits 0');
  } else {
    fail(`section_order build failed: ${JSON.stringify((ordered.res.stderr || '').slice(0, 200))}`);
  }

  if (/<html[\s>]/i.test(orderedHtml) && /<\/html>/i.test(orderedHtml)) {
    pass('document retains <html> and closes </html>');
  } else {
    fail('document lost <html>/</html> — section reorder is truncating the file');
  }
  if (/Test Person/.test(orderedHtml)) {
    pass('name/contact header survives the reorder');
  } else {
    fail('name header was dropped — reorder is slicing off pre-section markup');
  }
  if (/<style[\s>]/i.test(orderedHtml)) {
    pass('style block survives the reorder');
  } else {
    fail('style block was dropped by the reorder');
  }

  const order = [...orderedHtml.matchAll(/class="section-title"[^>]*>\s*([^<]+?)\s*</g)].map((m) => m[1].trim());
  if (order.length && order[order.length - 1] === 'Core Competencies') {
    pass('competencies moved to last by section_order');
  } else {
    fail(`expected Core Competencies last, got ${JSON.stringify(order)}`);
  }
  if (order[0] === 'Professional Summary') {
    pass('summary stays first');
  } else {
    fail(`expected Professional Summary first, got ${JSON.stringify(order)}`);
  }
  // Every named section must survive — a reorder must not drop content.
  for (const want of ['Work Experience', 'Skills', 'Education']) {
    if (order.includes(want)) pass(`section preserved: ${want}`);
    else if (want === 'Education') pass('section preserved: Education (absent from payload, correctly stripped)');
    else fail(`section dropped by reorder: ${want}`);
  }

  // ---------------------------------------------------------------- 4
  // A role with zero bullets renders as a bare employer header — worse than absent.
  const emptyRole = build({
    ...BASE,
    experience: [{ company: 'Ghost Co', role: 'Nothing', location: 'NY', period: '2020 - 2021', bullets: [] }],
  });
  const emptyErr = `${emptyRole.res.stdout || ''}${emptyRole.res.stderr || ''}`;
  if (emptyRole.res.status !== 0 && /zero bullets/i.test(emptyErr)) {
    pass('role with zero bullets is rejected by the shape guard');
  } else {
    fail(`zero-bullet role not rejected (status ${emptyRole.res.status}); it renders as a bare header`);
  }

  // ---------------------------------------------------------------- 5
  // section_order must tolerate a key the template does not have, not explode.
  const unknown = build({ ...BASE, section_order: ['summary', 'nonexistent', 'skills'] }, 'unknown.html');
  if (unknown.res.status === 0) {
    pass('unknown section_order key is ignored rather than fatal');
  } else {
    fail(`unknown section_order key broke the build: ${JSON.stringify((unknown.res.stderr || '').slice(0, 200))}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}