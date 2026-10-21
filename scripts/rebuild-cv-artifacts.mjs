#!/usr/bin/env node
/**
 * Rebuild every artefact of a tailored CV from its payload, in one place.
 *
 * Why this exists: a corrected payload is only half a correction. The CV ships
 * as a styled PDF, an ATS-flat PDF, a .docx and a paste-ready .txt, and each
 * of those is a separate render of the same payload. Fixing the payload and
 * leaving the renders stale produces exactly the failure the four CV gates
 * exist to catch - and a stale artefact is the one the user actually uploads.
 *
 * So: one command re-renders the whole set, and the set is derived from the
 * payload's own filenames rather than hard-coded, so a CV cannot end up with
 * one artefact family rebuilt and another left behind.
 *
 * Usage:
 *   node scripts/rebuild-cv-artifacts.mjs --report=NNN [--dry-run] [--ern-scope=cityjobs]
 *   node scripts/rebuild-cv-artifacts.mjs --report=NNN --only=pdf,txt
 *
 * The ATS payload is regenerated from the main payload every time (ats-payload.mjs
 * is a pure transform), so a fix in the main payload can never fail to reach
 * the ATS family.
 *
 * --ern-scope: which platform the CV is FOR, which decides the ERN
 * expectation. The default is 'other' - the ERN must be ABSENT - because
 * cv.md's scope rule allows it on cityjobs postings ONLY, and leaking a
 * municipal employee ID is the documented harm. A cityjobs CV therefore has to
 * say so: --ern-scope=cityjobs. The check reads the rendered PDF, not the
 * HTML, because the employer receives the PDF.
 *
 * Exits non-zero if any step fails. Steps run in order and a failure stops the
 * rest, so a half-built set is never presented as a finished one.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "output");
const ATS_TEMPLATE = resolve(ROOT, "templates/ats/cv-template.ats.html");

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}


// The CLI tail is guarded: 122 of the repo's .mjs files do this, and a
// hand-rolled `process.argv[1]` comparison silently no-ops through a
// symlinked checkout - the process exits 0 having done nothing, which
// every caller reads as success.
function main() {
  const args = process.argv.slice(2);
  const reportArg = args.find((a) => a.startsWith("--report="));
  if (!reportArg) fail("usage: node scripts/rebuild-cv-artifacts.mjs --report=NNN [--dry-run] [--only=pdf,txt]");
  const report = reportArg.split("=")[1];
  if (!/^\d+$/.test(report)) fail(`--report= must be a report number, got "${report}"`);

  const dryRun = args.includes("--dry-run");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  const ernArg = args.find((a) => a.startsWith("--ern-scope="));
  // The SAFE direction: the ERN must be absent unless the CV is for a cityjobs
  // posting and says so. cv.md's scope rule allows the ERN on cityjobs postings
  // ONLY, and leaking a municipal employee ID is the documented harm.
  const ernScope = ernArg ? ernArg.split("=")[1] : "other";
  if (!["other", "cityjobs"].includes(ernScope)) {
    fail(`--ern-scope must be 'other' or 'cityjobs', got "${ernScope}"`);
  }
  const wants = (kind) => !only || only.includes(kind);

  /** Every file in output/ belonging to this report, keyed by family. */
  function resolveArtefacts() {
    if (!existsSync(OUT)) fail("output/ does not exist");
    const prefix = `cv-candidate-${report}-`;
    const files = readdirSync(OUT).filter((f) => f.startsWith(prefix));
    const pick = (re) => files.find((f) => re.test(f));

    // The main payload is the one that is neither the ATS transform nor a cover
    // letter. readdirSync gives no ordering guarantee, so the siblings are
    // excluded by name rather than by position.
    const mainPayload = files.find((f) => f.endsWith(".payload.json") && !f.includes("-ats.") && !f.includes("-cover."));
    if (!mainPayload) fail(`no tailored CV payload for report ${report} in output/`);
    const stem = mainPayload.replace(/\.payload\.json$/, "");
    const at = (name) => resolve(OUT, name);

    return {
      mainPayload: at(mainPayload),
      mainHtml: at(`${stem}.html`),
      mainPdf: at(`${stem}.pdf`),
      docx: at(`${stem}.docx`),
      atsPayload: at(`${stem}-ats.payload.json`),
      atsHtml: at(`${stem}-ats.html`),
      atsPdf: pick(new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-ats-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.pdf$`))
        ? at(pick(new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-ats-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.pdf$`)))
        : at(`${stem}-ats.pdf`),
      atsTxt: at(`${stem}-ats.txt`),
    };
  }

  /** Run a command; never throws, so the caller decides what a failure means. */
  function run(label, cmd, cmdArgs, opts = {}) {
    if (dryRun) {
      console.log(`  [dry-run] ${label}`);
      return { ok: true, stdout: "", stderr: "" };
    }
    const res = spawnSync(cmd, cmdArgs, {
      cwd: ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
    if (res.status !== 0) {
      console.error(`  FAILED: ${label}`);
      console.error((res.stderr || "").split("\n").slice(0, 12).map((l) => `    ${l}`).join("\n"));
      console.error((res.stdout || "").split("\n").slice(0, 12).map((l) => `    ${l}`).join("\n"));
      return { ok: false, stdout: res.stdout || "", stderr: res.stderr || "" };
    }
    console.log(`  ok: ${label}`);
    return { ok: true, stdout: res.stdout || "", stderr: res.stderr || "" };
  }

  const a = resolveArtefacts();
  console.log(`Rebuilding report ${report}${dryRun ? " (dry run)" : ""}:`);
  console.log(`  payload: ${a.mainPayload.replace(ROOT + "\\", "")}`);

  const steps = [];

  // 1. ATS payload: a pure transform of the main payload, stdout only.
  steps.push(() => {
    const r = run("ats-payload (transform)", process.execPath, ["ats-payload.mjs", a.mainPayload]);
    if (!r.ok) return false;
    const findings = (r.stderr || "").trim();
    if (findings) {
      console.log("    ats-payload findings (reported, not applied):");
      for (const line of findings.split("\n").slice(0, 8)) console.log(`      ${line}`);
    }
    if (dryRun) return true;
    writeFileSync(a.atsPayload, r.stdout, "utf-8");
    return true;
  });

  // 2. Styled HTML (default template).
  steps.push(() => run("html (styled)", process.execPath, ["build-cv-html.mjs", a.mainPayload, a.mainHtml]).ok);

  // 3. Styled PDF - carries the report number so the manifest links it to the tracker row.
  steps.push(() => run("pdf (styled)", process.execPath, ["generate-pdf.mjs", a.mainHtml, a.mainPdf, "--format=letter", `--report=${report}`, "--kind=cv", `--ern-scope=${ernScope}`]).ok);

  // 4. .docx - the upload artefact for SmartRecruiters.
  steps.push(() => run("docx", process.execPath, ["build-cv-docx.mjs", a.mainPayload, a.docx]).ok);

  // 5. ATS HTML.
  steps.push(() => run("html (ats)", process.execPath, ["build-cv-html.mjs", a.atsPayload, a.atsHtml, ATS_TEMPLATE]).ok);

  // 6. ATS PDF - no report number, matching how the ATS family is already indexed.
  steps.push(() => run("pdf (ats)", process.execPath, ["generate-pdf.mjs", a.atsHtml, a.atsPdf, "--format=letter", "--kind=cv", `--ern-scope=${ernScope}`]).ok);

  // 7. Paste-ready plain text.
  steps.push(() => run("txt (paste-ready)", process.execPath, ["scripts/export-payload-text.mjs", a.mainPayload, "--out", a.atsTxt]).ok);

  const kinds = ["ats-payload", "html (styled)", "pdf (styled)", "docx", "html (ats)", "pdf (ats)", "txt (paste-ready)"];
  const wanted = kinds.filter((_, i) => wants(kinds[i].split(" ")[0]) || wants("all"));

  let failed = false;
  for (let i = 0; i < steps.length; i++) {
    if (!wanted.includes(kinds[i])) {
      console.log(`  skipped: ${kinds[i]}`);
      continue;
    }
    if (!steps[i]()) {
      failed = true;
      console.error(`\nStopped at "${kinds[i]}" - the artefact set is incomplete.`);
      process.exit(1);
    }
  }

  if (!failed) {
    console.log("\nAll artefacts rebuilt:");
    for (const p of [a.mainPayload, a.mainHtml, a.mainPdf, a.docx, a.atsPayload, a.atsHtml, a.atsPdf, a.atsTxt]) {
      console.log(`  ${p.replace(ROOT + "\\", "")}`);
    }
    console.log("\nNow re-run the gates:  node verify-cv-gates.mjs --report=" + report);
  }

}

if (isMainModule(import.meta.url)) {
  main();
}
