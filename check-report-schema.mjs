// check-report-schema.mjs - validate evaluation reports against the CURRENT
// contract, not against an old example.
//
// WHY THIS EXISTS
// Report 062 was used as the shape template for the NYC 56058 evaluation batch,
// and 062 predates the evidence-confidence contract. Every report copied from
// 062's shape was therefore missing `## Verdict (lead)`, `## Score Evidence`
// and the `score_evidence` / `confidence_gaps` / `posting_location` Machine
// Summary keys - which `analyze-patterns.mjs` READS. The content was sound; the
// shape was two releases out of date, and nothing checked.
//
// A report template is not a contract. `batch/batch-prompt.md` and
// `modes/oferta.md` are. This checks against those.
//
// Usage:
//   node check-report-schema.mjs                  # check every report
//   node check-report-schema.mjs --range 310-396  # check one batch
//   node check-report-schema.mjs --all            # include the legacy archive
//   node check-report-schema.mjs --summary        # human-readable table
//   node check-report-schema.mjs --json
//
// Exit: 0 when every checked report conforms, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { getCareerOpsRoot } from './path-resolver.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const REPORTS = path.join(DATA_ROOT, 'reports');

// --- the contract -------------------------------------------------------
// The evidence-confidence contract (score_evidence / confidence_gaps /
// posting_location, plus the `## Verdict (lead)` and `## Score Evidence`
// sections) postdates the entire existing archive: as of this writing NO
// report numbered below CONTRACT_EPOCH carries it, because none was written
// after the contract landed in modes/oferta.md.
//
// So the archive below the epoch is LEGACY, and the guard reports it without
// failing the run - otherwise every invocation would fail on 286 pre-existing
// reports and the guard would be noise. Reports at or above the epoch MUST
// conform, and a failure there exits 1.
//
// The epoch is the first report of the NYC 56058 evaluation batch (310), the
// first run whose reports were expected to satisfy the current contract.
const CONTRACT_EPOCH = 310;

// Machine Summary keys required by batch/batch-prompt.md L448-494.
const REQUIRED_KEYS = [
  'company', 'role', 'score', 'legitimacy_tier', 'archetype', 'final_decision',
  'hard_stops', 'soft_gaps', 'top_strengths', 'risk_level', 'confidence',
  'score_evidence', 'confidence_gaps', 'next_action', 'work_auth',
  'discard_reasons', 'via', 'company_confidential', 'advertised_comp',
  'reports_to', 'posting_location', 'requirement_importance', 'risk_summary',
];

// The five scored dimensions, each with an evidence status.
const SCORE_EVIDENCE_DIMS = ['cv_match', 'north_star', 'compensation', 'culture', 'red_flags'];
const EVIDENCE_STATUSES = ['supported', 'partial', 'unknown'];

// Report body order. The block LETTER is what matters; the title wording
// varies between releases ("## B) CV Match" vs "## B) Match with CV"), so each
// entry is a regex. The two sections that were ADDED by the evidence-
// confidence contract are matched exactly, because their headings are load-
// bearing (the `(lead)` marker is a router key).
const REQUIRED_SECTIONS = [
  { re: /^##\s*Machine Summary\s*$/m, name: '## Machine Summary' },
  { re: /^##\s*A\)/m, name: '## A)' },
  { re: /^##\s*B\)/m, name: '## B)' },
  { re: /^##\s*C\)/m, name: '## C)' },
  { re: /^##\s*D\)/m, name: '## D)' },
  { re: /^##\s*E\)/m, name: '## E)' },
  { re: /^##\s*F\)/m, name: '## F)' },
  { re: /^##\s*G\)/m, name: '## G)' },
  { re: /^##\s*Verdict \(lead\)\s*$/m, name: '## Verdict (lead)' },
  { re: /^##\s*Risk Summary\s*$/m, name: '## Risk Summary' },
  { re: /^##\s*Score Evidence\s*$/m, name: '## Score Evidence' },
];

// The JD archive is required (DATA_CONTRACT.md / AGENTS.md).
const JD_ARCHIVE_RE = /^##\s*Job Description \(archived verbatim\)\s*$/m;

function extractMachineSummary(text) {
  const m = text.match(/##\s*Machine Summary[\s\S]*?```yaml\s*([\s\S]*?)```/);
  if (!m) return { ok: false, reason: 'no Machine Summary yaml fence' };
  try {
    const doc = yaml.load(m[1]);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, reason: 'Machine Summary yaml is not a mapping' };
    }
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, reason: 'Machine Summary yaml does not parse: ' + String(e.message || e).split('\n')[0] };
  }
}

function checkReport(file, text) {
  const findings = [];

  // --- body sections, and their order ---
  const positions = [];
  for (const s of REQUIRED_SECTIONS) {
    const m = text.match(s.re);
    if (!m) { findings.push(`missing section ${s.name}`); positions.push(null); }
    else positions.push(m.index);
  }
  const known = positions.filter((p) => p !== null);
  for (let i = 1; i < known.length; i++) {
    if (known[i] < known[i - 1]) {
      findings.push('section order is wrong (Verdict must follow G, Score Evidence must follow Risk Summary)');
      break;
    }
  }
  if (!JD_ARCHIVE_RE.test(text)) findings.push('missing the ## Job Description (archived verbatim) section');

  // --- Machine Summary ---
  const ms = extractMachineSummary(text);
  if (!ms.ok) {
    findings.push(ms.reason);
    return { file, findings };
  }
  const doc = ms.doc;
  for (const k of REQUIRED_KEYS) if (!(k in doc)) findings.push(`Machine Summary missing key \`${k}\``);

  // score_evidence: five dimensions, each with a valid status.
  const se = doc.score_evidence;
  if (se && typeof se === 'object' && !Array.isArray(se)) {
    for (const d of SCORE_EVIDENCE_DIMS) {
      const v = se[d];
      if (v === undefined) findings.push(`score_evidence missing dimension \`${d}\``);
      else if (typeof v !== 'string' || !EVIDENCE_STATUSES.includes(v.trim().toLowerCase())) {
        findings.push(`score_evidence.${d} must be one of ${EVIDENCE_STATUSES.join('|')}, got ${JSON.stringify(v)}`);
      }
    }
  } else if (se !== undefined) {
    findings.push('score_evidence must be a map of the five dimensions');
  }

  // confidence_gaps: a list (possibly empty).
  if (doc.confidence_gaps !== undefined && !Array.isArray(doc.confidence_gaps)) {
    findings.push('confidence_gaps must be a list');
  }

  // An unverified dimension must name what to check - the contract's tie
  // between the two fields, and the thing that makes a gap actionable.
  if (se && typeof se === 'object' && !Array.isArray(se) && Array.isArray(doc.confidence_gaps)) {
    const unverified = SCORE_EVIDENCE_DIMS.filter((d) => String(se[d] || '').trim().toLowerCase() !== 'supported');
    if (unverified.length && doc.confidence_gaps.length === 0) {
      findings.push(`confidence_gaps is empty but ${unverified.join(', ')} ${unverified.length > 1 ? 'are' : 'is'} not supported`);
    }
  }

  return { file, findings };
}

// --- CLI ---
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const summaryMode = args.includes('--summary');
const checkLegacy = args.includes('--all');
const rangeIdx = args.indexOf('--range');
let lo = null;
let hi = null;
if (rangeIdx !== -1 && args[rangeIdx + 1]) {
  const m = /^(\d+)-(\d+)$/.exec(args[rangeIdx + 1]);
  if (m) { lo = Number(m[1]); hi = Number(m[2]); }
}

const files = fs.existsSync(REPORTS)
  ? fs.readdirSync(REPORTS).filter((f) => f.endsWith('.md')).sort()
  : [];

const results = [];
const legacy = [];
for (const f of files) {
  if (f.includes('RESERVED')) continue; // reservation sentinel, not a report
  const numMatch = /^(\d{3})-/.exec(f);
  if (!numMatch) continue;
  const num = Number(numMatch[1]);
  if (lo !== null && (num < lo || num > hi)) continue;
  const text = fs.readFileSync(path.join(REPORTS, f), 'utf8');
  const r = checkReport(f, text);
  if (num < CONTRACT_EPOCH && !checkLegacy) legacy.push(r);
  else results.push(r);
}

const failing = results.filter((r) => r.findings.length);
const passed = results.length - failing.length;

if (jsonMode) {
  console.log(JSON.stringify({
    contractEpoch: CONTRACT_EPOCH,
    checked: results.length, passed, failed: failing.length,
    legacySkipped: legacy.length,
    failures: failing.map((r) => ({ file: r.file, findings: r.findings })),
  }, null, 2));
} else if (summaryMode) {
  console.log(`  contract epoch: ${CONTRACT_EPOCH}`);
  console.log(`  reports checked: ${results.length}   conforming: ${passed}   failing: ${failing.length}`);
  if (legacy.length) console.log(`  legacy reports below the epoch (not checked): ${legacy.length}`);
  for (const r of failing) {
    console.log(`\n  ${r.file}`);
    for (const x of r.findings) console.log(`      - ${x}`);
  }
} else {
  console.log(`contract epoch: ${CONTRACT_EPOCH}`);
  console.log(`reports checked: ${results.length}  conforming: ${passed}  failing: ${failing.length}`);
  if (legacy.length) console.log(`legacy reports below the epoch (not checked): ${legacy.length}`);
  for (const r of failing.slice(0, 40)) console.log(`  ${r.file}: ${r.findings.length} finding(s) -- ${r.findings[0]}`);
  if (failing.length > 40) console.log(`  ... (+${failing.length - 40} more)`);
}

if (failing.length) process.exit(1);
