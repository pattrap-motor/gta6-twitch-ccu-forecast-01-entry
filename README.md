[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/pattrap-motor/gta6-twitch-ccu-forecast-01-entry/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/pattrap-motor/gta6-twitch-ccu-forecast-01-entry/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

# GTA VI launch-day Twitch CCU forecast

Entry for [Forecast GTA VI's launch-day Twitch viewers hour by hour](https://make.fun/bounty/gta6-twitch-ccu-forecast-01) — a program that reads one `makefun/twitch-ccu-case/v1` case and forecasts hours 2–24 of release day as five log-scale pinball quantiles (0.05 / 0.25 / 0.5 / 0.75 / 0.95) per hour.

## Model

The launch-day curve of a rolling-midnight console launch, learned from the case file's own comparables:

- Each comparable launch contributes its 24 hourly prints from release-day midnight, as log-ratios to its hour-1 print.
- Per forecast hour, a least-squares line `log-ratio ~ a + b · ln(hour-1 print)` is fitted over the pool and evaluated at this case's hour-1 print. The slope is clamped to ≤ 0 (bigger launches grow flatter through the day) and the case's log hour-1 print is winsorised to the pool's observed range, so a launch bigger than every comparable still gets the shape of the biggest observed launches instead of a linear extrapolation. The median is clamped to the pool's observed envelope for that hour.
- Spread comes from the empirical quantiles of that hour's regression residuals, scaled by 0.85.
- One case-specific signal: viewers in the hour before release day (the pre-midnight unlock wave) relative to the hour-1 print, shifted by 0.75 × its deviation from the pool median, clamped to ±0.40 log units.
- Pool keeps only rolling-midnight console launches (simultaneous-global unlocks, early-access-contaminated and weak analogues are dropped; the GTA VI category's own pre-release history is not a launch curve and drops out too). Fewer than 5 surviving comparables falls back to flat persistence.

## Practice results

Scored on the four practice cases against the historical SullyGnome prints (log-scale pinball loss, official ×2 factor per RULES):

| model | mean loss | p00 | p01 | p02 | p03 |
|---|---|---|---|---|---|
| house baseline (starter) | 0.387 | 0.744 | 0.287 | 0.215 | 0.303 |
| this entry | **0.140** | 0.132 | 0.098 | 0.134 | 0.196 |

Typical miss ≈ 23% (median), 90% coverage ≈ 0.90. All four practice cases improve on the starter; the model was selected for the best mean loss stable across all four cases, not a single-case spike.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network, deterministic.
