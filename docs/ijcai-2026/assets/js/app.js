import { toCSV } from "./csv.js";
import { DEFAULT_MU, DEFAULT_SIGMA, MIN_SIGMA, SIGMA_DECAY, updatePair } from "./rating.js";
import { chooseNextPair } from "./selector.js";
import { initializeCloudSync } from "./cloud-sync.js";
import { mergeComparisonData } from "./merge-comparisons.js";

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

const el = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

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
    ratings: {},
    history: [],
    history_tombstones: [],
    reset_at: "",
    modified_at: "",
    lastPair: [],
    mode: "active",
    topN: 60,
    resolveTieNMatches: "minimal",
    muPriority: "highest",
    winsOnly: false,
    scheduleByPresentationOrder: false,
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
  const modes = new Set(["active", "random", "bubble", "resolve_ties"]);
  const matchModes = new Set(["minimal", "random", "maximal"]);
  const priorities = new Set(["highest", "lowest", "random"]);
  const topN = Number(value.topN);
  return {
    ...defaults,
    ratings,
    history,
    history_tombstones: Array.isArray(value.history_tombstones) ? [...new Set(value.history_tombstones.map(String))].sort() : [],
    reset_at: typeof value.reset_at === "string" ? value.reset_at : "",
    modified_at: typeof value.modified_at === "string" ? value.modified_at : "",
    lastPair: Array.isArray(value.lastPair) ? value.lastPair.slice(0, 2) : [],
    mode: modes.has(value.mode) ? value.mode : defaults.mode,
    topN: Number.isInteger(topN) && topN >= 10 && topN <= 500 ? topN : defaults.topN,
    resolveTieNMatches: matchModes.has(value.resolveTieNMatches) ? value.resolveTieNMatches : defaults.resolveTieNMatches,
    muPriority: priorities.has(value.muPriority) ? value.muPriority : defaults.muPriority,
    winsOnly: Boolean(value.winsOnly),
    scheduleByPresentationOrder: Boolean(value.scheduleByPresentationOrder),
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

function notifyVisualization() {
  const frame = el("vizFrame");
  frame?.contentWindow?.postMessage(
    { type: "ranking_state_update", payload: { key: stateKey(), ratings: state.ratings } },
    window.location.origin,
  );
}

function persistState({ touch = true, sync = true } = {}) {
  if (touch) state.modified_at = new Date().toISOString();
  localStorage.setItem(stateKey(), JSON.stringify(state));
  notifyVisualization();
  if (sync) cloudSync?.scheduleSave(state);
}

function getRatingFrom(target, id) {
  if (!target.ratings[id]) {
    target.ratings[id] = { ...DEFAULT_RATING };
  }
  const rating = target.ratings[id];
  for (const [key, fallback] of Object.entries({ mu: DEFAULT_MU, sigma: DEFAULT_SIGMA, n: 0, wins: 0, losses: 0, ties: 0 })) {
    if (!Number.isFinite(Number(rating[key]))) rating[key] = fallback;
  }
  return rating;
}

function readRating(id) {
  return state.ratings[id] || DEFAULT_RATING;
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
  const rating = readRating(String(paper.id));
  const oral = firstPresentation(paper, "oral");
  const poster = firstPresentation(paper, "poster");
  const primary = primaryPresentation(paper);
  return {
    ...paper,
    id: String(paper.id),
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
  };
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
  const query = el("search").value.trim().toLowerCase();
  const track = el("trackFilter").value;
  const category = el("categoryFilter").value;
  const day = el("dayFilter").value;
  const location = el("locationFilter").value;
  const winsOnly = el("hasWinsOnly").checked;
  filtered = papers.map(hydrate).filter((paper) => {
    if (track && paper.track !== track) return false;
    const topics = [paper.cat1, paper.cat2, ...(paper.keywords || [])];
    if (category && !topics.includes(category)) return false;
    if (day && !(paper.presentations || []).some((item) => item.date === day)) return false;
    if (location && !(paper.presentations || []).some((item) => item.location === location)) return false;
    if (winsOnly && paper.wins < 1) return false;
    if (!query) return true;
    const schedule = (paper.presentations || []).flatMap((item) => Object.values(item));
    return [paper.id, paper.title, paper.abstract, paper.authorsText, paper.track, paper.cat1, paper.cat2, paper.keywordsText, ...schedule]
      .join(" ").toLowerCase().includes(query);
  });
  renderAll();
}

function renderStats() {
  el("stats").innerHTML = [
    ["Total", papers.length],
    ["Filtered", filtered.length],
    ["Comparisons", state.history.length],
    ["Rated", Object.values(state.ratings).filter((rating) => Number(rating.n) > 0).length],
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
    if (!groups.has(day)) groups.set(day, new Map());
    if (!groups.get(day).has(session)) groups.get(day).set(session, new Map());
    if (!groups.get(day).get(session).has(location)) groups.get(day).get(session).set(location, []);
    groups.get(day).get(session).get(location).push(paper);
  }
  root.innerHTML = [...groups.keys()].sort((a, b) => dateSort(a) - dateSort(b)).map((day) => {
    const sessions = groups.get(day);
    const sessionHtml = [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([session, locations]) => {
      const locationHtml = [...locations.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([location, items]) => `
        <details class="overview-location" open><summary>${esc(location)} <span class="small">(${items.length})</span></summary>
          ${items.sort(comparePapers).map(paperHtml).join("")}
        </details>`).join("");
      return `<details class="overview-session" open><summary>${esc(session)}</summary><div class="overview-content">${locationHtml}</div></details>`;
    }).join("");
    return `<details class="overview-date" open><summary>${esc(day)}</summary><div class="overview-content">${sessionHtml}</div></details>`;
  }).join("");
}

function paperHtml(paper) {
  const badges = (paper.presentations || []).map((item) => `<span class="chip">${esc(presentationLabel(item))}</span>`).join("");
  return `<article class="paper">
    <div class="top">${esc(paper.title)}</div>
    <div class="meta"><span>${esc(paper.id)}</span><span>${esc(paper.authorsText || "Authors unavailable")}</span><span>${esc(paper.track || paper.cat1 || "Uncategorized")}</span><span>μ ${paper.mu.toFixed(1)}</span></div>
    <div class="schedule-badges">${badges || '<span class="chip">Schedule unavailable</span>'}</div>
    <details class="abs"><summary>Abstract</summary><div>${esc(paper.abstract || "Abstract unavailable")}</div></details>
  </article>`;
}

function renderCard(paper, label) {
  if (!paper) return "";
  return `<div class="head"><strong>${label}: ${esc(paper.title)}</strong><div class="k">${esc(paper.id)} · ${esc(paper.track || paper.cat1 || "Uncategorized")} · μ ${paper.mu.toFixed(1)} · σ ${paper.sigma.toFixed(1)} · n ${paper.n}</div></div>
    <div class="body"><div class="small">${esc(paper.authorsText)}</div><p>${esc(paper.abstract || "Abstract unavailable")}</p><div class="schedule-badges">${(paper.presentations || []).map((item) => `<span class="chip">${esc(presentationLabel(item))}</span>`).join("")}</div></div>`;
}

function nextPair() {
  const pair = chooseNextPair(filtered, state);
  const arena = el("arena");
  if (!pair) {
    currentPair = null;
    arena.hidden = true;
    return;
  }
  currentPair = { A: pair[0], B: pair[1] };
  state.lastPair = [{ id: pair[0].id }, { id: pair[1].id }];
  arena.hidden = false;
  el("cardA").innerHTML = renderCard(pair[0], "A");
  el("cardB").innerHTML = renderCard(pair[1], "B");
}

function applyCounters(a, b, outcome) {
  if (outcome === 1) { a.wins += 1; b.losses += 1; }
  else if (outcome === 0) { b.wins += 1; a.losses += 1; }
  else { a.ties += 1; b.ties += 1; }
}

function applyJoint(rating, direction, multiplier) {
  rating.mu += direction * BASE_K * JOINT_FEEDBACK_SCALE * multiplier;
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
  return rebuildRatings({
    ...(merged.localIsNewer ? local : remote),
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
    <div class="lb-row"><div class="lb-top"><div class="lb-title">#${index + 1} — ${esc(paper.title)}</div><div class="small">μ ${paper.mu.toFixed(1)} · σ ${paper.sigma.toFixed(1)} · n ${paper.n}</div></div>
    <div class="lb-sub">${esc(paper.id)} · ${esc(paper.track || paper.cat1 || "Uncategorized")} · ${esc(presentationLabel(paper.oral || paper.poster))}</div></div>`).join("");
}

function normalized(values, value) {
  const low = Math.min(...values); const high = Math.max(...values);
  return high - low < 1e-9 ? 0.5 : (value - low) / (high - low);
}

function renderOralSchedule() {
  const root = el("schedule");
  const records = filtered.flatMap((paper) => presentationsOf(paper, "oral").map((presentation) => ({ paper, presentation })));
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
        return { room, papers: ranked, max: ranked[0]?.mu ?? DEFAULT_MU, mean: ranked.reduce((sum, paper) => sum + paper.mu, 0) / ranked.length };
      });
      const maxValues = blocks.map((block) => block.max); const means = blocks.map((block) => block.mean);
      blocks.forEach((block) => { block.score = 0.65 * normalized(maxValues, block.max) + 0.35 * normalized(means, block.mean); });
      blocks.sort((a, b) => b.score - a.score);
      const rows = blocks.map((block, index) => `<tr><td>${index === 0 ? "Primary" : index === 1 ? "Backup" : index + 1}</td><td>${esc(block.room)}</td><td>${block.score.toFixed(3)}</td><td>${block.max.toFixed(1)}</td><td>${block.mean.toFixed(1)}</td><td>${block.papers.slice(0, 4).map((paper) => esc(paper.title)).join(" · ")}</td></tr>`).join("");
      return `<details class="schedule-slot" open><summary class="schedule-slot-title">${esc(slot.time)}</summary><table class="schedule-table"><thead><tr><th>Pick</th><th>Room</th><th>Score</th><th>Max μ</th><th>Mean μ</th><th>Top papers</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    }).join("");
    return `<details class="schedule-day" open><summary class="schedule-day-head">${esc(day)}</summary>${slotHtml}</details>`;
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
    return `<tr><td>${esc(group.date)}</td><td>${esc(group.time)}</td><td>${esc(group.order)}</td><td>${esc(best?.title || "—")}</td><td>${esc(best?.oral?.location || "—")}</td><td>${esc(backup?.title || "—")}</td></tr>`;
  }).join("");
  el("schedule").innerHTML = rows ? `<table class="schedule-table"><thead><tr><th>Day</th><th>Block</th><th>Order</th><th>Top talk</th><th>Room</th><th>Backup</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="small">No presentation-order data is available.</div>';
}

function renderPosters() {
  const root = el("posters");
  const records = filtered.flatMap((paper) => [
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
      const rows = items.map(({ paper, presentation }) => `<tr><td>${rank.get(paper.id) || "—"}</td><td>${esc(paper.id)}</td><td>${esc(paper.title)}</td><td>${esc(paper.track || paper.cat1 || "—")}</td><td>${esc(presentation.location || "—")}</td><td>${paper.mu.toFixed(1)}</td></tr>`).join("");
      return `<details class="poster-slot" open><summary class="poster-slot-head">${esc(time)} <span class="small">(${items.length})</span></summary><table class="poster-table"><thead><tr><th>Rank</th><th>ID</th><th>Title</th><th>Track/topic</th><th>Location</th><th>μ</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    }).join("");
    return `<details class="poster-day" open><summary class="poster-day-head">${esc(day)}</summary>${blocks}</details>`;
  }).join("");
}

function renderAll() {
  renderStats(); renderOverview(); renderLeaderboard(); renderOralSchedule(); renderPosters(); nextPair();
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
  const prompt = `Import ${imported.history.length} comparisons and ${rated} rated papers for ${config.short_name}? This replaces the rankings currently stored in this browser.`;
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
  showMessage(`Imported ${state.history.length} comparisons and ${rated} rated papers.`);
}

function exportCSV() {
  const ranked = papers.map(hydrate).sort(comparePapers); const rank = new Map(ranked.map((paper, index) => [paper.id, index + 1]));
  const headers = ["paper_id", "title", "authors", "track", "primary_category", "secondary_category", "presentations", "pref_mu", "pref_sigma", "pref_rank", "n_matches", "wins", "losses", "ties"];
  const records = papers.map((paper) => {
    const rating = readRating(String(paper.id));
    return { paper_id: paper.id, title: paper.title, authors: (paper.authors || []).join("; "), track: paper.track || "", primary_category: paper.primary_category || "", secondary_category: paper.secondary_category || "", presentations: (paper.presentations || []).map(presentationLabel).join(" | "), pref_mu: rating.mu, pref_sigma: rating.sigma, pref_rank: rank.get(String(paper.id)), n_matches: rating.n, wins: rating.wins, losses: rating.losses, ties: rating.ties };
  });
  download(`${config.id}-scored.csv`, toCSV(headers, records), "text/csv");
}

function activateTab(tab) {
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
  if (tab === "viz") {
    notifyVisualization();
    el("vizFrame")?.contentWindow?.postMessage({ type: "viz_resize" }, window.location.origin);
  }
}

function wireEvents() {
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.tab)));
  for (const id of ["search", "trackFilter", "categoryFilter", "dayFilter", "locationFilter", "hasWinsOnly"]) el(id).addEventListener(id === "search" ? "input" : "change", rebuildFiltered);
  for (const id of ["mode", "resolveTieNMatches", "muPriority", "winsOnly", "topN"]) el(id).addEventListener("change", () => {
    state[id] = id === "topN" ? Number(el(id).value) : id === "winsOnly" ? el(id).checked : el(id).value;
    persistState(); rebuildFiltered();
  });
  el("scheduleByPresentationOrder").addEventListener("change", () => { state.scheduleByPresentationOrder = el("scheduleByPresentationOrder").checked; persistState(); renderOralSchedule(); });
  document.querySelectorAll("[data-vote]").forEach((button) => button.addEventListener("click", () => vote(button.dataset.vote)));
  el("btnUndo").addEventListener("click", undo);
  el("btnReset").addEventListener("click", () => {
    if (!confirm(`Reset all ${config.short_name} ratings and history?`)) return;
    const resetAt = new Date().toISOString();
    const tombstones = [...new Set([...state.history_tombstones, ...state.history.map((entry) => entry.id)])];
    state = { ...defaultState(), history_tombstones: tombstones, reset_at: resetAt };
    syncControls(); persistState(); rebuildFiltered();
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
  el("winsOnly").checked = state.winsOnly; el("topN").value = state.topN; el("scheduleByPresentationOrder").checked = state.scheduleByPresentationOrder;
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
  return value.history.length > 0 || Object.values(value.ratings).some((rating) => Number(rating.n) > 0);
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
  } else if (!guestOwner && stateHasRankings(guestState) && confirm(`Import this browser's ${guestState.history.length} guest comparisons into ${user.email || "your account"}?`)) {
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
    const [configResponse, dataResponse] = await Promise.all([fetch("./data/conference.json"), fetch("./data/papers.json")]);
    if (!configResponse.ok || !dataResponse.ok) throw new Error("Could not load conference data.");
    config = await configResponse.json(); dataset = await dataResponse.json(); papers = dataset.papers || [];
    state = loadState(); applyConfiguration(); wireEvents(); syncControls(); populateFilters(); rebuildFiltered();
    await startCloudSync();
  } catch (error) { showError(error.message || String(error)); }
}

initialize();
