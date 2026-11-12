// @ts-check
// Reply-ingest side of the gmail plugin (#1583). Reads the same Gmail label as
// the job-lead side, but instead of extracting job URLs into the pipeline,
// normalizes every fetched message into the exact candidate shape
// reply-watch.mjs understands and appends it to data/reply-candidates.json.
//
// Design rules:
//   - Never classifies. Classification stays reply-watch.mjs's job, gated by a
//     human on the digest. This file only normalizes and appends.
//   - Never touches the tracker. data/applications.md is reply-watch's to
//     recommend changes on, never this plugin's.
//   - Its own cursor (data/gmail-reply-state.json), independent of the job-lead
//     cursor (data/gmail-state.json): a message counted a lead may also be a
//     reply worth classifying. Re-running never duplicates a candidate.
//
// Gated on `gmail.ingest_replies: true` in config/plugins.yml (default off).

import fs from 'node:fs';
import path from 'node:path';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { writeFileAtomic } from '../../tracker-utils.mjs';

const REPLY_STATE_FILE = path.join('data', 'gmail-reply-state.json');

/** Where reply-candidates.json lives; env override mirrors paste-reply.mjs for tests. */
export function resolveCandidatesPath(ctx) {
  if (process.env.CAREER_OPS_REPLY_CANDIDATES) return process.env.CAREER_OPS_REPLY_CANDIDATES;
  const root = ctx?.dataRoot || process.cwd();
  return path.join(root, 'data', 'reply-candidates.json');
}

function replyStatePath(ctx) {
  const root = ctx?.dataRoot || process.cwd();
  return path.join(root, REPLY_STATE_FILE);
}

/** Load the message-id set ingested on a previous run. */
export function loadReplyIds(ctx) {
  try {
    const state = JSON.parse(fs.readFileSync(replyStatePath(ctx), 'utf-8'));
    return new Set(state?.processed_message_ids || []);
  } catch {
    return new Set();
  }
}

/** Persist the ingested-id set; best-effort, never fails the run. Exported for tests. */
export function saveReplyIds(ctx, ids) {
  try {
    const p = replyStatePath(ctx);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ processed_message_ids: [...ids] }, null, 2));
  } catch (err) {
    ctx?.log?.(`gmail replies: could not persist reply cursor — ${err.message}`);
  }
}

const ENTITY_MAP = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&middot;': '.', '&hellip;': '...',
};

/** Best-effort HTML to text for HTML-only parts: tags out, entities decoded, collapsed whitespace. */
export function stripHtml(text) {
  if (!text) return '';
  let out = String(text);
  for (const [k, v] of Object.entries(ENTITY_MAP)) out = out.split(k).join(v);
  out = out.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/\r?\n{3,}/g, '\n\n');
  out = out.replace(/[ \t]{2,}/g, ' ');
  return out.trim();
}

const REPLY_BODY_CAP = 40_000; // keep candidate files small; classification is keyword-based

/**
 * Build the exact candidate shape reply-watch.mjs expects. Message id is the
 * Gmail id, so dedup across runs never collides with paste-reply's ids. The
 * body arrives already decoded (index.mjs handles MIME/quoted-printable).
 */
export function buildReplyCandidate(msgId, headers, decodedBody) {
  const get = (n) => (headers.find(h => h?.name?.toLowerCase() === n)?.value || '').trim();
  const from = get('from');
  const subject = get('subject');
  const body = typeof decodedBody === 'string' ? decodedBody : '';
  let snippet = stripHtml(body);
  if (snippet.length > REPLY_BODY_CAP) snippet = snippet.slice(0, REPLY_BODY_CAP);
  return { message_id: String(msgId), from, subject, body_snippet: snippet, signal: null };
}

/**
 * Append new candidates to data/reply-candidates.json. Read-modify-write under
 * the shared pipeline lock, write-then-rename via writeFileAtomic — mirrors
 * paste-reply.mjs's append, so a partial write can never truncate the file.
 */
export async function appendReplyCandidates(ctx, candidates) {
  if (!candidates.length) return 0;
  const candidatesPath = resolveCandidatesPath(ctx);
  return withPipelineLock(candidatesPath, () => {
    let existing = [];
    if (fs.existsSync(candidatesPath)) {
      const parsed = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
      if (!Array.isArray(parsed)) throw new Error(`Reply candidates at ${candidatesPath} is not a JSON array`);
      existing = parsed;
    }
    fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
    writeFileAtomic(candidatesPath, JSON.stringify([...existing, ...candidates], null, 2));
    return candidates.length;
  }, { timeoutMs: 30_000 });
}
