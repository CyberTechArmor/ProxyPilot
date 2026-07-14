// Mock2 estimator PURE decision layer (cost-truth Part 3). Native-free, unit-tested.
//
// Today's estimator estimates TOKENS and runs ~2× high. This estimates COST (cents),
// per stage type, calibrated from recent (base-estimate, actual) pairs so it tracks
// reality instead of a fixed envelope, biased ~20% high as a safety margin, with the
// multiplier clamped to a sane band. It is PER-LANE: it prices the stage's own model,
// so an audit stage on Fable 5 (2×/token vs Opus) estimates accordingly.
//
// Terminology (risk R7): nothing here is named "agent".

import { usageCostCents, priceForModel, isComparable } from './usage-logic.js';

// The stage types we calibrate independently — they have very different cost shapes.
export const STAGE_TYPES = Object.freeze(['define', 'build', 'resume_verify']);

// Bias the estimate ~20% high (a reservation should sit a little above the expected
// actual, never under it), and clamp the calibrated multiplier so one weird cycle
// can't send estimates to 0 or the moon.
export const ESTIMATE_BIAS = 1.2;
export const MULTIPLIER_MIN = 0.4;
export const MULTIPLIER_MAX = 3.0;

// Only calibrate from the most recent N comparable pairs (rolling window).
export const CALIBRATION_WINDOW = 10;

function median(nums) {
  const a = nums.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// calibrateMultiplier — from recent { baseCents, actualCents } pairs, the factor to
// multiply a fresh base estimate by. Centers on the median actual/base ratio (so a
// systematically-2×-high base is pulled back toward truth), then applies the high bias
// and clamps. With no usable history, returns the bias alone (trust the base, pad 20%).
// `pairs` may carry a `comparable` flag; non-comparable (pre-v3 basis) pairs are dropped
// so a legacy token basis never trains the estimator.
export function calibrateMultiplier(pairs = [], { bias = ESTIMATE_BIAS, min = MULTIPLIER_MIN, max = MULTIPLIER_MAX, window = CALIBRATION_WINDOW } = {}) {
  const usable = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p && (p.comparable === undefined || p.comparable === true || isComparable(p)))
    .filter((p) => Number(p.baseCents) > 0 && Number(p.actualCents) >= 0)
    .slice(-window);
  const ratios = usable.map((p) => Number(p.actualCents) / Number(p.baseCents)).filter((r) => Number.isFinite(r) && r > 0);
  const center = median(ratios);
  const raw = (center == null ? 1 : center) * bias;
  return Math.min(max, Math.max(min, raw));
}

// Split a token envelope into input/output the way a stage tends to run, so the base
// estimate can be priced at the lane's real rate. Build/resume are input-heavy
// (big cached context, small output); define (audit) is a bit more balanced.
function splitForStage(tokens, stage) {
  const inputShare = stage === 'define' ? 0.7 : 0.85;
  const t = Number(tokens) || 0;
  return { input: t * inputShare, output: t * (1 - inputShare) };
}

// estimateStageCostCents — the calibrated cost reservation for a stage, in cents.
// baseTokens is the rough token envelope (the old estimate's token count); model is the
// LANE'S assigned model id (priced from the built-in list); pairs is the stage's recent
// history. Returns { estCents, baseCents, multiplier, model } so callers can show
// est-vs-actual and the basis.
export function estimateStageCostCents({ baseTokens = 0, model = '', stage = 'build', pairs = [] } = {}) {
  const price = priceForModel(model);
  const split = splitForStage(baseTokens, stage);
  const baseCents = usageCostCents(split, price);
  const multiplier = calibrateMultiplier(pairs);
  return {
    estCents: Math.max(0, baseCents * multiplier),
    baseCents,
    multiplier,
    model: String(model || ''),
  };
}

// estAccuracy — the ratio (and signed % delta) of an estimate to the actual, for the
// "est-vs-actual" read shown on every completed request. A healthy calibrated estimate
// lands a bit above actual (ratio ~1.1–1.35).
export function estAccuracy(estCents, actualCents) {
  const est = Number(estCents) || 0;
  const act = Number(actualCents) || 0;
  if (act <= 0) return { ratio: null, pct: null, within: null };
  const ratio = est / act;
  return { ratio, pct: Math.round((ratio - 1) * 100), within: ratio >= 1.0 && ratio <= 1.5 };
}

// A rolling accuracy read for a project: how the last N estimates compared to actuals.
// Mean absolute % error over comparable, completed pairs. Pure over plain rows.
export function projectEstimateAccuracy(pairs = [], { window = CALIBRATION_WINDOW } = {}) {
  const usable = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p && Number(p.actualCents) > 0 && Number(p.estCents) >= 0)
    .slice(-window);
  if (!usable.length) return { n: 0, mape: null, meanRatio: null };
  const ratios = usable.map((p) => Number(p.estCents) / Number(p.actualCents));
  const mape = Math.round((usable.reduce((s, p) => s + Math.abs(Number(p.estCents) - Number(p.actualCents)) / Number(p.actualCents), 0) / usable.length) * 100);
  const meanRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  return { n: usable.length, mape, meanRatio };
}
