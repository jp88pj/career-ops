import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getCareerOpsRoot } from "../path-resolver.mjs";

// Reconcile the pipeline inbox after the workers finish.
//
// modes/pipeline.md step 2f: "Only a completed evaluation moves from 'Pending'
// to 'Processed': `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`"
//
// The workers are told not to touch data/pipeline.md, because eight of them
// writing the same file concurrently is a race. This does it once, afterwards,
// from their tracker TSVs - which carry the report number, the company, the
// role, the score and whether a PDF was produced.
//
// Usage: node reconcile-pipeline.mjs [--dry-run]

const dryRun = process.argv.includes("--dry-run");

// The data root is resolved through path-resolver.mjs, NOT through the
// current directory and NOT through __dirname. The root can be overridden
// (CAREER_OPS_ROOT, CAREER_OPS_DATA_DIR, or the .career-ops-data marker) and
// can live OUTSIDE this repository - and merge-tracker.mjs, which produces
// the tracker rows this script reconciles, writes the additions and the
// pipeline under THAT root. A hardcoded "data/pipeline.md" therefore read a
// different inbox (or none at all) in such an install, and the reconciliation
// silently reconciled nothing.
const DATA_ROOT = getCareerOpsRoot();
const ADDITIONS = join(DATA_ROOT, "batch/tracker-additions");
// merge-tracker.mjs MOVES a TSV to batch/tracker-additions/merged/ once it has
// been merged, so the reconciler has to look in both places - the order matters:
// the merge has to happen first (it produces the tracker rows), and the
// reconciliation second (it moves the inbox entries).
const DIRS = [ADDITIONS, `${ADDITIONS}/merged`];

if (!existsSync(ADDITIONS)) { console.error("no batch/tracker-additions directory"); process.exit(1); }

// the TSVs the workers wrote
const rows = [];
for (const dir of DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsv"))) {
    const lines = readFileSync(`${dir}/${f}`, "utf-8").split("\n").filter((l) => l.trim());
    if (lines.length < 2) continue;
    const header = lines[0].split("\t").map((h) => h.trim());
    const data = lines[1].split("\t").map((d) => d.trim());
    const rec = Object.fromEntries(header.map((h, i) => [h, data[i] ?? ""]));
    if (!rec.url) continue;
    rows.push({ file: f, ...rec });
  }
}

if (!rows.length) { console.log("  no tracker additions to reconcile"); process.exit(0); }

// the pending lines they correspond to
const path = join(DATA_ROOT, "data/pipeline.md");
const lines = readFileSync(path, "utf-8").split("\n");

const done = [];
const kept = [];
for (const line of lines) {
  const m = line.match(/^\s*-\s*\[ \]\s*(https?:\/\/[^\s|]+)/);
  const match = m ? rows.find((r) => r.url === m[1]) : null;
  if (match) {
    const num = (match.report || "").match(/\[(\d+)\]/)?.[1] || "";
    const score = match.score || "";
    const pdf = /✅|yes|true/i.test(match.pdf) ? "✅" : "❌";
    const company = match.company || "";
    const role = match.role || "";
    done.push(`- [x] #${num} | ${match.url} | ${company} | ${role} | ${score} | ${pdf}`);
  } else {
    kept.push(line);
  }
}

// insert into the Processed section, newest first
const h2 = kept.findIndex((l) => /^##\s+Processed\s*$/);
if (h2 < 0) { console.error("no Processed section"); process.exit(1); }
kept.splice(h2 + 1, 0, ...done);

if (!dryRun) writeFileSync(path, kept.join("\n"), "utf-8");

console.log(`  ${done.length} pipeline entr(ies) reconciled to Processed${dryRun ? " (dry run)" : ""}:`);
for (const d of done) console.log("    " + d);
const pending = kept.filter((l) => /^\s*-\s*\[ \]/.test(l)).length;
console.log(`  pending now: ${pending}`);
