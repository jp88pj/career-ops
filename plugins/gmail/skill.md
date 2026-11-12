---
name: career-ops-plugin-gmail
description: How to pull job leads from a Gmail label into the career-ops pipeline.
license: MIT
---

# gmail plugin

Reads a Gmail label, extracts clean job URLs from authentic (DMARC-passing)
emails, and returns them as leads. The engine writes them to the pipeline.

With `ingest_replies: true`, every message seen is also appended to
`data/reply-candidates.json` in the exact candidate shape `reply-watch.mjs`
expects (message id, from, subject, body snippet, `signal: null`). Its
cursor is `data/gmail-reply-state.json`, independent of the job-leads cursor
`data/gmail-state.json`, so one message can be both a lead and a reply.
Nothing is classified and the tracker is never touched — classification stays
`reply-watch.mjs`'s job, behind your confirmation.

## Command

- `node plugins.mjs run gmail` — ingest new leads from the configured label.

## Setup

Put `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` + `GMAIL_REFRESH_TOKEN` in `.env`
(an OAuth Desktop client + a refresh token from the consent flow). Configure the
label + lookback in `config/plugins.yml`:

```yaml
plugins:
  gmail: { enabled: true, label: "Job Leads", days_back: 7, ingest_replies: true }
```

`ingest_replies` defaults to false; with it off, behavior is unchanged from 1.0.0.
Dry-run (`node plugins.mjs run gmail --dry-run`) logs how many candidates would
be appended without writing anything.

## Data it produces

`Job[]` ({ title, url, company, location }) — the engine de-dups against the
pipeline and appends new ones. It maintains its own processed-message cursor in
`data/gmail-state.json`, under your data root, to avoid re-reading the same
emails.

With `ingest_replies: true`, also `ReplyCandidate[]` appended to
`data/reply-candidates.json` via the shared pipeline lock; same normalization as
`paste-reply.mjs` (DMARC-filtered, HTML stripped, ≤ 40,000 body chars). Run
`node reply-watch.mjs` afterwards to classify them.
