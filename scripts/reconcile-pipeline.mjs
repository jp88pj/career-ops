import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";

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
const ADDITIONS = "batch/tracker-additions";

if (!existsSync(ADDITIONS)) { console.error("no batch/tracker-additions directory"); process.exit(1); }

// the TSVs the workers wrote
const rows = [];
for (const f of readdirSync(ADDITIONS).filter((x) => x.endsWith(".tsv"))) {
  const lines = readFileSync(`${ADDITIONS}/${f}`, "utf-8").split("\n").filter((l) => l.trim());
  if (lines.length < 2) continue;
  const header = lines[0].split("\t").map((h) => h.trim());
  const data = lines[1].split("\t").map((d) => d.trim());
  const rec = Object.fromEntries(header.map((h, i) => [h, data[i] ?? ""]));
  if (!rec.url) continue;
  rows.push({ file: f, ...rec });
}

if (!rows.length) { console.log("  no tracker additions to reconcile"); process.exit(0); }

// the pending lines they correspond to
const path = "data/pipeline.md";
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
