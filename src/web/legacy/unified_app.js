import { parseCSV, toCSV, detectColumns } from "./csv.js";
import { DEFAULT_MU, DEFAULT_SIGMA, MIN_SIGMA, SIGMA_DECAY, updatePair } from "./rating.js";
import { chooseNextPair } from "./selector.js";
import { saveState, loadState, clearState } from "./storage.js";

const AUTO_FILENAME = "./data/EACL_2026_program_categorized.csv";
const BASE_K = 32;
const JOINT_FEEDBACK_SCALE = 0.45;
const RANKING_STORAGE_KEY = "eacl_pref_arena_state_v1";

let RAW_HEADERS = [];
let RAW_RECORDS = [];
let COL = null;
let filtered = [];
let currentPair = null;
let scheduleRenderSeq = 0;

const state = normalizeState(loadState()) ?? getDefaultState();

function getDefaultState() {
  return {
    version: 2,
    ratings: {},
    history: [],
    lastPair: [],
    mode: "active",
    topN: 60,
    resolveTieNMatches: "minimal",
    muPriority: "highest",
    winsOnly: false,
    scheduleByPresentationOrder: false,
  };
}

function normalizeHistoryEntry(h) {
  if (!h || typeof h !== "object") return null;
  if ((h.outcome !== null && h.outcome !== undefined) && (!h.a || !h.b)) return null;
  const outcome = (typeof h.outcome === "number") ? h.outcome : null;
  let choice = typeof h.choice === "string" ? h.choice : null;
  let kMult = (typeof h.kMult === "number") ? h.kMult : null;
  let neitherPenaltyApplied = Boolean(h.neitherPenaltyApplied);

  if (!choice) {
    if (outcome === 1.0) choice = "A";
    else if (outcome === 0.0) choice = "B";
    else if (outcome === 0.5) choice = "BOTH";
    else choice = "SKIP";
  }
  if (kMult === null) {
    if (outcome === 1.0 || outcome === 0.0) kMult = 1.0;
    else if (outcome === 0.5) kMult = 0.75;
    else kMult = 0.0;
  }
  if (choice === "NEITHER") neitherPenaltyApplied = true;

  return {
    a: h.a,
    b: h.b,
    outcome,
    choice,
    kMult,
    neitherPenaltyApplied,
    ts: h.ts ?? new Date().toISOString(),
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || !raw.ratings) return null;
  return {
    ...getDefaultState(),
    ...raw,
    version: 2,
    history: Array.isArray(raw.history) ? raw.history.map(normalizeHistoryEntry).filter(Boolean) : [],
  };
}

function el(id) {
  return document.getElementById(id);
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clearError() {
  el("errors").innerHTML = "";
}

function error(msg) {
  el("errors").innerHTML = `<div>${esc(msg)}</div>`;
}

async function apiJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function notifyVizRatings() {
  const frame = el("vizFrame");
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage(
    {
      type: "ranking_state_update",
      payload: {
        key: RANKING_STORAGE_KEY,
        ratings: state.ratings,
      },
    },
    window.location.origin
  );
}

function notifyVizResize() {
  const frame = el("vizFrame");
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage({ type: "viz_resize" }, window.location.origin);
}

function persistState() {
  saveState(state);
  notifyVizRatings();
}

function activateTab(tab) {
  document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
  if (tab === "viz") {
    notifyVizResize();
    setTimeout(notifyVizResize, 120);
    setTimeout(notifyVizResize, 320);
  }
}

function getRating(id) {
  if (!state.ratings[id]) {
    state.ratings[id] = { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA, n: 0, wins: 0, losses: 0, ties: 0 };
  } else {
    const r = state.ratings[id];
    if (typeof r.wins !== "number") r.wins = 0;
    if (typeof r.losses !== "number") r.losses = 0;
    if (typeof r.ties !== "number") r.ties = 0;
    if (typeof r.n !== "number") r.n = 0;
    if (typeof r.mu !== "number") r.mu = DEFAULT_MU;
    if (typeof r.sigma !== "number") r.sigma = DEFAULT_SIGMA;
  }
  return state.ratings[id];
}

function averageMu(items) {
  if (!items.length) return DEFAULT_MU;
  return items.reduce((sum, it) => sum + Number(it.mu || DEFAULT_MU), 0) / items.length;
}

function buildRankById() {
  const all = RAW_RECORDS.map(hydrateItem).sort((a, b) => b.mu - a.mu);
  return new Map(all.map((it, idx) => [it.id, idx + 1]));
}

function formatOrderText(orderText) {
  const text = String(orderText ?? "").trim();
  if (!text) return "";
  const parsed = parseOrderValue(text);
  if (parsed == null) return text;
  return String(Math.trunc(parsed));
}

function resolveOrderText(rec) {
  const raw = (COL.order ? rec[COL.order] : undefined) ?? rec.Order ?? rec.order ?? rec["Presentation Order"] ?? rec.presentation_order;
  return formatOrderText(raw);
}

function hydrateItem(rec) {
  const id = String(rec[COL.id] ?? "").trim();
  const r = getRating(id);
  const order = resolveOrderText(rec);
  return {
    id,
    title: String(rec[COL.title] ?? ""),
    abstract: String(rec[COL.abstract] ?? ""),
    authors: COL.authors ? String(rec[COL.authors] ?? "") : "",
    presenter: COL.presenter ? String(rec[COL.presenter] ?? "") : "",
    session: COL.session ? String(rec[COL.session] ?? "") : "",
    location: COL.location ? String(rec[COL.location] ?? "") : "",
    date: COL.date ? String(rec[COL.date] ?? "") : "",
    time: COL.time ? String(rec[COL.time] ?? "") : "",
    order,
    orderNum: parseOrderValue(order),
    cat1: COL.cat1 ? String(rec[COL.cat1] ?? "") : "",
    cat2: COL.cat2 ? String(rec[COL.cat2] ?? "") : "",
    keywords: COL.keywords ? String(rec[COL.keywords] ?? "") : "",
    type: String(rec["Type of Presentation"] ?? rec["type_presentation"] ?? ""),
    attendanceType: String(rec["Attendance Type"] ?? rec["attendance_type"] ?? ""),
    mu: r.mu,
    sigma: r.sigma,
    n: r.n,
    wins: r.wins,
  };
}

function rebuildFiltered() {
  const q = el("search").value.trim().toLowerCase();
  const cat = el("categoryFilter").value;
  const ses = el("sessionFilter").value;
  const loc = el("locationFilter").value;
  const hasWinsOnly = !!el("hasWinsOnly")?.checked;
  const oralOnlyByLocation = loc === "__oral_only__";
  const oralOnlyWithoutChellahByLocation = loc === "__oral_only_no_chellah__";

  filtered = RAW_RECORDS.map(hydrateItem).filter((it) => {
    if (!it.id) return false;
    if (cat && it.cat1 !== cat && it.cat2 !== cat) return false;
    if (ses && it.session !== ses) return false;
    if (oralOnlyByLocation || oralOnlyWithoutChellahByLocation) {
      const isOral = /\boral\b/i.test(String(it.type ?? ""));
      const isInPerson = String(it.attendanceType ?? "").trim().toLowerCase() === "in-person";
      const locationNorm = String(it.location ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      const isLeChellah = locationNorm === "salle le chellah";
      if (!(isOral && isInPerson)) return false;
      if (oralOnlyWithoutChellahByLocation && isLeChellah) return false;
    } else if (loc && it.location !== loc) {
      return false;
    }
    if (hasWinsOnly && Number(it.wins || 0) < 1) return false;
    if (!q) return true;
    const blob = [it.id, it.title, it.abstract, it.authors, it.presenter, it.keywords, it.cat1, it.cat2, it.session, it.location, it.date, it.time].join(" ").toLowerCase();
    return blob.includes(q);
  });

  renderStats();
  renderOverview();
  renderLeaderboard();
  void renderSchedule();
  renderPosters();
  nextPair();
}

function isPosterHallLocation(location) {
  return /\bposter\s*hall\b/i.test(String(location || ""));
}

function isPosterItem(item) {
  const typeLooksPoster = /\bposter\b/i.test(String(item?.type || ""));
  return isPosterHallLocation(item?.location) || typeLooksPoster;
}

function isOralPresentationItem(item) {
  const typeLooksOral = /\boral\b/i.test(String(item?.type || ""));
  const inPerson = String(item?.attendanceType || "").trim().toLowerCase() === "in-person";
  return typeLooksOral && inPerson && !isPosterHallLocation(item?.location);
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseStartMinutes(timeText) {
  const text = String(timeText || "");
  const match = text.match(/(\d{1,2}):(\d{2})/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const hour = safeNumber(match[1], 99);
  const minute = safeNumber(match[2], 99);
  return hour * 60 + minute;
}

function parseOrderValue(orderText) {
  const text = String(orderText || "").trim();
  if (!text) return null;
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;
  const match = text.match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateSortValue(dateText) {
  const text = String(dateText || "").trim();
  if (!text) return Number.MAX_SAFE_INTEGER;

  const monthMap = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };

  const monthDayMatch = text.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})/i);
  if (monthDayMatch) {
    const month = monthMap[monthDayMatch[1].toLowerCase()] || 99;
    const day = safeNumber(monthDayMatch[2], 99);
    return month * 100 + day;
  }

  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed;

  return Number.MAX_SAFE_INTEGER;
}

function normalizeInGroup(values, value) {
  if (!values.length) return 0.0;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const span = maxVal - minVal;
  if (span < 1e-9) return 0.5;
  return (value - minVal) / span;
}

function tokenizeForTopic(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function buildPreferenceTokenWeights(items) {
  const withSignal = items.filter((it) => safeNumber(it.wins, 0) > 0 || safeNumber(it.n, 0) > 0);
  const source = withSignal.length > 0 ? withSignal : items;
  const ranked = source
    .slice()
    .sort((a, b) => safeNumber(b.mu, DEFAULT_MU) - safeNumber(a.mu, DEFAULT_MU))
    .slice(0, 80);

  const weights = new Map();
  ranked.forEach((it, idx) => {
    const recencyBoost = Math.max(0.2, 1 - idx / 100);
    const prefBoost = Math.max(0, safeNumber(it.mu, DEFAULT_MU) - DEFAULT_MU) / 120;
    const baseWeight = 1 + prefBoost;
    const combinedWeight = baseWeight * recencyBoost;
    const text = `${it.title || ""} ${it.keywords || ""} ${it.cat1 || ""} ${it.cat2 || ""}`;
    tokenizeForTopic(text).forEach((tok) => {
      weights.set(tok, (weights.get(tok) || 0) + combinedWeight);
    });
  });

  return weights;
}

function lexicalPaperTopicScore(item, prefWeights) {
  const text = `${item.title || ""} ${item.keywords || ""} ${item.cat1 || ""} ${item.cat2 || ""}`;
  const tokens = tokenizeForTopic(text);
  if (!tokens.length || prefWeights.size === 0) return 0;

  let matchedWeight = 0;
  tokens.forEach((tok) => {
    matchedWeight += prefWeights.get(tok) || 0;
  });
  const normalized = matchedWeight / Math.max(1, tokens.length);
  return normalized;
}

function buildLexicalTopicMatchByBlock(blocks, allItems) {
  const prefWeights = buildPreferenceTokenWeights(allItems);
  if (prefWeights.size === 0) return new Map();

  const rawScores = new Map();
  blocks.forEach((block) => {
    const paperScores = block.papers
      .map((p) => lexicalPaperTopicScore(p, prefWeights))
      .sort((a, b) => b - a);
    const k = Math.min(2, paperScores.length);
    const score = k > 0 ? paperScores.slice(0, k).reduce((s, v) => s + v, 0) / k : 0;
    rawScores.set(block.key, score);
  });

  const values = [...rawScores.values()];
  const minVal = values.length ? Math.min(...values) : 0;
  const maxVal = values.length ? Math.max(...values) : 0;
  const span = maxVal - minVal;

  const normalized = new Map();
  rawScores.forEach((value, key) => {
    if (span < 1e-9) {
      normalized.set(key, value > 0 ? 0.5 : 0);
    } else {
      normalized.set(key, (value - minVal) / span);
    }
  });
  return normalized;
}

function buildScheduleBlocks(items) {
  const blocksByKey = new Map();

  items.forEach((it) => {
    const date = String(it.date || "(No date)");
    const time = String(it.time || "(No time)");
    const room = String(it.location || "(No location)");
    const key = `${date}|||${time}|||${room}`;
    if (!blocksByKey.has(key)) {
      blocksByKey.set(key, {
        key,
        date,
        time,
        room,
        papers: [],
      });
    }
    blocksByKey.get(key).papers.push(it);
  });

  return [...blocksByKey.values()];
}

function compareItemsByPreference(a, b) {
  const muDiff = safeNumber(b.mu, DEFAULT_MU) - safeNumber(a.mu, DEFAULT_MU);
  if (Math.abs(muDiff) > 1e-9) return muDiff;
  const winsDiff = safeNumber(b.wins, 0) - safeNumber(a.wins, 0);
  if (winsDiff !== 0) return winsDiff;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function buildPresentationScheduleSlots(items) {
  const slotsByKey = new Map();

  items.forEach((it) => {
    if (it.orderNum == null) return;
    const date = String(it.date || "(No date)");
    const time = String(it.time || "(No time)");
    const slotKey = `${date}|||${time}`;

    if (!slotsByKey.has(slotKey)) {
      slotsByKey.set(slotKey, { date, time, orders: new Map() });
    }

    const slot = slotsByKey.get(slotKey);
    const orderLabel = formatOrderText(it.order || it.orderNum);
    const orderKey = `${String(it.orderNum).padStart(3, "0")}|||${orderLabel}`;
    if (!slot.orders.has(orderKey)) {
      slot.orders.set(orderKey, {
        orderLabel,
        orderSort: safeNumber(it.orderNum, Number.MAX_SAFE_INTEGER),
        papers: [],
      });
    }
    slot.orders.get(orderKey).papers.push(it);
  });

  return [...slotsByKey.values()].map((slot) => ({
    date: slot.date,
    time: slot.time,
    orders: [...slot.orders.values()].sort((a, b) => {
      if (a.orderSort !== b.orderSort) return a.orderSort - b.orderSort;
      return String(a.orderLabel).localeCompare(String(b.orderLabel));
    }),
  }));
}

function renderPresentationScheduleHtml(slots) {
  const byDate = new Map();
  slots.forEach((slot) => {
    if (!byDate.has(slot.date)) byDate.set(slot.date, []);
    byDate.get(slot.date).push(slot);
  });

  const dayKeys = [...byDate.keys()].sort((a, b) => {
    const da = parseDateSortValue(a);
    const db = parseDateSortValue(b);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  return dayKeys
    .map((day) => {
      const daySlots = byDate.get(day).slice().sort((a, b) => {
        const minuteCmp = parseStartMinutes(a.time) - parseStartMinutes(b.time);
        if (minuteCmp !== 0) return minuteCmp;
        return String(a.time).localeCompare(String(b.time));
      });

      const slotsHtml = daySlots
        .map((slot) => {
          const rows = slot.orders
            .map((group) => {
              const ranked = group.papers.slice().sort(compareItemsByPreference);
              const primary = ranked[0] || null;
              const backup = ranked[1] || null;
              return `
                <tr>
                  <td>${esc(group.orderLabel)}</td>
                  <td>${esc(primary?.title || primary?.id || "—")}</td>
                  <td>${esc(primary?.session || "—")}</td>
                  <td>${esc(primary?.location || "—")}</td>
                  <td>${primary ? safeNumber(primary.mu, DEFAULT_MU).toFixed(1) : "—"}</td>
                  <td>${primary ? safeNumber(primary.wins, 0) : "—"}</td>
                  <td>${esc(backup?.title || backup?.id || "—")}</td>
                  <td>${esc(backup?.location || "—")}</td>
                   <td>${backup ? safeNumber(backup.mu, DEFAULT_MU).toFixed(1) : "—"}</td>
                   <td>${backup ? safeNumber(backup.wins, 0) : "—"}</td>
                </tr>
              `;
            })
            .join("");

          return `
            <details class="schedule-slot" open>
              <summary class="schedule-slot-title">${esc(slot.time)}</summary>
              <div class="small">Top-rated presentation for each within-session order.</div>
              <table class="schedule-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Top presentation</th>
                    <th>Session</th>
                    <th>Room</th>
                    <th>μ</th>
                    <th>Wins</th>
                    <th>Backup presentation</th>
                    <th>Backup room</th>
                    <th>Backup μ</th>
                    <th>Backup Wins</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </details>
          `;
        })
        .join("");

      return `
        <details class="schedule-day" open>
          <summary class="schedule-day-head">${esc(day)}</summary>
          ${slotsHtml}
        </details>
      `;
    })
    .join("");
}

async function fetchTopicMatches(blocks) {
  if (!blocks.length) return new Map();

  const slots = blocks.map((b) => ({
    slot_key: b.key,
    paper_ids: b.papers.map((p) => p.id),
  }));

  try {
    const response = await apiJson("/api/topic_match", {
      ratings: state.ratings,
      slots,
      top_k: 2,
    });
    const byKey = new Map();
    (response.results || []).forEach((r) => {
      byKey.set(String(r.slot_key || ""), safeNumber(r.topic_match, 0));
    });
    return byKey;
  } catch {
    return new Map();
  }
}

function renderScheduleEmpty(message) {
  const root = el("schedule");
  if (!root) return;
  root.innerHTML = `<div class="small">${esc(message)}</div>`;
}

async function renderSchedule() {
  const root = el("schedule");
  if (!root) return;
  const scheduleByPresentationOrder = !!el("scheduleByPresentationOrder")?.checked;

  const oralItems = filtered.filter((it) => isOralPresentationItem(it));

  if (oralItems.length === 0) {
    renderScheduleEmpty("No oral-schedule records available with the current filters.");
    return;
  }

  if (scheduleByPresentationOrder) {
    const orderedItems = oralItems.filter((it) => it.orderNum != null);
    if (orderedItems.length === 0) {
      state.scheduleByPresentationOrder = false;
      if (el("scheduleByPresentationOrder")) el("scheduleByPresentationOrder").checked = false;
      persistState();
      root.innerHTML = `<div class="small">No ordered oral-schedule records were found, so the schedule fell back to room-based recommendations.</div>`;
    } else {
      root.innerHTML = renderPresentationScheduleHtml(buildPresentationScheduleSlots(orderedItems));
      return;
    }
  }

  const runId = ++scheduleRenderSeq;
  root.innerHTML = `<div class="small">Computing slot recommendations...</div>`;

  const blocks = buildScheduleBlocks(oralItems);
  const topicMatchByBlock = await fetchTopicMatches(blocks);
  const lexicalTopicMatchByBlock = buildLexicalTopicMatchByBlock(blocks, oralItems);
  if (runId !== scheduleRenderSeq) return;

  const blocksBySlot = new Map();
  blocks.forEach((block) => {
    const maxMu = Math.max(...block.papers.map((p) => safeNumber(p.mu, DEFAULT_MU)));
    const meanMu = block.papers.reduce((sum, p) => sum + safeNumber(p.mu, DEFAULT_MU), 0) / Math.max(1, block.papers.length);
    const embeddingTopicMatch = safeNumber(topicMatchByBlock.get(block.key), 0);
    const lexicalTopicMatch = safeNumber(lexicalTopicMatchByBlock.get(block.key), 0);
    const topicMatch = embeddingTopicMatch > 0 ? embeddingTopicMatch : lexicalTopicMatch;

    const enriched = {
      ...block,
      maxMu,
      meanMu,
      topicMatch,
      score: 0,
      topPapers: block.papers
        .slice()
        .sort((a, b) => safeNumber(b.mu, DEFAULT_MU) - safeNumber(a.mu, DEFAULT_MU))
        .slice(0, 3),
    };

    const slotKey = `${block.date}|||${block.time}`;
    if (!blocksBySlot.has(slotKey)) {
      blocksBySlot.set(slotKey, { date: block.date, time: block.time, blocks: [] });
    }
    blocksBySlot.get(slotKey).blocks.push(enriched);
  });

  const slots = [...blocksBySlot.values()];
  slots.forEach((slot) => {
    const maxMuValues = slot.blocks.map((b) => b.maxMu);
    const meanMuValues = slot.blocks.map((b) => b.meanMu);
    const topicValues = slot.blocks.map((b) => b.topicMatch);

    slot.blocks.forEach((block) => {
      const maxMuNorm = normalizeInGroup(maxMuValues, block.maxMu);
      const meanMuNorm = normalizeInGroup(meanMuValues, block.meanMu);
      const topicNorm = normalizeInGroup(topicValues, block.topicMatch);
      block.score = 0.5 * maxMuNorm + 0.3 * meanMuNorm + 0.2 * topicNorm;
    });

    slot.blocks.sort((a, b) => b.score - a.score);
  });

  const byDate = new Map();
  slots.forEach((slot) => {
    if (!byDate.has(slot.date)) byDate.set(slot.date, []);
    byDate.get(slot.date).push(slot);
  });

  const dayKeys = [...byDate.keys()].sort((a, b) => {
    const da = parseDateSortValue(a);
    const db = parseDateSortValue(b);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  const html = dayKeys
    .map((day) => {
      const daySlots = byDate.get(day).slice().sort((a, b) => {
        const minuteCmp = parseStartMinutes(a.time) - parseStartMinutes(b.time);
        if (minuteCmp !== 0) return minuteCmp;
        return String(a.time).localeCompare(String(b.time));
      });

      const slotsHtml = daySlots
        .map((slot) => {
          const primary = slot.blocks[0];
          const backup = slot.blocks[1] || null;
          const primaryTopPaper = primary?.topPapers?.[0] || null;
          const backupTopPaper = backup?.topPapers?.[0] || null;
          const rows = slot.blocks
            .map((block, index) => {
              const topTitles = block.topPapers.map((p) => esc(p.title || p.id)).join(" · ");
              return `
                <tr>
                  <td>${index === 0 ? "Primary" : index === 1 ? "Backup" : `${index + 1}`}</td>
                  <td>${esc(block.room)}</td>
                  <td>${block.score.toFixed(3)}</td>
                  <td>${block.maxMu.toFixed(1)}</td>
                  <td>${block.meanMu.toFixed(1)}</td>
                  <td>${block.topicMatch.toFixed(3)}</td>
                  <td>${esc(topTitles || "—")}</td>
                </tr>
              `;
            })
            .join("");

          return `
            <details class="schedule-slot" open>
              <summary class="schedule-slot-title">${esc(slot.time)}</summary>
              <div class="schedule-picks">
                <div class="schedule-pick">
                  <div class="label">Primary room</div>
                  <div class="room">${esc(primary?.room || "—")}</div>
                  <div class="meta">Score ${primary ? primary.score.toFixed(3) : "—"} · topic ${primary ? primary.topicMatch.toFixed(3) : "—"} · μ ${primaryTopPaper ? safeNumber(primaryTopPaper.mu, DEFAULT_MU).toFixed(1) : "—"} · wins ${primaryTopPaper ? safeNumber(primaryTopPaper.wins, 0) : "—"}</div>
                </div>
                <div class="schedule-pick">
                  <div class="label">Backup room</div>
                  <div class="room">${esc(backup?.room || "—")}</div>
                  <div class="meta">Score ${backup ? backup.score.toFixed(3) : "—"} · topic ${backup ? backup.topicMatch.toFixed(3) : "—"} · μ ${backupTopPaper ? safeNumber(backupTopPaper.mu, DEFAULT_MU).toFixed(1) : "—"} · wins ${backupTopPaper ? safeNumber(backupTopPaper.wins, 0) : "—"}</div>
                </div>
              </div>
              <table class="schedule-table">
                <thead>
                  <tr>
                    <th>Pick</th>
                    <th>Room</th>
                    <th>Block score</th>
                    <th>Max μ</th>
                    <th>Mean μ</th>
                    <th>Topic match</th>
                    <th>Top papers in room</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </details>
          `;
        })
        .join("");

      return `
        <details class="schedule-day" open>
          <summary class="schedule-day-head">${esc(day)}</summary>
          ${slotsHtml}
        </details>
      `;
    })
    .join("");

  root.innerHTML = html;
}

function renderPosters() {
  const root = el("posters");
  if (!root) return;

  const posterItems = filtered.filter((it) => isPosterItem(it));
  if (posterItems.length === 0) {
    root.innerHTML = '<div class="small">No poster papers available with the current filters.</div>';
    return;
  }

  const rankById = buildRankById();
  const byDate = new Map();

  posterItems.forEach((it) => {
    const date = it.date || "(No date)";
    const time = it.time || "(No time)";
    if (!byDate.has(date)) byDate.set(date, new Map());
    const byTime = byDate.get(date);
    if (!byTime.has(time)) byTime.set(time, []);
    byTime.get(time).push(it);
  });

  const dateKeys = [...byDate.keys()].sort((a, b) => {
    const da = parseDateSortValue(a);
    const db = parseDateSortValue(b);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  const html = dateKeys
    .map((dateKey) => {
      const byTime = byDate.get(dateKey);
      const timeKeys = [...byTime.keys()].sort((a, b) => {
        const minuteCmp = parseStartMinutes(a) - parseStartMinutes(b);
        if (minuteCmp !== 0) return minuteCmp;
        return String(a).localeCompare(String(b));
      });

      const slotHtml = timeKeys
        .map((timeKey) => {
          const items = byTime.get(timeKey).slice().sort((a, b) => {
            const rankA = rankById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const rankB = rankById.get(b.id) ?? Number.MAX_SAFE_INTEGER;
            if (rankA !== rankB) return rankA - rankB;
            return a.id.localeCompare(b.id);
          });

          const rows = items
            .map((it) => {
              const rank = rankById.get(it.id) ?? "—";
              return `
                <tr>
                  <td>${rank}</td>
                  <td>${esc(it.id)}</td>
                  <td>${esc(it.title || "(No title)")}</td>
                  <td>${esc(it.session || "—")}</td>
                  <td>${esc(it.location || "—")}</td>
                  <td>${safeNumber(it.mu, DEFAULT_MU).toFixed(1)}</td>
                  <td>${safeNumber(it.wins, 0)}</td>
                </tr>
              `;
            })
            .join("");

          return `
            <details class="poster-slot" open>
              <summary class="poster-slot-head">${esc(timeKey)} <span class="small">(${items.length})</span></summary>
              <table class="poster-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Paper ID</th>
                    <th>Title</th>
                    <th>Session</th>
                    <th>Location</th>
                    <th>μ</th>
                    <th>Wins</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </details>
          `;
        })
        .join("");

      return `
        <details class="poster-day" open>
          <summary class="poster-day-head">${esc(dateKey)}</summary>
          ${slotHtml}
        </details>
      `;
    })
    .join("");

  root.innerHTML = html;
}

function renderStats() {
  el("stats").innerHTML = `
    <span class="pill">Total: <b>${RAW_RECORDS.length}</b></span>
    <span class="pill">Filtered: <b>${filtered.length}</b></span>
    <span class="pill">Comparisons: <b>${state.history.length}</b></span>
    <span class="pill">Rated papers: <b>${Object.values(state.ratings).filter((r) => r.n > 0).length}</b></span>
  `;
}

function renderOverview() {
  const root = el("overview");
  root.innerHTML = "";

  if (filtered.length === 0) {
    root.innerHTML = '<div class="small">No records to display.</div>';
    return;
  }

  const byDate = new Map();
  const rankById = buildRankById();
  filtered.forEach((it) => {
    const d = it.date || "(No date)";
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(it);
  });

  const dateKeys = [...byDate.keys()].sort((a, b) => {
    const da = parseDateSortValue(a);
    const db = parseDateSortValue(b);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  dateKeys.forEach((dKey) => {
    const dateItems = byDate.get(dKey) || [];
    const bySession = new Map();
    dateItems.forEach((it) => {
      const s = it.session || "(No session)";
      if (!bySession.has(s)) bySession.set(s, []);
      bySession.get(s).push(it);
    });

    const dateNode = document.createElement("details");
    dateNode.className = "overview-date";
    dateNode.open = true;
    dateNode.innerHTML = `<summary>${esc(dKey)} <span class="small">(${dateItems.length})</span></summary><div class="overview-content"></div>`;
    const dateBody = dateNode.querySelector(".overview-content");

    const sessionKeys = [...bySession.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    sessionKeys.forEach((sKey) => {
      const sessionItems = bySession.get(sKey) || [];
      const sessionAvg = averageMu(sessionItems);
      const timeValues = [...new Set(sessionItems.map((it) => String(it.time || "").trim()).filter(Boolean))]
        .sort((a, b) => {
          const ma = parseStartMinutes(a);
          const mb = parseStartMinutes(b);
          if (ma !== mb) return ma - mb;
          return a.localeCompare(b);
        });
      const timeText = timeValues.length ? timeValues.join(" · ") : "No time";

      const locMap = new Map();
      sessionItems.forEach((it) => {
        const l = it.location || "(No location)";
        if (!locMap.has(l)) locMap.set(l, []);
        locMap.get(l).push(it);
      });

      const session = document.createElement("details");
      session.className = "overview-session";
      session.open = true;
      session.innerHTML = `<summary>${esc(sKey)} <span class="small">(${sessionItems.length}) · ${esc(timeText)} · avg μ ${sessionAvg.toFixed(1)}</span></summary><div class="overview-content"></div>`;
      const body = session.querySelector(".overview-content");

      const locKeys = [...locMap.keys()].sort((a, b) => {
        const itemsA = locMap.get(a) || [];
        const itemsB = locMap.get(b) || [];
        const avgA = averageMu(itemsA);
        const avgB = averageMu(itemsB);
        const isPosterA = isPosterHallLocation(a);
        const isPosterB = isPosterHallLocation(b);

        if (isPosterA !== isPosterB) return isPosterA ? 1 : -1;
        if (avgA !== avgB) return avgB - avgA;
        return a.localeCompare(b);
      });
      locKeys.forEach((lKey) => {
        const items = [...locMap.get(lKey)].sort((a, b) => a.id.localeCompare(b.id));
        const locationAvg = averageMu(items);
        const loc = document.createElement("details");
        loc.className = "overview-location";
        loc.innerHTML = `<summary>${esc(lKey)} <span class="small">(${items.length}) · avg μ ${locationAvg.toFixed(1)}</span></summary>`;

        items.forEach((it) => {
          const rank = rankById.get(it.id) ?? "—";
          const card = document.createElement("div");
          card.className = "paper";
          card.innerHTML = `
            <div class="top">${esc(it.id)} — ${esc(it.title || "(No title)")}</div>
            <div class="meta">
              <span class="chip">Rank: ${rank}</span>
              <span class="chip">μ: ${Number(it.mu).toFixed(1)}</span>
              <span class="chip">σ: ${Number(it.sigma).toFixed(1)}</span>
              <span class="chip">Category: ${esc(it.cat1 || "—")}${it.cat2 ? ` / ${esc(it.cat2)}` : ""}</span>
              <span class="chip">Keywords: ${esc(it.keywords || "—")}</span>
            </div>
            <div class="small">${esc(it.authors || "")}</div>
            <details class="abs">
              <summary><b>Abstract</b></summary>
              <div>${esc(it.abstract || "(No abstract)")}</div>
            </details>
          `;
          loc.appendChild(card);
        });

        body.appendChild(loc);
      });

      dateBody.appendChild(session);
    });

    root.appendChild(dateNode);
  });
}

function renderCard(node, item, label) {
  node.innerHTML = `
    <div class="head" role="button" tabindex="0">
      <div><b>${label}</b> — ${esc(item.id)}</div>
      <div style="margin-top:6px;font-weight:900">${esc(item.title || "(No title)")}</div>
      <div class="k">μ=${item.mu.toFixed(1)} · σ=${item.sigma.toFixed(1)} · matches=${item.n}</div>
    </div>
    <div class="body">
      <div class="meta">
        <span class="chip">Session: ${esc(item.session || "—")}</span>
        <span class="chip">Location: ${esc(item.location || "—")}</span>
        <span class="chip">Category: ${esc(item.cat1 || "—")}${item.cat2 ? ` / ${esc(item.cat2)}` : ""}</span>
      </div>
      <div class="small" style="margin-top:10px">${esc(item.authors || "")}</div>
      <div style="margin-top:10px;white-space:pre-wrap"><b>Abstract:</b>\n${esc(item.abstract || "(No abstract)")}</div>
    </div>
  `;

  const head = node.querySelector(".head");
  head.addEventListener("click", () => vote(label));
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") vote(label);
  });
}

function nextPair() {
  if (filtered.length < 2) {
    el("arena").hidden = true;
    el("leaderboardPanel").hidden = false;
    return;
  }

  const pair = chooseNextPair(filtered, state);
  if (!pair) {
    el("arena").hidden = true;
    el("leaderboardPanel").hidden = false;
    return;
  }

  const [A, B] = pair;
  currentPair = { A, B };
  state.lastPair = [A, B];

  renderCard(el("cardA"), A, "A");
  renderCard(el("cardB"), B, "B");

  el("arena").hidden = false;
  el("leaderboardPanel").hidden = false;
  persistState();
}

function applyOutcomeCounters(rA, rB, outcome) {
  if (outcome === 1.0) {
    rA.wins += 1;
    rB.losses += 1;
  } else if (outcome === 0.0) {
    rB.wins += 1;
    rA.losses += 1;
  } else {
    rA.ties += 1;
    rB.ties += 1;
  }
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function applyJointAdjustment(rating, direction, kMult) {
  const effectiveK = BASE_K * kMult * clamp(rating.sigma / DEFAULT_SIGMA, 0.6, 1.8);
  rating.mu += direction * effectiveK * JOINT_FEEDBACK_SCALE;
  rating.sigma = Math.max(MIN_SIGMA, rating.sigma * SIGMA_DECAY * 0.99);
  rating.n += 1;
}

function vote(choice) {
  if (!currentPair) return;

  const map = {
    A: { outcome: 1.0, kMult: 1.0, neitherPenaltyApplied: false },
    STRONG_A: { outcome: 1.0, kMult: 1.8, neitherPenaltyApplied: false },
    B: { outcome: 0.0, kMult: 1.0, neitherPenaltyApplied: false },
    STRONG_B: { outcome: 0.0, kMult: 1.8, neitherPenaltyApplied: false },
    BOTH: { outcome: 0.5, kMult: 0.8, neitherPenaltyApplied: false },
    NEITHER: { outcome: 0.5, kMult: 1.2, neitherPenaltyApplied: false },
    SKIP: { outcome: null, kMult: 0.0, neitherPenaltyApplied: false },
  };

  const cfg = map[choice];
  if (!cfg) return;

  const A = currentPair.A;
  const B = currentPair.B;

  if (cfg.outcome === null) {
    state.history.push({ a: A.id, b: B.id, outcome: null, choice, kMult: 0.0, neitherPenaltyApplied: false, ts: new Date().toISOString() });
    persistState();
    rebuildFiltered();
    return;
  }

  const rA = getRating(A.id);
  const rB = getRating(B.id);
  if (choice === "BOTH") {
    applyJointAdjustment(rA, +1, cfg.kMult);
    applyJointAdjustment(rB, +1, cfg.kMult);
  } else if (choice === "NEITHER") {
    applyJointAdjustment(rA, -1, cfg.kMult);
    applyJointAdjustment(rB, -1, cfg.kMult);
  } else {
    updatePair(rA, rB, cfg.outcome, { baseK: BASE_K * cfg.kMult });
  }

  applyOutcomeCounters(rA, rB, cfg.outcome);
  state.history.push({ a: A.id, b: B.id, outcome: cfg.outcome, choice, kMult: cfg.kMult, neitherPenaltyApplied: cfg.neitherPenaltyApplied, ts: new Date().toISOString() });

  persistState();
  rebuildFiltered();
}

function undo() {
  if (state.history.length === 0) return;

  const history = state.history.slice(0, -1);
  state.ratings = {};
  state.history = [];
  state.lastPair = [];

  history.forEach((h) => {
    if (h.outcome === null || h.outcome === undefined) {
      state.history.push(h);
      return;
    }
    const rA = getRating(h.a);
    const rB = getRating(h.b);
    const kMult = (typeof h.kMult === "number") ? h.kMult : 1.0;
    if (h.choice === "BOTH") {
      applyJointAdjustment(rA, +1, kMult);
      applyJointAdjustment(rB, +1, kMult);
    } else if (h.choice === "NEITHER") {
      applyJointAdjustment(rA, -1, kMult);
      applyJointAdjustment(rB, -1, kMult);
    } else {
      updatePair(rA, rB, h.outcome, { baseK: BASE_K * kMult });
      if (h.neitherPenaltyApplied) {
        rA.mu -= 10;
        rB.mu -= 10;
      }
    }
    applyOutcomeCounters(rA, rB, h.outcome);
    state.history.push(h);
  });

  rebuildFiltered();
  persistState();
}

function renderLeaderboard() {
  const lb = el("leaderboard");
  const items = filtered.slice().sort((a, b) => b.mu - a.mu).slice(0, 30);
  lb.innerHTML = items
    .map((it, idx) => `
      <div class="lb-row">
        <div class="lb-top">
          <div class="lb-title">#${idx + 1} — ${esc(it.title)}</div>
          <div class="small">μ ${it.mu.toFixed(1)} · σ ${it.sigma.toFixed(1)} · n ${it.n}</div>
        </div>
        <div class="lb-sub">${esc(it.id)} · ${esc(it.session || "—")} · ${esc(it.location || "—")} · ${esc(it.cat1 || "—")}${it.cat2 ? ` / ${esc(it.cat2)}` : ""}</div>
      </div>
    `)
    .join("");
}

function populateFilters() {
  const cats = new Set();
  const sessions = new Set();
  const locations = new Set();

  RAW_RECORDS.forEach((rec) => {
    const it = hydrateItem(rec);
    if (it.cat1) cats.add(it.cat1);
    if (it.cat2) cats.add(it.cat2);
    if (it.session) sessions.add(it.session);
    if (it.location) locations.add(it.location);
  });

  el("categoryFilter").innerHTML = `<option value="">All categories</option>${[...cats].sort().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}`;
  el("sessionFilter").innerHTML = `<option value="">All sessions</option>${[...sessions].sort().map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}`;
  el("locationFilter").innerHTML = `<option value="">All locations</option>${[...locations].sort().map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}<option value="__oral_only__">Oral only (in-person)</option><option value="__oral_only_no_chellah__">Oral only (in-person, no Salle Le Chellah)</option>`;
}

function loadCSVFromText(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error("CSV is empty or missing data.");

  RAW_HEADERS = rows[0];
  COL = detectColumns(RAW_HEADERS);

  if (!COL.id || !COL.title || !COL.abstract) {
    throw new Error(`Missing required columns. Need ID/Title/Abstract. Found headers: ${RAW_HEADERS.join(", ")}`);
  }

  RAW_RECORDS = rows.slice(1).map((r) => {
    const rec = {};
    RAW_HEADERS.forEach((h, i) => {
      rec[h] = r[i] ?? "";
    });
    return rec;
  }).filter((rec) => {
    const attendance = String(rec["Attendance Type"] ?? rec["attendance_type"] ?? "").trim().toLowerCase();
    const sessionVal = String(COL.session ? rec[COL.session] : "").trim().toLowerCase();
    const locationVal = String(COL.location ? rec[COL.location] : "").trim().toLowerCase();

    const isVirtual = (
      attendance === "virtual"
      || locationVal === "zoom"
      || /\bvirtual\b/.test(sessionVal)
    );
    return !isVirtual;
  });

  populateFilters();
  rebuildFiltered();
}

async function loadCSVTextFromFetch() {
  const res = await fetch(AUTO_FILENAME, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status} ${res.statusText})`);
  return await res.text();
}

async function exportState() {
  await apiJson("/api/save_state", { state });
}

function importState(jsonText) {
  const obj = JSON.parse(jsonText);
  const normalized = normalizeState(obj);
  if (!normalized) throw new Error("Invalid state JSON.");

  state.version = normalized.version;
  state.ratings = normalized.ratings;
  state.history = normalized.history;
  state.lastPair = normalized.lastPair;
  state.mode = normalized.mode;
  state.topN = normalized.topN;
  state.resolveTieNMatches = normalized.resolveTieNMatches;
  state.muPriority = normalized.muPriority;
  state.winsOnly = normalized.winsOnly;

  el("mode").value = state.mode;
  el("topN").value = String(state.topN);
  el("resolveTieNMatches").value = state.resolveTieNMatches || "minimal";
  el("muPriority").value = state.muPriority || "highest";
  el("winsOnly").checked = !!state.winsOnly;

  persistState();
  rebuildFiltered();
}

async function exportScoredCSV() {
  if (!RAW_HEADERS.length) return;

  const extraCols = ["pref_mu", "pref_sigma", "pref_rank", "n_matches", "wins", "losses", "ties"];
  const headers = [...RAW_HEADERS];
  extraCols.forEach((c) => {
    if (!headers.includes(c)) headers.push(c);
  });

  const rankById = buildRankById();

  const outRecords = RAW_RECORDS.map((rec) => {
    const id = String(rec[COL.id] ?? "").trim();
    const r = state.ratings[id] ?? { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA, n: 0, wins: 0, losses: 0, ties: 0 };
    return {
      ...rec,
      pref_mu: r.mu,
      pref_sigma: r.sigma,
      pref_rank: rankById.get(id) ?? "",
      n_matches: r.n,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
    };
  });

  const csvText = toCSV(headers, outRecords);
  await apiJson("/api/save_scored_csv", { csv_text: csvText });
}

function wireEvents() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  el("csvFile").addEventListener("change", async (e) => {
    clearError();
    const file = e.target.files?.[0];
    if (!file) return;
    loadCSVFromText(await file.text());
  });

  el("btnAutoLoad").addEventListener("click", async () => {
    clearError();
    try {
      loadCSVFromText(await loadCSVTextFromFetch());
    } catch (err) {
      error(String(err.message ?? err));
    }
  });

  el("btnReset").addEventListener("click", () => {
    if (!confirm("Reset all ratings and history?")) return;
    clearState();
    const next = getDefaultState();
    state.version = next.version;
    state.ratings = next.ratings;
    state.history = next.history;
    state.lastPair = next.lastPair;
    state.mode = next.mode;
    state.topN = next.topN;
    state.resolveTieNMatches = next.resolveTieNMatches;
    state.muPriority = next.muPriority;
    state.winsOnly = next.winsOnly;
    state.scheduleByPresentationOrder = next.scheduleByPresentationOrder;
    if (el("scheduleByPresentationOrder")) el("scheduleByPresentationOrder").checked = !!state.scheduleByPresentationOrder;
    persistState();
    rebuildFiltered();
  });

  el("btnExportState").addEventListener("click", async () => {
    clearError();
    try {
      await exportState();
    } catch (err) {
      error(String(err.message ?? err));
    }
  });

  el("btnExportCSV").addEventListener("click", async () => {
    clearError();
    try {
      await exportScoredCSV();
    } catch (err) {
      error(String(err.message ?? err));
    }
  });

  el("stateFile").addEventListener("change", async (e) => {
    clearError();
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      importState(await file.text());
    } catch (err) {
      error(String(err.message ?? err));
    }
  });

  el("search").addEventListener("input", rebuildFiltered);
  el("categoryFilter").addEventListener("change", rebuildFiltered);
  el("sessionFilter").addEventListener("change", rebuildFiltered);
  el("locationFilter").addEventListener("change", rebuildFiltered);
  el("hasWinsOnly").addEventListener("change", rebuildFiltered);
  el("scheduleByPresentationOrder")?.addEventListener("change", (e) => {
    state.scheduleByPresentationOrder = Boolean(e.target.checked);
    persistState();
    void renderSchedule();
  });

  el("mode").addEventListener("change", (e) => {
    state.mode = e.target.value;
    persistState();
    nextPair();
  });

  el("resolveTieNMatches").addEventListener("change", (e) => {
    state.resolveTieNMatches = e.target.value;
    persistState();
    nextPair();
  });

  el("muPriority").addEventListener("change", (e) => {
    state.muPriority = e.target.value;
    persistState();
    nextPair();
  });

  el("winsOnly").addEventListener("change", (e) => {
    state.winsOnly = Boolean(e.target.checked);
    persistState();
    nextPair();
  });

  el("topN").addEventListener("input", (e) => {
    state.topN = Number(e.target.value || 60);
    persistState();
  });

  el("btnA").addEventListener("click", () => vote("A"));
  el("btnStrongA").addEventListener("click", () => vote("STRONG_A"));
  el("btnB").addEventListener("click", () => vote("B"));
  el("btnStrongB").addEventListener("click", () => vote("STRONG_B"));
  el("btnBoth").addEventListener("click", () => vote("BOTH"));
  el("btnNeither").addEventListener("click", () => vote("NEITHER"));
  el("btnSkip").addEventListener("click", () => vote("SKIP"));
  el("btnUndo").addEventListener("click", undo);
}

async function boot() {
  wireEvents();

  el("mode").value = state.mode;
  el("topN").value = String(state.topN);
  el("resolveTieNMatches").value = state.resolveTieNMatches || "minimal";
  el("muPriority").value = state.muPriority || "highest";
  el("winsOnly").checked = !!state.winsOnly;
  if (el("scheduleByPresentationOrder")) el("scheduleByPresentationOrder").checked = !!state.scheduleByPresentationOrder;

  try {
    loadCSVFromText(await loadCSVTextFromFetch());
    notifyVizRatings();
  } catch {
    renderStats();
    renderOverview();
    notifyVizRatings();
  }
}

boot();
