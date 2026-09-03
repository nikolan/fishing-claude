# Fishing Claude — scoring algorithm

Species: **perch**, **pike**, **zander** on Midlands canals (~1.2–1.5 m deep, pound-regulated, boat-coloured).
Scale: 0–5 per hour; day score = mean of the best three fishable hours.

This document is the spec for `public/src/engine.js`. Every weight below is a constant in that file — change it there, the in-app "How the score is built" panel reads the same constants.

## 0. What changed from your original algorithm, and why

| Original (daily, perch only) | Now | Reason |
|---|---|---|
| Season base 2.6 / 2.8 (late Aug / early Sep) | ~~12-month curve per species~~ **removed; replaced by a flat base of 2.5** | See "The seasonal base was removed" below |
| Precipitation +1.0 light rain | +0.3 (perch) | Rain acts mainly through light and colour, which are scored directly; evidence grade B |
| Cloud cover as its own factor (+0.8 / +0.3 / −0.5) | Folded into a single **light** component = sun elevation × cloud × fog, with species-specific diel curve | Prevents double-counting dusk + overcast; makes hourly forecasts possible |
| Pressure falling +0.7 / rising −0.4 | Falling +0.2, post-frontal rise −0.3 (needs rise ≥ 8 hPa **and** clearing **and** colder) | Two controlled angling studies found **no** direct pressure effect (Kuparinen 2010; Escanaba 2021). What's real in the folklore is the covarying weather, already scored |
| Temperature (air) bands | **Water temperature proxy** (2.5-day EWMA of air + solar term) with species-specific bands; plus a 3-day **trend** term | Water, not air, drives fish; Casselman / Craig / Frisk give the bands |
| Wind speed thresholds | Kept, with ripple bonus and gust penalty; wind **direction weight 0** | "East wind" acts via air mass (temperature, cloud) — grade C on its own |
| Solunar +0.3 optional | Off by default, +0.15 major / +0.05 minor if enabled; **new/full moon ±3 days +0.15** on by default | Quigley 2023: solunar tables have zero predictive value; syzygy effect (~5%) is real in two large datasets |
| — | **Canal colour index** (rain run-off, 48 h half-life, plus boat wash, 6 h half-life) | The main perch-vs-zander differentiator (Ljunggren & Sandström 2007) |
| — | **Boat traffic** disturbance (season × weekday × bank holiday × hour) | Biggest non-weather driver on canals |
| — | Cold-snap / mild-spell / frost / ice / thunder / pike-welfare flags | Safety and welfare |
| Hard clamp at 5 | Soft cap: above 4.0 excess counts ⅓, hard cap 5 | Reproduces your "5.6 → ~4.5" behaviour explicitly |

## 1. Inputs (all free, no keys, fetched from the phone)

| Source | Used for |
|---|---|
| **Open-Meteo forecast API** (`past_days=14`, `forecast_days=8`, hourly `temperature_2m, precipitation, cloud_cover, pressure_msl, wind_speed_10m, wind_gusts_10m, wind_direction_10m, weather_code, visibility`) | Everything weather-side, incl. 14 days of history for the water-temperature proxy and pressure trend. CC BY 4.0 |
| **Environment Agency flood-monitoring API** — nearest 15-min rainfall gauge within 15 km | Observed rain replaces modelled past rain in the colour index (optional; CORS `*`, OGL v3) |
| **GOV.UK bank-holidays.json** | Boat-traffic weekend logic |
| **On-device astronomy** (Meeus / SunCalc algorithms in `astro.js`) | Sun altitude, civil dawn/dusk, moon phase, moon transit/underfoot and rise/set for solunar |

Not used, deliberately: Met Office DataHub (needs a key), Open-Meteo archive (2–5 day lag; `past_days` is better), CRT stoppage notices (no CORS — would need a scheduled snapshot), any water-temperature feed (none exists for canals).

## 2. Derived series

- **Water temperature proxy** `Tw = EWMA(air, τ = 60 h) + 1.5 × EWMA(brightness, 24 h)`, floored at 0 °C. τ from ρ·c<sub>p</sub>·h / K with h ≈ 1.3 m, K ≈ 25 W m⁻² K⁻¹ (Edinger 1968). Cross-check with a thermometer; feeders, lock flows and urban outfalls shift the offset.
- **Brightness** `B = √sin(sun altitude) × (1 − 0.7 × cloud/100)`, halved when visibility < 2 km. 0 at night, ≈1 clear noon, ≈0.3 overcast noon.
- **Colour index** `C[t] = C[t−1] × 0.5^(1/48) + rain_mm[t] + boat_input[t]` with boat input 0.6 / 0.3 / 0.1 mm-eq per hour for busy / moderate / light traffic. Bands: <5 clear, 5–12 tinged, 12–25 coloured, ≥25 chocolate. Calibrate against what you see.
- **Boat traffic** (09:00–18:00 only): May–Sep weekends/bank holidays and all of Jul–Aug → *busy*; May–Sep weekdays → *moderate*; Apr/Oct → moderate (weekend) / light (weekday); Mar/Nov weekends → light; otherwise none (CRT winter stoppages Nov–Mar).
- **Air-temperature trend** = mean(last 72 h) − mean(previous 72 h).

## 3. Components and weights

Evidence grade: **A** peer-reviewed on the species (or a close congener), **B** consistent angler consensus / transferred science, **C** folklore.

### 3.1 Season base (grade B, anchored by A for spawning and thermal windows)

| Month | Perch | Pike | Zander |
|---|---|---|---|
| Jan | 2.0 | 2.3 | 2.3 |
| Feb | 2.2 | 2.6 | 2.3 |
| Mar | 2.4 | 2.0 | 2.0 |
| Apr | 1.4 | 1.3 | 1.3 |
| May | 1.8 | 1.6 | 1.3 |
| Jun | 2.1 | 1.3 | 2.0 |
| Jul | 2.1 | 0.7 | 2.3 |
| Aug | 2.4 | 0.7 | 2.3 |
| Sep | 2.8 | 1.6 | 2.6 |
| Oct | 3.1 | 2.6 | 2.9 |
| Nov | 3.0 | 2.9 | 2.9 |
| Dec | 2.4 | 2.9 | 2.6 |

Perch spawn Mar–May at 9–13 °C; pike late Feb–Apr at 8–15 °C; zander Apr–May at 12–15 °C. The pike summer trough is welfare-driven (PAC: refrain 16 Jun – 1 Oct). Canals have **no statutory close season** (removed by byelaw in 2000) — check club rules.

### 3.2 Light (grade A for the diel pattern; thresholds are engineering choices)

| Regime | Perch | Pike | Zander |
|---|---|---|---|
| Dark (sun < −6°), not within 3 h of dusk | −0.4 | −0.2 | +0.4 |
| First 3 h after civil dusk | −0.4 | −0.1 | **+0.9** |
| Twilight / low sun (−6° … +10°) | +0.8 × S | +0.5 × S | +0.7 × S |
| Day (> +10°) | 0.8 − 1.5·B·(1 − R) | 0.5 − 0.8·B | 0.2 − 1.5·B·(1 − R) |

S = seasonal factor for crepuscular peaks: 1.0 Oct–Apr, 0.8 May/Sep, 0.6 Jun–Aug (Craig 1977; Jacobsen 2002). R = colour relief when C ≥ 12: 0.3 perch, 0.5 zander (coloured water flattens the diel curve — Angling Times consensus; Ljunggren & Sandström). Sources: Craig 1977; Jacobsen et al. 2002; Horký et al. 2008 (zander activity peaks at twilight, rests at night); Kuparinen et al. 2010 (pike CPUE highest at dusk).

### 3.3 Water temperature (grade A/B)

| Tw °C | Perch | Pike | Zander |
|---|---|---|---|
| < 2 | −0.8 | −0.3 | −0.2 |
| 2–4 | −0.5 | −0.3 | −0.2 |
| 4–6 | −0.1 | −0.1 | +0.2 |
| 6–8 | −0.1 | +0.2 | +0.2 |
| 8–9 | +0.5 | +0.2 | +0.2 |
| 9–10 | +0.5 | +0.5 | +0.2 |
| 10–18 | +0.5 | +0.5 | +0.4 |
| 18–20 | +0.1 | −0.6 ⚠ | +0.4 |
| 20–23 | +0.1 | −1.2 ⚠ | +0.4 |
| 23–27 | −0.3 | −1.2 ⚠ | +0.4 |
| > 27 | −0.3 | −1.2 ⚠ | −0.3 |

⚠ = pike welfare flag shown in the app (PAC: don't target pike at ≥ 18 °C). Sources: Craig 1977 (perch activity ∝ temperature); specialist consensus that big perch rarely feed < 4 °C; Casselman 1978 (pike peak 15–18 °C, markedly less active < 6 °C); Frisk et al. 2012 (zander aerobic-scope plateau 10–27 °C).

### 3.4 Trend (grade A/B)

- Cold snap: 3-day mean ≤ −5 °C vs previous 3 days → −0.5 (perch, pike), −0.25 (zander).
- Mild spell: ≥ +3 °C, Nov–Mar → +0.3.
- Summer cooling: pike only, ≤ −2 °C with Tw > 16 °C → +0.2 (Kuparinen: pike CPUE ↑ with lower water temperature).
- While < 6 days of history exist, a 24 h version of the cold-snap test is used.

### 3.5 Colour (grade A lab / B field)

| C index | Perch | Pike | Zander |
|---|---|---|---|
| < 5 clear | +0.1 | 0 | 0 |
| 5–12 tinged | 0 | 0 | +0.25 |
| 12–25 coloured | −0.35 | +0.1 | +0.5 |
| ≥ 25 chocolate | −0.7 | 0 | +0.5 |

Perch foraging falls sharply at ~25 NTU while pikeperch are unaffected (Ljunggren & Sandström 2007); a tinge may *raise* perch catchability (search activity ↑).

### 3.6 Rain now (grade B; small because rain mostly acts via light and colour)

Light 0.1–1.5 mm/h: +0.3 / +0.2 / +0.2 (perch / pike / zander). Moderate 1.5–4: +0.1 / +0.1 / +0.2. Heavy ≥ 4: −0.2 / −0.2 / +0.1. Thunderstorm (WMO 95+): −0.5 and a safety flag.

### 3.7 Wind (grade A for pike/wind, B for thresholds)

| 10 m wind | Points |
|---|---|
| < 4 mph and B > 0.5 (flat calm, bright) | −0.1 |
| 4–12 mph | +0.15 |
| 13–20 mph | −0.15 perch / +0.1 pike / 0 zander |
| 21–28 mph | −0.5 |
| > 28 mph | −0.8 |
| Gusts ≥ 30 mph | −0.3 extra |
| Direction | 0 |

### 3.8 Boat traffic disturbance (grade B)

Busy −0.3 / −0.2 / −0.15; moderate −0.15 / −0.1 / −0.05; light −0.05 / −0.05 / 0 (perch / pike / zander). Colour from boats is handled in the colour index, not here.

### 3.9 Pressure (grade A — null result; kept as tie-breaker)

Falling ≥ 3 hPa/24 h → +0.2. Rising ≥ 8 hPa/24 h **and** cloud < 30 % **and** 24 h temperature falling ≥ 1 °C → −0.3. Otherwise 0. Absolute level ignored.

### 3.10 Moon (grade A, small)

New or full moon ± 3 days → +0.15 (Kuparinen 2010; Vinson & Angradi 2014, 342 k muskellunge records, ~+5 %). Zander only: night with < 25 % illumination or ≥ 80 % cloud → +0.1 (Horký; UK "dark moon" anecdote). Solunar major/minor periods (Knight 1936 convention: transit/underfoot ± 60 min, rise/set ± 30 min) are **opt-in** at +0.15 / +0.05 — Quigley et al. 2023 found no relationship between any solunar service and catch rate.

### 3.11 Frost / ice

Tw < 3 °C and 24 h air minimum < −1 °C → −0.5; ice flag when Tw < 1.5 and air min < −3.

## 4. Aggregation

- `raw = Σ components`; `score = raw` up to 4.0, then `4 + (raw − 4)/3`, capped at 5, floored at 0.
- Fishable hours: sun altitude ≥ −8° for perch and pike; all hours for zander.
- Day score = mean of the best three fishable hours. Best window = highest-scoring 3 consecutive fishable hours. Rating bands: ≥ 4.2 Excellent, ≥ 3.4 Good, ≥ 2.6 Fair, ≥ 1.8 Poor, else Stay home.

Worked example (your 30 Aug day, perch, 16 °C for a week, 85 % cloud, showers, pressure falling 4 hPa/day, 8 mph): season 2.6 + light (dawn) 0.8×0.6 − 0.3·B + water +0.5 + colour ≈ 0 + rain +0.3 + wind +0.15 + pressure +0.2 ≈ 4.2 raw → day score ≈ 4.1 "Good/Excellent". Bright, calm midday in the same week scores ≈ 3.2.

## 5. Views

**Forecast** — now + 7 days ahead. **History** — the previous 14 days scored from recorded weather (Open-Meteo `past_days=14`, with EA gauge rainfall substituted where available). History exists to be checked against a catch log: the score is only worth what it predicts, and nothing here has been validated against Midlands canal catches yet.

## 6. Known limitations / calibration hooks

1. Colour index and water temperature are **proxies**; log what you observe and adjust `COLOUR_HALF_LIFE_HOURS`, `BOAT_COLOUR_INPUT`, `WATER_TAU_HOURS`.
2. Boat traffic is a calendar heuristic; a specific stretch (marina, popular hire base, remote summit pound) will differ. CRT stoppage notices would refine winter traffic but need a scheduled server-side snapshot.
3. Season curves are angler consensus scaled to leave headroom — the shape is well supported, the absolute numbers are yours to tune.
4. No catch-log feedback loop yet. The single most valuable upgrade is logging sessions (score shown vs fish caught) and re-fitting weights.

## 7. Key references

- Craig J.F. (1977) seasonal/diel activity of perch, Windermere. *J. Fish Biol.*
- Jacobsen L. et al. (2002) piscivorous perch telemetry, shallow lake. *Freshwater Biol.*
- Ljunggren L. & Sandström A. (2007) turbidity: perch vs pikeperch foraging. *J. Fish Biol.*
- Horký P. et al. (2008) pikeperch diel distribution, River Elbe. *Hydrobiologia*; Horký — moon phase and seasonality in pikeperch.
- Kuparinen A., Klefoth T., Arlinghaus R. (2010) pike catch rates vs environment; no pressure effect. *Fisheries Research*
- Escanaba Lake walleye/muskellunge angler catch 2003–2015. *PLOS ONE* (2021)
- Vinson M.R. & Angradi T.R. (2014) "Muskie Lunacy". *PLOS ONE*
- Quigley et al. (2023) solunar tables fail to predict trout fishing success. *SN Applied Sciences*
- Casselman J.M. (1978) pike activity vs temperature and light (via EA pike literature review)
- Frisk M. et al. (2012) thermal optimum of pikeperch. *Aquaculture*
- Edinger J.E. et al. (1968) response of water temperatures to meteorological conditions. *Water Resources Research*
- Pike Anglers' Club — warm-water piking guidance (≥ 18 °C).
- EA close-season byelaw background (canal exemption, 2000); CRT zander FAQs; Angling Trust zander position (2021).


## Canal colour: why run-off and boat wash decay at different rates

The colour index sums two accumulators rather than one.

Rain run-off carries suspended clay into the cut and it stays up for days, so it
keeps a 48-hour half-life. Boat wash is different in kind: a propeller lifts silt
off the bed, and it settles within a few hours of the last boat. It now decays
with a 6-hour half-life.

Both inputs originally shared the 48-hour accumulator. That made boat wash behave
like rainfall. Because canal traffic runs most days through the summer, the term
never drained, and it added a standing offset of roughly 13 index points to every
day between May and September. Three consequences followed:

- The index could not read "clear" in summer, however long the dry spell. Six
  rainless days in August 2026 still reported "coloured".
- The offset was near-constant day to day, so it carried no information while
  consuming most of the scale the index is measured on.
- It pushed ordinary days across the 25-point threshold into "chocolate", where
  perch take the model's largest single penalty.

Splitting the half-lives leaves rainfall as the signal the index exists to carry
and returns boat wash to what it physically is: a daytime disturbance that clears
overnight. It also gives the index a daily cycle, so a morning and an afternoon on
the same day no longer score identically on colour.


## Perch and water colour: why the response is a hump, not a slope

The perch colour term used to fall away monotonically, rewarding the clearest
water available and penalising anything coloured. That encodes one half of the
biology and none of the angling.

Two mechanisms act in opposite directions.

**Foraging efficiency favours clear water.** Perch hunt by sight. Reaction
distance shortens as turbidity rises, and feeding rate falls with it
(Radke & Gaupisch 2005; Ljunggren & Sandström 2007). On this mechanism alone,
gin-clear water is best.

**Catchability favours coloured water.** In clear water perch are warier, hold
deeper, and have time to inspect a lure and refuse it. Turbidity is also a
refuge from their own predators, so fish use the margins more freely. Measured
perch catchability runs roughly threefold higher in low-clarity years than in
clear ones.

An angler meets the product of the two, not either one alone. That product peaks
somewhere in between, which is why the response is now an inverted U:

| Index | Water | Perch |
| --- | --- | --- |
| 0–5 | clear | −0.2 |
| 5–12 | tinged | +0.3 |
| 12–25 | coloured | 0 |
| 25+ | chocolate | −0.5 |

Zander are left rewarding the coloured end throughout. They are adapted to low
light and gain on perch as visibility drops, which is the main reason the two
species need separate models at all.

The hump was prompted by two sessions at Knowle: an outstanding morning in
lightly coloured water after heavy rain, and a poor evening in the clearest
water the angler had seen there. Two sessions cannot fix a curve. The literature
above is what justifies the shape; the sessions only pointed at it.


## The seasonal base was removed

The score used to start from a per-species seasonal curve, interpolated daily,
running 1.4 to 3.1 across the year for perch and 0.7 to 2.9 for pike. That term
is gone. Every hour of every day now starts from a flat `WEIGHTS.base` of 2.5,
and only the condition terms move it.

What this changes, and what it does not:

- **Within any few weeks, almost nothing.** The seasonal curve was near constant
  over a fortnight, so removing it shifts the whole block by about 0.1 and leaves
  the spread as it was. Over the 22 days at Knowle used for calibration the range
  stayed at roughly 3.3 to 4.1 either way. Removing a constant re-levels a
  forecast; it does not sharpen one.
- **Across the year, a great deal.** The model no longer knows that October beats
  April for perch, or that November beats July for pike by more than two points.
  A mild January day and a mild October day now score the same. For pike the loss
  is largest, because its seasonal swing was the widest of the three species.
- **What still tracks the calendar.** The twilight factor still flattens the
  dawn and dusk peaks in midsummer, the pike welfare break is still flagged from
  16 June to 1 October, and boat traffic is still modelled by month. Those are
  separate from the removed base.

The narrow spread that prompted this is not caused by the base. It is caused by
the condition terms being individually small: light moves about 1.0, water
temperature 0.5, colour 0.5, and everything else 0.2 or less. Widening the
forecast means giving those terms more authority, or applying a gain to their
sum, not removing the constant they sat on.

Restore `SEASON` and `seasonBase` from git history if the seasonal signal is
wanted back.


## Water clarity was removed from the score

The canal colour term no longer contributes to the score, for any species. The
bright-midday "colour relief", which let coloured water soften the glare penalty
inside the light term, is gone with it, so clarity now reaches the score by no
path at all. The per-species colour bands are deleted.

The clarity index itself is still computed, and still does two jobs: it fills the
"Canal colour" fact on each day, and it drives the lure guidance, where the
inverted-U reasoning now lives. That is the honest home for it. Clarity clearly
changes what you should tie on. Whether it changes how well the fish feed is a
claim this model could not support with the estimate it had.

## The condition terms carry the whole scale

The score is now `base + gain x (sum of condition terms)`, clamped to 0-5, with
no soft cap.

Each term is small on its own: light moves about 1.0, water temperature 0.5, and
everything else 0.3 or less. Added raw to a flat base they spanned roughly 3.3 to
4.1 across three weeks, so no day read bad and none read excellent. A gain of
1.05 gives them authority over the full range.

The gain is set from the terms' own limits rather than from a sample. Stacking
every plausible positive for perch (dawn +0.8, water temperature +0.5, a mild
spell +0.3, light rain +0.3, a good ripple +0.15, falling pressure +0.2, a
new or full moon +0.15) sums to about 2.4, which lands on 5.0. Stacking the
negatives (darkness, cold water, a gale, frost, busy boats, pressure rising
behind a cold front) reaches about -3.6, which clamps to 0.

A 5.0 therefore needs almost everything to line up at once. A strong, realistic
October dawn with rain, ripple and falling pressure reaches 4.5.

One thing the gain does not fix. The headline number on each day tile is the mean
of that day's three best hours, so it tracks the day's peak and stays high in
settled weather. The hourly chart is where the new range shows.

## The service worker was serving stale builds

The app shell was cached first with a fixed version string, so once a phone had
installed the app, no deployed change ever reached it. The engine could be
rewritten and the towpath would still show the old numbers and the old breakdown.

The shell is now stale-while-revalidate. The cached copy still answers instantly,
a fresh copy is fetched in the background, and when the two differ the page shows
a "newer version is ready" bar that reloads on tap. Offline behaviour is
unchanged.


## The score is a points budget

There is no base and no gain. Every factor scores from 0 to its own maximum, and
the maxima add up to 5, so the score is simply their sum.

| Factor | Max | Full marks when |
| --- | --- | --- |
| Light & time of day | 1.5 | the species' best light window |
| Water temperature | 1.2 | inside the species' best band |
| Run-up (3-5 days) | 0.8 | improving, and released from a hard spell |
| Wind & surface | 0.5 | a 4-12 mph ripple |
| Rain | 0.3 | light rain falling |
| Pressure trend | 0.3 | falling at least 3 hPa in 24 hours |
| Boat disturbance | 0.3 | the cut is quiet |
| Moon | 0.1 | within 3 days of new or full |
| **Total** | **5.0** | |

The arrangement it replaced was a flat base of 2.5 plus signed deviations. Half
the score sat in a constant that told the angler nothing, printed on screen as
"Base, flat starting point, +2.5", while the real factors fought over what was
left. Now each line of the breakdown reads as a mark out of a mark, and the
number at the bottom is the sum of the column above it.

Some consequences worth stating.

- **Frost is gone as a separate line.** Freezing air is already inside the water
  temperature proxy, so scoring it twice was double-counting one mechanism. The
  ice flag remains.
- **Thunder scores zero on rain** rather than applying a penalty, and stays a
  safety flag.
- **Solunar shares the moon budget** instead of adding to it, so switching it on
  cannot push a total past 5.
- **The floor is not zero in practice.** A freezing gale at night still scores
  about 1.3, because a quiet cut and steady pressure genuinely are not the
  problem that day. The verdict still reads "Stay home".
- **The ceiling is reachable but strict.** Three days of gale that lift while the
  water climbs into the perfect band, at dawn, with light rain, a ripple, falling
  pressure and a new moon, reaches 4.9.

## Run-up: the collective effect of the days before

The run-up is not one variable's trend. A heatwave, a week of storms, a blocking
high, a drought and a cold snap are all multi-day regimes, and each suppresses
feeding by a different route: too-warm water, an unfishable surface, flat bright
stagnation, no run-off, too-cold water. An earlier version read only the water
temperature, which caught the last of those and missed the rest.

So the run-up reads the score itself. Every other factor is computed first, and
their sum becomes an hourly quality between 0 and 1. Averaged over whole days the
day-and-night cycle washes out, and what is left is the regime.

Measured daily quality, from running the model over real weather and over
synthetic regimes:

| Regime | Daily quality |
| --- | --- |
| Ideal mild spell | 0.78 |
| Settled September at Knowle | 0.72 |
| Gale with glare | 0.57 |
| Heatwave | 0.50 |
| Freezing and still | 0.41 |

Par is set at 0.70, an ordinary decent day, and a quarter below that counts as a
fully hard spell. Three things are then scored.

**Trajectory, up to 0.45.** How the last day compares with the three before it.
Rising is promising, falling is not, flat sits mid-band.

**Release, up to 0.25.** How far below par the regime ran, paid out only in
proportion to how much conditions have actually improved. A hard spell that has
not lifted earns nothing here.

**Sustained, up to 0.10.** A small credit when the whole five days have run well,
so a genuinely good settled spell is not treated as though nothing were going on.

What that produces across regimes, taking the best hour of each:

| Lead-in | Run-up out of 0.80 |
| --- | --- |
| Heatwave breaking | 0.60 |
| Gale and glare breaking | 0.56 |
| Week of storms ending | 0.54 |
| Blocking high breaking | 0.47 |
| Settled and good throughout | 0.34 |
| Good spell souring | 0.04 |

A swing of more than half a point out of five, which is enough to move a day
between ratings.

### Why this is still not "bad weather then good weather"

The request behind the factor was that a bad spell followed by a favourable one
should count for more. That is right for a specific mechanism and wrong as a
blanket rule, so the implementation is narrower than the phrase.

It is right when the earlier spell physically prevented feeding. Fish that could
not feed normally carry a deficit and feed hard when the brake comes off. That is
the release half.

It is wrong as a blanket rule because the best-known pattern in angling runs the
other way. Fish feed on the falling limb ahead of a front, while the weather is
deteriorating, and go quiet in the bright, cold, rising-pressure air behind it.
By the plain reading, that post-frontal morning is "bad then good" and would
score well. It should not. That effect stays in the pressure factor, where
falling takes full marks and a rising, clearing, colder morning takes none, and
the run-up does not touch it. A test pins exactly this case.
