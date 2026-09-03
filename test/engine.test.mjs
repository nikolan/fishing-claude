import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampScore,
  brightness,
  waterTempSeries,
  colourSeries,
  boatTraffic,
  scoreHours,
  summariseDays,
  ratingLabel,
  twilightSeasonFactor,
  pikeSummerBreak,
  WEIGHTS,
  FACTORS,
  FACTOR_TOTAL,
  runUpScore,
  BOAT_COLOUR_INPUT,
  RUNOFF_COLOUR_COEFF,
  PROFILES,
  lureAdvice,
  lurePicks,
} from '../public/src/engine.js';

const LAT = 52.41;
const LNG = -1.51;
const TZ = 'Europe/London';
const ctxFor = (species, extra = {}) => ({ lat: LAT, lng: LNG, tz: TZ, species, bankHolidays: new Set(), solunar: false, ...extra });

/** Build a synthetic hourly series of `days` days starting at `startIso`. */
function synth(startIso, days, fn) {
  const start = Math.floor(new Date(startIso).valueOf() / 1000);
  const n = days * 24;
  const wx = { time: [], temp: [], precip: [], cloud: [], pressure: [], wind: [], gust: [], windDir: [], weatherCode: [], visibility: [] };
  for (let i = 0; i < n; i++) {
    const t = start + i * 3600;
    const v = fn(i, i % 24);
    wx.time.push(t);
    wx.temp.push(v.temp ?? 15);
    wx.precip.push(v.precip ?? 0);
    wx.cloud.push(v.cloud ?? 50);
    wx.pressure.push(v.pressure ?? 1015);
    wx.wind.push(v.wind ?? 8);
    wx.gust.push(v.gust ?? 15);
    wx.windDir.push(v.windDir ?? 240);
    wx.weatherCode.push(v.weatherCode ?? 3);
    wx.visibility.push(v.visibility ?? 20000);
  }
  return wx;
}

test('scores clamp to the 0-5 scale', () => {
  assert.equal(clampScore(3.2), 3.2);
  assert.equal(clampScore(5.4), 5);
  assert.equal(clampScore(-1.2), 0);
  assert.equal(clampScore(0), 0);
  assert.equal(clampScore(5), 5);
});

test('brightness: night 0, clear noon ~1, overcast noon ~0.3, fog halves it, NaN cloud tolerated', () => {
  assert.equal(brightness(-5, 0), 0);
  assert.ok(brightness(60, 0) > 0.9);
  const overcast = brightness(60, 100);
  assert.ok(overcast > 0.25 && overcast < 0.35, `overcast ${overcast}`);
  assert.ok(brightness(60, 0, 500) < 0.5);
  assert.ok(Number.isFinite(brightness(40, NaN)));
});

test('twilight peaks strongest Oct–Apr, weakest Jun–Aug', () => {
  assert.equal(twilightSeasonFactor(11), 1);
  assert.equal(twilightSeasonFactor(7), 0.6);
  assert.ok(twilightSeasonFactor(9) > twilightSeasonFactor(7));
});

test('water temperature proxy lags air temperature; solar gain small and non-negative', () => {
  const temps = [...Array(72).fill(10), ...Array(72).fill(20)];
  const w = waterTempSeries(temps);
  assert.ok(Math.abs(w[71] - 10) < 0.01);
  const at60 = w[71 + 60];
  assert.ok(at60 > 15.5 && at60 < 17.5, `at60 ${at60}`);
  assert.ok(w[143] < 20);
  const sunny = waterTempSeries(temps, new Array(144).fill(0.4));
  assert.ok(sunny[143] - w[143] > 0.4 && sunny[143] - w[143] < 0.7);
  assert.ok(waterTempSeries(new Array(48).fill(-5)).every((v) => v >= 0));
});

test('colour proxy: run-off keeps a 48h half-life', () => {
  const p = new Array(100).fill(0);
  p[0] = 20;
  const c = colourSeries(p);
  const peak = 20 * RUNOFF_COLOUR_COEFF;
  assert.ok(Math.abs(c[0] - peak) < 1e-9, `peak ${c[0]}`);
  assert.ok(Math.abs(c[48] - peak / 2) < 0.05, `half-life ${c[48]}`);
});

test('colour proxy: boat wash settles overnight instead of accumulating', () => {
  // Busy boat traffic 9 hours a day for 3 weeks, no rain at all. Boat wash must
  // not build a standing offset: dawn has to come back to clear water, or the
  // index can never read "clear" in summer and rainfall stops being visible.
  const n = 21 * 24;
  const boats = Array.from({ length: n }, (_, i) => (i % 24 >= 9 && i % 24 < 18 ? BOAT_COLOUR_INPUT.busy : 0));
  const cb = colourSeries(new Array(n).fill(0), boats);
  const dawnLast = cb[n - 24 + 6];
  const noonLast = cb[n - 12];
  assert.ok(dawnLast < 2, `dawn after 3 boat-heavy weeks should be near clear, got ${dawnLast}`);
  assert.ok(noonLast > dawnLast, 'boats must still colour the water during the day');
  assert.ok(noonLast < 5, `afternoon boat wash alone should stay clear-ish, got ${noonLast}`);
});

test('colour proxy: rainfall dominates boat wash after a real flush', () => {
  const n = 10 * 24;
  const boats = Array.from({ length: n }, (_, i) => (i % 24 >= 9 && i % 24 < 18 ? BOAT_COLOUR_INPUT.busy : 0));
  const rain = new Array(n).fill(0);
  for (let i = 24; i < 48; i++) rain[i] = 1.5; // 36 mm over a day
  const c = colourSeries(rain, boats);
  // 36 mm on an impounded canal tinges it. The same figure on a river catchment
  // would run chocolate; see RUNOFF_COLOUR_COEFF for why the two differ.
  assert.ok(c[48] > 5, `a 36 mm flush should leave clear water, got ${c[48]}`);
  assert.ok(c[48] < 25, `and should not read chocolate on a canal, got ${c[48]}`);
  assert.ok(c[n - 1] < c[48], 'and it should fall back as the run-off clears');
});

test('boat traffic classes and pike summer break', () => {
  assert.equal(boatTraffic({ month: 8, hour: 13, weekday: 2, isBankHoliday: false }), 'busy');
  assert.equal(boatTraffic({ month: 6, hour: 13, weekday: 2, isBankHoliday: false }), 'normal');
  assert.equal(boatTraffic({ month: 6, hour: 13, weekday: 6, isBankHoliday: false }), 'busy');
  assert.equal(boatTraffic({ month: 6, hour: 7, weekday: 6, isBankHoliday: false }), 'none');
  assert.equal(boatTraffic({ month: 1, hour: 13, weekday: 6, isBankHoliday: false }), 'none');
  assert.equal(boatTraffic({ month: 9, hour: 13, weekday: 1, isBankHoliday: true }), 'busy');
  assert.equal(pikeSummerBreak(7, 10), true);
  assert.equal(pikeSummerBreak(6, 15), false);
  assert.equal(pikeSummerBreak(10, 1), false);
});

test("user's example day (30 Aug, showers, overcast, falling pressure, 16°C) is a Good/Excellent perch day", () => {
  // A week of 16°C lead-in so the water proxy settles; pressure falling 4 hPa/day; showers on the day.
  const wx = synth('2026-08-23T00:00:00Z', 8, (i) => ({
    temp: 16,
    cloud: 85,
    precip: i >= 168 ? 0.8 : 0,
    pressure: 1022 - i * (4 / 24),
    wind: 8,
  }));
  const hours = scoreHours(wx, ctxFor('perch'));
  const day = summariseDays(hours, ctxFor('perch')).find((d) => d.dateKey === '2026-08-30');
  assert.ok(day, 'expected 30 Aug summary');
  assert.ok(day.score >= 3.8 && day.score <= 4.6, `score ${day.score}`);
  const keys = new Set(day.hours[12].parts.map((p) => p.key));
  for (const k of ['runup', 'light', 'water', 'pressure', 'rain', 'wind']) assert.ok(keys.has(k), `missing ${k}`);
  // Pressure stays a tie-breaker: it can never take more than its small share.
  const pr = day.hours[12].parts.find((p) => p.key === 'pressure');
  assert.ok(pr.value <= pr.max, `pressure ${pr.value} over its ceiling ${pr.max}`);
  assert.ok(pr.max <= 0.3, 'pressure must remain a minor factor');
});

test('bright, calm, post-frontal day is poor for perch at noon; zander peak is the hours after dusk', () => {
  const wx = synth('2026-10-01T00:00:00Z', 8, (i) => ({
    temp: i < 96 ? 16 : 11,
    cloud: 5,
    precip: 0,
    pressure: i < 96 ? 1005 : 1005 + Math.min(i - 96, 48) * 0.25,
    wind: 3,
  }));
  const perchDay = summariseDays(scoreHours(wx, ctxFor('perch')), ctxFor('perch')).find((d) => d.dateKey === '2026-10-07');
  const zander = scoreHours(wx, ctxFor('zander')).filter((h) => h.dateKey === '2026-10-07');
  const perchNoon = perchDay.hours.find((h) => h.hour === 13);
  assert.ok(perchNoon.score < 3.4, `perch noon ${perchNoon.score} should not rate Good`);
  assert.ok(perchDay.bestWindow && perchDay.score > perchNoon.score + 0.7, 'perch should still get a dawn/dusk window');
  const zNoon = zander.find((h) => h.hour === 13);
  const zDusk = zander.find((h) => h.hour === 20); // civil dusk ~19:20 BST in early Oct
  const zLate = zander.find((h) => h.hour === 2);
  assert.ok(zDusk.score > zNoon.score + 1.2, `zander dusk ${zDusk.score} vs noon ${zNoon.score}`);
  assert.ok(zDusk.score > zLate.score, `after-dusk ${zDusk.score} should beat deep night ${zLate.score}`);
  assert.ok(zDusk.parts.find((p) => p.key === 'light').note.includes('after dusk'));
});

test('a cold snap strips the water and run-up marks, and raises the ice flag', () => {
  const wx = synth('2027-01-04T00:00:00Z', 9, (i) => ({
    temp: i < 96 ? 6 : -4,
    cloud: 20,
    pressure: 1030,
    wind: 4,
  }));
  const hours = scoreHours(wx, ctxFor('perch'));
  const h = hours[96 + 60];
  const runup = h.parts.find((p) => p.key === 'runup');
  assert.ok(runup.value <= runup.max * 0.35, `run-up should collapse into a cold snap, got ${runup.value}`);
  const late = hours[hours.length - 1];
  const water = late.parts.find((p) => p.key === 'water');
  assert.ok(water.value <= water.max * 0.2, `freezing water should score near zero, got ${water.value}`);
  assert.ok(late.flags.includes('ice'));
  assert.equal(ratingLabel(late.score), 'Stay home');
});

test('pike: welfare and summer-break flags, and warm water costs water marks', () => {
  const wx = synth('2026-07-10T00:00:00Z', 8, (i) => ({ temp: i < 96 ? 24 : 19, cloud: 60 }));
  const hours = scoreHours(wx, ctxFor('pike'));
  const mid = hours[100];
  assert.ok(mid.flags.includes('pikeWelfare'));
  assert.ok(mid.flags.includes('pikeSummer'));
  const water = mid.parts.find((p) => p.key === 'water');
  assert.ok(water.value <= water.max * 0.25, `too-warm water should score low for pike, got ${water.value}`);
  // The estimate must follow the air down, even though 19 °C is still above the
  // pike welfare line, so the water factor stays at its floor throughout.
  const later = hours[hours.length - 12];
  assert.ok(later.waterTemp < mid.waterTemp, `water should cool: ${mid.waterTemp} then ${later.waterTemp}`);
  assert.equal(later.parts.find((p) => p.key === 'water').value, 0, 'still too warm for pike');
});

test('moon: full marks within ±3 days of syzygy, less at the quarter', () => {
  // Full moon 2026-09-26 16:49 UTC; first quarter 2026-09-18.
  const wx = synth('2026-09-10T00:00:00Z', 20, () => ({ temp: 14, cloud: 60 }));
  const hours = scoreHours(wx, ctxFor('perch'));
  const moonAt = (key) => hours.find((h) => h.dateKey === key && h.hour === 12).parts.find((p) => p.key === 'moon');
  const atFull = moonAt('2026-09-26');
  const atQuarter = moonAt('2026-09-18');
  assert.equal(atFull.value, atFull.max, 'full moon should take the whole moon budget');
  assert.ok(atQuarter.value < atFull.value, 'the quarter should score less than syzygy');
});

test('solunar is opt-in and shares the moon budget rather than adding to it', () => {
  const wx = synth('2026-09-10T00:00:00Z', 3, () => ({ temp: 14, cloud: 60 }));
  const off = scoreHours(wx, ctxFor('perch', { solunar: false }));
  const on = scoreHours(wx, ctxFor('perch', { solunar: true }));
  const notes = on.flatMap((h) => h.parts.filter((p) => p.key === 'moon' && /solunar/.test(p.note ?? '')));
  assert.ok(notes.length > 0, 'expected some solunar periods when opted in');
  assert.ok(off.every((h) => !/solunar/.test(h.parts.find((p) => p.key === 'moon')?.note ?? '')));
  // Turning it on must never push any hour past the ceiling.
  const maxOn = Math.max(...on.map((h) => h.score));
  const maxOff = Math.max(...off.map((h) => h.score));
  assert.ok(maxOn <= 5 && maxOff <= 5);
  assert.ok(on.every((h) => h.parts.find((p) => p.key === 'moon').value <= FACTORS.moon.max));
});

test('scores are bounded 0..5 and every part is a finite number under extreme input', () => {
  const wx = synth('2026-06-01T00:00:00Z', 3, (i) => ({
    temp: 30,
    cloud: 0,
    precip: 12,
    pressure: 1040 - i,
    wind: 45,
    gust: 60,
    weatherCode: 96,
  }));
  const hours = scoreHours(wx, ctxFor('pike', { solunar: true }));
  for (const h of hours) {
    assert.ok(h.score >= 0 && h.score <= 5, `score ${h.score}`);
    for (const p of h.parts) assert.ok(Number.isFinite(p.value), `${p.key} not finite`);
    assert.ok(h.flags.includes('thunder'));
  }
});

test('NaN weather values (model gaps) do not poison the score', () => {
  const wx = synth('2026-09-01T00:00:00Z', 3, (i) => ({ temp: i % 7 === 0 ? NaN : 15, cloud: NaN, precip: NaN, pressure: NaN, wind: NaN, visibility: NaN }));
  const hours = scoreHours(wx, ctxFor('perch'));
  for (const h of hours) assert.ok(Number.isFinite(h.score), `score NaN at ${h.time}`);
});

test('lure guidance tracks the clarity bands', () => {
  assert.equal(lureAdvice({ colourIndex: 3 }).clarity, 'clear');
  assert.equal(lureAdvice({ colourIndex: 9 }).clarity, 'tinged');
  assert.equal(lureAdvice({ colourIndex: 18 }).clarity, 'coloured');
  assert.equal(lureAdvice({ colourIndex: 40 }).clarity, 'chocolate');
  // Clear water asks for natural and small, coloured water for contrast.
  assert.ok(lureAdvice({ colourIndex: 3 }).colours.some((c) => /natural|motor oil|smoke/.test(c)));
  assert.ok(lureAdvice({ colourIndex: 18 }).colours.some((c) => /chartreuse|firetiger/.test(c)));
});

test('bright sun on clear water adds a note; zander and pike adjust', () => {
  assert.ok(lureAdvice({ colourIndex: 3, cloudPct: 10 }).notes.some((n) => /Bright sun/.test(n)));
  assert.equal(lureAdvice({ colourIndex: 3, cloudPct: 95 }).notes.filter((n) => /Bright sun/.test(n)).length, 0);
  assert.ok(lureAdvice({ colourIndex: 9, species: 'zander' }).notes.some((n) => /Zander/.test(n)));
  assert.ok(lureAdvice({ colourIndex: 9, species: 'pike' }).notes.some((n) => /pike/.test(n)));
});

test('the logged sessions land in the band their lure is filed under', () => {
  // Sun 30 Aug and Mon 31 Aug both fished tinged water; Wed 2 Sept was clear.
  const tinged = lurePicks('tinged').map((l) => l.name).join(' ');
  assert.ok(/Mini Minnow/.test(tinged), 'Mini Minnow is the tinged-water pick');
  assert.ok(/Spikey Fry/.test(tinged), 'the UV Spikey Fry is a tinged-water pick');
  const clear = lurePicks('clear').map((l) => l.name).join(' ');
  assert.ok(/Motor Oil/.test(clear), 'Motor Oil is the clear-water pick');
  assert.ok(!/Motor Oil/.test(tinged), 'Motor Oil should not be offered for tinged water');
});

test('the calendar no longer moves the score', () => {
  const make = (iso) =>
    scoreHours(
      synth(iso, 8, () => ({ temp: 12, cloud: 70, precip: 0, pressure: 1015, wind: 8 })),
      ctxFor('perch'),
    );
  const april = make('2026-04-10T00:00:00Z');
  const october = make('2026-10-10T00:00:00Z');
  const noon = (hs) => hs.filter((h) => h.hour === 12).at(-1).score;
  // Sun geometry still differs between the two dates, so they are not identical.
  // What must be gone is the seasonal step, which was worth more than a point.
  assert.ok(Math.abs(noon(april) - noon(october)) < 0.3, `April ${noon(april)} vs October ${noon(october)}`);
  assert.ok(october.every((h) => !h.parts.some((p) => p.key === 'season')), 'no season factor remains');
});

test('the score is the sum of the factors, with no base and nothing left over', () => {
  const hs = scoreHours(
    synth('2026-09-10T00:00:00Z', 8, () => ({ temp: 14, cloud: 60, precip: 0, pressure: 1015, wind: 8 })),
    ctxFor('perch'),
  );
  assert.equal(Math.round(FACTOR_TOTAL * 100) / 100, 5, 'the factor maxima must add up to 5');
  for (const h of hs) {
    assert.equal(h.parts.find((p) => p.key === 'base'), undefined, 'no base factor');
    const sum = h.parts.reduce((s, p) => s + p.value, 0);
    assert.ok(Math.abs(sum - h.raw) < 0.005, `parts ${sum} should equal raw ${h.raw}`);
    for (const part of h.parts) {
      assert.ok(part.max > 0, `${part.key} must declare a ceiling`);
      assert.ok(part.value >= 0 && part.value <= part.max, `${part.key} ${part.value} outside 0..${part.max}`);
    }
  }
});

test('water clarity no longer reaches the score by any path', () => {
  // Identical weather, two very different canals: one flushed by 60 mm of rain,
  // one bone dry. Only the rainfall differs, and rain's own term is tiny, so the
  // midday scores must not diverge the way the colour term used to make them.
  const make = (mm) =>
    scoreHours(
      synth('2026-09-10T00:00:00Z', 6, (i) => ({
        temp: 15,
        cloud: 80,
        precip: i >= 24 && i < 48 ? mm : 0,
        pressure: 1015,
        wind: 8,
      })),
      ctxFor('perch'),
    );
  const noon = (hs) => hs.filter((h) => h.hour === 12).at(-1);
  const wet = noon(make(2.5));
  const dry = noon(make(0));
  assert.equal(wet.parts.find((p) => p.key === 'colour'), undefined, 'no colour component');
  assert.equal(dry.parts.find((p) => p.key === 'colour'), undefined, 'no colour component');
  assert.ok(Math.abs(wet.score - dry.score) < 0.35, `clarity still moves the score: ${wet.score} vs ${dry.score}`);
  // The index itself survives, because the lure guidance and the facts panel use it.
  assert.ok(wet.colour > dry.colour, 'the clarity estimate is still computed');
});

test('the scale is reachable at both ends', () => {
  const grim = scoreHours(
    synth('2027-01-10T00:00:00Z', 9, () => ({ temp: -6, cloud: 15, precip: 0, pressure: 1034, wind: 42 })),
    ctxFor('perch'),
  );
  const floor = Math.min(...grim.map((h) => h.score));
  // A quiet cut and steady pressure still earn their small share on a dreadful
  // day, because they genuinely are not the problem. What matters is the verdict.
  assert.ok(floor <= 1.5, `a freezing gale at night should bottom out, got ${floor}`);
  assert.equal(ratingLabel(floor), 'Stay home');
  // Full marks everywhere is exactly 5: that is what the budget guarantees.
  assert.equal(Math.round(Object.values(FACTORS).reduce((s, f) => s + f.max, 0) * 100) / 100, 5);
});

test('run-up rewards recovery from a hard spell, not merely a grey one', () => {
  // Five cold days, then mild. The recovery half should pay out once the water
  // has come back toward the perch optimum.
  const recovering = scoreHours(
    synth('2026-11-01T00:00:00Z', 12, (i) => ({ temp: i < 168 ? -1 : 13, cloud: 70, precip: 0, pressure: 1015, wind: 6 })),
    ctxFor('perch'),
  );
  // Steady mild throughout: nothing to recover from.
  const settled = scoreHours(
    synth('2026-11-01T00:00:00Z', 12, () => ({ temp: 13, cloud: 70, precip: 0, pressure: 1015, wind: 6 })),
    ctxFor('perch'),
  );
  const last = (hs) => hs.at(-1).parts.find((p) => p.key === 'runup').value;
  assert.ok(last(recovering) > last(settled), `recovery ${last(recovering)} should beat settled ${last(settled)}`);
});

test('run-up pays nothing when the hard spell has not actually lifted', () => {
  // Cold, then still cold: a bright freezing high releases nothing.
  const stillCold = scoreHours(
    synth('2027-01-05T00:00:00Z', 12, () => ({ temp: -4, cloud: 10, precip: 0, pressure: 1035, wind: 5 })),
    ctxFor('perch'),
  );
  const ru = stillCold.at(-1).parts.find((p) => p.key === 'runup');
  assert.ok(ru.value <= ru.max * 0.6, `no release means no recovery payout, got ${ru.value}`);
});

test('runUpScore returns null when there is too little history', () => {
  const wx = synth('2026-09-10T00:00:00Z', 1, () => ({ temp: 14, cloud: 60 }));
  const water = new Array(24).fill(14);
  assert.equal(runUpScore('perch', water, wx, 5), null);
});

test('the top of the scale is reachable when a hard spell breaks', () => {
  // Eleven days of gale and glare with the water sitting right, then it calms,
  // clouds over, rains lightly and the pressure falls away.
  const BREAK = 11 * 24;
  const wx = synth('2026-10-01T00:00:00Z', 14, (i) =>
    i < BREAK
      ? { temp: 13, cloud: 5, wind: 32, precip: 0, pressure: 1036 }
      : { temp: 13, cloud: 85, wind: 8, precip: 0.5, pressure: 1036 - (i - BREAK) * 0.6 },
  );
  const hours = scoreHours(wx, ctxFor('perch'));
  const best = [...hours].sort((a, b) => b.score - a.score)[0];
  assert.ok(best.score >= 4.6, `a hard spell lifting should approach 5, got ${best.score}`);
  assert.equal(ratingLabel(best.score), 'Excellent');
  assert.ok(/lifting/.test(best.parts.find((p) => p.key === 'runup').note));
});

test('run-up reads every condition, so any multi-day regime registers', () => {
  const BREAK = 11 * 24;
  const after = (i) => ({ temp: 14, cloud: 85, wind: 8, precip: 0.5, pressure: 1030 - (i - BREAK) * 0.6 });
  const regimes = {
    heatwave: (i) => (i < BREAK ? { temp: 31, cloud: 0, wind: 2, precip: 0, pressure: 1030 } : after(i)),
    blockingHigh: (i) => (i < BREAK ? { temp: 13, cloud: 0, wind: 2, precip: 0, pressure: 1038 } : after(i)),
    daysOfStorms: (i) => (i < BREAK ? { temp: 12, cloud: 95, wind: 34, precip: 4, pressure: 985 } : after(i)),
    galeAndGlare: (i) => (i < BREAK ? { temp: 13, cloud: 5, wind: 32, precip: 0, pressure: 1036 } : after(i)),
  };
  for (const [name, f] of Object.entries(regimes)) {
    const hours = scoreHours(synth('2026-10-01T00:00:00Z', 14, f), ctxFor('perch'));
    const best = [...hours].sort((a, b) => b.score - a.score)[0];
    const ru = best.parts.find((p) => p.key === 'runup');
    assert.ok(ru.value >= 0.45, `${name} lifting should pay the run-up, got ${ru.value}`);
  }
});

test('run-up separates a spell that lifts from one that sours', () => {
  const BREAK = 11 * 24;
  const good = { temp: 13, cloud: 85, wind: 8, precip: 0.4, pressure: 1012 };
  const bad = { temp: 4, cloud: 5, wind: 30, precip: 0, pressure: 1035 };
  const at = (f) => {
    const hours = scoreHours(synth('2026-10-01T00:00:00Z', 14, f), ctxFor('perch'));
    return hours[hours.length - 30].parts.find((p) => p.key === 'runup').value;
  };
  const souring = at((i) => (i < BREAK ? good : bad));
  const settled = at(() => good);
  const lifting = at((i) => (i < BREAK ? bad : good));
  assert.ok(souring < settled, `souring ${souring} should trail settled ${settled}`);
  assert.ok(settled < lifting, `settled ${settled} should trail a lift ${lifting}`);
  assert.ok(lifting - souring > 0.3, `the swing should be prominent, got ${lifting - souring}`);
});

test('run-up does not reward the post-frontal morning by the back door', () => {
  // A front passes: pressure rockets, sky clears, air drops. On a plain
  // "bad then good" reading this looks like an improvement. It must not score
  // like one, because the pressure factor is the thing that knows better.
  const BREAK = 11 * 24;
  const hours = scoreHours(
    synth('2026-10-01T00:00:00Z', 14, (i) =>
      i < BREAK
        ? { temp: 13, cloud: 95, wind: 18, precip: 2, pressure: 995 }
        : { temp: 6, cloud: 5, wind: 6, precip: 0, pressure: 995 + (i - BREAK) * 0.9 },
    ),
    ctxFor('perch'),
  );
  const late = hours[hours.length - 30];
  const pressure = late.parts.find((p) => p.key === 'pressure');
  assert.equal(pressure.value, 0, 'a rising, clearing, colder morning must take no pressure marks');
});
