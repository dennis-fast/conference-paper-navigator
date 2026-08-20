import { toCSV } from "./csv.js?v=20260814-stable-updates-v3";
import { DEFAULT_MU, DEFAULT_SIGMA, MIN_SIGMA, SIGMA_DECAY, updatePair } from "./rating.js?v=20260814-stable-updates-v3";
import { chooseNextPair } from "./selector.js?v=20260814-stable-updates-v3";
import { blendPreferencePrediction, preferenceProgress, trainPreferenceModel } from "./preference-model.js?v=20260814-stable-updates-v3";
import { initializeCloudSync } from "./cloud-sync.js?v=20260814-sync-retry-v1";
import { mergeComparisonData, mergeTimestampedRecords } from "./merge-comparisons.js?v=20260814-stable-updates-v3";

const BASE_K = 32;
const JOINT_FEEDBACK_SCALE = 0.45;
const STATE_EXPORT_TYPE = "conference-paper-navigator-state";
const STATE_EXPORT_VERSION = 1;
const DEFAULT_RATING = Object.freeze({ mu: DEFAULT_MU, sigma: DEFAULT_SIGMA, n: 0, wins: 0, losses: 0, ties: 0 });

let config = null;
let dataset = null;
let papers = [];
let filtered = [];
let currentPair = null;
let state = null;
let activeUserId = null;
let cloudSync = null;
let preferenceBundle = null;
let preferenceModel = null;
let lastVisualizationFingerprint = "";
const disclosureState = new Map();

const el = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function disclosureKey(...parts) {
  return parts.map((part) => String(part ?? "")).join("|||");
}

function disclosureAttribute(...parts) {
  return `data-disclosure-key="${esc(disclosureKey(...parts))}"`;
}

function captureDisclosureState() {
  document.querySelectorAll("details[data-disclosure-key]").forEach((details) => {
    disclosureState.set(details.dataset.disclosureKey, details.open);
  });
}

function restoreDisclosureState() {
  document.querySelectorAll("details[data-disclosure-key]").forEach((details) => {
    if (disclosureState.has(details.dataset.disclosureKey)) details.open = disclosureState.get(details.dataset.disclosureKey);
  });
}

function guestStateKey() {
  return `conference-paper-navigator:${config.id}:ratings:v1`;
}

function guestOwnerKey() {
  return `conference-paper-navigator:${config.id}:guest-owner:v1`;
}

function stateKey() {
  return activeUserId
    ? `conference-paper-navigator:${config.id}:user:${activeUserId}:ratings:v1`
    : guestStateKey();
}

function defaultState() {
  return {
    schema_version: 1,
    conference_id: config.id,
    priors: {},
    ratings: {},
    favorites: {},
    topicInterests: {},
    paperPlans: {},
    history: [],
    history_tombstones: [],
    reset_at: "",
    modified_at: "",
    lastPair: [],
    mode: "smart",
    topN: 60,
    posterTarget: 10,
    smartTarget: null,
    resolveTieNMatches: "minimal",
    muPriority: "highest",
    winsOnly: false,
    scheduleByPresentationOrder: false,
    continueAfterReady: false,
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableHistoryId(entry, index) {
  if (entry.id) return String(entry.id);
  const text = [entry.a, entry.b, entry.outcome, entry.choice, entry.kMult, entry.ts, index].join("|");
  let hash = 2166136261;
  for (let offset = 0; offset < text.length; offset += 1) {
    hash ^= text.charCodeAt(offset);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy-${(hash >>> 0).toString(16)}`;
}

function normalizeTimestampedSelections(value, label) {
  if (value != null && !isRecord(value)) throw new Error(`The ${label} list is invalid.`);
  const records = {};
  for (const [key, raw] of Object.entries(value || {})) {
    if (typeof raw === "boolean") {
      records[String(key)] = { selected: raw, modified_at: "" };
      continue;
    }
    if (!isRecord(raw)) throw new Error(`The ${label} entry for ${key} is invalid.`);
    records[String(key)] = { selected: Boolean(raw.selected), modified_at: typeof raw.modified_at === "string" ? raw.modified_at : "" };
  }
  return records;
}

function normalizePaperPlans(value) {
  if (value != null && !isRecord(value)) throw new Error("The personal paper plans are invalid.");
  const plans = {};
  const statuses = new Set(["", "planned", "attended", "skipped"]);
  for (const [paperId, raw] of Object.entries(value || {})) {
    if (!isRecord(raw)) continue;
    plans[String(paperId)] = {
      status: statuses.has(raw.status) ? raw.status : "",
      tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.map(String).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20) : [],
      notes: typeof raw.notes === "string" ? raw.notes.slice(0, 10000) : "",
      modified_at: typeof raw.modified_at === "string" ? raw.modified_at : "",
    };
  }
  return plans;
}

function normalizeState(value) {
  if (!isRecord(value)) throw new Error("The ranking state must be a JSON object.");
  if (value.schema_version != null && Number(value.schema_version) !== 1) {
    throw new Error(`Unsupported ranking schema version: ${value.schema_version}.`);
  }
  if (value.conference_id && value.conference_id !== config.id) {
    throw new Error(`This backup belongs to ${value.conference_id}, not ${config.id}.`);
  }
  if (!isRecord(value.ratings)) throw new Error("The backup has no valid ratings object.");

  const ratingDefaults = { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA, n: 0, wins: 0, losses: 0, ties: 0 };
  if (value.priors != null && !isRecord(value.priors)) throw new Error("The ranking priors are invalid.");
  const priors = {};
  for (const [paperId, rawPrior] of Object.entries(value.priors || {})) {
    if (!isRecord(rawPrior)) throw new Error(`The prior for paper ${paperId} is invalid.`);
    const mu = Number(rawPrior.mu);
    const sigma = Number(rawPrior.sigma);
    if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0) {
      throw new Error(`The prior for paper ${paperId} has invalid scoring values.`);
    }
    priors[String(paperId)] = { mu, sigma };
  }
  const ratings = {};
  for (const [paperId, rawRating] of Object.entries(value.ratings)) {
    if (!isRecord(rawRating)) throw new Error(`The rating for paper ${paperId} is invalid.`);
    const rating = {};
    for (const [field, fallback] of Object.entries(ratingDefaults)) {
      const number = rawRating[field] == null ? fallback : Number(rawRating[field]);
      if (!Number.isFinite(number)) throw new Error(`The ${field} value for paper ${paperId} is invalid.`);
      if (field === "sigma" && number <= 0) throw new Error(`The sigma value for paper ${paperId} must be positive.`);
      if (["n", "wins", "losses", "ties"].includes(field) && (!Number.isInteger(number) || number < 0)) {
        throw new Error(`The ${field} value for paper ${paperId} must be a non-negative integer.`);
      }
      rating[field] = number;
    }
    if (rating.n === 0 && rating.wins === 0 && rating.losses === 0 && rating.ties === 0
        && rating.mu === DEFAULT_MU && rating.sigma === DEFAULT_SIGMA) continue;
    ratings[String(paperId)] = rating;
  }

  const favorites = normalizeTimestampedSelections(value.favorites, "favorites");
  const topicInterests = normalizeTimestampedSelections(value.topicInterests, "topic interests");
  const paperPlans = normalizePaperPlans(value.paperPlans);

  if (value.history != null && !Array.isArray(value.history)) throw new Error("The comparison history is invalid.");
  const choices = new Set(["A", "STRONG_A", "B", "STRONG_B", "BOTH", "NEITHER", "SKIP"]);
  const history = (value.history || []).map((entry, index) => {
    if (!isRecord(entry) || !entry.a || !entry.b || !choices.has(entry.choice)) {
      throw new Error(`Comparison ${index + 1} is invalid.`);
    }
    const outcome = entry.outcome == null ? null : Number(entry.outcome);
    const kMult = Number(entry.kMult);
    if ((outcome != null && (!Number.isFinite(outcome) || outcome < 0 || outcome > 1)) || !Number.isFinite(kMult) || kMult < 0) {
      throw new Error(`Comparison ${index + 1} has invalid scoring values.`);
    }
    return { id: stableHistoryId(entry, index), a: String(entry.a), b: String(entry.b), outcome, choice: entry.choice, kMult, ts: String(entry.ts || "") };
  });

  const defaults = defaultState();
  const modes = new Set(["smart", "active", "random", "bubble", "resolve_ties"]);
  const matchModes = new Set(["minimal", "random", "maximal"]);
  const priorities = new Set(["highest", "lowest", "random"]);
  const topN = Number(value.topN);
  const posterTarget = Number(value.posterTarget);
  const smartTarget = isRecord(value.smartTarget)
    && ["oral", "poster"].includes(value.smartTarget.kind)
    && typeof value.smartTarget.key === "string"
    ? { kind: value.smartTarget.kind, key: value.smartTarget.key }
    : null;
  return {
    ...defaults,
    priors,
    ratings,
    favorites,
    topicInterests,
    paperPlans,
    history,
    history_tombstones: Array.isArray(value.history_tombstones) ? [...new Set(value.history_tombstones.map(String))].sort() : [],
    reset_at: typeof value.reset_at === "string" ? value.reset_at : "",
    modified_at: typeof value.modified_at === "string" ? value.modified_at : "",
    lastPair: Array.isArray(value.lastPair) ? value.lastPair.slice(0, 2) : [],
    // States created before smart ranking used "active" as their implicit
    // default and had no posterTarget. Migrate that default once while keeping
    // explicit advanced-mode choices made by newer clients.
    mode: value.posterTarget == null && value.mode === "active" ? "smart" : modes.has(value.mode) ? value.mode : defaults.mode,
    topN: Number.isInteger(topN) && topN >= 10 && topN <= 500 ? topN : defaults.topN,
    posterTarget: Number.isInteger(posterTarget) && posterTarget >= 1 && posterTarget <= 100 ? posterTarget : defaults.posterTarget,
    smartTarget,
    resolveTieNMatches: matchModes.has(value.resolveTieNMatches) ? value.resolveTieNMatches : defaults.resolveTieNMatches,
    muPriority: priorities.has(value.muPriority) ? value.muPriority : defaults.muPriority,
    winsOnly: Boolean(value.winsOnly),
    scheduleByPresentationOrder: Boolean(value.scheduleByPresentationOrder),
    continueAfterReady: Boolean(value.continueAfterReady),
  };
}

function createStateBackup() {
  return {
    type: STATE_EXPORT_TYPE,
    export_version: STATE_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    conference: { id: config.id, name: config.name },
    summary: {
      comparisons: state.history.length,
      rated_papers: Object.values(state.ratings).filter((rating) => Number(rating.n) > 0).length,
      prior_papers: Object.keys(state.priors).length,
      favorites: selectedFavoriteIds().length,
      planned_papers: Object.values(state.paperPlans || {}).filter((plan) => plan.status || plan.notes || plan.tags?.length).length,
    },
    state,
  };
}

function parseStateBackup(value) {
  if (isRecord(value) && value.type === STATE_EXPORT_TYPE) {
    if (Number(value.export_version) !== STATE_EXPORT_VERSION) {
      throw new Error(`Unsupported backup format version: ${value.export_version}.`);
    }
    return normalizeState(value.state);
  }
  // Backward compatibility with state files exported before backup metadata was added.
  return normalizeState(value);
}

function loadStateFromKey(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return defaultState();
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function loadState() {
  return loadStateFromKey(stateKey());
}

function notifyVisualization({ force = false } = {}) {
  const frame = el("vizFrame");
  const payload = {
    key: stateKey(), ratings: effectiveDisplayRatings(), favorites: state.favorites,
    clusters: preferenceModel ? Object.fromEntries(preferenceModel.clusterById) : {},
    clusterLabels: semanticClusterLabels(),
  };
  const fingerprint = JSON.stringify(payload);
  if (!force && fingerprint === lastVisualizationFingerprint) return;
  lastVisualizationFingerprint = fingerprint;
  frame?.contentWindow?.postMessage(
    { type: "ranking_state_update", payload },
    window.location.origin,
  );
}

function persistState({ touch = true, sync = true } = {}) {
  if (touch) state.modified_at = new Date().toISOString();
  localStorage.setItem(stateKey(), JSON.stringify(state));
  if (sync) cloudSync?.scheduleSave(state);
}

function getRatingFrom(target, id) {
  if (!target.ratings[id]) {
    target.ratings[id] = { ...DEFAULT_RATING, ...(target.priors?.[id] || {}) };
  }
  const rating = target.ratings[id];
  for (const [key, fallback] of Object.entries({ mu: DEFAULT_MU, sigma: DEFAULT_SIGMA, n: 0, wins: 0, losses: 0, ties: 0 })) {
    if (!Number.isFinite(Number(rating[key]))) rating[key] = fallback;
  }
  return rating;
}

function readRating(id) {
  return state.ratings[id] || (state.priors[id] ? { ...DEFAULT_RATING, ...state.priors[id] } : DEFAULT_RATING);
}

function effectiveRatings(target) {
  const ratings = {};
  for (const [paperId, prior] of Object.entries(target.priors || {})) {
    ratings[paperId] = { ...DEFAULT_RATING, ...prior };
  }
  return { ...ratings, ...target.ratings };
}

function selectedFavoriteIds(target = state) {
  return Object.entries(target?.favorites || {}).filter(([, favorite]) => favorite?.selected).map(([paperId]) => paperId);
}

function selectedTopicInterests(target = state) {
  return Object.entries(target?.topicInterests || {}).filter(([, interest]) => interest?.selected).map(([topic]) => topic);
}

function preferenceSeedPaperIds() {
  const selected = new Set(selectedTopicInterests());
  if (!selected.size) return [];
  const candidates = papers.filter((paper) => [paper.primary_category, paper.secondary_category, ...(paper.keywords || [])].some((topic) => selected.has(topic)));
  return candidates.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).filter((_, index) => index % Math.max(1, Math.ceil(candidates.length / 40)) === 0).slice(0, 40).map((paper) => String(paper.id));
}

function isFavorite(paperId, target = state) {
  return Boolean(target?.favorites?.[String(paperId)]?.selected);
}

function favoriteButton(paperId, extraClass = "") {
  const selected = isFavorite(paperId);
  const label = selected ? "Remove from favorites" : "Add to favorites";
  return `<button class="favorite-btn ${extraClass}" type="button" data-favorite-id="${esc(paperId)}" aria-label="${label}" aria-pressed="${selected}">${selected ? "★" : "☆"}</button>`;
}

function paperPlan(paperId) {
  return state.paperPlans?.[String(paperId)] || { status: "", tags: [], notes: "", modified_at: "" };
}

function planButton(paperId, extraClass = "") {
  const plan = paperPlan(paperId);
  const hasPlan = Boolean(plan.status || plan.notes || plan.tags?.length);
  return `<button class="plan-btn ${hasPlan ? "has-plan" : ""} ${extraClass}" type="button" data-plan-id="${esc(paperId)}">${plan.status === "attended" ? "✓ Attended" : hasPlan ? "Plan ✓" : "Plan"}</button>`;
}

function toggleFavorite(paperId, selected = !isFavorite(paperId)) {
  state.favorites[String(paperId)] = { selected, modified_at: new Date().toISOString() };
  persistState();
  rebuildFiltered();
  showMessage(selected ? "Added paper to favorites and updated preference predictions." : "Removed paper from favorites.");
}

function toggleTopicInterest(topic) {
  const selected = !state.topicInterests?.[topic]?.selected;
  state.topicInterests[String(topic)] = { selected, modified_at: new Date().toISOString() };
  persistState(); rebuildFiltered();
  showMessage(selected ? `Added ${topic} as an interest.` : `Removed ${topic} from your interests.`);
}

function openPaperPlanner(paperId) {
  const paper = papers.find((item) => String(item.id) === String(paperId));
  if (!paper) return;
  const plan = paperPlan(paperId);
  el("plannerPaperId").value = String(paperId);
  el("plannerPaperTitle").textContent = paper.title;
  el("plannerStatus").value = plan.status || "";
  el("plannerTags").value = (plan.tags || []).join(", ");
  el("plannerNotes").value = plan.notes || "";
  el("paperPlanner").showModal();
}

function savePaperPlanner() {
  const paperId = el("plannerPaperId").value;
  if (!paperId) return;
  state.paperPlans[paperId] = {
    status: el("plannerStatus").value,
    tags: [...new Set(el("plannerTags").value.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
    notes: el("plannerNotes").value.trim().slice(0, 10000),
    modified_at: new Date().toISOString(),
  };
  persistState(); rebuildFiltered();
  showMessage("Saved your personal paper plan.");
}

function effectiveDisplayRatings() {
  if (!papers.length) return effectiveRatings(state);
  return Object.fromEntries(papers.map((paper) => {
    const base = readRating(String(paper.id));
    const rating = blendPreferencePrediction(base, preferenceModel?.predictions?.get(String(paper.id)));
    return [String(paper.id), rating];
  }));
}

function presentationsOf(paper, type) {
  return (paper.presentations || []).filter((item) => item.type === type);
}

function firstPresentation(paper, type) {
  return presentationsOf(paper, type)[0] || null;
}

function primaryPresentation(paper) {
  return firstPresentation(paper, "oral") || firstPresentation(paper, "poster") || (paper.presentations || [])[0] || {};
}

function hydrate(paper) {
  const paperId = String(paper.id);
  const baseRating = readRating(paperId);
  const rating = blendPreferencePrediction(baseRating, preferenceModel?.predictions?.get(paperId));
  const oral = firstPresentation(paper, "oral");
  const poster = firstPresentation(paper, "poster");
  const primary = primaryPresentation(paper);
  const plan = paperPlan(paperId);
  return {
    ...paper,
    id: paperId,
    authorsText: (paper.authors || []).join(", "),
    keywordsText: (paper.keywords || []).join("; "),
    cat1: paper.primary_category || "",
    cat2: paper.secondary_category || "",
    oral,
    poster,
    displayDate: primary.date || "",
    displayTime: primary.time || "",
    displayLocation: primary.location || "",
    displaySession: primary.session || paper.track || "",
    mu: Number(rating.mu),
    sigma: Number(rating.sigma),
    n: Number(rating.n),
    wins: Number(rating.wins),
    favorite: isFavorite(paperId),
    predicted: Boolean(rating.predicted),
    modelConfidence: Number(rating.modelConfidence || 0),
    cluster: preferenceModel?.clusterById?.get(paperId),
    representative: Boolean(preferenceModel?.representatives?.has(paperId)),
    plan,
  };
}

function semanticClusterLabels() {
  if (!preferenceModel?.clusterById || !papers.length) return {};
  const counts = new Map();
  for (const paper of papers) {
    const cluster = preferenceModel.clusterById.get(String(paper.id));
    if (cluster == null) continue;
    if (!counts.has(cluster)) counts.set(cluster, new Map());
    const terms = [paper.primary_category, paper.secondary_category].filter(Boolean);
    for (const term of terms) counts.get(cluster).set(term, (counts.get(cluster).get(term) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].map(([cluster, terms]) => {
    const label = [...terms.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || `Semantic area ${Number(cluster) + 1}`;
    return [String(cluster), label];
  }));
}

function dotProduct(a, b) {
  let total = 0;
  for (let index = 0; index < Math.min(a?.length || 0, b?.length || 0); index += 1) total += a[index] * b[index];
  return total;
}

function recommendationReason(paper) {
  if (paper.favorite) return "You marked this paper as a favorite.";
  if (paper.plan?.status === "planned") return "You explicitly added this paper to your plan.";
  if (paper.plan?.status === "attended") return "Marked as attended/visited.";
  if (paper.n > 0) return `Directly informed by ${paper.n} comparison${paper.n === 1 ? "" : "s"}.`;
  const selectedTopics = selectedTopicInterests();
  const matchingTopics = [paper.cat1, paper.cat2, ...(paper.keywords || [])].filter((topic) => selectedTopics.includes(topic));
  if (matchingTopics.length) return `Matches your interest in ${matchingTopics.slice(0, 2).join(" and ")}.`;
  const feature = preferenceModel?.featureById?.get(paper.id);
  let nearest = null;
  if (feature) {
    for (const favoriteId of selectedFavoriteIds()) {
      const favoriteFeature = preferenceModel.featureById.get(favoriteId);
      const similarity = favoriteFeature ? dotProduct(feature, favoriteFeature) : -Infinity;
      if (!nearest || similarity > nearest.similarity) nearest = { id: favoriteId, similarity };
    }
  }
  if (nearest && nearest.similarity > 0.35) {
    const title = papers.find((item) => String(item.id) === nearest.id)?.title || nearest.id;
    return `Semantically similar to your favorite “${title}”.`;
  }
  if (paper.predicted) return `Preference model estimate · ${Math.round(paper.modelConfidence * 100)}% model confidence.`;
  return "Not enough personal evidence yet—compare or star related papers.";
}

function parseStartMinutes(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.MAX_SAFE_INTEGER;
}

function dateSort(value) {
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const match = String(value || "").match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})/i);
  if (match) return months[match[1].toLowerCase()] * 100 + Number(match[2]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function comparePapers(a, b) {
  return (b.mu - a.mu) || (b.wins - a.wins) || a.id.localeCompare(b.id);
}

function presentationLabel(item) {
  if (!item) return "";
  return [item.type, item.date, item.time, item.location].filter(Boolean).join(" · ");
}

function rebuildFiltered() {
  preferenceModel = trainPreferenceModel(preferenceBundle, { ...state, seedPaperIds: preferenceSeedPaperIds() });
  const query = el("search").value.trim().toLowerCase();
  const track = el("trackFilter").value;
  const category = el("categoryFilter").value;
  const day = el("dayFilter").value;
  const location = el("locationFilter").value;
  const winsOnly = el("hasWinsOnly").checked;
  const favoritesOnly = el("favoritesOnly").checked;
  filtered = papers.map(hydrate).filter((paper) => {
    if (track && paper.track !== track) return false;
    const topics = [paper.cat1, paper.cat2, ...(paper.keywords || [])];
    if (category && !topics.includes(category)) return false;
    if (day && !(paper.presentations || []).some((item) => item.date === day)) return false;
    if (location && !(paper.presentations || []).some((item) => item.location === location)) return false;
    if (winsOnly && paper.wins < 1) return false;
    if (favoritesOnly && !paper.favorite) return false;
    if (!query) return true;
    const schedule = (paper.presentations || []).flatMap((item) => Object.values(item));
    return [paper.id, paper.title, paper.abstract, paper.authorsText, paper.track, paper.cat1, paper.cat2, paper.keywordsText, ...schedule]
      .join(" ").toLowerCase().includes(query);
  });
  renderAll();
  notifyVisualization();
}

function renderStats() {
  el("stats").innerHTML = [
    ["Total", papers.length],
    ["Filtered", filtered.length],
    ["Comparisons", state.history.length],
    ["Rated", Object.values(state.ratings).filter((rating) => Number(rating.n) > 0).length],
    ["Model-scored", preferenceModel?.hasSignal ? preferenceModel.predictions.size : Object.keys(state.priors).length],
    ["Favorites", selectedFavoriteIds().length],
    ["Planned", Object.values(state.paperPlans || {}).filter((plan) => ["planned", "attended"].includes(plan.status)).length],
  ].map(([label, value]) => `<span class="pill">${label}: <b>${value}</b></span>`).join("");
}

function renderOverview() {
  const root = el("overview");
  if (!filtered.length) {
    root.innerHTML = '<div class="small">No papers match the current filters.</div>';
    return;
  }
  const groups = new Map();
  for (const paper of filtered) {
    const day = paper.displayDate || "Unscheduled";
    const session = paper.displaySession || "No session";
    const location = paper.displayLocation || "No location";
    const time = paper.displayTime || "Time unavailable";
    if (!groups.has(day)) groups.set(day, new Map());
    if (!groups.get(day).has(session)) groups.get(day).set(session, new Map());
    if (!groups.get(day).get(session).has(location)) groups.get(day).get(session).set(location, new Map());
    if (!groups.get(day).get(session).get(location).has(time)) groups.get(day).get(session).get(location).set(time, []);
    groups.get(day).get(session).get(location).get(time).push(paper);
  }
  root.innerHTML = [...groups.keys()].sort((a, b) => dateSort(a) - dateSort(b)).map((day) => {
    const sessions = groups.get(day);
    const sessionHtml = [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([session, locations]) => {
      const locationHtml = [...locations.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([location, times]) => {
        const count = [...times.values()].reduce((total, items) => total + items.length, 0);
        const timeHtml = [...times.entries()]
          .sort(([a], [b]) => parseStartMinutes(a) - parseStartMinutes(b) || a.localeCompare(b))
          .map(([time, items]) => `<details class="overview-time" ${disclosureAttribute("overview", day, session, location, time)} open>
            <summary>${esc(time)} <span class="small">(${items.length} paper${items.length === 1 ? "" : "s"})</span></summary>
            <div class="overview-time-content">${items.sort(comparePapers).map(paperHtml).join("")}</div>
          </details>`).join("");
        return `<details class="overview-location" ${disclosureAttribute("overview", day, session, location)} open><summary>${esc(location)} <span class="small">(${count})</span></summary>${timeHtml}</details>`;
      }).join("");
      return `<details class="overview-session" ${disclosureAttribute("overview", day, session)} open><summary>${esc(session)}</summary><div class="overview-content">${locationHtml}</div></details>`;
    }).join("");
    return `<details class="overview-date" ${disclosureAttribute("overview", day)} open><summary>${esc(day)}</summary><div class="overview-content">${sessionHtml}</div></details>`;
  }).join("");
}

function paperHtml(paper) {
  const badges = (paper.presentations || []).map((item) => `<span class="chip">${esc(presentationLabel(item))}</span>`).join("");
  return `<article class="paper">
    <div class="paper-heading"><div class="top">${esc(paper.title)}</div><div class="paper-actions">${planButton(paper.id)}${favoriteButton(paper.id)}</div></div>
    <div class="meta"><span>${esc(paper.id)}</span><span>${esc(paper.authorsText || "Authors unavailable")}</span><span>${esc(paper.track || paper.cat1 || "Uncategorized")}</span><span>μ ${paper.mu.toFixed(1)}</span></div>
    <div class="schedule-badges">${badges || '<span class="chip">Schedule unavailable</span>'}</div>
    <div class="recommendation-reason">${esc(recommendationReason(paper))}</div>
    <details class="abs" ${disclosureAttribute("abstract", paper.id)}><summary>Abstract</summary><div>${esc(paper.abstract || "Abstract unavailable")}</div></details>
  </article>`;
}

function renderCard(paper, label) {
  if (!paper) return "";
  return `<div class="head"><div class="paper-heading"><strong>${label}: ${esc(paper.title)}</strong><div class="paper-actions">${planButton(paper.id)}${favoriteButton(paper.id)}</div></div><div class="k">${esc(paper.id)} · ${esc(paper.track || paper.cat1 || "Uncategorized")} · μ ${paper.mu.toFixed(1)} · σ ${paper.sigma.toFixed(1)} · n ${paper.n}${paper.predicted ? " · model-informed" : ""}</div></div>
    <div class="body"><div class="small">${esc(paper.authorsText)}</div><p>${esc(paper.abstract || "Abstract unavailable")}</p><div class="recommendation-reason">Why shown: ${esc(recommendationReason(paper))}</div><div class="schedule-badges">${(paper.presentations || []).map((item) => `<span class="chip">${esc(presentationLabel(item))}</span>`).join("")}</div></div>`;
}

function nextPair() {
  const pairPool = (state.smartTarget ? papers.map(hydrate) : filtered).filter((paper) => paper.plan?.status !== "skipped");
  const decisions = decisionProgress();
  const selectorState = { ...state, resolvedDecisionKeys: decisions.resolvedKeys };
  const enoughEvidence = state.history.filter((entry) => entry.outcome != null).length >= 20 || selectedFavoriteIds().length >= 8;
  const allDecisionsReady = enoughEvidence && decisions.total > 0 && decisions.resolvedKeys.length === decisions.total;
  const ready = el("decisionReady");
  ready.hidden = !allDecisionsReady || state.continueAfterReady || Boolean(state.smartTarget);
  if (!ready.hidden) {
    ready.innerHTML = `<div class="panel-row"><div><div class="h2">Your schedule decisions are stable</div><div class="small">Additional comparisons are unlikely to change the recommended rooms or poster cutoff. You can use My Agenda now.</div></div><div class="agenda-actions"><button class="btn" type="button" data-open-agenda>Open My Agenda</button><button class="btn secondary" type="button" data-continue-ranking>Continue exploring</button></div></div>`;
    currentPair = null; el("arena").hidden = true; return;
  }
  const selection = chooseNextPair(pairPool, selectorState);
  const arena = el("arena");
  if (!selection?.pair) {
    currentPair = null;
    arena.hidden = true;
    return;
  }
  const pair = selection.pair;
  currentPair = { A: pair[0], B: pair[1] };
  arena.hidden = false;
  el("pairReason").textContent = selection.reason || "";
  el("pairStage").textContent = selection.stage || "Smart";
  el("cardA").innerHTML = renderCard(pair[0], "A");
  el("cardB").innerHTML = renderCard(pair[1], "B");
}

function applyCounters(a, b, outcome) {
  if (outcome === 1) { a.wins += 1; b.losses += 1; }
  else if (outcome === 0) { b.wins += 1; a.losses += 1; }
  else { a.ties += 1; b.ties += 1; }
}

function applyJoint(rating, direction, multiplier) {
  // Keep joint feedback uncertainty-aware, just like pairwise Elo updates.
  // This also preserves scores when replaying ranking histories exported by
  // the original EACL preference arena.
  const uncertainty = Math.max(0.6, Math.min(1.8, rating.sigma / DEFAULT_SIGMA));
  rating.mu += direction * BASE_K * JOINT_FEEDBACK_SCALE * multiplier * uncertainty;
  rating.sigma = Math.max(MIN_SIGMA, rating.sigma * SIGMA_DECAY * 0.99);
  rating.n += 1;
}

function applyHistoryEntry(entry, target = state) {
  if (entry.outcome == null) return;
  const a = getRatingFrom(target, entry.a);
  const b = getRatingFrom(target, entry.b);
  if (entry.choice === "BOTH") {
    applyJoint(a, 1, entry.kMult); applyJoint(b, 1, entry.kMult);
  } else if (entry.choice === "NEITHER") {
    applyJoint(a, -1, entry.kMult); applyJoint(b, -1, entry.kMult);
  } else {
    updatePair(a, b, entry.outcome, { baseK: BASE_K * entry.kMult });
  }
  applyCounters(a, b, entry.outcome);
}

function rebuildRatings(target) {
  const rebuilt = { ...target, ratings: {}, history: [] };
  for (const entry of target.history) {
    applyHistoryEntry(entry, rebuilt);
    rebuilt.history.push(entry);
  }
  return rebuilt;
}

function mergeStates(first, second) {
  const local = normalizeState(first);
  const remote = normalizeState(second);
  const merged = mergeComparisonData(local, remote);
  const localResetIsNewer = (local.reset_at || "") > (remote.reset_at || "");
  const remoteResetIsNewer = (remote.reset_at || "") > (local.reset_at || "");
  const favorites = localResetIsNewer
    ? local.favorites
    : remoteResetIsNewer ? remote.favorites : mergeTimestampedRecords(local.favorites, remote.favorites);
  const topicInterests = localResetIsNewer
    ? local.topicInterests
    : remoteResetIsNewer ? remote.topicInterests : mergeTimestampedRecords(local.topicInterests, remote.topicInterests);
  const paperPlans = localResetIsNewer
    ? local.paperPlans
    : remoteResetIsNewer ? remote.paperPlans : mergeTimestampedRecords(local.paperPlans, remote.paperPlans);
  const priors = localResetIsNewer
    ? local.priors
    : remoteResetIsNewer ? remote.priors : {
      ...(merged.localIsNewer ? remote.priors : local.priors),
      ...(merged.localIsNewer ? local.priors : remote.priors),
    };
  return rebuildRatings({
    ...(merged.localIsNewer ? local : remote),
    priors,
    favorites,
    topicInterests,
    paperPlans,
    history: merged.history,
    history_tombstones: merged.history_tombstones,
    reset_at: merged.reset_at,
    modified_at: merged.localIsNewer ? local.modified_at : remote.modified_at,
  });
}

function createHistoryId() {
  return globalThis.crypto?.randomUUID?.() || `comparison-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function vote(choice) {
  if (!currentPair) return;
  const choices = {
    A: [1, 1], STRONG_A: [1, 1.8], B: [0, 1], STRONG_B: [0, 1.8],
    BOTH: [0.5, 0.8], NEITHER: [0.5, 1.2], SKIP: [null, 0],
  };
  const [outcome, kMult] = choices[choice];
  const entry = { id: createHistoryId(), a: currentPair.A.id, b: currentPair.B.id, outcome, choice, kMult, ts: new Date().toISOString() };
  applyHistoryEntry(entry);
  state.history.push(entry);
  state.lastPair = [{ id: currentPair.A.id }, { id: currentPair.B.id }];
  persistState();
  rebuildFiltered();
}

function undo() {
  if (!state.history.length) return;
  const removed = state.history.at(-1);
  const history = state.history.slice(0, -1);
  state = rebuildRatings({
    ...state,
    history,
    history_tombstones: [...new Set([...state.history_tombstones, removed.id])],
  });
  persistState();
  rebuildFiltered();
}

function renderLeaderboard() {
  el("leaderboard").innerHTML = filtered.slice().sort(comparePapers).slice(0, 40).map((paper, index) => `
    <div class="lb-row"><div class="lb-top"><div class="lb-title">#${index + 1} — ${esc(paper.title)}</div><div class="row-actions">${planButton(paper.id)}${favoriteButton(paper.id)}<div class="small">μ ${paper.mu.toFixed(1)} · σ ${paper.sigma.toFixed(1)} · n ${paper.n}</div></div></div>
    <div class="lb-sub">${esc(paper.id)} · ${esc(paper.track || paper.cat1 || "Uncategorized")} · ${esc(presentationLabel(paper.oral || paper.poster))}</div><div class="recommendation-reason">${esc(recommendationReason(paper))}</div></div>`).join("");
}

function scheduleKey(presentation) {
  return `${presentation.date || "Unscheduled"}|||${presentation.time || "Time unavailable"}`;
}

function decisionProgress() {
  const hydrated = papers.map(hydrate).filter((paper) => paper.plan?.status !== "skipped");
  const oralSlots = new Map();
  const posterBlocks = new Map();
  for (const paper of hydrated) {
    for (const presentation of paper.presentations || []) {
      const key = scheduleKey(presentation);
      if (presentation.type === "oral") {
        if (!oralSlots.has(key)) oralSlots.set(key, new Map());
        const room = presentation.location || "Location unavailable";
        if (!oralSlots.get(key).has(room)) oralSlots.get(key).set(room, []);
        oralSlots.get(key).get(room).push(paper);
      } else if (["poster", "demo"].includes(presentation.type)) {
        if (!posterBlocks.has(key)) posterBlocks.set(key, new Map());
        posterBlocks.get(key).set(paper.id, paper);
      }
    }
  }
  let oralTotal = 0; let oralResolved = 0; const resolvedKeys = [];
  for (const [key, rooms] of oralSlots.entries()) {
    if (rooms.size < 2) continue;
    oralTotal += 1;
    const blocks = [...rooms.values()].map((roomPapers) => {
      const ranked = [...roomPapers].sort(comparePapers);
      const max = ranked[0]?.mu ?? DEFAULT_MU;
      const second = ranked[1]?.mu ?? max;
      const mean = ranked.reduce((sum, paper) => sum + paper.mu, 0) / ranked.length;
      return {
        utility: 0.5 * max + 0.3 * second + 0.2 * mean,
        uncertainty: ranked.slice(0, 3).reduce((sum, paper) => sum + paper.sigma, 0) / Math.min(3, ranked.length),
      };
    }).sort((a, b) => b.utility - a.utility);
    if (blocks[0].utility - blocks[1].utility > ((blocks[0].uncertainty + blocks[1].uncertainty) / 2) * 0.25) { oralResolved += 1; resolvedKeys.push(`oral:${key}`); }
  }
  let posterTotal = 0; let posterResolved = 0;
  for (const [key, blockMap] of posterBlocks.entries()) {
    const ranked = [...blockMap.values()].sort(comparePapers);
    if (ranked.length <= state.posterTarget) continue;
    posterTotal += 1;
    const upper = ranked[state.posterTarget - 1]; const lower = ranked[state.posterTarget];
    if (upper.mu - lower.mu > ((upper.sigma + lower.sigma) / 2) * 0.15) { posterResolved += 1; resolvedKeys.push(`poster:${key}`); }
  }
  return { oralTotal, oralResolved, posterTotal, posterResolved, resolvedKeys, total: oralTotal + posterTotal };
}

function renderSmartProgress() {
  const progress = preferenceProgress(preferenceBundle, state, preferenceModel) || {
    stage: "Discover", comparisons: state.history.length, favorites: selectedFavoriteIds().length,
    coveredClusters: 0, clusterCount: 0, coverage: 0,
  };
  const percent = Math.round(progress.coverage * 100);
  const decisions = decisionProgress();
  const target = state.smartTarget
    ? `${state.smartTarget.kind === "oral" ? "Oral slot" : "Poster block"}: ${state.smartTarget.key.replace("|||", " · ")}`
    : "Automatic: discovery, schedule decisions, and exploration";
  el("smartProgress").innerHTML = `
    <div class="progress-head"><div><span class="stage-badge">${esc(progress.stage)}</span><strong> Smart ranking</strong></div><button class="btn secondary" id="clearSmartTarget" ${state.smartTarget ? "" : "hidden"}>Return to automatic</button></div>
    <div class="progress-grid">
      <div><strong>${progress.favorites}</strong><span>favorites</span></div>
      <div><strong>${progress.comparisons}</strong><span>answered comparisons</span></div>
      <div><strong>${progress.coveredClusters}/${progress.clusterCount || "—"}</strong><span>semantic areas sampled</span></div>
      <div><strong>${percent}%</strong><span>preference coverage</span></div>
      <div><strong>${decisions.oralResolved}/${decisions.oralTotal || "—"}</strong><span>oral slots resolved</span></div>
      <div><strong>${decisions.posterResolved}/${decisions.posterTotal || "—"}</strong><span>poster blocks stable</span></div>
    </div>
    <div class="progress-bar" aria-label="Preference coverage ${percent}%"><span style="width:${percent}%"></span></div>
    <div class="small">Current target: ${esc(target)}. ${progress.favorites < 5 && progress.comparisons < 10 ? "Tip: star 5–15 promising papers for a faster start." : "Questions now favor unresolved schedule decisions while reserving some exploration."} Predictions are guidance; stars and direct reviews remain visible.</div>`;
  el("clearSmartTarget")?.addEventListener("click", () => {
    state.smartTarget = null; persistState(); rebuildFiltered();
  });
}

function normalized(values, value) {
  const low = Math.min(...values); const high = Math.max(...values);
  return high - low < 1e-9 ? 0.5 : (value - low) / (high - low);
}

function renderOralSchedule() {
  const root = el("schedule");
  const records = filtered.filter((paper) => paper.plan?.status !== "skipped").flatMap((paper) => presentationsOf(paper, "oral").map((presentation) => ({ paper, presentation })));
  if (!records.length) { root.innerHTML = '<div class="small">No oral presentations match the current filters.</div>'; return; }
  if (el("scheduleByPresentationOrder").checked && config.features.presentation_order) {
    renderOrderSchedule(records); return;
  }
  const slots = new Map();
  for (const record of records) {
    const p = record.presentation;
    const slotKey = `${p.date || "Unscheduled"}|||${p.time || "Time unavailable"}`;
    if (!slots.has(slotKey)) slots.set(slotKey, { date: p.date || "Unscheduled", time: p.time || "Time unavailable", rooms: new Map() });
    const room = p.location || "Location unavailable";
    if (!slots.get(slotKey).rooms.has(room)) slots.get(slotKey).rooms.set(room, []);
    slots.get(slotKey).rooms.get(room).push(record.paper);
  }
  const byDate = new Map();
  for (const slot of slots.values()) { if (!byDate.has(slot.date)) byDate.set(slot.date, []); byDate.get(slot.date).push(slot); }
  root.innerHTML = [...byDate.keys()].sort((a, b) => dateSort(a) - dateSort(b)).map((day) => {
    const slotHtml = byDate.get(day).sort((a, b) => parseStartMinutes(a.time) - parseStartMinutes(b.time)).map((slot) => {
      const blocks = [...slot.rooms.entries()].map(([room, roomPapers]) => {
        const ranked = roomPapers.slice().sort(comparePapers);
        const max = ranked[0]?.mu ?? DEFAULT_MU;
        const second = ranked[1]?.mu ?? max;
        const mean = ranked.reduce((sum, paper) => sum + paper.mu, 0) / ranked.length;
        const utility = 0.5 * max + 0.3 * second + 0.2 * mean;
        const uncertainty = ranked.slice(0, 3).reduce((sum, paper) => sum + paper.sigma, 0) / Math.min(3, ranked.length);
        return { room, papers: ranked, max, mean, utility, uncertainty };
      });
      blocks.sort((a, b) => b.utility - a.utility);
      const gap = blocks.length > 1 ? blocks[0].utility - blocks[1].utility : Infinity;
      const uncertainty = blocks.length > 1 ? (blocks[0].uncertainty + blocks[1].uncertainty) / 2 : 1;
      const confidence = gap === Infinity ? "high" : gap > uncertainty * 0.25 ? "high" : gap > uncertainty * 0.1 ? "medium" : "unresolved";
      const rows = blocks.map((block, index) => `<tr><td data-label="Pick">${index === 0 ? "Primary" : index === 1 ? "Backup" : index + 1}</td><td data-label="Room">${esc(block.room)}</td><td data-label="Room utility">${block.utility.toFixed(1)}</td><td data-label="Favorites">${block.papers.filter((paper) => paper.favorite).length || "—"}</td><td data-label="Top papers">${block.papers.slice(0, 4).map((paper) => `<div class="schedule-paper"><div class="schedule-paper-actions">${favoriteButton(paper.id, "inline-star")} ${planButton(paper.id)}</div><div><strong>${esc(paper.title)}</strong><div class="recommendation-reason">${esc(recommendationReason(paper))}</div></div></div>`).join("")}</td></tr>`).join("");
      const key = `${slot.date}|||${slot.time}`;
      return `<details class="schedule-slot" ${disclosureAttribute("schedule", slot.date, slot.time)} open><summary class="schedule-slot-title"><span>${esc(slot.time)} · <span class="confidence ${confidence}">${confidence}</span></span><button class="btn secondary compact-action" type="button" data-focus-kind="oral" data-focus-key="${esc(key)}">Resolve this slot</button></summary><table class="schedule-table"><thead><tr><th>Pick</th><th>Room</th><th>Room utility</th><th>Favorites</th><th>Top papers</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    }).join("");
    return `<details class="schedule-day" ${disclosureAttribute("schedule", day)} open><summary class="schedule-day-head">${esc(day)}</summary>${slotHtml}</details>`;
  }).join("");
}

function renderOrderSchedule(records) {
  const groups = new Map();
  for (const { paper, presentation } of records) {
    if (!presentation.order) continue;
    const key = `${presentation.date}|||${presentation.time}|||${presentation.order}`;
    if (!groups.has(key)) groups.set(key, { ...presentation, papers: [] });
    groups.get(key).papers.push(paper);
  }
  const rows = [...groups.values()].sort((a, b) => dateSort(a.date) - dateSort(b.date) || parseStartMinutes(a.time) - parseStartMinutes(b.time) || Number(a.order) - Number(b.order)).map((group) => {
    const ranked = group.papers.sort(comparePapers); const best = ranked[0]; const backup = ranked[1];
    return `<tr><td data-label="Day">${esc(group.date)}</td><td data-label="Block">${esc(group.time)}</td><td data-label="Order">${esc(group.order)}</td><td data-label="Top talk">${best ? `${favoriteButton(best.id, "inline-star")} ${esc(best.title)}` : "—"}</td><td data-label="Room">${esc(best?.oral?.location || "—")}</td><td data-label="Backup">${backup ? `${favoriteButton(backup.id, "inline-star")} ${esc(backup.title)}` : "—"}</td></tr>`;
  }).join("");
  el("schedule").innerHTML = rows ? `<table class="schedule-table"><thead><tr><th>Day</th><th>Block</th><th>Order</th><th>Top talk</th><th>Room</th><th>Backup</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="small">No presentation-order data is available.</div>';
}

function renderPosters() {
  const root = el("posters");
  const records = filtered.filter((paper) => paper.plan?.status !== "skipped").flatMap((paper) => [
    ...presentationsOf(paper, "poster"),
    ...presentationsOf(paper, "demo"),
  ].map((presentation) => ({ paper, presentation })));
  if (!records.length) { root.innerHTML = '<div class="small">No poster presentations match the current filters.</div>'; return; }
  const groups = new Map();
  for (const record of records) {
    const date = record.presentation.date || "Unscheduled"; const time = record.presentation.time || "Time unavailable";
    if (!groups.has(date)) groups.set(date, new Map());
    if (!groups.get(date).has(time)) groups.get(date).set(time, []);
    groups.get(date).get(time).push(record);
  }
  const rank = new Map(papers.map(hydrate).sort(comparePapers).map((paper, index) => [paper.id, index + 1]));
  root.innerHTML = [...groups.keys()].sort((a, b) => dateSort(a) - dateSort(b)).map((day) => {
    const blocks = [...groups.get(day).entries()].sort(([a], [b]) => parseStartMinutes(a) - parseStartMinutes(b)).map(([time, items]) => {
      items.sort((a, b) => (rank.get(a.paper.id) || Infinity) - (rank.get(b.paper.id) || Infinity));
      const target = Math.min(state.posterTarget, items.length);
      const rows = items.map(({ paper, presentation }, index) => {
        let status = "Optional";
        if (paper.favorite) status = "Must visit";
        else if (index < Math.min(3, target) && (paper.n >= 2 || paper.modelConfidence >= 0.55)) status = "Must visit";
        else if (index < target) status = "Likely visit";
        else if (index < target + 3 && paper.sigma > 180) status = "Explore";
        return `<tr><td data-label="Favorite">${favoriteButton(paper.id)}</td><td data-label="Priority"><span class="visit-status ${status.toLowerCase().replaceAll(" ", "-")}">${status}</span></td><td data-label="Rank">${rank.get(paper.id) || "—"}</td><td data-label="ID">${esc(paper.id)}</td><td data-label="Title">${esc(paper.title)}<div class="recommendation-reason">${esc(recommendationReason(paper))}</div></td><td data-label="Location">${esc(presentation.location || "—")}</td><td data-label="Score">${paper.mu.toFixed(1)} ± ${paper.sigma.toFixed(0)}</td><td data-label="Personal">${planButton(paper.id)}</td></tr>`;
      }).join("");
      const key = `${day}|||${time}`;
      return `<details class="poster-slot" ${disclosureAttribute("posters", day, time)} open><summary class="poster-slot-head"><span>${esc(time)} <span class="small">(${items.length} papers · target ${target})</span></span><button class="btn secondary compact-action" type="button" data-focus-kind="poster" data-focus-key="${esc(key)}">Refine this block</button></summary><table class="poster-table"><thead><tr><th>Favorite</th><th>Priority</th><th>Rank</th><th>ID</th><th>Title</th><th>Location</th><th>Score</th><th>Personal</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    }).join("");
    return `<details class="poster-day" ${disclosureAttribute("posters", day)} open><summary class="poster-day-head">${esc(day)}</summary>${blocks}</details>`;
  }).join("");
}

function topicOptions() {
  const counts = new Map();
  for (const paper of papers) {
    for (const topic of [paper.primary_category, paper.secondary_category].filter(Boolean)) counts.set(topic, (counts.get(topic) || 0) + 1);
  }
  const selected = new Set(selectedTopicInterests());
  return [...counts.entries()].sort((a, b) => (selected.has(b[0]) - selected.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 18);
}

function renderOnboarding() {
  const root = el("onboardingPanel");
  const favorites = selectedFavoriteIds().length;
  const interests = selectedTopicInterests().length;
  const comparisons = state.history.filter((entry) => entry.outcome != null).length;
  const ready = favorites >= 5 || interests >= 3 || comparisons >= 10;
  root.hidden = ready;
  if (ready) return;
  root.innerHTML = `<div class="onboarding-head"><div><div class="h2">Teach the app what you care about</div><div class="small">Choose a few topics or star promising papers. You will get a provisional agenda immediately; comparisons then focus on decisions that remain uncertain.</div></div><span class="stage-badge">2-minute setup</span></div>
    <div class="onboarding-steps"><div class="onboarding-step"><strong>${interests}/3 topics</strong><span>Select broad interests below.</span></div><div class="onboarding-step"><strong>${favorites}/5 favorites</strong><span>Star papers while exploring.</span></div><div class="onboarding-step"><strong>${comparisons}/10 comparisons</strong><span>Answer only useful tie-breakers.</span></div></div>
    <div class="topic-seeds">${topicOptions().map(([topic, count]) => `<button class="topic-seed" type="button" data-topic-interest="${esc(topic)}" aria-pressed="${state.topicInterests?.[topic]?.selected ? "true" : "false"}">${esc(topic)} <span>(${count})</span></button>`).join("")}</div>`;
}

function roomRecommendation(room, roomPapers) {
  const ranked = roomPapers.slice().sort(comparePapers);
  const max = ranked[0]?.mu ?? DEFAULT_MU;
  const second = ranked[1]?.mu ?? max;
  const mean = ranked.reduce((sum, paper) => sum + paper.mu, 0) / Math.max(1, ranked.length);
  const utility = 0.5 * max + 0.3 * second + 0.2 * mean;
  const uncertainty = ranked.slice(0, 3).reduce((sum, paper) => sum + paper.sigma, 0) / Math.max(1, Math.min(3, ranked.length));
  return { room, papers: ranked, utility, uncertainty };
}

function confidenceForChoices(primary, backup) {
  if (!backup) return "high";
  const gap = primary.utility - backup.utility;
  const uncertainty = (primary.uncertainty + backup.uncertainty) / 2;
  return gap > uncertainty * 0.25 ? "high" : gap > uncertainty * 0.1 ? "medium" : "unresolved";
}

function agendaData() {
  const hydrated = papers.map(hydrate).filter((paper) => paper.plan?.status !== "skipped");
  const oralSlots = new Map(); const posterBlocks = new Map();
  for (const paper of hydrated) {
    for (const presentation of paper.presentations || []) {
      const key = scheduleKey(presentation);
      if (presentation.type === "oral") {
        if (!oralSlots.has(key)) oralSlots.set(key, { key, date: presentation.date || "Unscheduled", time: presentation.time || "Time unavailable", rooms: new Map() });
        const room = presentation.location || "Location unavailable";
        if (!oralSlots.get(key).rooms.has(room)) oralSlots.get(key).rooms.set(room, []);
        oralSlots.get(key).rooms.get(room).push(paper);
      } else if (["poster", "demo"].includes(presentation.type)) {
        if (!posterBlocks.has(key)) posterBlocks.set(key, { key, date: presentation.date || "Unscheduled", time: presentation.time || "Time unavailable", records: [] });
        posterBlocks.get(key).records.push({ paper, presentation });
      }
    }
  }
  const events = [];
  for (const slot of oralSlots.values()) {
    const choices = [...slot.rooms.entries()].map(([room, roomPapers]) => roomRecommendation(room, roomPapers)).sort((a, b) => b.utility - a.utility);
    if (!choices.length) continue;
    events.push({ ...slot, kind: "oral", primary: choices[0], backup: choices[1] || null, confidence: confidenceForChoices(choices[0], choices[1]) });
  }
  for (const block of posterBlocks.values()) {
    const dedup = new Map(block.records.map((record) => [record.paper.id, record]));
    const records = [...dedup.values()].sort((a, b) => {
      const forceA = ["planned", "attended"].includes(a.paper.plan?.status) || a.paper.favorite ? 1 : 0;
      const forceB = ["planned", "attended"].includes(b.paper.plan?.status) || b.paper.favorite ? 1 : 0;
      return forceB - forceA || comparePapers(a.paper, b.paper);
    });
    const target = Math.min(state.posterTarget, records.length);
    const forcedIds = new Set(records.filter((record) => record.paper.favorite || ["planned", "attended"].includes(record.paper.plan?.status)).map((record) => record.paper.id));
    const must = records.filter((record, index) => forcedIds.has(record.paper.id) || index < target);
    const boundary = records.length > target && target > 0 ? [records[target - 1].paper, records[target].paper] : null;
    const confidence = !boundary ? "high" : boundary[0].mu - boundary[1].mu > ((boundary[0].sigma + boundary[1].sigma) / 2) * 0.15 ? "high" : "unresolved";
    events.push({ ...block, kind: "poster", must, target, confidence });
  }
  const keysWithConflict = new Set(events.filter((event, index) => events.some((other, otherIndex) => otherIndex !== index && other.key === event.key && other.kind !== event.kind)).map((event) => event.key));
  events.forEach((event) => { event.conflict = keysWithConflict.has(event.key); });
  return events.sort((a, b) => dateSort(a.date) - dateSort(b.date) || parseStartMinutes(a.time) - parseStartMinutes(b.time) || a.kind.localeCompare(b.kind));
}

function agendaPaperHtml(paper) {
  return `<div class="agenda-paper">${favoriteButton(paper.id, "inline-star")}<div><strong>${esc(paper.title)}</strong><div class="recommendation-reason">${esc(recommendationReason(paper))}</div></div></div>`;
}

function renderAgenda() {
  const root = el("agenda"); const events = agendaData();
  if (!events.length) { root.innerHTML = '<section class="panel"><div class="small">No scheduled presentations are available yet.</div></section>'; return; }
  const byDate = new Map();
  for (const event of events) { if (!byDate.has(event.date)) byDate.set(event.date, []); byDate.get(event.date).push(event); }
  root.innerHTML = [...byDate.entries()].map(([date, dayEvents]) => `<details class="agenda-day" ${disclosureAttribute("agenda", date)} open><summary>${esc(date)} · ${dayEvents.length} agenda decisions</summary>${dayEvents.map((event) => {
    if (event.kind === "oral") {
      const reasonPaper = event.primary.papers[0];
      return `<article class="agenda-item"><div><div class="agenda-time">${esc(event.time)}</div><div class="agenda-kind">Oral session</div></div><div><div class="agenda-title">${esc(event.primary.room)} <span class="confidence ${event.confidence}">${event.confidence}</span> ${event.conflict ? '<span class="conflict-badge">overlaps poster block</span>' : ""}</div><div class="agenda-sub">Backup: ${esc(event.backup?.room || "None")} · ${event.primary.papers.length} talks in recommended room</div><div class="recommendation-reason">Why: ${esc(recommendationReason(reasonPaper))}</div><div class="agenda-paper-list">${event.primary.papers.slice(0, 3).map(agendaPaperHtml).join("")}</div></div><div class="agenda-item-actions"><button class="btn secondary compact-action" data-focus-kind="oral" data-focus-key="${esc(event.key)}">${event.confidence === "unresolved" ? "Resolve choice" : "Refine"}</button>${planButton(reasonPaper.id)}</div></article>`;
    }
    return `<article class="agenda-item"><div><div class="agenda-time">${esc(event.time)}</div><div class="agenda-kind">Posters</div></div><div><div class="agenda-title">${event.must.length} must-visit posters <span class="confidence ${event.confidence}">${event.confidence}</span> ${event.conflict ? '<span class="conflict-badge">overlaps oral session</span>' : ""}</div><div class="agenda-sub">Target: ${event.target} visits. Favorites and explicitly planned papers stay at the top.</div><div class="agenda-paper-list">${event.must.map(({ paper }) => agendaPaperHtml(paper)).join("")}</div></div><div class="agenda-item-actions"><button class="btn secondary compact-action" data-focus-kind="poster" data-focus-key="${esc(event.key)}">${event.confidence === "unresolved" ? "Resolve cutoff" : "Refine"}</button></div></article>`;
  }).join("")}</details>`).join("");
}

function calendarTimestamp(dateText, timeText, end = false) {
  const year = String(config.guide?.conference_dates || "").match(/20\d{2}/)?.[0] || String(new Date().getFullYear());
  const date = new Date(`${dateText} ${year} 12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const times = String(timeText || "").split(/[–—-]/).map((value) => value.trim());
  const time = times[end ? 1 : 0] || times[0]; const match = time.match(/(\d{1,2}):(\d{2})/);
  const hour = match ? Number(match[1]) : end ? 10 : 9; const minute = match ? Number(match[2]) : 0;
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}T${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}00`;
}

function icsEscape(value) { return String(value || "").replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;"); }

function exportAgendaCalendar() {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Conference Paper Navigator//Personal Agenda//EN", "CALSCALE:GREGORIAN"];
  for (const event of agendaData()) {
    const start = calendarTimestamp(event.date, event.time, false); const end = calendarTimestamp(event.date, event.time, true);
    if (!start || !end) continue;
    const papersForEvent = event.kind === "oral" ? event.primary.papers.slice(0, 4) : event.must.map(({ paper }) => paper);
    const summary = event.kind === "oral" ? `${config.short_name}: ${event.primary.room}` : `${config.short_name}: must-visit posters`;
    const location = event.kind === "oral" ? event.primary.room : [...new Set(event.must.map(({ presentation }) => presentation.location).filter(Boolean))].join(", ");
    lines.push("BEGIN:VEVENT", `UID:${icsEscape(config.id)}-${icsEscape(event.kind)}-${start}@conference-paper-navigator`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${icsEscape(summary)}`, `LOCATION:${icsEscape(location)}`, `DESCRIPTION:${icsEscape(papersForEvent.map((paper) => paper.title).join("\n"))}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  download(`${config.id}-personal-agenda.ics`, `${lines.join("\r\n")}\r\n`, "text/calendar");
  showMessage("Exported your recommended agenda as an iCalendar file.");
}

function renderAll() {
  captureDisclosureState();
  renderStats(); renderOnboarding(); renderAgenda(); renderOverview(); renderSmartProgress(); renderLeaderboard(); renderOralSchedule(); renderPosters(); nextPair();
  restoreDisclosureState();
}

function fillSelect(id, label, values) {
  el(id).innerHTML = `<option value="">All ${label}</option>${[...values].filter(Boolean).sort().map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
}

function populateFilters() {
  const tracks = new Set(); const topics = new Set(); const days = new Set(); const locations = new Set();
  for (const paper of papers) {
    if (paper.track) tracks.add(paper.track);
    for (const value of [paper.primary_category, paper.secondary_category, ...(paper.keywords || [])]) if (value) topics.add(value);
    for (const presentation of paper.presentations || []) { if (presentation.date) days.add(presentation.date); if (presentation.location) locations.add(presentation.location); }
  }
  fillSelect("trackFilter", "tracks", tracks); fillSelect("categoryFilter", "topics", topics); fillSelect("dayFilter", "days", days); fillSelect("locationFilter", "locations", locations);
  el("trackFilter").hidden = tracks.size === 0;
}

function applyConfiguration() {
  document.title = `${config.name} · Conference Paper Navigator`;
  el("conferenceName").textContent = config.name;
  el("conferenceDescription").textContent = config.description;
  el("guideTitle").textContent = `${config.name} personal planning workspace`;
  el("guideMeta").textContent = `${config.guide?.conference_dates || ""} · ${config.location || ""}`;
  el("guideNotes").textContent = config.guide?.notes || "";
  el("presentationOrderControl").hidden = !config.features?.presentation_order;
  document.querySelector('[data-tab="schedule"]').hidden = !config.features?.oral_schedule;
  document.querySelector('[data-tab="posters"]').hidden = !config.features?.poster_schedule;
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}

function exportStateBackup() {
  const date = new Date().toISOString().slice(0, 10);
  download(`${config.id}-rankings-${date}.json`, JSON.stringify(createStateBackup(), null, 2), "application/json");
  showMessage(`Exported ${state.history.length} comparisons. Keep the JSON file as your ranking backup.`);
}

async function importStateBackup(file) {
  if (!file) return;
  const imported = parseStateBackup(JSON.parse(await file.text()));
  const rated = Object.values(imported.ratings).filter((rating) => Number(rating.n) > 0).length;
  const predicted = Object.keys(imported.priors).length;
  const favorites = selectedFavoriteIds(imported).length;
  const prompt = `Import ${imported.history.length} comparisons, ${rated} rated papers, ${predicted} predicted priors, and ${favorites} favorites for ${config.short_name}? This replaces the rankings currently stored in this browser.`;
  if (!confirm(prompt)) return;
  const importedIds = new Set(imported.history.map((entry) => entry.id));
  const replacedIds = state.history.map((entry) => entry.id).filter((id) => !importedIds.has(id));
  const inheritedTombstones = [...state.history_tombstones, ...replacedIds].filter((id) => !importedIds.has(id));
  const restoredAt = Date.now();
  state = rebuildRatings({
    ...imported,
    history: imported.history.map((entry, index) => ({ ...entry, ts: new Date(restoredAt + index).toISOString() })),
    history_tombstones: [...new Set([...imported.history_tombstones, ...inheritedTombstones])],
    reset_at: state.reset_at,
  });
  syncControls();
  persistState();
  rebuildFiltered();
  showMessage(`Imported ${state.history.length} comparisons, ${rated} rated papers, ${predicted} predicted priors, and ${favorites} favorites.`);
}

function exportCSV() {
  const ranked = papers.map(hydrate).sort(comparePapers); const rank = new Map(ranked.map((paper, index) => [paper.id, index + 1]));
  const headers = ["paper_id", "title", "authors", "track", "primary_category", "secondary_category", "presentations", "favorite", "personal_status", "personal_tags", "personal_notes", "recommendation_reason", "pref_mu", "pref_sigma", "model_confidence", "pref_rank", "n_matches", "wins", "losses", "ties"];
  const records = papers.map((paper) => {
    const hydrated = hydrate(paper);
    return { paper_id: paper.id, title: paper.title, authors: (paper.authors || []).join("; "), track: paper.track || "", primary_category: paper.primary_category || "", secondary_category: paper.secondary_category || "", presentations: (paper.presentations || []).map(presentationLabel).join(" | "), favorite: hydrated.favorite, personal_status: hydrated.plan.status, personal_tags: hydrated.plan.tags.join("; "), personal_notes: hydrated.plan.notes, recommendation_reason: recommendationReason(hydrated), pref_mu: hydrated.mu, pref_sigma: hydrated.sigma, model_confidence: hydrated.modelConfidence, pref_rank: rank.get(String(paper.id)), n_matches: hydrated.n, wins: hydrated.wins, losses: readRating(String(paper.id)).losses, ties: readRating(String(paper.id)).ties };
  });
  download(`${config.id}-scored.csv`, toCSV(headers, records), "text/csv");
}

function activateTab(tab, { updateUrl = true } = {}) {
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
  document.body.classList.toggle("viz-active", tab === "viz");
  if (tab === "viz") {
    notifyVisualization();
    el("vizFrame")?.contentWindow?.postMessage({ type: "viz_resize" }, window.location.origin);
  }
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url);
  }
}

function wireEvents() {
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.tab)));
  for (const id of ["search", "trackFilter", "categoryFilter", "dayFilter", "locationFilter", "hasWinsOnly", "favoritesOnly"]) el(id).addEventListener(id === "search" ? "input" : "change", rebuildFiltered);
  for (const id of ["mode", "resolveTieNMatches", "muPriority", "winsOnly", "topN", "posterTarget"]) el(id).addEventListener("change", () => {
    state[id] = ["topN", "posterTarget"].includes(id) ? Number(el(id).value) : id === "winsOnly" ? el(id).checked : el(id).value;
    if (id === "mode" && state.mode !== "smart") state.smartTarget = null;
    persistState(); rebuildFiltered();
  });
  document.addEventListener("click", (event) => {
    const favorite = event.target.closest("[data-favorite-id]");
    if (favorite) {
      event.preventDefault(); event.stopPropagation(); toggleFavorite(favorite.dataset.favoriteId); return;
    }
    const planner = event.target.closest("[data-plan-id]");
    if (planner) { event.preventDefault(); event.stopPropagation(); openPaperPlanner(planner.dataset.planId); return; }
    const topic = event.target.closest("[data-topic-interest]");
    if (topic) { event.preventDefault(); toggleTopicInterest(topic.dataset.topicInterest); return; }
    if (event.target.closest("[data-open-agenda]")) { event.preventDefault(); activateTab("agenda"); return; }
    if (event.target.closest("[data-continue-ranking]")) { event.preventDefault(); state.continueAfterReady = true; persistState(); rebuildFiltered(); return; }
    const focus = event.target.closest("[data-focus-kind]");
    if (focus) {
      event.preventDefault(); event.stopPropagation();
      state.mode = "smart";
      state.smartTarget = { kind: focus.dataset.focusKind, key: focus.dataset.focusKey };
      persistState(); syncControls(); rebuildFiltered(); activateTab("ranking");
      showMessage(`Smart ranking is now focused on ${focus.dataset.focusKey.replace("|||", " · ")}.`);
    }
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "viz_ready") {
      notifyVisualization({ force: true });
      return;
    }
    if (event.data?.type !== "favorite_update") return;
    if (event.data?.payload?.paperId) toggleFavorite(String(event.data.payload.paperId), Boolean(event.data.payload.selected));
  });
  el("scheduleByPresentationOrder").addEventListener("change", () => { state.scheduleByPresentationOrder = el("scheduleByPresentationOrder").checked; persistState(); renderOralSchedule(); });
  document.querySelectorAll("[data-vote]").forEach((button) => button.addEventListener("click", () => vote(button.dataset.vote)));
  el("btnUndo").addEventListener("click", undo);
  el("plannerSave").addEventListener("click", savePaperPlanner);
  el("btnExportCalendar").addEventListener("click", exportAgendaCalendar);
  el("btnPrintAgenda").addEventListener("click", () => { activateTab("agenda"); window.print(); });
  el("btnReset").addEventListener("click", () => {
    if (!confirm(`Fully reset ${config.short_name}? This clears comparisons, ratings, imported priors, favorites, topic interests, personal plans and notes, model predictions, and ranking settings for the current account and browser.`)) return;
    const resetAt = new Date().toISOString();
    const tombstones = [...new Set([...state.history_tombstones, ...state.history.map((entry) => entry.id)])];
    state = { ...defaultState(), history_tombstones: tombstones, reset_at: resetAt };
    syncControls(); persistState(); rebuildFiltered();
    showMessage(`Fully reset ${config.short_name}. Rankings, favorites, interests, agenda plans, and notes are now cleared.`);
  });
  el("btnExportState").addEventListener("click", exportStateBackup);
  el("btnExportCSV").addEventListener("click", exportCSV);
  el("stateFile").addEventListener("change", async (event) => {
    try {
      await importStateBackup(event.target.files?.[0]);
    } catch (error) {
      showError(`Could not import rankings: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  });
  el("datasetFile").addEventListener("change", async (event) => { try { const value = JSON.parse(await event.target.files[0].text()); if (value.conference_id !== config.id || !Array.isArray(value.papers)) throw new Error("Dataset conference or schema does not match."); dataset = value; papers = value.papers; populateFilters(); rebuildFiltered(); } catch (error) { showError(error.message); } });
}

function syncControls() {
  el("mode").value = state.mode; el("resolveTieNMatches").value = state.resolveTieNMatches; el("muPriority").value = state.muPriority;
  el("winsOnly").checked = state.winsOnly; el("topN").value = state.topN; el("posterTarget").value = state.posterTarget; el("scheduleByPresentationOrder").checked = state.scheduleByPresentationOrder;
}

function showMessage(message, kind = "success") {
  const output = el("errors");
  output.textContent = message;
  output.dataset.kind = kind;
}

function showError(message) { showMessage(message, "error"); }

function refreshStateUI() {
  syncControls();
  rebuildFiltered();
}

function stateHasRankings(value) {
  return Object.keys(value.priors).length > 0
    || value.history.length > 0
    || selectedFavoriteIds(value).length > 0
    || selectedTopicInterests(value).length > 0
    || Object.values(value.paperPlans || {}).some((plan) => plan.status || plan.notes || plan.tags?.length)
    || Object.values(value.ratings).some((rating) => Number(rating.n) > 0);
}

function changeCloudUser(user) {
  const previousUserId = activeUserId;
  const previousState = state;
  if (!user) {
    activeUserId = null;
    if (previousUserId) {
      // Keep the latest account state usable on this device after sign-out.
      state = normalizeState(previousState);
      localStorage.setItem(guestStateKey(), JSON.stringify(state));
      localStorage.setItem(guestOwnerKey(), previousUserId);
      notifyVisualization();
    } else {
      state = loadState();
    }
    refreshStateUI();
    return structuredClone(state);
  }

  const guestState = previousUserId ? loadStateFromKey(guestStateKey()) : previousState;
  const guestOwner = localStorage.getItem(guestOwnerKey());
  activeUserId = user.uid;
  if (localStorage.getItem(stateKey())) {
    const accountState = loadState();
    state = guestOwner === user.uid ? mergeStates(accountState, guestState) : accountState;
    persistState({ touch: false, sync: false });
  } else if (guestOwner === user.uid) {
    state = normalizeState(guestState);
    persistState({ touch: false, sync: false });
  } else if (!guestOwner && stateHasRankings(guestState) && confirm(`Import this browser's ${guestState.history.length} guest comparisons, ${Object.keys(guestState.priors).length} predicted priors, and ${selectedFavoriteIds(guestState).length} favorites into ${user.email || "your account"}?`)) {
    state = normalizeState(guestState);
    localStorage.setItem(guestOwnerKey(), user.uid);
    persistState({ touch: true, sync: false });
  } else {
    state = defaultState();
    persistState({ touch: false, sync: false });
  }
  refreshStateUI();
  return structuredClone(state);
}

function applyCloudState(value) {
  state = normalizeState(value);
  persistState({ touch: false, sync: false });
  refreshStateUI();
}

async function startCloudSync() {
  try {
    cloudSync = await initializeCloudSync({
      configUrl: "../firebase-config.json",
      conferenceId: config.id,
      signInButton: el("btnSignIn"),
      signOutButton: el("btnSignOut"),
      statusElement: el("cloudStatus"),
      getState: () => structuredClone(state),
      mergeStates,
      applyState: applyCloudState,
      onUserChanged: changeCloudUser,
      onError: showError,
    });
  } catch (error) {
    el("cloudStatus").textContent = "Cloud sync unavailable";
    showError(`Could not start cloud sync: ${error.message}`);
  }
}

async function initialize() {
  try {
    const [configResponse, dataResponse, preferenceResponse] = await Promise.all([fetch("./data/conference.json"), fetch("./data/papers.json"), fetch("./data/preference-features.json")]);
    if (!configResponse.ok || !dataResponse.ok || !preferenceResponse.ok) throw new Error("Could not load conference data or preference features.");
    config = await configResponse.json(); dataset = await dataResponse.json(); preferenceBundle = await preferenceResponse.json(); papers = dataset.papers || [];
    state = loadState(); applyConfiguration(); wireEvents(); syncControls(); populateFilters(); rebuildFiltered();
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab && document.querySelector(`[data-tab="${CSS.escape(requestedTab)}"]`)) activateTab(requestedTab, { updateUrl: false });
    await startCloudSync();
  } catch (error) { showError(error.message || String(error)); }
}

initialize();
