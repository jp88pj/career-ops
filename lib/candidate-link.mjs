// lib/candidate-link.mjs — one normalizer for the optional contact-link fields.
//
// WHY THIS EXISTS
//
// candidate.linkedin / github / portfolio are written two ways across the payload
// corpus: as an object {url, display} and as a bare string. Each builder that
// touches the contact line handled that differently, and each got it wrong in its
// own way:
//
//   build-cv-html.mjs         read only `.url` -> a string payload silently lost
//                             its LinkedIn line, with no error anywhere (#14)
//   build-cv-docx.mjs         joined the raw value -> the object form rendered a
//                             literal "[object Object]" in the header of every
//                             DOCX, including two applications already sent
//   generate-cover-letter.mjs called .replace() on it -> TypeError, build dies
//
// Three builders, three symptoms, one root cause. Fixing them individually means
// the next builder repeats it, so the rule lives here instead.
//
// Accepts either shape and returns {href, display}, or null when the field is
// absent/blank/unusable. A bare domain gets an https:// scheme so the href is an
// absolute URL rather than a relative path.
//
// SCHEME HANDLING IS LOAD-BEARING: a value that declares ANY scheme is passed
// through untouched so each caller's sanitizer can reject it. Prefixing
// unconditionally would turn `javascript:alert(1)` into
// `https://javascript:alert(1)`, which is a valid-looking URL that passes most
// allowlists. Callers MUST still run their own sanitize/asUrl step on `href`.

/**
 * @param {string|{url?:string, display?:string}|null|undefined} value
 * @returns {{href: string, display: string}|null}
 */
export function normalizeCandidateLink(value) {
  if (value === null || value === undefined) return null;

  const withScheme = (raw) => {
    const trimmed = String(raw).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  };
  const strip = (raw) => String(raw).trim().replace(/^https?:\/\//i, '');

  if (typeof value === 'string') {
    if (!value.trim()) return null;
    return { href: withScheme(value), display: strip(value) };
  }
  if (typeof value === 'object' && typeof value.url === 'string' && value.url.trim()) {
    const display = typeof value.display === 'string' && value.display.trim()
      ? value.display.trim()
      : strip(value.url);
    return { href: withScheme(value.url), display };
  }
  return null;
}

/**
 * The contact fields a payload is expected to carry, in display order, with
 * optional entries already filtered out. Used by builders that assemble a single
 * contact line so they share one notion of which fields exist.
 *
 * @param {object} candidate
 * @returns {Array<{key: string, value: string, link: {href: string, display: string}|null}>}
 */
export function contactFields(candidate) {
  const c = candidate || {};
  const out = [];
  if (c.location) out.push({ key: 'location', value: String(c.location), link: null });
  if (c.email) out.push({ key: 'email', value: String(c.email), link: null });
  if (c.phone) out.push({ key: 'phone', value: String(c.phone), link: null });
  for (const key of ['linkedin', 'github', 'portfolio']) {
    const link = normalizeCandidateLink(c[key]);
    if (link) out.push({ key, value: link.display, link });
  }
  return out;
}