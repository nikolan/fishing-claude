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
  for (const k of ['base', 'light', 'water', 'pressure', 'rain', 'wind']) assert.ok(keys.has(k), `missing ${k}`);
  // Pressure is a tie-breaker now: never more than +0.2.
  const pr = day.hours[12].parts.find((p) => p.key === 'pressure');
  assert.ok(pr.value <= 0.2);
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

test('cold snap (3-day means) and frost are penalised; ice flag raised', () => {
  const wx = synth('2027-01-04T00:00:00Z', 9, (i) => ({
    temp: i < 96 ? 6 : -4,
    cloud: 20,
    pressure: 1030,
    wind: 4,
  }));
  const hours = scoreHours(wx, ctxFor('perch'));
  const h = hours[96 + 60];
  assert.ok(h.parts.some((p) => p.key === 'trend' && p.value <= -0.4), 'cold snap missing');
  const late = hours[hours.length - 1];
  assert.ok(late.parts.some((p) => p.key === 'frost'), 'frost missing');
  assert.ok(late.flags.includes('ice'));
  assert.equal(ratingLabel(late.score), 'Stay home');
});

test('pike: welfare flag at ≥18°C water and summer break flag; summer cooling bonus', () => {
  const wx = synth('2026-07-10T00:00:00Z', 8, (i) => ({ temp: i < 96 ? 24 : 19, cloud: 60 }));
  const hours = scoreHours(wx, ctxFor('pike'));
  const mid = hours[100];
  assert.ok(mid.flags.includes('pikeWelfare'));
  assert.ok(mid.flags.includes('pikeSummer'));
  assert.ok(mid.parts.find((p) => p.key === 'water').value <= -0.6);
  const cooling = hours.slice(150).some((h) => h.parts.some((p) => p.key === 'trend' && p.label === 'Summer cooling'));
  assert.ok(cooling, 'summer cooling bonus expected for pike');
});

test('moon: syzygy bonus within ±3 days of full moon, absent at quarter', () => {
  // Full moon 2026-09-26 16:49 UTC; first quarter 2026-09-18.
  const wx = synth('2026-09-10T00:00:00Z', 20, () => ({ temp: 14, cloud: 60 }));
  const hours = scoreHours(wx, ctxFor('perch'));
  const atFull = hours.find((h) => h.dateKey === '2026-09-26' && h.hour === 12);
  const atQuarter = hours.find((h) => h.dateKey === '2026-09-18' && h.hour === 12);
  assert.ok(atFull.parts.some((p) => p.key === 'moon'), 'syzygy bonus missing at full moon');
  assert.ok(!atQuarter.parts.some((p) => p.key === 'moon'), 'unexpected moon bonus at quarter');
});

test('solunar periods only when opted in, and never worth more than 0.15', () => {
  const wx = synth('2026-09-10T00:00:00Z', 3, () => ({ temp: 14, cloud: 60 }));
  const off = scoreHours(wx, ctxFor('perch', { solunar: false }));
  const on = scoreHours(wx, ctxFor('perch', { solunar: true }));
  assert.ok(off.every((h) => !h.parts.some((p) => p.key === 'solunar')));
  const sol = on.flatMap((h) => h.parts.filter((p) => p.key === 'solunar'));
  assert.ok(sol.length > 0);
  assert.ok(sol.every((p) => p.value <= 0.15));
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
  // Same conditions in April and in October must now score identically. The
  // seasonal base used to separate them by more than a point.
  const make = (iso) =>
    scoreHours(
      synth(iso, 3, () => ({ temp: 12, cloud: 70, precip: 0, pressure: 1015, wind: 8 })),
      ctxFor('perch'),
    );
  const april = make('2026-04-10T00:00:00Z');
  const october = make('2026-10-10T00:00:00Z');
  const noonPart = (hs, key) => hs.find((h) => h.hour === 12).parts.find((p) => p.key === key);
  assert.equal(noonPart(april, 'base').value, noonPart(october, 'base').value, 'the base must not read the calendar');
  // Sun geometry still differs between the two dates, so the totals are not
  // identical. What must be gone is the seasonal step, which was above a point.
  const noon = (hs) => hs.find((h) => h.hour === 12).score;
  assert.ok(Math.abs(noon(april) - noon(october)) < 0.3, `April ${noon(april)} vs October ${noon(october)}`);
  assert.equal(noonPart(april, 'season'), undefined, 'no season component remains');
});

test('every hour starts from the flat base', () => {
  const hs = scoreHours(
    synth('2026-09-10T00:00:00Z', 2, () => ({ temp: 14, cloud: 60, precip: 0, pressure: 1015, wind: 8 })),
    ctxFor('perch'),
  );
  for (const h of hs) {
    const base = h.parts.find((p) => p.key === 'base');
    assert.ok(base, 'every hour carries a base part');
    assert.equal(base.value, WEIGHTS.base);
  }
  assert.equal(hs.filter((h) => h.parts.some((p) => p.key === 'season')).length, 0, 'no season part remains');
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

test('good conditions can reach 5 and bad ones reach 0', () => {
  // A dark, freezing, gale-blown January midnight must bottom out.
  const grim = scoreHours(
    synth('2027-01-10T00:00:00Z', 8, () => ({ temp: -3, cloud: 20, precip: 0, pressure: 1032, wind: 40 })),
    ctxFor('perch'),
  );
  assert.ok(Math.min(...grim.map((h) => h.score)) <= 0.5, `grim floor ${Math.min(...grim.map((h) => h.score))}`);
  // The scale must still be reachable at the top: no soft cap compresses it now.
  assert.equal(clampScore(2.5 + WEIGHTS.gain * 2.4), 5);
  assert.ok(WEIGHTS.gain > 1, 'conditions carry more than face value');
});
