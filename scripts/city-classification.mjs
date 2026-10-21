#!/usr/bin/env node
// The City's own board is the applicant-facing answer on eligibility.
//
// WHY THIS EXISTS. The SmartRecruiters tenant carries a raw customField
// "Title Classification" whose value can be "Pending Classification-2" - the
// DCAS title is not finally classified yet. The SAME posting on the City's own
// board (cityjobs.nyc.gov) publishes a different value for the same field:
// "No exam required". Measured 2026-10-21 on every pending-classification
// posting in wave A:
//
//   posting                     code    ATS metadata            board publishes
//   Volunteer Coordinator       0660A  Pending Classification-2  No exam required
//   Outreach Coordinator        0660A  Pending Classification-2  No exam required
//   Community Liaison           0668A  Pending Classification-2  No exam required
//   Executive Operations Mgr    0527A  Pending Classification-2  No exam required
//   Program Manager, Buildings  0527A  Pending Classification-2  No exam required
//
// and the field DISCRIMINATES - the same reader returns "Exam may be required"
// for competitive-1 postings (Facility Manager 10124, Permit Coordinator 21538,
// Circular Economy Program Manager 10043). So the board's value is the employer's
// answer as published, and "Pending" in the ATS is a forward-looking risk (the
// title could still be reclassified), not a present bar.
//
// HOW IT GETS THERE. The board's /jobs?* search is CLIENT-SIDE and robots.txt
// disallows it, so the permitted route is the vacancies sitemap:
//   https://cityjobs.nyc.gov/vacanciessitemap.xml   (1,625 postings)
// then the board page itself, whose classification is server-rendered.
//
// Usage:
//   node scripts/city-classification.mjs                 # every posting, classified
//   node scripts/city-classification.mjs <url> [<url>..] # just these
//   node scripts/city-classification.mjs --json

import { execFileSync } from "node:child_process";

const SITEMAP = "https://cityjobs.nyc.gov/vacanciessitemap.xml";
const BOARD = "https://cityjobs.nyc.gov";
const UA = "Mozilla/5.0 (compatible; career-ops/1.0)";

const fetchText = (url) => {
  try {
    return execFileSync("curl.exe", ["-s", "-L", "--max-time", "45", "-A", UA, url], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return "";
  }
};

// The board's markup, measured 2026-10-21 on a live posting:
//
//   <li class="TitleClassification-wrapper">
//     <label class="TitleClassification"> Title Classification: </label> No exam required
//   </li>
//   <script> document.body.className += " titleclassification-noexamrequired"; </script>
//
// So the classification is the text AFTER the </label>, and the page also
// stamps a machine-readable class on <body> - which is the stronger read,
// because it cannot be confused with the metadata block's raw value.
const htmlEntities = (s) =>
  s
    .replace(/&#x2013;/g, "-")
    .replace(/&#x2014;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();

const classificationOf = (html) => {
  const after = (html.match(/class="TitleClassification"[^>]*>[^<]*<\/label>\s*([^<]{1,60})/i) || [])[1] || "";
  const bodyClass = (html.match(/titleclassification-([a-z]+)/i) || [])[1] || "";
  return {
    value: htmlEntities(after),
    bodyClass,
  };
};

// The board's other fields are name/value pairs:
//   <p class="...-field-name"> Job ID </p> <p class="...-field-value">775042</p>
const pairValue = (html, nameRe) => {
  const re = new RegExp(
    `class="[^"]*-field-name"[^>]*>\\s*${nameRe.source}\\s*</p>\\s*<p class="[^"]*-field-value"[^>]*>\\s*([^<]{1,120})`,
    "i",
  );
  return htmlEntities((html.match(re) || [])[1] || "");
};

const loadSitemap = () => {
  const xml = fetchText(SITEMAP);
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
};

const readBoardPage = (url) => {
  const html = fetchText(url);
  const cls = classificationOf(html);
  return {
    url,
    title: htmlEntities((html.match(/<title>([^<]{3,140})<\/title>/i) || [])[1] || ""),
    titleCode: pairValue(html, /Title\s*code/i),
    classification: cls.value || cls.bodyClass,
    bodyClass: cls.bodyClass,
    postedUntil: pairValue(html, /Posted\s*until/i),
    department: pairValue(html, /Department/i),
    salaryRange: pairValue(html, /Salary\s*range/i),
    jobId: pairValue(html, /Job\s*ID/i),
  };
};

const slugOf = (u) => {
  const m = u.match(/CityOfNewYork\/(\d+)(?:-(.*))?/i);
  if (!m) return null;
  return m[2] || "";
};

const main = () => {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const targets = args.filter((a) => !a.startsWith("--"));
  const sm = loadSitemap();
  if (!sm.length) {
    console.error("city-classification: the vacancies sitemap returned nothing");
    process.exit(2);
  }

  let pages = [];
  if (targets.length) {
    for (const t of targets) {
      const slug = slugOf(t) || "";
      // The board slug is "<title-slug>-in-<borough>-jid-<n>", so an exact slug
      // prefix is the reliable match. A looser "contains the first word" match
      // can land on a DIFFERENT posting ("Facility Manager" vs "Facility
      // Manager Assistant"), so it is flagged rather than trusted.
      const exact = slug ? sm.find((l) => l.includes(`/job/${slug}-`)) : "";
      const loose = slug ? sm.find((l) => l.includes(slug.split("-")[0])) : "";
      const hit = exact || loose || t;
      const page = readBoardPage(hit);
      page.match = exact ? "exact" : loose ? "LOOSE" : "direct";
      pages.push(page);
    }
  } else {
    // Every posting is a fetch; this is the "how does the board classify
    // everything" view, and it is slow on purpose - it is not a scan path.
    for (const l of sm) pages.push(readBoardPage(l));
  }

  if (asJson) {
    console.log(JSON.stringify(pages, null, 2));
    return;
  }
  const exam = pages.filter((p) => /exam may be required/i.test(p.classification)).length;
  console.log(`  postings read: ${pages.length}`);
  console.log(`  exam may be required: ${exam}`);
  console.log(`  no exam required    : ${pages.length - exam}`);
  for (const p of pages.slice(0, 40)) {
    console.log(`    ${String(p.titleCode || "?").padEnd(8)} ${String(p.classification || "?").padEnd(24)} ${String(p.postedUntil || "?").padEnd(12)} ${p.title.slice(0, 46)}`);
  }
};

main();
