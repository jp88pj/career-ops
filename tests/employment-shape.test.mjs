// Employment shape: annotate, never veto.
//
// The regression this suite exists to prevent, measured 2026-10-04: the RFCUNY
// posting "Math Curriculum Developer" reads "$40-50 per hour" with
// `timeType: Part time`. Annualising $50 x 2080 produced a confident
// "$104,000 flat — best lead on the board". It is roughly $52K at 25 h/wk.
//
// Two distinct failures are covered: computing the 2080 figure at all for a
// non-full-time role, and a hard veto HIDING a well-paid part-time role in the
// same breath as a badly-paid one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHAPE_TITLE_NEGATIVES, stripShapeNegatives, classifyEmploymentType,
  parseHourlyRate, parseDeclaredHours, annualize, buildShapePolicy,
  shouldSurfaceFlagged, describeShape, parseWorkdayApi, isWorkdayUrl,
  readWorkdayDetail, detectEmploymentShape, __clearWorkdayCache,
} from '../lib/employment-shape.mjs';

test('classifyEmploymentType reads platform shapes, and "unknown" stays unknown', () => {
  assert.equal(classifyEmploymentType('Part time'), 'part-time');
  assert.equal(classifyEmploymentType('Full time'), 'full-time');
  assert.equal(classifyEmploymentType('Per Diem'), 'per-diem');
  assert.equal(classifyEmploymentType('Seasonal'), 'seasonal');
  assert.equal(classifyEmploymentType('Intermittent'), 'intermittent');
  // Contract outranks temp: "Temporary Contract" is a contract, not merely temp.
  assert.equal(classifyEmploymentType('Temporary Contract'), 'contract');
  assert.equal(classifyEmploymentType('1099 contract work'), 'contract');
});

test('classifyEmploymentType respects word boundaries', () => {
  // "Temperature" must not read as a temporary role.
  assert.equal(classifyEmploymentType('Temperature Control'), 'unknown');
  assert.equal(classifyEmploymentType('Extraordinary'), 'unknown');
  assert.equal(classifyEmploymentType(''), 'unknown');
  assert.equal(classifyEmploymentType(null), 'unknown');
});

test('parseHourlyRate handles bands and singles but rejects annual bands', () => {
  assert.deepEqual(parseHourlyRate('Pay Range: $40-50 per hour'), { lo: 40, hi: 50 });
  assert.deepEqual(parseHourlyRate('salary is $22.50/hour'), { lo: 22.5, hi: 22.5 });
  assert.deepEqual(parseHourlyRate('$40 - $50 / hr'), { lo: 40, hi: 50 });
  // A yearly band misread as hourly would fabricate a five-figure salary.
  assert.equal(parseHourlyRate('The band is $70,000 - $90,000 per year'), null);
  assert.equal(parseHourlyRate('$120,000 per hour'), null);
  assert.equal(parseHourlyRate('no numbers here'), null);
});

test('annualize refuses to invent a schedule', () => {
  const rate = { lo: 40, hi: 50 };
  assert.equal(annualize(rate, 40).hi, 104000);   // full-time 52 x 40
  assert.equal(annualize(rate, 25).hi, 65000);    // part-time 25 h/wk
  assert.equal(annualize(rate, 21).hi, 54600);    // the declared 21 h/wk case
  // THE GUARD: no stated schedule means no annual figure at all.
  assert.equal(annualize(rate, null), null);
  assert.equal(annualize(rate, undefined), null);
  assert.equal(annualize(rate, 0), null);
  assert.equal(annualize(null, 40), null);
});

test('parseDeclaredHours reads a real schedule and nothing else', () => {
  assert.equal(parseDeclaredHours('This Position is for 21 hours a week'), 21);
  assert.equal(parseDeclaredHours('20 hrs/week schedule'), 20);
  assert.equal(parseDeclaredHours('30 hours weekly'), 30);
  assert.equal(parseDeclaredHours('Full-time, no schedule given'), null);
  // Nonsense hours must not become a figure.
  assert.equal(parseDeclaredHours('80 hours a week'), null);
});

test('stripShapeNegatives lifts exactly the shape words, and does not mutate', () => {
  const cfg = {
    positive: ['Program'],
    negative: [...SHAPE_TITLE_NEGATIVES, 'Attorney', 'RN', 'MD'],
  };
  const before = cfg.negative.length;
  const out = stripShapeNegatives(cfg);
  // 8 shape words in, 3 non-shape survivors out. "Contract" is deliberately
  // absent from SHAPE_TITLE_NEGATIVES -- portals.yml removed word:Contract on
  // 2026-10-01 because it vetoed 17 permanent civil-service roles whose SUBJECT
  // is contracts.
  assert.equal(out.negative.length, 3);
  assert.deepEqual(out.negative, ['Attorney', 'RN', 'MD']);
  assert.equal(cfg.negative.length, before, 'original config must not be mutated');
  // A config with no shape words is returned unchanged (identity, not a copy).
  const none = { negative: ['Attorney'] };
  assert.equal(stripShapeNegatives(none), none);
  assert.equal(stripShapeNegatives(undefined), undefined);
});

test('the stripped set is exhaustive against the shipped portals.yml list', async () => {
  const { readFileSync } = await import('node:fs');
  const { load } = await import('js-yaml');
  const cfg = load(readFileSync(new URL('../portals.yml', import.meta.url), 'utf8'));
  const shipped = cfg.title_filter.negative
    .map((s) => s.replace(/^word:/, '').toLowerCase())
    .filter((s) => SHAPE_TITLE_NEGATIVES.some((w) => w.toLowerCase() === s));
  // Every shape word in the config must be one this module knows how to strip,
  // so a future addition to one list cannot silently diverge from the other.
  assert.equal(shipped.length, SHAPE_TITLE_NEGATIVES.length);
});

test('buildShapePolicy is inert without config, so default behaviour is unchanged', () => {
  assert.equal(buildShapePolicy(undefined).active, false);
  assert.equal(buildShapePolicy(null).active, false);
  assert.equal(buildShapePolicy({}).active, false);
  assert.equal(buildShapePolicy([]).active, false);
  const on = buildShapePolicy({ flag_not_veto: true, surface_min: 50000 });
  assert.equal(on.active, true);
  assert.equal(on.flagNotVeto, true);
  assert.equal(on.surfaceMin, 50000);
  assert.equal(on.assumeFullTimeHours, 40);
  assert.ok(on.detailPlatforms.has('workday'));
});

test('shouldSurfaceFlagged gates on the figure, never on the shape alone', () => {
  const P = buildShapePolicy({ flag_not_veto: true, surface_min: 50000 });
  // A full-time role is never "flagged" — there is nothing to flag.
  assert.equal(shouldSurfaceFlagged({ shape: 'full-time', annualHi: 200000 }, P), false);
  assert.equal(shouldSurfaceFlagged({ shape: 'unknown' }, P), false);
  // Well-paid part-time SURFACES. This is the whole point: a hard veto hid these.
  assert.equal(shouldSurfaceFlagged({ shape: 'part-time', annualHi: 65000 }, P), true);
  // Badly-paid part-time does not queue, but is still counted by the caller.
  assert.equal(shouldSurfaceFlagged({ shape: 'part-time', annualHi: 45864 }, P), false);
  // No stated schedule falls back to a generous UPPER bound, not a guess.
  assert.equal(shouldSurfaceFlagged({ shape: 'part-time', annualHi: null, rateHi: 42 }, P), true);
  assert.equal(shouldSurfaceFlagged({ shape: 'part-time', annualHi: null, rateHi: 20 }, P), false);
  assert.equal(shouldSurfaceFlagged({ shape: 'part-time' }, P), false);
});

test('describeShape travels with the row so the figure is never separated', () => {
  const note = describeShape({
    shape: 'part-time', source: 'workday timeType',
    rateLo: 40, rateHi: 50, hoursPerWeek: 25, annualLo: 52000, annualHi: 65000,
  });
  assert.match(note, /part-time/);
  assert.match(note, /\$40-\$50\/hr/);
  assert.match(note, /25 h\/wk/);
  assert.match(note, /65,000/);
  const unscheduled = describeShape({
    shape: 'part-time', source: 'x', rateLo: 40, rateHi: 50,
    hoursPerWeek: null, annualLo: null, annualHi: null,
  });
  assert.match(unscheduled, /not annualised/);
});

test('Workday URL helpers: tenant/site come from the portal api, not the posting', () => {
  const api = parseWorkdayApi('https://rfcuny.wd108.myworkdayjobs.com/wday/cxs/rfcuny/RFCUNY/jobs');
  assert.deepEqual(api, {
    origin: 'https://rfcuny.wd108.myworkdayjobs.com',
    host: 'rfcuny.wd108.myworkdayjobs.com',
    tenant: 'rfcuny',
    site: 'RFCUNY',
  });
  assert.equal(parseWorkdayApi('https://boards-api.greenhouse.io/v1/boards/x/jobs'), null);
  assert.equal(parseWorkdayApi(undefined), null);

  // The provider composes host+SITE+externalPath, so the public URL carries the
  // site segment. Rebuilding the cxs path from it doubled the site and 404'd,
  // which surfaced as every role silently classifying as 'unknown'.
  const postingUrl = 'https://rfcuny.wd108.myworkdayjobs.com/RFCUNY/job/Bronx-New-York/Resident-Coordinator_JR4259';
  assert.equal(isWorkdayUrl(postingUrl), true);
  assert.equal(isWorkdayUrl('https://boards-api.greenhouse.io/v1/boards/x/jobs/1'), false);
  assert.equal(isWorkdayUrl(''), false);

  // readWorkdayDetail must slice from the LAST "/job/", i.e. externalPath.
  __clearWorkdayCache();
  const seen = [];
  const fakeFetch = async (url) => { seen.push(url); return { ok: true, json: async () => ({ jobPostingInfo: { timeType: 'Part time', jobDescription: 'x', jobReqId: 'JR4259' } }) }; };
  return readWorkdayDetail(postingUrl, { api: 'https://rfcuny.wd108.myworkdayjobs.com/wday/cxs/rfcuny/RFCUNY/jobs', fetchImpl: fakeFetch })
    .then((detail) => {
      assert.equal(seen.length, 1);
      assert.equal(
        seen[0],
        'https://rfcuny.wd108.myworkdayjobs.com/wday/cxs/rfcuny/RFCUNY/job/Bronx-New-York/Resident-Coordinator_JR4259',
        'site segment must appear exactly once',
      );
      assert.equal(detail.timeType, 'Part time');
      assert.equal(detail.reqId, 'JR4259');
    });
});

test('readWorkdayDetail returns null rather than guessing when unreachable', async () => {
  __clearWorkdayCache();
  const denied = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const r = await readWorkdayDetail(
    'https://rfcuny.wd108.myworkdayjobs.com/job/New-York-NY/X_JR1',
    { api: 'https://rfcuny.wd108.myworkdayjobs.com/wday/cxs/rfcuny/RFCUNY/jobs', fetchImpl: denied },
  );
  assert.equal(r, null);
  // No api configured at all -> cannot resolve tenant/site -> null, not a guess.
  assert.equal(await readWorkdayDetail('https://rfcuny.wd108.myworkdayjobs.com/job/New-York-NY/X_JR1', {}), null);
});

test('detectEmploymentShape: the phantom $104,000 regression, closed', async () => {
  const P = buildShapePolicy({ flag_not_veto: true, surface_min: 50000 });
  const api = 'https://rfcuny.wd108.myworkdayjobs.com/wday/cxs/rfcuny/RFCUNY/jobs';
  __clearWorkdayCache();

  // Stand in for the real JR4221 payload: part-time, $40-50/hr, no stated schedule.
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      jobPostingInfo: {
        timeType: 'Part time',
        jobReqId: 'JR4221',
        jobDescription: 'About the Role: We are looking for a part-time math curriculum developer. Pay Range: $40-50 per hour',
      },
    }),
  });

  const shape = await detectEmploymentShape(
    {
      title: 'Math Curriculum Developer',
      url: 'https://rfcuny.wd108.myworkdayjobs.com/job/New-York-NY/Math-Curriculum-Developer_JR4221',
      description: '',
    },
    P,
    { api, fetchImpl: fakeFetch },
  );

  assert.equal(shape.shape, 'part-time', 'the title never says part-time; only timeType does');
  assert.equal(shape.source, 'workday timeType');
  assert.equal(shape.reqId, 'JR4221');
  assert.equal(shape.rateHi, 50);
  assert.notEqual(shape.annualHi, 104000, 'must NOT annualise a part-time rate at 2080 hours');
  assert.equal(shape.annualHi, null, 'no declared schedule -> no salary figure at all');
});

test('detectEmploymentShape: a declared schedule yields a real, defensible figure', async () => {
  const P = buildShapePolicy({ flag_not_veto: true, surface_min: 50000 });
  const api = 'https://rfcuny.wd108.myworkdayjobs.com/wday/cxs/rfcuny/RFCUNY/jobs';
  __clearWorkdayCache();

  // JR3121 states its own schedule, so the annualisation is grounded.
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      jobPostingInfo: {
        timeType: 'Part time',
        jobReqId: 'JR3121',
        jobDescription: 'This Position is for 21 hours a week. Pay Rate: $42 per hour.',
      },
    }),
  });

  const shape = await detectEmploymentShape(
    {
      title: 'Assistant Paramedic Program Coordinator',
      url: 'https://rfcuny.wd108.myworkdayjobs.com/job/Long-Island-City-NY/Assistant-Paramedic_JR3121',
      description: '',
    },
    P,
    { api, fetchImpl: fakeFetch },
  );

  assert.equal(shape.shape, 'part-time');
  assert.equal(shape.hoursPerWeek, 21, 'the schedule comes from the posting, not the default');
  assert.equal(shape.annualHi, 45864); // 42 x 21 x 52
  // $45,864 is below the $50K floor: counted by the caller, not queued.
  assert.equal(shouldSurfaceFlagged(shape, P), false);
});

test('detectEmploymentShape: a full-time role still annualises normally', async () => {
  const P = buildShapePolicy({ flag_not_veto: true, surface_min: 50000 });
  const api = 'https://rfcuny.wd108.myworkdayjobs.com/wday/cxs/rfcuny/RFCUNY/jobs';
  __clearWorkdayCache();
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      jobPostingInfo: { timeType: 'Full time', jobReqId: 'JR179', jobDescription: 'Compensation $70,000 - $90,000' },
    }),
  });
  const shape = await detectEmploymentShape(
    {
      title: 'Instructional Designer',
      url: 'https://rfcuny.wd108.myworkdayjobs.com/job/New-York-NY/Instructional-Designer_JR179',
      description: '',
    },
    P,
    { api, fetchImpl: fakeFetch },
  );
  assert.equal(shape.shape, 'full-time');
  assert.equal(shape.hoursPerWeek, 40);
  assert.equal(shouldSurfaceFlagged(shape, P), false, 'full-time is not a flagged shape');
});

test('detectEmploymentShape reports unknown rather than assuming full-time', async () => {
  const P = buildShapePolicy({ flag_not_veto: true, surface_min: 50000 });
  const shape = await detectEmploymentShape(
    { title: 'Program Manager', url: 'https://boards-api.greenhouse.io/v1/boards/x/jobs/1', description: '' },
    P,
    { fetchImpl: async () => { throw new Error('should not be called'); } },
  );
  assert.equal(shape.shape, 'unknown');
  assert.equal(shape.annualLo, null);
});
