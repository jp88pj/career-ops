// Regression: a careers-portal footer's "set job alerts" must not type a real
// rejection as Noise. Found 2026-10-05 on tracker #201 (Pfizer req 4964318):
// reply-matcher.mjs ran its noise tier first, matched 'job alert' from the
// closing footer, and returned Noise before the rejection tier was consulted -
// even though 'pursue other candidates' was sitting in the body.
// Two separate defects are covered here:
//   1. footer boilerplate pre-empting a decisive decision signal
//   2. the big-pharma template inserting "qualified" between "other" and
//      "candidates", so 'pursue other candidates' did not match
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply } from '../reply-matcher.mjs';

// Verbatim body from the real Pfizer Workday rejection, trimmed only of the
// trailing contact block. The two clauses under test are both in this text.
const PFIZER_REJECTION =
  'Dear Jonathan Presser , We really appreciate your interest in joining Pfizer and we want to ' +
  'thank you for the time and energy you invested in applying for the Administrative Assistant, US ' +
  'Prostate Franchise (4964318) position. Our patients expect the very best of us, therefore our ' +
  'selection process is rigorous. After a comprehensive review, we have elected to pursue other ' +
  'qualified candidates whose combination of education, skills and experience more closely fit the ' +
  'needs of this position. Our needs may change, and we now have your professional profile on our ' +
  'radar. We will continue to keep you top of mind for future opportunities. Please keep in mind ' +
  'that many current Pfizer employees were considered for multiple roles before getting an ' +
  'interview. We encourage you to return to Pfizer Careers to monitor the status of any other ' +
  'application(s), set job alerts and to view current opportunities.';

describe('reply classifier: footer noise vs a real decision', () => {
  it('types the Pfizer rejection Rejected, not Noise', () => {
    const r = classifyReply({
      from: 'pfizer@myworkday.com',
      subject: 'Pfizer Recruitment Update',
      body_snippet: PFIZER_REJECTION,
    });
    assert.equal(r.type, 'Rejected');
    assert.equal(r.suggestedTrackerUpdate, 'Rejected');
  });

  it('matches the big-pharma "other qualified candidates" phrasing', () => {
    const r = classifyReply({
      from: 'pfizer@myworkday.com',
      subject: 'Pfizer Recruitment Update',
      body_snippet: PFIZER_REJECTION,
    });
    assert.ok(
      r.evidence.some(e => /pursue other qualified candidates/i.test(e)),
      `expected a big-pharma rejection phrase in evidence, got: ${JSON.stringify(r.evidence)}`
    );
  });

  it('still types a genuine job-alert blast as Noise', () => {
    // No salutation by name, no applicant-specific reference, no requisition.
    const r = classifyReply({
      from: 'jobs@linkedin.com',
      subject: 'Your job alert: 12 new Data Analyst roles in New York',
      body_snippet:
        'Your weekly job alert is ready. 12 new recommended jobs match your preferences. ' +
        'Set job alerts or manage your alerts at any time.',
    });
    assert.equal(r.type, 'Noise');
    assert.equal(r.suggestedTrackerUpdate, 'none');
  });

  it('does not treat candidate-addressed scheduling mail as Noise on footer wording', () => {
    const r = classifyReply({
      from: 'no-reply@greenhouse.io',
      subject: 'Interview scheduling for Administrative Assistant',
      body_snippet:
        'Hi Jonathan, Thank you for applying to Example Co. We would like to schedule your ' +
        'interview. Please pick a time that works for you: https://scheduling.example.com/x. ' +
        'You can set job alerts for future roles in our careers portal.',
    });
    assert.notEqual(r.type, 'Noise');
  });

  it('respects an explicit upstream signal over footer wording', () => {
    const r = classifyReply({
      from: 'pfizer@myworkday.com',
      subject: 'Pfizer Recruitment Update',
      body_snippet: PFIZER_REJECTION,
      signal: 'rejection',
    });
    assert.equal(r.type, 'Rejected');
  });
});

// Two further real rejections the user pasted on 2026-10-05, which exposed gaps
// the Pfizer case alone did not cover.
describe('reply classifier: variable-word rejection phrasings', () => {
  it('matches "unable to move you forward" (DREAM #171)', () => {
    // The substring entry 'unable to move forward' does NOT hit this: the single
    // word "you" breaks it. With no decisive match the mail fell through to
    // respondedKeywords, where talent-community boilerplate ("may reach out
    // should another opportunity arise") matched 'reach out' and typed an
    // interview-stage rejection as Responded.
    const r = classifyReply({
      from: 'embassakou@wearedream.org',
      subject: 'DREAM: Application Follow Up- Jonathan Presser',
      body_snippet:
        'Thank you for your interest in DREAM. We appreciated the opportunity to consider you for ' +
        'Advancement Operations Coordinator role with us. At this time, we are unable to move you ' +
        'forward in our selection process. We will keep your profile active in our talent community ' +
        'and may reach out should another opportunity arise that is suited to your skill set.',
    });
    assert.equal(r.type, 'Rejected');
    assert.equal(r.suggestedTrackerUpdate, 'Rejected');
  });

  it('matches "your qualifications did not match our needs" (Talkspace #177)', () => {
    // Matched nothing at all before - classified Unknown with zero evidence.
    // Nearest substring entry, 'not a match', needs the literal "not a match".
    const r = classifyReply({
      from: 'no-reply@us.greenhouse-mail.io',
      subject: 'Network Strategic Operations Coordinator - Talkspace',
      body_snippet:
        'Thank you so much for applying for the Network Strategic Operations Coordinator position at ' +
        'Talkspace. We had an overwhelming number of applicants, and although your qualifications did ' +
        'not match our needs for this position, we encourage you to apply for future openings we post.',
    });
    assert.equal(r.type, 'Rejected');
    assert.ok(r.evidence.length > 0, 'expected evidence, got none');
  });

  it('types a real NYC House Manager rejection Rejected', () => {
    const r = classifyReply({
      from: 'notifications@cityjobsupport.nyc.gov',
      subject: 'House Manager Application',
      body_snippet:
        'Jonathan,\n\nThank you for applying for the House Manager role (reference number: 720231). ' +
        'After careful review, the hiring team has decided not to move forward with your application.',
    });
    assert.equal(r.type, 'Rejected');
  });

  it('still types a confirmation carrying footer noise wording as Auto-confirmation', () => {
    // Personal marker present, so it must not be discarded as Noise; the
    // acknowledgement tier must then win over the footer phrase.
    const r = classifyReply({
      from: 'no-reply@greenhouse.io',
      subject: 'Thanks for applying to Example Co!',
      body_snippet:
        'Hi Jonathan, Thank you for applying to Example Co. Our team will review your application and ' +
        'be in touch. You can set job alerts for future roles.',
    });
    assert.equal(r.type, 'Auto-confirmation');
  });
});
