// Canal predator feeding forecast — deterministic scoring engine.
//
// Input: normalised hourly weather series (see data.js) + location/time context.
// Output: per-hour scores with an itemised breakdown, plus per-day summaries.
//
// Design principles
//  * Additive components on a 0–5 scale with a soft cap above 4, so the reader
//    can see exactly WHY a score is what it is.
//  * Every component is one physical mechanism. Light (sun angle × cloud × fog)
//    is one component, so "overcast" and "dusk" don't double-count.
//  * Weights live in WATER_TEMP / PROFILES / WEIGHTS and nowhere else.
//  * Weights follow the evidence review in ALGORITHM.md: well-evidenced factors
//    (season, water temperature, light, clarity) carry the score; folklore
//    factors (pressure, solunar) are small tie-breakers.

import { sunAltitudeDeg, getSolunarPeriods, solunarAt, getMoonIllumination, moonPhaseName, getSunTimes } from './astro.js';
import { localParts, midnightForDateKey, dayOfYear } from './timezone.js';

export const SPECIES = ['perch'];

// Mid-month seasonal base (Jan..Dec), interpolated by day of year. Shape from
// the angler-consensus month tables (ALGORITHM.md §7) scaled so modifiers have
// room; perch late-Aug/early-Sep anchored to the user's own 2.6 / 2.8.

// Water-temperature bands [lo, hi, points] on the canal water-temp PROXY.
// Perch: Craig 1977 activity ∝ temp; specialists say big perch rarely feed <4 °C.
// Pike: Casselman 1978 peak 15–18, much less active <6; PAC welfare stop ≥18.
// Zander: thermal generalist (Frisk 2012, 10–27 °C plateau).
export const WATER_TEMP = {
  perch: [
    [-99, 2, -0.8],
    [2, 4, -0.5],
    [4, 8, -0.1],
    [8, 18, 0.5],
    [18, 23, 0.1],
    [23, 99, -0.3],
  ],
};

// Per-species constants for light, rain, colour and boat components.
export const PROFILES = {
  perch: {
    label: 'Perch',
    night: -0.4, // true dark: visual feeder, essentially inactive (Craig 1977)
    twilight: 0.8, // dawn/dusk band (scaled by season, see twilightSeasonFactor)
    afterDusk: -0.4, // first 3h after civil dusk = night for perch
    dayBase: 0.8, // day score = dayBase - daySlope * brightness
    daySlope: 1.5,
    rain: { light: 0.3, moderate: 0.1, heavy: -0.2 },
    boats: { busy: -0.3, normal: -0.15, shoulder: -0.05 },
    windFresh: -0.15,
    fishableNight: false,
  },
};

export const WEIGHTS = {
  // Tie-breakers only: controlled studies find no direct pressure effect.
  pressure: { falling: 0.2, risingClearingCold: -0.3 },
  wind: { flatBright: -0.1, ripple: 0.15, strong: -0.5, gale: -0.8, gusty: -0.3 },
};

// ---------------------------------------------------------------------------
// The points budget
//
// Every factor scores from 0 to its own maximum, and the maxima sum to 5. There
// is no base and no gain: the score IS the sum of the factors, so a perfect day
// earns 5 by earning full marks everywhere, and a hopeless one earns 0 because
// every factor is at its floor.
//
// This replaced a flat base of 2.5 plus signed deviations. That arrangement put
// half the score in a constant that told the angler nothing ("Base, flat
// starting point, +2.5") and left the real factors fighting over the remainder.
//
// The share each factor gets reflects how much it moves fishing on a canal, and
// how well that is evidenced. Light and water temperature are the two that
// decide most days, so they hold more than half the budget between them.
export const FACTORS = {
  light: { max: 1.4, label: 'Light & time of day' },
  water: { max: 1.0, label: 'Water temperature' },
  season: { max: 0.7, label: 'Season' },
  runup: { max: 0.7, label: 'Run-up (3-5 days)' },
  wind: { max: 0.45, label: 'Wind & surface' },
  rain: { max: 0.25, label: 'Rain' },
  pressure: { max: 0.25, label: 'Pressure trend' },
  boats: { max: 0.2, label: 'Boat disturbance' },
  moon: { max: 0.05, label: 'Moon' },
};

/** Total points available. Must be 5 for the 0-5 scale to mean anything. */
export const FACTOR_TOTAL = Object.values(FACTORS).reduce((s, f) => s + f.max, 0);

/** Map a value from [lo, hi] onto [0, max], clamped. */
export function toBudget(value, lo, hi, max) {
  if (!(hi > lo) || !Number.isFinite(value)) return max / 2;
  return Math.min(max, Math.max(0, ((value - lo) / (hi - lo)) * max));
}

/**
 * The light term's own floor and ceiling for a species, used to normalise it.
 *
 * Every state the term can produce must be inside this range. Leaving one out
 * silently clamps it. This caught a real bug when the model still carried three
 * species: zander's after-dusk value sat above a ceiling built from twilight and
 * daytime alone, so their primary feeding window scored the same as twilight.
 */
export function lightRange(prof) {
  const states = [prof.night, prof.afterDusk, prof.twilight, prof.dayBase, prof.dayBase - prof.daySlope];
  return [Math.min(...states), Math.max(...states)];
}

/** The water-temperature band's floor and ceiling for a species. */
export function waterRange(species) {
  const pts = WATER_TEMP[species].map((b) => b[2]);
  return [Math.min(...pts), Math.max(...pts)];
}

/** Midpoint of the species' best water-temperature band: what the fish is heading toward. */
export function optimumWaterTemp(species) {
  const best = WATER_TEMP[species].reduce((a, b) => (b[2] > a[2] ? b : a));
  return (Math.max(best[0], -5) + Math.min(best[1], 30)) / 2;
}

// ---------------------------------------------------------------------------
// Run-up: what the days before this hour did to the fish.
//
// The run-up is the collective effect of every condition over the lead-in, not
// one variable's trend. A heatwave, a week of storms, a blocking high, a drought
// and a cold snap are all multi-day regimes, and they suppress feeding by
// different routes: too-warm water, an unfishable surface, flat bright
// stagnation, no run-off, too-cold water. Reading only the water temperature
// caught the last of those and missed the rest.
//
// So the run-up reads the score itself. Every other factor is computed first,
// and their sum becomes an hourly quality between 0 and 1. Averaged over whole
// days the diel cycle washes out and what is left is the regime.
//
// Three things are then measured.
//
// Trajectory: how the last day compares with the three before it. Rising is
// promising, falling is not, flat sits in the middle.
//
// Release: how far below par the regime ran, paid out only in proportion to how
// much conditions have actually improved. This is the case the request was
// about. A spell that physically shut the fishing down, then lifting, is worth
// more than either state alone. A spell that has not lifted is worth nothing.
//
// Sustained: a small credit when the whole five days have run well, so a
// genuinely good settled spell is not treated as though nothing were happening.
//
// What this still refuses to do is treat any bad-then-good pair as a bonus. The
// best-known pattern in angling runs the other way: fish feed on the falling limb
// ahead of a front and go quiet in the bright, cold, rising air behind it. That
// belongs to the pressure factor, which the run-up does not touch.
// Calibrated against measured daily quality, not guessed. Running the model over
// real weather and over synthetic regimes gives roughly:
//
//   ideal mild spell   0.78      gale with glare   0.57
//   settled September  0.72      heatwave          0.50
//                                freezing still    0.41
//
// so par sits at an ordinary decent day and a fully hard spell is a quarter
// below it. Trajectory reaches full marks on a change of 0.12, which a real
// regime break clears easily.
export const RUNUP = {
  par: 0.7,
  trajectoryShare: 0.45,
  releaseShare: 0.25,
  sustainedShare: 0.1,
  trajectoryReach: 0.12,
  deficitReach: 0.25,
  sustainedReach: 0.08,
};

const meanOf = (arr, from, to) => {
  let s = 0;
  let k = 0;
  for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++) {
    if (Number.isFinite(arr[i])) {
      s += arr[i];
      k++;
    }
  }
  return k ? s / k : NaN;
};

/**
 * Run-up points for hour `i` from a series of hourly quality values in [0, 1].
 * Returns null when there is too little history to judge.
 */
export function runUpScore(quality, i) {
  const max = FACTORS.runup.max;
  if (i < 96) return null; // need the previous day plus three before it

  const last24 = meanOf(quality, i - 23, i + 1);
  const prev3 = meanOf(quality, i - 95, i - 23);
  const prev5 = meanOf(quality, i - 143, i - 23);
  if (!Number.isFinite(last24) || !Number.isFinite(prev3)) return null;
  const regime = Number.isFinite(prev5) ? 0.6 * prev3 + 0.4 * prev5 : prev3;

  // Trajectory: centred, so no change sits mid-band.
  const change = Math.max(-1, Math.min(1, (last24 - prev3) / RUNUP.trajectoryReach));
  const trajectory = ((change + 1) / 2) * RUNUP.trajectoryShare;

  // Release: a real shortfall, and it has to have lifted.
  const deficit = Math.max(0, Math.min(1, (RUNUP.par - regime) / RUNUP.deficitReach));
  const lift = Math.max(0, Math.min(1, (last24 - regime) / RUNUP.trajectoryReach));
  const release = deficit * lift * RUNUP.releaseShare;

  // Sustained: a settled spell that has simply been good all along.
  const sustained = Math.max(0, Math.min(1, (regime - RUNUP.par) / RUNUP.sustainedReach)) * RUNUP.sustainedShare;

  const pts = Math.min(max, Math.max(0, trajectory + release + sustained));

  let note;
  if (release > 0.05) note = `hard spell lifting (regime ${Math.round(regime * 100)}%, now ${Math.round(last24 * 100)}%)`;
  else if (change > 0.25) note = `conditions improving on the last ${Math.round((last24 - prev3) * 100)} points`;
  else if (change < -0.25) note = 'conditions falling away from the last few days';
  else if (sustained > 0.03) note = `settled and running well (${Math.round(regime * 100)}%)`;
  else note = `settled (${Math.round(regime * 100)}% over the last few days)`;
  return { pts, note };
}

// ---------------------------------------------------------------------------
// Season: the part of the year that water temperature cannot see.
//
// An earlier version of this model carried a seasonal base and it was removed,
// correctly: it was a large constant that set the level of every score and told
// the angler nothing. This is a different thing. It is centred, it varies, and
// it covers a mechanism no other factor reaches.
//
// The test is October against May. Canal water sits around 12 C in October and
// 14 C in May, so the water factor scores both at full marks and cannot tell
// them apart. On the bank they are not remotely alike. October is the peak of
// canal perch fishing and May is close to its worst.
//
// Three things drive that, and none of them is temperature:
//
//   Spawning. Perch spawn March to May. They feed hard beforehand, are
//   preoccupied during, and are in poor condition for weeks afterwards.
//
//   Prey. The year's fry hatch in spring and are too small to interest a decent
//   perch until late summer. By October they are at their largest and most
//   abundant, and perch are gorging on them.
//
//   Shoaling. Perch pack into tight shoals through autumn and hunt
//   co-operatively, which is why a good October swim produces fish after fish.
//
// Values are angler consensus for Midlands canals, not measurements, which is
// why the factor is worth 0.7 of the 5 and not more. Zero is the worst month, 1
// the best, interpolated between month midpoints.
export const SEASON_PERCH = {
  1: 0.45, // cold and slow, but the month for a big single fish
  2: 0.55, // pre-spawn feeding begins as light returns
  3: 0.6, // pre-spawn peak, then spawning starts
  4: 0.25, // spawning
  5: 0.2, // spent, recovering, the worst of the year
  6: 0.35, // condition returning
  7: 0.45, // fry still too small to be worth chasing
  8: 0.55, // fry growing into a worthwhile meal
  9: 0.7, // shoals forming
  10: 0.9, // the peak: shoaled, gorging on fry at their biggest
  11: 0.85, // still excellent, fish at their heaviest
  12: 0.6, // cooling off but the shoals are still findable
};

const MONTH_MID_DOY = [15, 46, 75, 105, 136, 166, 197, 228, 258, 289, 319, 350];

/** Seasonal quality on a day of year, 0 to 1, interpolated between month midpoints. */
export function seasonQuality(doy) {
  const v = (i) => SEASON_PERCH[((i % 12) + 12) % 12 + 1];
  let i = MONTH_MID_DOY.findIndex((m) => m > doy);
  if (i === -1) i = 0;
  const j = (i + 11) % 12;
  let a = MONTH_MID_DOY[j];
  let b = MONTH_MID_DOY[i];
  let x = doy;
  if (i === 0) {
    b += 365;
    if (x < a) x += 365;
  }
  const t = (x - a) / (b - a);
  return v(j) + (v(i) - v(j)) * t;
}

/** A short reason for the month's seasonal mark, so the breakdown says something. */
export function seasonNote(month) {
  if (month === 3) return 'pre-spawn, feeding hard';
  if (month === 4 || month === 5) return 'spawning and recovery, the low point';
  if (month === 6 || month === 7) return 'condition returning, fry still small';
  if (month === 8) return 'fry growing into a meal';
  if (month === 9) return 'shoals forming';
  if (month === 10 || month === 11) return 'peak: shoaled and gorging on fry';
  return 'cold water, fewer but bigger fish';
}

// Water-temperature proxy: exponential moving average of air temperature with
// a 2.5-day time constant (τ = ρ·cp·h/K for h≈1.3 m, K≈25 W/m²K), plus a small
// solar-gain term, floored at 0 °C.
export const WATER_TAU_HOURS = 60;
export const WATER_SOLAR_GAIN = 1.5; // °C at a 24h-mean brightness of 1.0
// Canal colour proxy: run-off and boat-wash accumulators, summed.
//
// The two inputs clear at very different rates, so they get separate half-lives.
// Rain run-off carries suspended clay that stays up for days. Boat wash is a
// propeller stirring silt off the bed, and it settles within hours of the last
// boat. Running both through one 48 h accumulator made boat wash behave like
// rain: it added a near-constant offset of about 13 index points to every
// summer day, which put "clear" out of reach between May and September and
// swamped the rainfall signal the index exists to carry.
export const COLOUR_HALF_LIFE_HOURS = 48;
export const BOAT_COLOUR_HALF_LIFE_HOURS = 6;

// Index units per mm of rain. A canal is not a river. It is impounded, level-
// controlled by weirs, and has almost no upstream catchment delivering suspended
// load, so rain mostly raises the level rather than carrying clay in. With no
// current to hold silt up, what does get stirred settles out.
//
// The model used to count 1 mm of rain as 1 index unit, which is a river
// catchment's response. That read 44.6 mm over three days as "coloured" water
// when the canal was in fact quite clear. This coefficient is set from two
// clarity observations at Knowle, so treat the exact value as provisional: the
// direction and rough scale are supported, the second digit is not.
export const RUNOFF_COLOUR_COEFF = 0.3;
export const BOAT_COLOUR_INPUT = { busy: 0.6, normal: 0.3, shoulder: 0.1, none: 0 }; // mm-equivalent per hour

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
/**
 * Value from a table of [lo, hi, points] bands, with the boundaries softened.
 *
 * Each band is a plateau: the table says 8-18 C is all equally good for perch,
 * and that claim is kept intact. Only the joins are smoothed, over BAND_BLEND_C
 * either side of a boundary.
 *
 * The reason is that a tenth of a degree across 18 C used to move the water
 * factor by a third of its range, which is an artefact of where the bin edge was
 * drawn rather than a fact about fish. Blending across a degree removes the
 * cliff without inventing a curve the evidence does not support.
 */
export const BAND_BLEND_C = 1.0;

const bandStep = (bands, v) => {
  for (const [lo, hi, pts] of bands) if (v >= lo && v < hi) return pts;
  return v < bands[0][0] ? bands[0][2] : bands[bands.length - 1][2];
};

const band = (bands, v) => {
  if (!bands.length || !Number.isFinite(v)) return 0;
  const half = BAND_BLEND_C / 2;
  for (let i = 1; i < bands.length; i++) {
    const edge = bands[i][0];
    if (v > edge - half && v < edge + half) {
      const t = (v - (edge - half)) / BAND_BLEND_C;
      return bands[i - 1][2] + (bands[i][2] - bands[i - 1][2]) * t;
    }
  }
  return bandStep(bands, v);
};

/** Crepuscular peaks are strongest Oct–Apr and flatten in midsummer (Craig 1977; Jacobsen 2002). */
export function twilightSeasonFactor(month) {
  if (month >= 10 || month <= 4) return 1.0;
  if (month === 5 || month === 9) return 0.8;
  return 0.6; // Jun–Aug
}

/** Clamp a raw score to the 0-5 scale. */
export function clampScore(raw) {
  return Math.min(5, Math.max(0, raw));
}

/** Brightness 0..1: 0 at night, ~1 at clear noon, ~0.3 overcast noon. */
export function brightness(sunAltDeg, cloudPct, visibilityM) {
  if (sunAltDeg <= 0) return 0;
  const elev = Math.sqrt(Math.sin((sunAltDeg * Math.PI) / 180));
  const cloud = Number.isFinite(cloudPct) ? clamp(cloudPct, 0, 100) : 50;
  let b = elev * (1 - 0.7 * cloud / 100);
  if (Number.isFinite(visibilityM) && visibilityM < 2000) b *= 0.5;
  return clamp(b, 0, 1);
}

export function ratingLabel(score) {
  if (score >= 4.2) return 'Excellent';
  if (score >= 3.4) return 'Good';
  if (score >= 2.6) return 'Fair';
  if (score >= 1.8) return 'Poor';
  return 'Stay home';
}

/** Canal water temperature proxy. `bright` (optional) is the hourly brightness series for solar gain. */
export function waterTempSeries(temps, bright, tauHours = WATER_TAU_HOURS) {
  const alpha = 1 - Math.exp(-1 / tauHours);
  const out = new Array(temps.length);
  const n0 = Math.min(24, temps.length);
  let acc = temps.slice(0, n0).reduce((s, v) => s + v, 0) / Math.max(1, n0);
  let sun = 0;
  const alphaSun = 1 - Math.exp(-1 / 24);
  for (let i = 0; i < temps.length; i++) {
    const t = Number.isFinite(temps[i]) ? temps[i] : acc;
    acc = acc + alpha * (t - acc);
    if (bright) sun = sun + alphaSun * ((bright[i] || 0) - sun);
    out[i] = Math.max(0, acc + WATER_SOLAR_GAIN * sun);
  }
  return out;
}

/**
 * Canal colour proxy (mm-equivalent): run-off and boat-wash accumulators summed.
 * Run-off decays over days, boat wash over hours. See the note on the half-life
 * constants for why they are kept apart.
 */
export function colourSeries(precip, boatInput, halfLifeHours = COLOUR_HALF_LIFE_HOURS, boatHalfLifeHours = BOAT_COLOUR_HALF_LIFE_HOURS) {
  const kRain = Math.pow(0.5, 1 / halfLifeHours);
  const kBoat = Math.pow(0.5, 1 / boatHalfLifeHours);
  const out = new Array(precip.length);
  let rain = 0;
  let boat = 0;
  for (let i = 0; i < precip.length; i++) {
    rain = rain * kRain + (Number.isFinite(precip[i]) ? precip[i] * RUNOFF_COLOUR_COEFF : 0);
    boat = boat * kBoat + (boatInput ? boatInput[i] || 0 : 0);
    out[i] = rain + boat;
  }
  return out;
}

export function colourLabel(v) {
  if (v < 5) return 'clear';
  if (v < 12) return 'tinged';
  if (v < 25) return 'coloured';
  return 'chocolate';
}

function meanRange(arr, from, to) {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++) {
    if (Number.isFinite(arr[i])) {
      s += arr[i];
      n++;
    }
  }
  return n ? s / n : NaN;
}

/**
 * Boat traffic class for a local hour. Canals are busiest Apr–Oct daytime,
 * with weekends/bank holidays and the Jul–Aug hire-boat peak busiest of all.
 * Nov–Mar most traffic stops (CRT winter stoppages, few hire boats).
 */
export function boatTraffic({ month, hour, weekday, isBankHoliday }) {
  const daytime = hour >= 9 && hour < 18;
  if (!daytime) return 'none';
  const weekendish = weekday === 0 || weekday === 6 || isBankHoliday;
  if (month >= 5 && month <= 9) {
    if (weekendish || month === 7 || month === 8) return 'busy';
    return 'normal';
  }
  if (month === 4 || month === 10) return weekendish ? 'normal' : 'shoulder';
  if (month === 3 || month === 11) return weekendish ? 'shoulder' : 'none';
  return 'none';
}


/**
 * Score every hour for one species.
 * @param {object} wx normalised hourly weather (see data.js) — arrays aligned to wx.time (unix s)
 * @param {object} ctx { lat, lng, tz, species, bankHolidays:Set<'YYYY-MM-DD'>, solunar:boolean }
 */
export function scoreHours(wx, ctx) {
  const species = ctx.species || 'perch';
  const prof = PROFILES[species];
  const tz = ctx.tz || 'Europe/London';
  const n = wx.time.length;

  // Pass 1: per-hour local calendar, sun altitude, brightness, boat traffic.
  const lps = new Array(n);
  const alts = new Array(n);
  const brights = new Array(n);
  const boats = new Array(n);
  const boatInput = new Array(n);
  for (let i = 0; i < n; i++) {
    const date = new Date(wx.time[i] * 1000);
    const lp = localParts(date, tz);
    lps[i] = lp;
    alts[i] = sunAltitudeDeg(date, ctx.lat, ctx.lng);
    brights[i] = brightness(alts[i], wx.cloud[i], wx.visibility ? wx.visibility[i] : NaN);
    boats[i] = boatTraffic({ month: lp.month, hour: lp.hour, weekday: lp.weekday, isBankHoliday: ctx.bankHolidays?.has(lp.dateKey) });
    boatInput[i] = BOAT_COLOUR_INPUT[boats[i]];
  }
  const water = waterTempSeries(wx.temp, brights);
  const colour = colourSeries(wx.precip, boatInput);

  const perDay = new Map(); // dateKey -> { dusk, solunar, moon }
  const dayInfo = (lp) => {
    let d = perDay.get(lp.dateKey);
    if (!d) {
      const midnight = midnightForDateKey(lp.dateKey, tz);
      const noon = new Date(midnight.valueOf() + 43200000);
      const sun = getSunTimes(noon, ctx.lat, ctx.lng);
      d = {
        dusk: sun.dusk ? sun.dusk.valueOf() / 1000 : NaN,
        solunar: ctx.solunar ? getSolunarPeriods(midnight, ctx.lat, ctx.lng).periods : null,
        moon: getMoonIllumination(noon),
      };
      perDay.set(lp.dateKey, d);
    }
    return d;
  };

  const results = [];
  for (let i = 0; i < n; i++) {
    const t = wx.time[i];
    const date = new Date(t * 1000);
    const lp = lps[i];
    const parts = [];
    const flags = [];
    const add = (key, value, note) => {
      const f = FACTORS[key];
      parts.push({ key, label: f.label, value: round2(Math.min(f.max, Math.max(0, value))), max: f.max, note });
    };

    // 1. Light: sun angle × cloud × fog, with a species-specific diel curve.
    const alt = alts[i];
    const cloud = wx.cloud[i];
    const B = brights[i];
    const c = colour[i];
    const di = dayInfo(lp);
    // "After dusk" = the 3h following civil dusk (yesterday's dusk for the small hours).
    let sinceDusk = Number.isFinite(di.dusk) ? t - di.dusk : NaN;
    if (Number.isFinite(sinceDusk) && sinceDusk < 0) {
      const y = localParts(new Date((t - 86400) * 1000), tz);
      const yd = dayInfo(y);
      sinceDusk = Number.isFinite(yd.dusk) ? t - yd.dusk : NaN;
    }
    let lightPts;
    let lightNote;
    if (alt < -6) {
      if (Number.isFinite(sinceDusk) && sinceDusk >= 0 && sinceDusk < 3 * 3600) {
        lightPts = prof.afterDusk;
        lightNote = 'first hours after dusk';
      } else {
        lightPts = prof.night;
        lightNote = 'dark';
      }
    } else if (alt < 10) {
      lightPts = prof.twilight * twilightSeasonFactor(lp.month) - 0.3 * B;
      lightNote = alt < 0 ? 'twilight' : 'low sun';
      if (twilightSeasonFactor(lp.month) < 1) lightNote += ' (summer: weaker peak)';
    } else {
      lightPts = prof.dayBase - prof.daySlope * B;
      lightNote = cloud >= 70 ? `overcast ${Math.round(cloud)}%` : cloud >= 40 ? `partly cloudy ${Math.round(cloud)}%` : `bright, ${Math.round(cloud)}% cloud`;
      const vis = wx.visibility ? wx.visibility[i] : NaN;
      if (Number.isFinite(vis) && vis < 2000) lightNote += ', murky/fog';
    }
    const [lightLo, lightHi] = lightRange(prof);
    add('light', toBudget(lightPts, lightLo, lightHi, FACTORS.light.max), lightNote);

    // 2. Water temperature proxy
    const tw = water[i];
    const [waterLo, waterHi] = waterRange(species);
    add('water', toBudget(band(WATER_TEMP[species], tw), waterLo, waterHi, FACTORS.water.max), `~${tw.toFixed(1)}°C (est.)`);

    // 2b. Season: spawning state and prey availability, which the water
    //     temperature cannot express. See the note on SEASON_PERCH.
    const doy = dayOfYear(lp.year, lp.month, lp.day);
    add('season', seasonQuality(doy) * FACTORS.season.max, `${date.toLocaleString('en-GB', { month: 'long', timeZone: tz })} — ${seasonNote(lp.month)}`);

    // 3. Run-up is added in a second pass: it reads every other factor, so it
    //    cannot be computed until they all exist. See below the loop.

    // 4. Pressure — tie-breaker only (no direct effect in controlled studies).
    if (i >= 24 && Number.isFinite(wx.pressure[i]) && Number.isFinite(wx.pressure[i - 24])) {
      const d24 = wx.pressure[i] - wx.pressure[i - 24];
      const tempDrop = i >= 48 ? meanRange(wx.temp, i - 24, i) - meanRange(wx.temp, i - 48, i - 24) : 0;
      let pts = 0;
      let note = `${d24 >= 0 ? '+' : ''}${d24.toFixed(1)} hPa/24h`;
      if (d24 <= -3) {
        pts = WEIGHTS.pressure.falling;
        note += ', falling (weather on the move)';
      } else if (d24 >= 8 && cloud < 30 && tempDrop < -1) {
        pts = WEIGHTS.pressure.risingClearingCold;
        note += ', post-frontal: rising, clearing, colder';
      } else note += d24 >= 3 ? ', rising' : ', steady';
      add('pressure', toBudget(pts, WEIGHTS.pressure.risingClearingCold, WEIGHTS.pressure.falling, FACTORS.pressure.max), note);
    }

    // 5. Rain now (small: rain mostly acts via light and colour)
    const p = wx.precip[i] || 0;
    const code = wx.weatherCode ? wx.weatherCode[i] : 0;
    const rainLo = Math.min(prof.rain.heavy, prof.rain.moderate, prof.rain.light, 0);
    const rainHi = Math.max(prof.rain.heavy, prof.rain.moderate, prof.rain.light, 0);
    const rainPts = (raw, note) => add('rain', toBudget(raw, rainLo, rainHi, FACTORS.rain.max), note);
    if (code >= 95) {
      add('rain', 0, 'thunderstorm — stay off the bank');
      flags.push('thunder');
    } else if (p >= 4) rainPts(prof.rain.heavy, `heavy ${p.toFixed(1)} mm/h`);
    else if (p >= 1.5) rainPts(prof.rain.moderate, `moderate ${p.toFixed(1)} mm/h`);
    else if (p >= 0.1) rainPts(prof.rain.light, `light ${p.toFixed(1)} mm/h`);
    else rainPts(0, 'dry');

    // 7. Canal colour no longer scores. The index is still computed, and still
    // drives the lure guidance and the facts panel, but it does not move the
    // score. See "Water clarity was removed from the score" in ALGORITHM.md.

    // 6. Wind (speed only; direction acts through air mass = temperature/cloud)
    const wind = wx.wind[i];
    const gust = wx.gust ? wx.gust[i] : NaN;
    const ww = WEIGHTS.wind;
    if (Number.isFinite(wind)) {
      let pts = 0;
      let note = `${Math.round(wind)} mph`;
      if (wind > 28) {
        pts = ww.gale;
        note += ', gale';
      } else if (wind > 20) {
        pts = ww.strong;
        note += ', strong';
      } else if (wind > 12) {
        pts = prof.windFresh;
        note += ', fresh';
      } else if (wind >= 4) {
        pts = ww.ripple;
        note += ', good ripple';
      } else if (B > 0.5) {
        pts = ww.flatBright;
        note += ', flat calm & bright';
      } else note += ', calm';
      if (Number.isFinite(gust) && gust >= 30) {
        pts += ww.gusty;
        note += `, gusts ${Math.round(gust)}`;
      }
      const windLo = Math.min(ww.gale + ww.gusty, ww.strong, prof.windFresh, ww.flatBright);
      const windHi = Math.max(ww.ripple, prof.windFresh, 0);
      add('wind', toBudget(pts, windLo, windHi, FACTORS.wind.max), note);
    }

    // 7. Boat traffic disturbance (colour effect already in the colour index)
    const traffic = boats[i];
    const boatRaw = traffic === 'none' ? 0 : prof.boats[traffic];
    const boatNote = traffic === 'none' ? 'quiet' : traffic === 'busy' ? 'busy — weekend/holiday/peak season' : traffic === 'normal' ? 'moderate' : 'light';
    add('boats', toBudget(boatRaw, prof.boats.busy, 0, FACTORS.boats.max), boatNote);

    // 10. Frost / ice
    // Frost no longer scores on its own: freezing air is already in the water
    // temperature proxy, and counting it twice was double-counting one mechanism.
    const airMin24 = i >= 24 ? Math.min(...wx.temp.slice(i - 24, i + 1).filter(Number.isFinite)) : wx.temp[i];
    if (tw < 1.5 && airMin24 < -3) flags.push('ice');

    // 8. Moon: small syzygy effect (Kuparinen 2010; Vinson & Angradi 2014).
    const phase = di.moon.phase;
    const distNew = Math.min(phase, 1 - phase);
    const distFull = Math.abs(phase - 0.5);
    const daysFromSyzygy = Math.min(distNew, distFull) * 29.53;
    const moonMax = FACTORS.moon.max;
    let moonPts = moonMax * 0.3;
    let moonNote = 'no lunar edge';
    if (daysFromSyzygy <= 3) {
      moonPts = moonMax;
      moonNote = `${distFull < distNew ? 'full' : 'new'} moon ±3 days`;
    }

    // 9. Solunar periods — opt-in, traditional; no predictive value in controlled tests.
    if (di.solunar) {
      const hit = solunarAt(date, di.solunar);
      if (hit) {
        // Shares the moon budget rather than adding to it, so switching solunar
        // on cannot inflate the total past 5.
        moonPts = Math.max(moonPts, hit === 'major' ? moonMax : moonMax * 0.6);
        moonNote = `${hit} solunar period (traditional)`;
      }
    }
    add('moon', moonPts, moonNote);

    // The score is the sum of the factors. No base, no gain, nothing to clamp
    // in normal use: each factor is already bounded by its own share of the 5.
    const fishable = prof.fishableNight || alt >= -8;
    results.push({
      time: t,
      dateKey: lp.dateKey,
      hour: lp.hour,
      score: 0,
      raw: 0,
      parts,
      flags,
      fishable,
      sunAlt: round1(alt),
      brightness: round1(B),
      waterTemp: round1(tw),
      colour: round1(c),
      temp: wx.temp[i],
      wind,
      precip: p,
      cloud,
      pressure: wx.pressure[i],
      traffic,
    });
  }

  // ---- second pass: the run-up ---------------------------------------------
  // Everything but the run-up is scored, so the sum of those factors is an
  // hourly quality between 0 and 1. The run-up reads that series, which is how
  // it picks up heatwaves, week-long storms, blocking highs and droughts alike
  // rather than one variable's trend.
  const otherMax = FACTOR_TOTAL - FACTORS.runup.max;
  const quality = results.map((r) => r.parts.reduce((s, x) => s + x.value, 0) / otherMax);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ru = runUpScore(quality, i);
    const f = FACTORS.runup;
    const value = ru ? Math.min(f.max, Math.max(0, ru.pts)) : f.max * 0.5;
    // Keep the run-up in reading order, right after water temperature.
    const at = r.parts.findIndex((x) => x.key === 'water');
    r.parts.splice(at < 0 ? r.parts.length : at + 1, 0, {
      key: 'runup',
      label: f.label,
      value: round2(value),
      max: f.max,
      note: ru ? ru.note : 'not enough history yet',
    });
    const raw = r.parts.reduce((s, x) => s + x.value, 0);
    r.raw = round2(raw);
    r.score = round1(clampScore(raw));
  }
  return results;
}

/**
 * Collapse hourly results into per-day summaries. The day score is the mean of
 * the best 3 fishable hours (≈ "how good is the best session you could fish"),
 * not the daily mean — nobody fishes 24 hours.
 */
export function summariseDays(hours, ctx, { fromTime = 0 } = {}) {
  const tz = ctx.tz || 'Europe/London';
  const byDay = new Map();
  for (const h of hours) {
    if (h.time < fromTime) continue;
    if (!byDay.has(h.dateKey)) byDay.set(h.dateKey, []);
    byDay.get(h.dateKey).push(h);
  }
  const days = [];
  for (const [dateKey, hs] of byDay) {
    const fishable = hs.filter((h) => h.fishable);
    if (fishable.length < 3) continue; // partial day at the series edge
    const top3 = [...fishable].sort((a, b) => b.score - a.score).slice(0, 3);
    const score = round1(top3.reduce((s, h) => s + h.score, 0) / 3);

    // Best contiguous 3h window among fishable hours.
    let best = null;
    for (let i = 0; i + 2 < fishable.length; i++) {
      const a = fishable[i];
      const c = fishable[i + 2];
      if (c.time - a.time !== 7200) continue;
      const sum = a.score + fishable[i + 1].score + c.score;
      if (!best || sum > best.sum) best = { sum, start: a.time, end: c.time + 3600 };
    }

    // Peaks: fishable hours within 0.4 of the day's best hour, grouped into windows.
    const maxScore = Math.max(...fishable.map((h) => h.score));
    const windows = [];
    let cur = null;
    for (const h of fishable) {
      const good = h.score >= maxScore - 0.4 && h.score >= 2.6;
      if (good && cur && h.time - cur.end === 0) cur.end = h.time + 3600;
      else if (good) {
        cur = { start: h.time, end: h.time + 3600, peak: h.score };
        windows.push(cur);
      } else cur = null;
      if (good && cur) cur.peak = Math.max(cur.peak, h.score);
    }

    const mid = hs.find((h) => h.hour === 12) || hs[Math.floor(hs.length / 2)];
    const pressurePart = mid.parts.find((p) => p.key === 'pressure');
    const midnight = midnightForDateKey(dateKey, tz);
    const noon = new Date(midnight.valueOf() + 43200000);
    const moon = getMoonIllumination(noon);
    const sol = ctx.solunar ? getSolunarPeriods(midnight, ctx.lat, ctx.lng).periods : [];
    const flags = [...new Set(hs.flatMap((h) => h.flags))];

    days.push({
      dateKey,
      score,
      label: ratingLabel(score),
      bestWindow: best ? { start: best.start, end: best.end, score: round1(best.sum / 3) } : null,
      windows,
      hours: hs,
      waterTemp: mid.waterTemp,
      colour: mid.colour,
      colourLabel: colourLabel(mid.colour),
      pressureNote: pressurePart?.note ?? null,
      tempRange: [Math.min(...hs.map((h) => h.temp)), Math.max(...hs.map((h) => h.temp))].map(round1),
      rainTotal: round1(hs.reduce((s, h) => s + (h.precip || 0), 0)),
      windMax: Math.round(Math.max(...hs.map((h) => h.wind || 0))),
      cloudMean: Math.round(hs.reduce((s, h) => s + (h.cloud || 0), 0) / hs.length),
      traffic: hs.some((h) => h.traffic === 'busy') ? 'busy' : hs.some((h) => h.traffic === 'normal') ? 'moderate' : hs.some((h) => h.traffic === 'shoulder') ? 'light' : 'quiet',
      moon: { phase: moon.phase, fraction: round1(moon.fraction), name: moonPhaseName(moon.phase) },
      solunar: sol,
      flags,
    });
  }
  return days;
}

/** Convenience: full forecast for one species. */
export function forecast(wx, ctx, opts) {
  const hours = scoreHours(wx, ctx);
  const days = summariseDays(hours, ctx, opts);
  return { hours, days };
}

// ---------------------------------------------------------------------------
// Lure guidance
//
// Same clarity axis as the scoring, read for tackle instead of timing. In clear
// water a perch has time to follow and inspect, so a small natural profile on
// fine line wins and anything loud gets refused. As clarity drops the fish stops
// working on detail and starts working on silhouette, contrast and vibration, so
// bright colours, UV and a bit more noise earn their place.
//
// This is guidance, not scoring. It does not enter the score.
export const LURE_GUIDE = [
  {
    max: 5,
    clarity: 'clear',
    colours: ['natural baitfish', 'motor oil', 'smoke', 'translucent browns and greens'],
    size: 'smallest in the box, 30–40 mm',
    action: 'subtle: drop shot, slow straight lift, long casts and fine line',
    why: 'The fish gets a long look before it commits, so detail and a natural profile matter more than attraction.',
  },
  {
    max: 12,
    clarity: 'tinged',
    colours: ['silver and white baitfish', 'dark back over pale belly', 'UV accents'],
    size: '38–50 mm',
    action: 'a little more movement: jig with sharper lifts, or a light spinnerhead',
    why: 'Enough visibility for the fish to track a lure, enough cover that it commits instead of inspecting. The best of both.',
  },
  {
    max: 25,
    clarity: 'coloured',
    colours: ['chartreuse', 'firetiger', 'orange belly', 'strong UV'],
    size: '40–70 mm',
    action: 'push water: paddle tails, rattles, slower retrieve, work close to features',
    why: 'Contrast and vibration do the finding now. Reaction distance is short, so keep the lure in front of the fish for longer.',
  },
  {
    max: 999,
    clarity: 'chocolate',
    colours: ['black', 'chartreuse', 'firetiger', 'anything with a rattle'],
    size: '50–80 mm',
    action: 'vibration first: bladed jigs and rattles, very slow, tight to the near shelf',
    why: 'Sight is nearly out of the equation. A dark silhouette and a lateral-line signal beat any colour subtlety.',
  },
];

/** Clarity band for a colour index, from LURE_GUIDE. */
export function lureBand(colourIndex) {
  return LURE_GUIDE.find((b) => colourIndex < b.max) ?? LURE_GUIDE[LURE_GUIDE.length - 1];
}

/**
 * Lure guidance for a set of conditions. `cloudPct` shifts the advice within a
 * band: bright sun over clear water is the hardest combination and pushes the
 * advice smaller and more natural, while heavy cloud relaxes it.
 */
export function lureAdvice({ colourIndex, cloudPct = 50 }) {
  const band = lureBand(colourIndex);
  const notes = [];
  if (band.clarity === 'clear' && cloudPct < 40) {
    notes.push('Bright sun on clear water is the hardest combination. Go smaller still, lengthen the cast and fish the shade.');
  }
  if (band.clarity !== 'clear' && cloudPct > 80) {
    notes.push('Heavy cloud holds the light down all day, so the good window is wider than the usual dawn and dusk.');
  }
  return { ...band, notes };
}

/**
 * The lures actually in the bag, so the guidance can name one instead of
 * describing a colour family. `logged` records what happened on the bank: three
 * sessions is a starting log, not evidence. Edit freely as the log grows.
 */
export const LURE_BOX = [
  {
    name: 'Micro Fry Nano 38 mm — Mini Minnow',
    detail: 'dark grey back, silver-white belly',
    clarity: ['tinged'],
    logged: 'Sun 30 Aug, tinged water: did great.',
  },
  {
    name: 'Fox Rage Ultra UV Micro Spikey Fry 40 mm',
    detail: 'dark green, orange belly, UV',
    clarity: ['tinged', 'coloured'],
    logged: 'Mon 31 Aug, tinged water: one large perch and a few bites.',
  },
  {
    name: 'Micro Fry Nano 38 mm — Motor Oil Red',
    detail: 'dark translucent, red fleck',
    clarity: ['clear'],
    logged: 'Wed 2 Sept, clearest water seen there: the only bites of the session.',
  },
];

/** The lures in LURE_BOX that suit a clarity band, best first. */
export function lurePicks(clarity) {
  return LURE_BOX.filter((l) => l.clarity.includes(clarity));
}
