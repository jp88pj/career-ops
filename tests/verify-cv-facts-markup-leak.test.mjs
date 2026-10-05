// Prove the guard catches the REAL defect and does not fire on honest prose.
// The tainted fixture is the actual leaked line from
// output/cv-jonathan-presser.html, not a reconstruction.
import { findMarkupLeaks, verifyFacts } from '../verify-cv-facts.mjs';

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// The literal leaked line, exactly as it appeared in the rendered artifact.
const LEAK = '> **REPLAY OPERATOR SCOPE CORRECTED (2026-09-29) - READ BEFORE REUSING** > The user confirmed this role did **not** involve making or explaining rulings';

console.log('  === catches the real defect ===');
const hits = findMarkupLeaks(LEAK, LEAK.replace(/\*\*/g, ''));
ok(hits.length >= 2, `two independent signals fired (got ${hits.length}): ${hits.join(' | ').slice(0, 90)}`);
ok(hits.some((h) => /blockquote/.test(h)), 'blockquote signal');
ok(hits.some((h) => /annotation/.test(h)), 'QA-vocabulary signal');

console.log('');
console.log('  === does NOT fire on honest prose ===');
const CLEAN = [
  ['a > b comparison', 'Reduced cycle time by routing intake A > B and logging the delta.'],
  ['percent over threshold', 'Improved pass rate to > 90% of enrolled students.'],
  ['angle bracket in prose', 'Enrolled students with IEPs and 504 plans (p<0.001 in trials).'],
  ['a normal bullet', 'Coordinated daily scheduling and staff coverage across multiple sites.'],
  ['a quoted employer phrase', 'Supported a "for purpose" mission in mental healthcare.'],
  ['an empty doc', ''],
];
for (const [label, text] of CLEAN) {
  const h = findMarkupLeaks(text, text);
  ok(h.length === 0, `no false positive: ${label}${h.length ? ' -> ' + h.join(';') : ''}`);
}

console.log('');
console.log('  === the guard BLOCKS, it does not warn ===');
// A document with no invented claims and no forbidden phrases, but a leaked
// annotation, must still come back 'block'.
const doc = `${LEAK}\nCoordinated daily scheduling and staff coverage across multiple sites.`;
const r = verifyFacts(doc, { sourcePaths: [], configPath: 'config/cv-facts.json' });
ok(r.verdict === 'block', `verdict is block (got ${r.verdict})`);
ok(Array.isArray(r.markupLeaks) && r.markupLeaks.length > 0, `markupLeaks reported: ${r.markupLeaks?.length}`);

console.log('');
console.log('  === a clean document is unaffected ===');
const cleanDoc = 'Coordinated daily scheduling and staff coverage across multiple program sites.';
const r2 = verifyFacts(cleanDoc, { sourcePaths: [], configPath: 'config/cv-facts.json' });
ok(!r2.markupLeaks || r2.markupLeaks.length === 0, 'no leaks on a clean doc');
ok(r2.verdict !== 'block', `clean doc does not block (got ${r2.verdict})`);

console.log('');
console.log(`  ${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
