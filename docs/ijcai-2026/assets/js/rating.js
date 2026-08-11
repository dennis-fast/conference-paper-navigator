// rating.js
export const DEFAULT_MU = 1500;
export const DEFAULT_SIGMA = 350;   // starts uncertain
export const MIN_SIGMA = 60;        // don't collapse to zero
export const SIGMA_DECAY = 0.93;    // per match

function logistic(x) {
  return 1 / (1 + Math.pow(10, -x / 400));
}

/**
 * Uncertainty-aware Elo update.
 * outcome: 1 = A wins, 0 = B wins, 0.5 = tie
 */
export function updatePair(A, B, outcome, opts={}) {
  const baseK = opts.baseK ?? 32;

  // Higher uncertainty => larger effective K
  const KA = baseK * clamp(A.sigma / DEFAULT_SIGMA, 0.6, 1.8);
  const KB = baseK * clamp(B.sigma / DEFAULT_SIGMA, 0.6, 1.8);

  const pA = logistic(A.mu - B.mu);
  const pB = 1 - pA;

  const dA = KA * (outcome - pA);
  const dB = KB * ((1 - outcome) - pB);

  A.mu += dA;
  B.mu += dB;

  // sigma decays with exposure to evidence; ties decay less aggressively
  const tieFactor = (outcome === 0.5) ? 0.98 : 1.0;
  A.sigma = Math.max(MIN_SIGMA, A.sigma * SIGMA_DECAY * tieFactor);
  B.sigma = Math.max(MIN_SIGMA, B.sigma * SIGMA_DECAY * tieFactor);

  A.n += 1;
  B.n += 1;
}

function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }
