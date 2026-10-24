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
// PAGE IDENTITY IS VERIFIED, NOT ASSUMED (2026-10-22)
// ----------------------------------------------------
// The board's URL slug is NOT unique. It is
//
//     /job/<business-title-slug>-in-<borough>-jid-<board id>
//
// and the same business title recurs across boroughs, divisions and agencies:
// measured 2026-10-22 on a 127-posting sample of the tenant, 46 of the 120
// postings whose title slug matched the board EXACTLY (38%) had SEVERAL board
// pages carrying that slug, and taking the first sitemap hit therefore
// answered the wrong requisition's eligibility question - and the wrong
// answer can be the dangerous one, because a page read as "No exam required"
// clears a seat that the employer had marked Competitive-1.
//
// Measured 2026-10-22 on 127 ATS postings (every 13th of the tenant listing):
// the first-hit resolver returned ANOTHER requisition's page 31 times (24.4%),
// 7 classifications were wrong (5.5%) - 3 of them FALSE CLEARANCES of
// exam-required postings - and 2 more were answered from a page that was not
// the posting's at all.
//
// THE FIX. The board page carries the requisition's JOB ID, and that number
// IS the ATS refNumber for the same requisition:
//
//     board page  ... Job ID 611327      <- read from the page
//     ATS posting ... refNumber 611327   <- the employer's requisition id
//
// So a page is accepted only when its Job ID equals the ATS refNumber of the
// posting being asked about. Every candidate page is fetched and checked; a
// posting with no matching candidate is reported UNRESOLVED, never with
// another requisition's classification.
//
// Usage:
//   node scripts/city-classification.mjs                 # every posting, classified
//   node scripts/city-classification.mjs <url> [<url>..] # just these
//   node scripts/city-classification.mjs --json

import { execFileSync } from "node:child_process";

const SITEMAP = "https://cityjobs.nyc.gov/vacanciessitemap.xml";
const BOARD = "https://cityjobs.nyc.gov";
const ATS_API = "https://api.smartrecruiters.com/v1/companies/CityOfNewYork/postings";
const ATS_TENANT = "CityOfNewYork";
const UA = "Mozilla/5.0 (compatible; career-ops/1.0)";

// How many candidate pages one posting may cost.
//
// The exact-slug tier is bounded by the board itself: measured 2026-10-22, the
// largest number of board pages sharing one title slug was 70, so the cap
// below is above that ceiling and the exact tier is never truncated in
// practice.
//
// The fallback tiers (a title whose slug does not prefix-match the board's)
// match the broadest possible set of pages, so they get a tighter cap. A
// posting still unmatched inside the cap is reported UNRESOLVED - the safe
// direction, because the whole point of the check is that an unmatched
// posting gets NO classification rather than someone else's.
const MAX_EXACT_CANDIDATES = 100;
const MAX_FALLBACK_CANDIDATES = 40;

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

const fetchJson = (url) => {
  const text = fetchText(url);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
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
//
// THE BODY-CLASS READ IS A TRAP. The FIRST "titleclassification-" token in
// the document is the WRAPPER element ("TitleClassification-wrapper"), so a
// plain /titleclassification-([a-z]+)/ match returns the literal string
// "wrapper" on every page - which is what it did until 2026-10-22. The stamp
// is only reachable through the script that sets it, so the read is anchored
// on body.className and the known stamp values are matched literally: an
// unknown stamp is reported as unknown, never as "wrapper".
const htmlEntities = (s) =>
  s
    .replace(/&#x2013;/g, "-")
    .replace(/&#x2014;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();

const KNOWN_STAMPS = ["noexamrequired", "exammayberequired"];

const bodyClassOf = (html) => {
  // The templating engine breaks the string across lines, so the stamp can sit
  // after a newline inside the quoted assignment.
  const stamp = html.match(/body\.className\s*\+?=\s*["'`][^"'`]*?titleclassification-([a-z]+)/i);
  if (stamp && KNOWN_STAMPS.includes(stamp[1].toLowerCase())) return stamp[1].toLowerCase();
  const known = html.match(/titleclassification-(noexamrequired|exammayberequired)/i);
  return known ? known[1].toLowerCase() : "";
};

const classificationOf = (html) => {
  const after = (html.match(/class="TitleClassification"[^>]*>[^<]*<\/label>\s*([^<]{1,60})/i) || [])[1] || "";
  const bodyClass = bodyClassOf(html);
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

// The ATS posting id and the business-title slug, from a public ATS URL:
//   https://jobs.smartrecruiters.com/CityOfNewYork/3743990016330476-special-assistant-intern-operations
const slugOf = (u) => {
  const m = u.match(/CityOfNewYork\/(\d+)(?:-(.*))?/i);
  if (!m) return null;
  return { id: m[1], slug: m[2] || "" };
};

// The ATS tenant listing, loaded once and only when a target needs it.
// It is the source of the refNumber - the employer's requisition id - which
// is the number the board publishes as the page's Job ID.
let atsListingCache = null;
const loadAtsListing = () => {
  if (atsListingCache) return atsListingCache;
  const byId = new Map();
  for (let offset = 0; offset < 5000; offset += 100) {
    const json = fetchJson(`${ATS_API}?limit=100&offset=${offset}&status=PUBLIC`);
    const content = json?.content;
    if (!Array.isArray(content) || content.length === 0) break;
    for (const p of content) {
      if (p?.id && p?.refNumber) byId.set(String(p.id), String(p.refNumber));
    }
    if (content.length < 100) break;
  }
  atsListingCache = byId;
  return byId;
};

// The requisition id for one ATS posting. The listing covers the whole tenant
// in one pass; a posting released after that pass was read is fetched on its
// own, so a fresh posting is still verifiable rather than silently unresolved.
const atsRefNumber = (postingId) => {
  const found = loadAtsListing().get(String(postingId));
  if (found) return found;
  const detail = fetchJson(`${ATS_API}/${encodeURIComponent(postingId)}`);
  const ref = detail?.refNumber;
  return ref ? String(ref) : "";
};

// Candidate board pages for one business-title slug, best tier first.
//
// TIER 1 - exact: every sitemap page whose slug starts with the ATS slug.
//   This is the tier that fires for ~94% of postings, and it is the tier that
//   used to take the FIRST hit and answer with the wrong requisition.
//
// TIER 2 - distinctive token: the board's own title can differ from the ATS
//   one (a truncated tail, "and" vs "&"), so the slug prefix misses. The
//   rarest DISTINCTIVE word of the ATS title is used instead: it is the word
//   most likely to survive into the board's slug without matching a hundred
//   unrelated pages.
//
// TIER 3 - first word: the legacy fallback, kept as the last resort and
//   capped, because it matches the broadest possible set of pages.
//
// Every candidate is verified by Job ID afterwards, so a broad tier cannot
// produce a wrong answer - it can only cost requests.
const STOPWORDS = new Set(["of", "and", "the", "for", "in", "a", "an", "to", "with", "or", "at", "on", "by"]);

const candidatesFor = (sitemap, slug) => {
  if (!slug) return { tier: "direct", urls: [] };
  const exact = sitemap.filter((l) => l.includes(`/job/${slug}-`));
  if (exact.length) return { tier: "exact", urls: exact.slice(0, MAX_EXACT_CANDIDATES) };

  const words = [...new Set(slug.split("-").filter((w) => w.length >= 4 && !STOPWORDS.has(w)))];
  const ranked = words
    .map((w) => ({ w, urls: sitemap.filter((l) => l.includes(w)) }))
    .filter((c) => c.urls.length > 0)
    .sort((a, b) => a.urls.length - b.urls.length);
  if (ranked.length) return { tier: "token", urls: ranked[0].urls.slice(0, MAX_FALLBACK_CANDIDATES) };

  const first = slug.split("-")[0];
  const loose = first ? sitemap.filter((l) => l.includes(first)) : [];
  return { tier: "LOOSE", urls: loose.slice(0, MAX_FALLBACK_CANDIDATES) };
};

// One target -> one entry.
//
// resolved: true  - the classification was read from the board page that
//                    belongs to the requisition asked about: its Job ID was
//                    checked against the ATS refNumber (or the target WAS that
//                    board page).
// resolved: false - no board page could be tied to that requisition. The
//                    entry carries NO classification and NO Job ID, because a
//                    classification read from a page that belongs to another
//                    requisition is exactly the failure this check exists to
//                    prevent.
const classifyTarget = (target, sitemap) => {
  const parsed = slugOf(target);

  // A board URL: the page asked about IS the requisition's page, so its own
  // Job ID is the identity. Read it directly.
  if (!parsed) {
    const page = readBoardPage(target);
    return {
      requested: target,
      url: target,
      ...page,
      match: "direct",
      resolved: Boolean(page.jobId),
    };
  }

  const refNumber = atsRefNumber(parsed.id);
  const { tier, urls } = candidatesFor(sitemap, parsed.slug);
  if (!refNumber) {
    // No requisition id to check against: an unverified page must not be
    // reported as an answer, so the posting stays UNRESOLVED.
    return {
      requested: target,
      url: "",
      title: "",
      titleCode: "",
      classification: "",
      bodyClass: "",
      postedUntil: "",
      department: "",
      salaryRange: "",
      jobId: "",
      match: "unresolved",
      resolved: false,
    };
  }

  for (const candidate of urls) {
    const page = readBoardPage(candidate);
    if (page.jobId && page.jobId === refNumber) {
      return { requested: target, ...page, match: tier, resolved: true };
    }
  }

  return {
    requested: target,
    url: "",
    title: "",
    titleCode: "",
    classification: "",
    bodyClass: "",
    postedUntil: "",
    department: "",
    salaryRange: "",
    jobId: "",
    match: "unresolved",
    resolved: false,
  };
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
    for (const t of targets) pages.push(classifyTarget(t, sm));
  } else {
    // Every posting is a fetch; this is the "how does the board classify
    // everything" view, and it is slow on purpose - it is not a scan path.
    // Each board page is its own requisition's page, so each one is read
    // directly and is resolved by construction.
    for (const l of sm) {
      const page = readBoardPage(l);
      pages.push({ requested: l, ...page, match: "direct", resolved: Boolean(page.jobId) });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(pages, null, 2));
    return;
  }
  const exam = pages.filter((p) => /exam may be required/i.test(p.classification)).length;
  const unresolved = pages.filter((p) => !p.resolved).length;
  console.log(`  postings read: ${pages.length}`);
  console.log(`  exam may be required: ${exam}`);
  console.log(`  no exam required    : ${pages.length - exam - unresolved}`);
  console.log(`  unresolved          : ${unresolved}`);
  for (const p of pages.slice(0, 40)) {
    if (!p.resolved) {
      console.log(`    ${"?".padEnd(8)} ${"UNRESOLVED".padEnd(24)} ${"?".padEnd(12)} ${p.requested}`);
      continue;
    }
    console.log(`    ${String(p.titleCode || "?").padEnd(8)} ${String(p.classification || "?").padEnd(24)} ${String(p.postedUntil || "?").padEnd(12)} ${p.title.slice(0, 46)}`);
  }
};

main();
