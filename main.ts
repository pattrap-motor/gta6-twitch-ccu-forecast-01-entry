// gta6-twitch-ccu-forecast-01 — launch-day Twitch CCU forecaster (Node 22, stdlib only).
//
// Model: the launch-day curve of a rolling-midnight console launch, learned
// from the case file's own comparables. For each comparable launch we take
// its 24 hourly prints starting at its release-day midnight and work in
// log-ratios to its hour-1 print, r[h] = ln(viewers[h] / viewers[1]).
// For every forecast hour we fit one least-squares line
//     r[h] ~ a[h] + b[h] * ln(hour-1 print)
// over the comparable pool, and predict at this case's hour-1 print. The
// slope is clamped to <= 0 (bigger launches grow flatter through the day,
// never steeper) and the case's log hour-1 print is winsorised to the pool's
// observed range, so a launch bigger than every comparable still gets the
// shape of the biggest observed launches instead of a linear extrapolation.
// The predicted median log-ratio is clamped to the central 90% of the
// pool's observed log-ratios for that hour (5th-95th percentile), so one
// outlier launch cannot stretch the forecast to an extreme shape.
// regression residuals at that hour, scaled by 0.85.
//
// One case-specific signal: the viewers in the hour before the release day
// (the pre-midnight unlock wave) relative to the hour-1 print. A strong
// pre-midnight wave predicts a stronger day, so the median log-ratio is
// shifted by 0.75 * (ln(v23 / p1) - median ln(v23 / c1) over the pool),
// clamped to +-0.40 log units.
//
// Pool: only launches shaped like a rolling-midnight console launch are
// kept. A comparable is dropped when its hour-1 print is under 5% of its
// day peak (a simultaneous global unlock: the day starts near-quiet and
// explodes) or its peak falls before hour 6 (a midnight-UTC simultaneous
// unlock), when its notes mark it early-access-contaminated or weak, or
// when its day curve is missing/short. The GTA VI category's own
// pre-release history is not a launch curve (its day_start is the trailer
// premiere, not a release) and drops out by the same missing-curve rule.
//
// If fewer than 5 comparables survive, the forecast falls back to the
// house baseline's persistence shape (flat median, 0.15*sqrt(h-1) spread).
//
// Input: every <id>.in in MAKEFUN_INPUT_DIR (default /input); output:
// <id>.out in MAKEFUN_OUTPUT_DIR (default /output), one JSON object
// {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]} with 23 rows.
// Runs offline, no network, no clock, no randomness: the same case file
// always produces the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const BETA = 0.75; // weight of the pre-midnight-wave signal
const RAMP_CLAMP = 0.4; // max |shift| the pre-midnight signal may apply, log units
const SPREAD_SCALE = 0.85; // shrink on the residual-quantile spread
const MIN_POOL = 5; // below this, fall back to persistence
const FALLBACK_SIGMA = 0.15;

type HourlyPoint = { from: string; viewers: number | null; channels?: number | null; reads?: number };
type Comparable = { day_start: string; hourly: HourlyPoint[]; unlock?: string };
type CaseFile = {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  day_start: string;
  history_hourly?: HourlyPoint[];
  comparables?: Comparable[];
};

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
/** Linear-interpolation quantile, matching the reference implementation. */
const quantile = (sorted: number[], q: number): number => {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
};
const hourBefore = (iso: string): string => {
  const d = new Date(Date.parse(iso) - 3600_000);
  return d.toISOString().replace(".000Z", "Z");
};

/** The 24 hourly prints from a comparable's release-day midnight, or null. */
function dayCurve(comp: Comparable): number[] | null {
  const idx = comp.hourly.findIndex((p) => p.from === comp.day_start);
  if (idx < 0 || idx + 24 > comp.hourly.length) return null;
  const day = comp.hourly.slice(idx, idx + 24).map((p) => p.viewers);
  if (day.some((v) => v === null || v === undefined || v <= 0)) return null;
  return day as number[];
}

function isRollingLaunch(comp: Comparable, day: number[]): boolean {
  const peak = Math.max(...day);
  if (day[0] < 0.05 * peak) return false; // simultaneous global unlock
  if (day.indexOf(peak) + 1 < 6) return false; // peak at hour 1-2: UTC-midnight unlock
  const notes = comp.unlock ?? "";
  if (notes.includes("early-access-contaminated")) return false;
  if (notes.includes("Tier: weak")) return false;
  return true;
}

function hourBeforeRelease(comp: Comparable): number | null {
  const idx = comp.hourly.findIndex((p) => p.from === comp.day_start);
  if (idx <= 0) return null;
  const v = comp.hourly[idx - 1].viewers;
  return v === null || v === undefined || v <= 0 ? null : v;
}

/** Least-squares line y ~ a + b*x; returns [a, b]. */
function fitLine(xs: number[], ys: number[]): [number, number] {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return [my - b * mx, b];
}

function forecastCase(c: CaseFile): Array<{ hour: number; q: number[] }> {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error("case has no hour-1 print");
  const p1 = Math.max(1, first.viewers);
  const hours = c.forecast.map((f) => f.hour);

  // Build the comparable pool: (log hour-1 print, day curve, pre-midnight viewers).
  const pool: Array<{ logC1: number; day: number[]; v23: number | null }> = [];
  for (const comp of c.comparables ?? []) {
    const day = dayCurve(comp);
    if (day === null || !isRollingLaunch(comp, day)) continue;
    pool.push({ logC1: Math.log(day[0]), day, v23: hourBeforeRelease(comp) });
  }

  if (pool.length < MIN_POOL) {
    // Fallback: persistence, the house baseline's shape.
    return hours.map((h) => ({
      hour: h,
      q: Z.map((z) => round2(p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1)))),
    }));
  }

  const xs = pool.map((p) => p.logC1);
  const logP1 = clamp(Math.log(p1), Math.min(...xs), Math.max(...xs));

  // Pre-midnight-wave signal from this case's own hourly history.
  let rampAdj = 0;
  const want = hourBefore(c.day_start);
  const v23 = c.history_hourly?.find((p) => p.from === want)?.viewers ?? null;
  if (v23 !== null && v23 !== undefined && v23 > 0) {
    const poolR = pool
      .filter((p) => p.v23 !== null)
      .map((p) => Math.log((p.v23 as number) / p.day[0]));
    if (poolR.length > 0) {
      rampAdj = clamp(BETA * (Math.log(v23 / p1) - median(poolR)), -RAMP_CLAMP, RAMP_CLAMP);
    }
  }

  return hours.map((h) => {
    const idx = h - 1; // day[0] is hour 1, so hour h sits at index h-1
    const ys = pool.map((p) => Math.log(p.day[idx] / p.day[0]));
    let [a, b] = fitLine(xs, ys);
    b = Math.min(b, 0); // bigger launches grow flatter, never steeper
    let med = a + b * logP1 + rampAdj;
    const sortedYs = [...ys].sort((x, y) => x - y);
    med = clamp(med, quantile(sortedYs, 0.05), quantile(sortedYs, 0.95)); // stay inside the central 90% of observed shapes
    const resid = pool
      .map((p, i) => ys[i] - (a + b * xs[i]))
      .sort((x, y) => x - y);
    const q = LEVELS.map((tau) => med + SPREAD_SCALE * quantile(resid, tau));
    const ratios = q.map((x) => Math.max(0.001, Math.exp(x)));
    for (let j = 1; j < ratios.length; j++) ratios[j] = Math.max(ratios[j], ratios[j - 1]);
    return { hour: h, q: ratios.map((r) => round2(round4(r) * p1)) };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith(".in")).sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
