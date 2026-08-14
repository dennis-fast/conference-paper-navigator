const DEFAULT_MU = 1500;
const DEFAULT_SIGMA = 350;
const MIN_MODEL_SIGMA = 105;

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-Math.min(value, 30)));
  const exp = Math.exp(Math.max(value, -30));
  return exp / (1 + exp);
}

function dot(a, b) {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += a[index] * b[index];
  return total;
}

function subtract(a, b) {
  return a.map((value, index) => value - b[index]);
}

function selectedFavorites(state) {
  return Object.entries(state.favorites || {})
    .filter(([, favorite]) => favorite?.selected)
    .map(([paperId]) => paperId)
    .sort();
}

function seededReferences(favoriteId, ids, favoriteSet, count = 4) {
  const available = ids.filter((paperId) => !favoriteSet.has(paperId));
  if (!available.length) return [];
  let hash = 2166136261;
  for (const char of favoriteId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const step = Math.max(1, Math.floor(available.length / count));
  const start = (hash >>> 0) % available.length;
  const chosen = [];
  for (let offset = 0; offset < available.length && chosen.length < count; offset += step) {
    const paperId = available[(start + offset) % available.length];
    if (!chosen.includes(paperId)) chosen.push(paperId);
  }
  return chosen;
}

function trainingExamples(bundle, state, featureById) {
  const pairwise = [];
  const pointwise = [];
  const favorites = selectedFavorites(state);
  const favoriteSet = new Set(favorites);
  const topicSeeds = [...new Set((state.seedPaperIds || []).map(String))].filter((paperId) => !favoriteSet.has(paperId));

  for (const paperId of favorites) {
    const positive = featureById.get(paperId);
    if (!positive) continue;
    pointwise.push({ x: positive, y: 1, weight: 0.35 });
    for (const referenceId of seededReferences(paperId, bundle.ids, favoriteSet)) {
      const reference = featureById.get(referenceId);
      if (reference) pairwise.push({ x: subtract(positive, reference), y: 1, weight: 0.5 });
    }
  }

  for (const paperId of topicSeeds) {
    const positive = featureById.get(paperId);
    if (positive) pointwise.push({ x: positive, y: 1, weight: 0.12 });
  }

  for (const entry of state.history || []) {
    if (entry.outcome == null || entry.choice === "SKIP") continue;
    const a = featureById.get(String(entry.a));
    const b = featureById.get(String(entry.b));
    if (!a || !b) continue;
    const weight = Math.max(0.25, Number(entry.kMult) || 1);
    if (entry.choice === "BOTH" || entry.choice === "NEITHER") {
      const target = entry.choice === "BOTH" ? 1 : 0;
      pointwise.push({ x: a, y: target, weight: weight * 0.7 });
      pointwise.push({ x: b, y: target, weight: weight * 0.7 });
    } else {
      pairwise.push({ x: subtract(a, b), y: Number(entry.outcome), weight });
    }
  }
  return { pairwise, pointwise, favorites, topicSeeds };
}

function update(weights, bias, example, learningRate, includeBias) {
  const prediction = sigmoid(dot(weights, example.x) + (includeBias ? bias : 0));
  const gradient = (example.y - prediction) * example.weight;
  const decay = 1 - learningRate * 0.015;
  for (let index = 0; index < weights.length; index += 1) {
    weights[index] = weights[index] * decay + learningRate * gradient * example.x[index];
  }
  return includeBias ? bias + learningRate * gradient * 0.2 : bias;
}

export function trainPreferenceModel(bundle, state) {
  if (!bundle?.ids?.length || !bundle?.features?.length) return null;
  const featureById = new Map(bundle.ids.map((paperId, index) => [String(paperId), bundle.features[index].map(Number)]));
  const examples = trainingExamples(bundle, state, featureById);
  const signalCount = examples.pairwise.length + examples.pointwise.length;
  const directlySeen = new Set([
    ...examples.favorites,
    ...examples.topicSeeds,
    ...(state.history || []).flatMap((entry) => entry.outcome == null ? [] : [String(entry.a), String(entry.b)]),
  ]);
  if (!signalCount) {
    return {
      hasSignal: false, signalCount: 0, featureById, predictions: new Map(),
      clusterById: new Map(bundle.ids.map((paperId, index) => [String(paperId), Number(bundle.clusters[index])])),
      clusterCount: Number(bundle.cluster_count || 0), directlySeen,
      representatives: new Set((bundle.representatives || []).map(String)),
    };
  }

  const dimensions = Number(bundle.dimensions || bundle.features[0].length);
  const weights = Array(dimensions).fill(0);
  let bias = 0;
  for (let epoch = 0; epoch < 16; epoch += 1) {
    const learningRate = 0.18 / Math.sqrt(1 + epoch * 0.35);
    for (const example of examples.pairwise) bias = update(weights, bias, example, learningRate, false);
    for (const example of examples.pointwise) bias = update(weights, bias, example, learningRate, true);
  }

  const raw = bundle.ids.map((paperId) => dot(weights, featureById.get(String(paperId))) + bias);
  const mean = raw.reduce((total, value) => total + value, 0) / raw.length;
  const variance = raw.reduce((total, value) => total + (value - mean) ** 2, 0) / raw.length;
  const scale = Math.max(Math.sqrt(variance), 0.15);
  const evidenceFeatures = [...directlySeen].map((paperId) => featureById.get(paperId)).filter(Boolean);
  const maturity = Math.min(1, Math.sqrt(signalCount / 45));
  const predictions = new Map();
  bundle.ids.forEach((paperId, index) => {
    const id = String(paperId);
    const feature = featureById.get(id);
    const z = Math.max(-3, Math.min(3, (raw[index] - mean) / scale));
    let proximity = 0;
    for (const evidence of evidenceFeatures) proximity = Math.max(proximity, dot(feature, evidence));
    proximity = Math.max(0, Math.min(1, (proximity + 1) / 2));
    const direct = directlySeen.has(id);
    const confidence = Math.min(1, maturity * (0.3 + 0.7 * proximity) + (direct ? 0.18 : 0));
    predictions.set(id, {
      mu: DEFAULT_MU + 70 * z,
      sigma: Math.max(MIN_MODEL_SIGMA, DEFAULT_SIGMA - 235 * confidence),
      confidence,
      raw: raw[index],
    });
  });

  return {
    hasSignal: true,
    signalCount,
    featureById,
    predictions,
    weights,
    bias,
    directlySeen,
    clusterById: new Map(bundle.ids.map((paperId, index) => [String(paperId), Number(bundle.clusters[index])])),
    clusterCount: Number(bundle.cluster_count || 0),
    representatives: new Set((bundle.representatives || []).map(String)),
  };
}

export function blendPreferencePrediction(rating, prediction) {
  if (!prediction) return { ...rating, predicted: false, modelConfidence: 0 };
  const directWeight = Math.min(0.7, Number(rating.n || 0) / (Number(rating.n || 0) + 3));
  const personalDelta = prediction.mu - DEFAULT_MU;
  return {
    ...rating,
    mu: Number(rating.mu) + personalDelta * (1 - directWeight),
    sigma: Math.min(Number(rating.sigma), prediction.sigma),
    predicted: true,
    modelConfidence: prediction.confidence,
  };
}

export function preferenceProgress(bundle, state, model) {
  const favoriteIds = selectedFavorites(state);
  const covered = new Set();
  for (const paperId of model?.directlySeen || []) {
    const cluster = model?.clusterById?.get(paperId);
    if (cluster != null) covered.add(cluster);
  }
  const comparisons = (state.history || []).filter((entry) => entry.outcome != null).length;
  const clusterCount = Number(bundle?.cluster_count || 0);
  const coverage = clusterCount ? covered.size / clusterCount : 0;
  let stage = "Discover";
  if (comparisons >= 15 && coverage >= 0.3) stage = "Learn";
  if (comparisons >= 35 && coverage >= 0.5) stage = "Decide";
  if (comparisons >= 80 && coverage >= 0.7) stage = "Refine";
  return { stage, comparisons, favorites: favoriteIds.length, coveredClusters: covered.size, clusterCount, coverage };
}
