const state = {
  meta: null,
  staticBundle: null,
  staticMetaById: new Map(),
  staticCoordsByMethod: {},
  staticNeighbors: {},
  filters: {},
  currentPoints: [],
  selectedPoints: [],
  sort: { key: 'paper_id', dir: 'asc' },
  currentClickedPaperId: null,
  lastRequestPayload: null,
  lastPlotMeta: { colorBy: 'Session', mode: 'all' },
  lastNeighbors: [],
  hiddenCategories: new Set(),
  legendColorBy: null,
  ratings: {},
  favorites: {},
  colorMaps: {
    Session: {},
    'Room Location': {},
  },
};

const FILTER_COLUMNS = ['Type of Presentation', 'Attendance Type', 'Room Location', 'Session'];
const COLUMN_TO_FIELD = {
  'Type of Presentation': 'type_presentation',
  'Attendance Type': 'attendance_type',
  'Room Location': 'room_location',
  Session: 'session',
};
const STATIC_DATA_URL = '../data/projection.json';
let VIEW_STATE_KEY = 'conference-paper-navigator:unknown:embedding-view:v1';
let RANKING_STORAGE_KEY = 'conference-paper-navigator:unknown:ratings:v1';
const DEFAULT_MU = 1500;
const FIXED_COLOR_PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
  '#bcbd22', '#17becf', '#393b79', '#637939', '#8c6d31', '#843c39', '#7b4173', '#3182bd',
  '#31a354', '#756bb1', '#636363', '#e6550d',
];

function qs(id) {
  return document.getElementById(id);
}

function readRankingStateFromStorage() {
  const raw = localStorage.getItem(RANKING_STORAGE_KEY);
  if (!raw) return { ratings: {}, favorites: {} };
  try {
    const parsed = JSON.parse(raw);
    const priors = Object.fromEntries(Object.entries(parsed?.priors || {}).map(([paperId, prior]) => [
      paperId,
      { mu: prior.mu, sigma: prior.sigma, n: 0, wins: 0, losses: 0, ties: 0 },
    ]));
    return { ratings: { ...priors, ...(parsed?.ratings || {}) }, favorites: parsed?.favorites || {} };
  } catch {
    return { ratings: {}, favorites: {} };
  }
}

function refreshRatingsFromStorage() {
  const stored = readRankingStateFromStorage();
  state.ratings = stored.ratings;
  state.favorites = stored.favorites;
}

function isFavorite(paperId) {
  return Boolean(state.favorites?.[String(paperId)]?.selected);
}

function favoriteButton(paperId) {
  const selected = isFavorite(paperId);
  return `<button class="favorite-viz icon" type="button" data-favorite-id="${paperId}" aria-label="${selected ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${selected}">${selected ? '★' : '☆'}</button>`;
}

function requestFavoriteToggle(paperId) {
  const selected = !isFavorite(paperId);
  state.favorites[String(paperId)] = { selected, modified_at: new Date().toISOString() };
  window.parent.postMessage({ type: 'favorite_update', payload: { paperId: String(paperId), selected } }, window.location.origin);
  renderSelectionTable();
  renderNeighbors(state.lastNeighbors);
  if (state.currentClickedPaperId === String(paperId)) updateDetailFavoriteButton();
  if (state.currentPoints.length > 0) renderPlot(state.currentPoints, state.lastPlotMeta.colorBy, state.lastPlotMeta.mode);
}

function buildRankMap() {
  const entries = Object.entries(state.ratings || {})
    .filter(([, rating]) => rating && typeof rating.mu === 'number')
    .sort((a, b) => b[1].mu - a[1].mu);

  const rankMap = new Map();
  entries.forEach(([paperId], idx) => {
    rankMap.set(paperId, idx + 1);
  });
  return rankMap;
}

function rankForPaperId(paperId, rankMap = null) {
  const map = rankMap || buildRankMap();
  return map.get(paperId) ?? null;
}

function buildOpacityMap(points) {
  const mus = points.map((p) => Number(state.ratings?.[p.paper_id]?.mu ?? DEFAULT_MU));
  if (mus.length === 0) return new Map();
  const minMu = Math.min(...mus);
  const maxMu = Math.max(...mus);
  const span = Math.max(1e-9, maxMu - minMu);
  const opacityById = new Map();

  points.forEach((point, index) => {
    const mu = mus[index];
    const norm = (mu - minMu) / span;
    const opacity = 0.18 + (0.92 - 0.18) * norm;
    opacityById.set(point.paper_id, opacity);
  });

  return opacityById;
}

function setStatus(message, isError = false) {
  const el = qs('status-line');
  el.textContent = message;
  el.style.color = isError ? '#b42318' : '#1b2430';
}

function setLoading(loading) {
  qs('run-btn').disabled = loading;
  if (loading) {
    setStatus('Running projection...');
  }
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

function parseSearchTerms(searchText) {
  if (!searchText) return [];
  return searchText
    .split(';')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function titleMatchesTerms(title, terms) {
  if (!terms || terms.length === 0) return false;
  const lowered = String(title || '').toLowerCase();
  return terms.some((term) => lowered.includes(term.toLowerCase()));
}

function seededRandom(seed) {
  let t = Number(seed) || 42;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleArray(values, n, rng) {
  if (n >= values.length) return [...values];
  const arr = [...values];
  for (let idx = arr.length - 1; idx > 0; idx -= 1) {
    const j = Math.floor(rng() * (idx + 1));
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
  }
  return arr.slice(0, n);
}

function sampleRecords(records, sampleCfg, randomState) {
  const enabled = !!sampleCfg?.enabled;
  const maxPoints = Number(sampleCfg?.max_points ?? records.length);
  const strategy = String(sampleCfg?.strategy || 'random');
  if (!enabled || maxPoints <= 0 || records.length <= maxPoints) return [...records];

  const rng = seededRandom(randomState);
  if (strategy !== 'stratified_by_session') {
    return sampleArray(records, maxPoints, rng);
  }

  const bySession = new Map();
  records.forEach((rec) => {
    const key = rec.session || '';
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(rec);
  });

  const sampled = [];
  bySession.forEach((group) => {
    const frac = group.length / records.length;
    const nTake = Math.min(group.length, Math.max(1, Math.round(maxPoints * frac)));
    sampled.push(...sampleArray(group, nTake, rng));
  });

  if (sampled.length > maxPoints) {
    return sampleArray(sampled, maxPoints, rng);
  }
  if (sampled.length < maxPoints) {
    const sampledSet = new Set(sampled.map((item) => item.paper_id));
    const remaining = records.filter((item) => !sampledSet.has(item.paper_id));
    const fill = sampleArray(remaining, Math.min(maxPoints - sampled.length, remaining.length), rng);
    return [...sampled, ...fill];
  }
  return sampled;
}

function buildStaticStores(bundle) {
  const methods = bundle?.methods || {};
  const pointsMeta = bundle?.points_meta || [];

  state.staticMetaById = new Map();
  pointsMeta.forEach((point) => {
    state.staticMetaById.set(String(point.paper_id), {
      paper_id: String(point.paper_id),
      title: String(point.title || ''),
      session: String(point.session || ''),
      room_location: String(point.room_location || ''),
      type_presentation: String(point.type_presentation || ''),
      attendance_type: String(point.attendance_type || ''),
    });
  });

  if (state.staticMetaById.size === 0 && Array.isArray(bundle?.points)) {
    bundle.points.forEach((point) => {
      state.staticMetaById.set(String(point.paper_id), {
        paper_id: String(point.paper_id),
        title: String(point.title || ''),
        session: String(point.session || ''),
        room_location: String(point.room_location || ''),
        type_presentation: String(point.type_presentation || ''),
        attendance_type: String(point.attendance_type || ''),
      });
    });
  }

  const coordsByMethod = {};
  ['pca', 'tsne', 'umap'].forEach((method) => {
    coordsByMethod[method] = new Map();
    if (Array.isArray(methods[method])) {
      methods[method].forEach((row) => {
        coordsByMethod[method].set(String(row.paper_id), {
          x: Number(row.x),
          y: Number(row.y),
        });
      });
    }
  });

  if (coordsByMethod.pca.size === 0 && Array.isArray(bundle?.points)) {
    bundle.points.forEach((row) => {
      coordsByMethod.pca.set(String(row.paper_id), {
        x: Number(row.x),
        y: Number(row.y),
      });
    });
  }

  state.staticCoordsByMethod = coordsByMethod;
  state.staticNeighbors = bundle?.neighbors && typeof bundle.neighbors === 'object' ? bundle.neighbors : {};
}

function buildMetaFromStatic(bundle) {
  const values = {
    'Type of Presentation': new Set(),
    'Attendance Type': new Set(),
    'Room Location': new Set(),
    Session: new Set(),
  };

  state.staticMetaById.forEach((row) => {
    values['Type of Presentation'].add(row.type_presentation);
    values['Attendance Type'].add(row.attendance_type);
    values['Room Location'].add(row.room_location);
    values.Session.add(row.session);
  });

  const filters = {
    'Type of Presentation': sortedUnique([...(bundle?.filters?.['Type of Presentation'] || values['Type of Presentation'])]),
    'Attendance Type': sortedUnique([...(bundle?.filters?.['Attendance Type'] || values['Attendance Type'])]),
    'Room Location': sortedUnique([...(bundle?.filters?.['Room Location'] || values['Room Location'])]),
    Session: sortedUnique([...(bundle?.filters?.Session || values.Session)]),
  };

  return {
    n_total: state.staticMetaById.size,
    filters,
    available_sessions: sortedUnique(bundle?.available_sessions || filters.Session),
    default_columns: {
      title: 'title',
      paper_id: 'paper_id',
      color_by_all: 'Session',
      color_by_session: 'Room Location',
    },
  };
}

async function loadStaticBundle() {
  const bundle = await fetchJSON(STATIC_DATA_URL);
  state.staticBundle = bundle;
  buildStaticStores(bundle);
  return buildMetaFromStatic(bundle);
}

function projectLocally(payload) {
  const started = performance.now();
  const method = String(payload?.method || 'pca').toLowerCase();
  const mode = String(payload?.mode || 'all').toLowerCase();
  const sessionValue = payload?.session_value;
  const searchText = String(payload?.search_text || '').trim();
  const searchMode = String(payload?.search_mode || 'highlight').toLowerCase();
  const terms = parseSearchTerms(searchText);

  let records = [...state.staticMetaById.values()];
  const filters = payload?.filters || {};

  FILTER_COLUMNS.forEach((col) => {
    if (!Array.isArray(filters[col])) return;
    const allowed = new Set(filters[col].map((value) => String(value)));
    const field = COLUMN_TO_FIELD[col];
    records = records.filter((row) => allowed.has(String(row[field] || '')));
  });

  if (mode === 'session' && sessionValue) {
    records = records.filter((row) => row.session === String(sessionValue));
  }

  if (payload?.oral_only) {
    records = records.filter((row) => {
      const oral = /\boral\b/i.test(String(row.type_presentation || ''));
      const inPerson = String(row.attendance_type || '').trim().toLowerCase() === 'in-person';
      return oral && inPerson;
    });
  }

  if (terms.length > 0 && searchMode === 'filter') {
    records = records.filter((row) => titleMatchesTerms(row.title, terms));
  }

  const nFiltered = records.length;
  const randomState = Number(payload?.params?.random_state ?? 42);
  const sampled = sampleRecords(records, payload?.sample || {}, randomState);
  const fallbackMethod = state.staticCoordsByMethod.pca?.size ? 'pca' : method;
  const coordsMap = state.staticCoordsByMethod[method]?.size ? state.staticCoordsByMethod[method] : state.staticCoordsByMethod[fallbackMethod];
  const colorField = mode === 'all' ? 'session' : 'room_location';

  const points = sampled
    .map((row) => {
      const coords = coordsMap?.get(row.paper_id);
      if (!coords) return null;
      const matched = terms.length > 0 ? titleMatchesTerms(row.title, terms) : false;
      return {
        paper_id: row.paper_id,
        x: Number(coords.x),
        y: Number(coords.y),
        title: row.title,
        session: row.session,
        room_location: row.room_location,
        type_presentation: row.type_presentation,
        attendance_type: row.attendance_type,
        color_value: row[colorField] || '',
        matched,
      };
    })
    .filter(Boolean);

  const legendValues = sortedUnique(points.map((point) => point.color_value));
  const computeMs = Math.round((performance.now() - started) * 100) / 100;
  return {
    points,
    color_by: mode === 'all' ? 'Session' : 'Room Location',
    legend_values: legendValues,
    stats: {
      n_total: state.staticMetaById.size,
      n_filtered: nFiltered,
      n_returned: points.length,
      compute_ms: computeMs,
    },
  };
}

function neighborsLocally(paperId, k, currentIds) {
  const all = Array.isArray(state.staticNeighbors?.[paperId]) ? state.staticNeighbors[paperId] : [];
  const currentSet = Array.isArray(currentIds) && currentIds.length > 0 ? new Set(currentIds.map((id) => String(id))) : null;
  let rows = all;
  if (currentSet) {
    rows = rows.filter((row) => currentSet.has(String(row.paper_id)));
  }
  return rows.slice(0, Math.max(1, Number(k) || 10));
}

function updateMethodParamVisibility() {
  const method = qs('method-select').value;
  qs('params-pca').classList.toggle('hidden', method !== 'pca');
  qs('params-tsne').classList.toggle('hidden', method !== 'tsne');
  qs('params-umap').classList.toggle('hidden', method !== 'umap');
}

function updateModeUI() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  qs('session-select').disabled = mode !== 'session';
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
}

function createColorMap(values) {
  const sortedValues = sortedUnique(values || []);
  const map = {};
  sortedValues.forEach((value, index) => {
    map[value] = FIXED_COLOR_PALETTE[index % FIXED_COLOR_PALETTE.length];
  });
  return map;
}

function initColorMaps(meta) {
  const sessionValues = meta?.filters?.Session || [];
  const roomValues = meta?.filters?.['Room Location'] || [];
  state.colorMaps.Session = createColorMap(sessionValues);
  state.colorMaps['Room Location'] = createColorMap(roomValues);
}

function getCategoryColor(categoryValue, colorBy) {
  const key = String(categoryValue || 'Unknown');
  const colorMap = state.colorMaps[colorBy] || {};
  if (colorMap[key]) return colorMap[key];
  const fallbackIdx = Math.abs(key.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0));
  return FIXED_COLOR_PALETTE[fallbackIdx % FIXED_COLOR_PALETTE.length];
}

function buildFilterGroup(column, values) {
  const wrap = document.createElement('div');
  wrap.className = 'filter-group';

  const title = document.createElement('h3');
  title.textContent = column;
  title.style.margin = '0 0 6px';
  title.style.fontSize = '0.9rem';

  const actions = document.createElement('div');
  actions.className = 'filter-actions';

  const btnAll = document.createElement('button');
  btnAll.className = 'secondary';
  btnAll.textContent = 'Select all';
  btnAll.type = 'button';
  btnAll.addEventListener('click', () => {
    wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = true;
    });
  });

  const btnNone = document.createElement('button');
  btnNone.className = 'secondary';
  btnNone.textContent = 'Select none';
  btnNone.type = 'button';
  btnNone.addEventListener('click', () => {
    wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
    });
  });

  actions.appendChild(btnAll);
  actions.appendChild(btnNone);

  const valuesWrap = document.createElement('div');
  valuesWrap.className = 'filter-values';

  values.forEach((v) => {
    const item = document.createElement('label');
    item.className = 'filter-value';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.column = column;
    cb.value = v;

    const span = document.createElement('span');
    span.textContent = v;

    item.appendChild(cb);
    item.appendChild(span);
    valuesWrap.appendChild(item);
  });

  wrap.appendChild(title);
  wrap.appendChild(actions);
  wrap.appendChild(valuesWrap);
  return wrap;
}

function renderFilters(metaFilters) {
  const container = qs('filters-container');
  container.innerHTML = '';
  FILTER_COLUMNS.forEach((col) => {
    const vals = sortedUnique(metaFilters[col] || []);
    container.appendChild(buildFilterGroup(col, vals));
  });
}

function getCurrentFilters() {
  const filters = {};
  FILTER_COLUMNS.forEach((col) => {
    const checkboxes = document.querySelectorAll(`input[type="checkbox"][data-column="${col}"]`);
    filters[col] = [...checkboxes].filter((cb) => cb.checked).map((cb) => cb.value);
  });
  return filters;
}

function getCurrentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function getProjectionParams() {
  const method = qs('method-select').value;
  if (method === 'pca') {
    return {
      whiten: qs('pca-whiten').checked,
      random_state: Number(qs('pca-random-state').value || 42),
    };
  }
  if (method === 'tsne') {
    const lrRaw = qs('tsne-learning-rate').value.trim();
    const learningRate = lrRaw.toLowerCase() === 'auto' ? 'auto' : Number(lrRaw);
    return {
      perplexity: Number(qs('tsne-perplexity').value || 30),
      learning_rate: Number.isFinite(learningRate) ? learningRate : 'auto',
      n_iter: Number(qs('tsne-n-iter').value || 1000),
      init: qs('tsne-init').value,
      metric: qs('tsne-metric').value,
      random_state: Number(qs('tsne-random-state').value || 42),
      pca_components_for_tsne_umap: Number(qs('tsne-pca-pre').value || 50),
    };
  }
  return {
    n_neighbors: Number(qs('umap-n-neighbors').value || 15),
    min_dist: Number(qs('umap-min-dist').value || 0.1),
    metric: qs('umap-metric').value,
    spread: Number(qs('umap-spread').value || 1.0),
    random_state: Number(qs('umap-random-state').value || 42),
    pca_components_for_tsne_umap: Number(qs('umap-pca-pre').value || 50),
  };
}

function buildProjectPayload() {
  const mode = getCurrentMode();
  const payload = {
    method: qs('method-select').value,
    params: getProjectionParams(),
    mode,
    session_value: mode === 'session' ? qs('session-select').value : null,
    filters: getCurrentFilters(),
    sample: {
      enabled: qs('sample-enabled').checked,
      max_points: Number(qs('sample-max-points').value || 960),
      strategy: qs('sample-strategy').value,
    },
    oral_only: qs('oral-only-toggle').checked,
    search_text: qs('search-text').value.trim(),
    search_mode: qs('search-mode').value,
  };
  state.lastRequestPayload = payload;
  return payload;
}

function pointHoverTemplate(mode, favorite = false) {
  const favoriteLabel = favorite ? '<br>★ Favorite' : '';
  if (mode === 'session') {
    return `<b>%{customdata[1]}</b><br>paper_id: %{customdata[0]}<br>rank: %{customdata[6]}<br>Room: %{customdata[3]}${favoriteLabel}<extra></extra>`;
  }
  return `<b>%{customdata[1]}</b><br>paper_id: %{customdata[0]}<br>rank: %{customdata[6]}${favoriteLabel}<extra></extra>`;
}

function toTableRowFromPoint(point, rankMap = null) {
  return {
    rank: rankForPaperId(point.paper_id, rankMap),
    paper_id: point.paper_id,
    title: point.title,
    session: point.session,
    room_location: point.room_location,
    type_presentation: point.type_presentation,
    attendance_type: point.attendance_type,
  };
}

function getHighlightedRows() {
  const hasSearch = !!qs('search-text').value.trim();
  const isHighlightMode = qs('search-mode').value === 'highlight';
  if (!hasSearch || !isHighlightMode) return [];
  const rankMap = buildRankMap();
  return state.currentPoints.filter((p) => p.matched).map((p) => toTableRowFromPoint(p, rankMap));
}

function mergeUniqueRows(rows) {
  const dedup = new Map();
  rows.forEach((row) => dedup.set(row.paper_id, row));
  return [...dedup.values()];
}

function groupByCategory(points) {
  const grouped = new Map();
  points.forEach((p) => {
    const key = p.color_value || 'Unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  });
  return grouped;
}

function buildTraces(points, mode, colorBy) {
  const grouped = groupByCategory(points);
  const traces = [];
  const opacityById = buildOpacityMap(points);
  const rankMap = buildRankMap();

  [...grouped.entries()].forEach(([category, items]) => {
    const regularItems = items.filter((point) => !isFavorite(point.paper_id));
    if (regularItems.length === 0) return;
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: String(category),
      x: regularItems.map((p) => p.x),
      y: regularItems.map((p) => p.y),
      text: regularItems.map((p) => p.title),
      customdata: regularItems.map((p) => [
        p.paper_id,
        p.title,
        p.session,
        p.room_location,
        p.type_presentation,
        p.attendance_type,
        rankForPaperId(p.paper_id, rankMap) ?? '-',
      ]),
      hovertemplate: pointHoverTemplate(mode),
      marker: {
        size: 8,
        opacity: regularItems.map((p) => opacityById.get(p.paper_id) ?? 0.65),
        color: getCategoryColor(category, colorBy),
      },
      visible: state.hiddenCategories.has(String(category)) ? false : true,
      showlegend: false,
    });
  });

  const favorites = points.filter((point) => (
    isFavorite(point.paper_id)
    && !state.hiddenCategories.has(String(point.color_value || 'Unknown'))
  ));
  if (favorites.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: 'Favorites',
      x: favorites.map((point) => point.x),
      y: favorites.map((point) => point.y),
      customdata: favorites.map((point) => [
        point.paper_id,
        point.title,
        point.session,
        point.room_location,
        point.type_presentation,
        point.attendance_type,
        rankForPaperId(point.paper_id, rankMap) ?? '-',
      ]),
      hovertemplate: pointHoverTemplate(mode, true),
      marker: {
        symbol: 'star',
        size: 18,
        opacity: 1,
        color: favorites.map((point) => getCategoryColor(point.color_value || 'Unknown', colorBy)),
        line: { width: 2, color: '#111827' },
      },
      showlegend: false,
    });
  }

  const matched = points.filter((p) => p.matched && !state.hiddenCategories.has(String(p.color_value || 'Unknown')));
  if (matched.length > 0 && qs('search-mode').value === 'highlight' && qs('search-text').value.trim()) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: 'Search matches',
      x: matched.map((p) => p.x),
      y: matched.map((p) => p.y),
      customdata: matched.map((p) => [
        p.paper_id,
        p.title,
        p.session,
        p.room_location,
        p.type_presentation,
        p.attendance_type,
        rankForPaperId(p.paper_id, rankMap) ?? '-',
      ]),
      hovertemplate: pointHoverTemplate(mode),
      marker: {
        size: 24,
        color: 'rgba(0,0,0,0)',
        line: { width: 2, color: '#d92d20' },
      },
      showlegend: false,
    });
  }

  return traces;
}

function plotMarginForViewport() {
  const isSmallScreen = window.matchMedia('(max-width: 900px)').matches;
  return isSmallScreen
    ? { t: 48, r: 12, b: 44, l: 48 }
    : { t: 52, r: 18, b: 52, l: 56 };
}

function renderCategoryLegend(points, colorBy) {
  if (state.legendColorBy !== colorBy) {
    state.hiddenCategories.clear();
    state.legendColorBy = colorBy;
  }

  const grouped = groupByCategory(points);
  const categories = [...grouped.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
  qs('legend-title').textContent = `${colorBy} (${categories.length})`;
  const container = qs('category-legend');
  container.innerHTML = '';

  categories.forEach(([category, items]) => {
    const key = String(category);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `legend-item${state.hiddenCategories.has(key) ? ' is-hidden' : ''}`;
    button.title = `${key}: ${items.length} papers`;

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = getCategoryColor(key, colorBy);
    const label = document.createElement('span');
    label.className = 'legend-label';
    label.textContent = key;
    const count = document.createElement('span');
    count.className = 'legend-count';
    count.textContent = items.length;
    button.append(swatch, label, count);

    button.addEventListener('click', (event) => {
      if (event.shiftKey) {
        if (state.hiddenCategories.has(key)) state.hiddenCategories.delete(key);
        else state.hiddenCategories.add(key);
      } else {
        const isOnlyVisible = categories.every(([value]) => String(value) === key || state.hiddenCategories.has(String(value)));
        state.hiddenCategories = isOnlyVisible
          ? new Set()
          : new Set(categories.map(([value]) => String(value)).filter((value) => value !== key));
      }
      renderPlot(state.currentPoints, state.lastPlotMeta.colorBy, state.lastPlotMeta.mode);
    });
    container.appendChild(button);
  });
}

function renderPlot(points, colorBy, mode) {
  const plot = qs('plot');
  state.lastPlotMeta = { colorBy, mode };
  renderCategoryLegend(points, colorBy);
  const traces = buildTraces(points, mode, colorBy);

  Plotly.newPlot(
    plot,
    traces,
    {
      dragmode: 'lasso',
      title: `2D projection (color by ${colorBy})`,
      margin: plotMarginForViewport(),
      xaxis: { title: 'Dimension 1', automargin: true },
      yaxis: { title: 'Dimension 2', automargin: true },
      showlegend: false,
      hovermode: 'closest',
      uirevision: `${state.lastRequestPayload?.method || 'projection'}-${colorBy}`,
    },
    {
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
      modeBarButtonsToAdd: ['select2d', 'lasso2d'],
    }
  );

  plot.removeAllListeners('plotly_selected');
  plot.removeAllListeners('plotly_click');

  plot.on('plotly_selected', (ev) => {
    if (!ev || !ev.points) {
      state.selectedPoints = getHighlightedRows();
      renderSelectionTable();
      return;
    }
    const selected = ev.points.map((pp) => {
      const [paper_id, title, session, room_location, type_presentation, attendance_type, rank] = pp.customdata;
      return { paper_id, title, session, room_location, type_presentation, attendance_type, rank: rank === '-' ? null : Number(rank) };
    });

    state.selectedPoints = mergeUniqueRows([...selected, ...getHighlightedRows()]);
    renderSelectionTable();
    if (state.selectedPoints.length > 0) qs('selection-panel').open = true;
  });

  plot.on('plotly_click', async (ev) => {
    if (!ev || !ev.points || ev.points.length === 0) return;
    const [paper_id, title, session, room_location, type_presentation, attendance_type] = ev.points[0].customdata;
    state.currentClickedPaperId = paper_id;
    setPanelCollapsed('right', false);
    renderDetails({ paper_id, title, session, room_location, type_presentation, attendance_type });
    await refreshNeighbors();
  });
}

function requestPlotResize({ updateMargins = false } = {}) {
  const plot = qs('plot');
  if (!plot || !plot.data) return;
  const applyResize = () => {
    Plotly.Plots.resize(plot);
    if (updateMargins) Plotly.relayout(plot, { margin: plotMarginForViewport() });
  };
  requestAnimationFrame(applyResize);
}

function renderStats(stats) {
  qs('stats-line').textContent = `n_total=${stats.n_total} | n_filtered=${stats.n_filtered} | n_returned=${stats.n_returned} | compute_ms=${stats.compute_ms}`;
}

function compareValues(a, b, dir) {
  const lhs = String(a || '');
  const rhs = String(b || '');
  const cmp = lhs.localeCompare(rhs, undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? cmp : -cmp;
}

function renderSelectionTable() {
  const tbody = qs('selection-table').querySelector('tbody');
  tbody.innerHTML = '';

  const { key, dir } = state.sort;
  const rows = [...state.selectedPoints].sort((a, b) => compareValues(a[key], b[key], dir));
  qs('selection-count').textContent = rows.length;

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${favoriteButton(row.paper_id)}</td>
      <td>${row.rank ?? '-'}</td>
      <td>${row.paper_id}</td>
      <td>${row.title}</td>
      <td>${row.session}</td>
      <td>${row.room_location}</td>
    `;
    tbody.appendChild(tr);
  });
}

function updateLayoutButtons() {
  const layout = qs('viz-layout');
  const controlsCollapsed = layout.classList.contains('left-collapsed');
  const inspectorCollapsed = layout.classList.contains('right-collapsed');
  const focusMode = controlsCollapsed && inspectorCollapsed;
  qs('toggle-controls-btn').textContent = controlsCollapsed ? 'Show controls' : 'Hide controls';
  qs('toggle-controls-btn').setAttribute('aria-expanded', String(!controlsCollapsed));
  qs('toggle-inspector-btn').textContent = inspectorCollapsed ? 'Show inspector' : 'Hide inspector';
  qs('toggle-inspector-btn').setAttribute('aria-expanded', String(!inspectorCollapsed));
  qs('focus-plot-btn').textContent = focusMode ? 'Show panels' : 'Focus plot';
}

function setPanelCollapsed(side, collapsed) {
  const layout = qs('viz-layout');
  const className = side === 'left' ? 'left-collapsed' : 'right-collapsed';
  if (layout.classList.contains(className) === collapsed) return;
  layout.classList.toggle(className, collapsed);
  updateLayoutButtons();
  requestPlotResize();
}

function toggleFocusPlot() {
  const layout = qs('viz-layout');
  const focusMode = layout.classList.contains('left-collapsed') && layout.classList.contains('right-collapsed');
  layout.classList.toggle('left-collapsed', !focusMode);
  layout.classList.toggle('right-collapsed', !focusMode);
  updateLayoutButtons();
  requestPlotResize();
}

function updateFullscreenButton() {
  const fullscreen = Boolean(document.fullscreenElement);
  qs('fullscreen-btn').textContent = fullscreen ? 'Exit full screen' : 'Full screen';
  qs('fullscreen-btn').setAttribute('aria-pressed', String(fullscreen));
  requestPlotResize({ updateMargins: true });
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    setStatus(`Full screen is unavailable: ${error.message}`, true);
  }
}

function renderDetails(paper) {
  qs('details-empty').classList.add('hidden');
  qs('details-content').classList.remove('hidden');
  qs('detail-title').textContent = paper.title;
  qs('detail-paper-id').textContent = paper.paper_id;
  qs('detail-session').textContent = paper.session;
  qs('detail-room').textContent = paper.room_location;
  qs('detail-type').textContent = paper.type_presentation;
  qs('detail-attendance').textContent = paper.attendance_type;
  updateDetailFavoriteButton();
}

function updateDetailFavoriteButton() {
  const button = qs('detail-favorite-btn');
  const selected = isFavorite(state.currentClickedPaperId);
  button.textContent = selected ? '★ Favorite' : '☆ Add to favorites';
  button.setAttribute('aria-pressed', String(selected));
}

function renderNeighbors(rows) {
  state.lastNeighbors = rows || [];
  const tbody = qs('nn-table').querySelector('tbody');
  tbody.innerHTML = '';
  const rankMap = buildRankMap();

  rows.forEach((row) => {
    const rank = rankForPaperId(row.paper_id, rankMap);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${favoriteButton(row.paper_id)}</td>
      <td>${rank ?? '-'}</td>
      <td>${row.paper_id}</td>
      <td>${row.title}</td>
      <td>${row.cosine.toFixed(4)}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function refreshNeighbors() {
  if (!state.currentClickedPaperId) return;
  const k = Number(qs('nn-k').value || 10);
  try {
    const neighbors = neighborsLocally(
      state.currentClickedPaperId,
      k,
      state.currentPoints.map((p) => p.paper_id)
    );
    renderNeighbors(neighbors || []);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function downloadCSV(filename, rows) {
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          const str = String(v ?? '');
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replaceAll('"', '""')}"`;
          }
          return str;
        })
        .join(',')
    )
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportSelectedIds() {
  if (state.selectedPoints.length === 0) {
    setStatus('No selected points to export.');
    return;
  }
  const rows = [['paper_id'], ...state.selectedPoints.map((p) => [p.paper_id])];
  downloadCSV('selected_paper_ids.csv', rows);
}

function exportProjection() {
  if (state.currentPoints.length === 0) {
    setStatus('No projection data to export.');
    return;
  }

  const header = [
    'paper_id',
    'x',
    'y',
    'title',
    'session',
    'room_location',
    'type_presentation',
    'attendance_type',
  ];

  const rows = [
    header,
    ...state.currentPoints.map((p) => [
      p.paper_id,
      p.x,
      p.y,
      p.title,
      p.session,
      p.room_location,
      p.type_presentation,
      p.attendance_type,
    ]),
  ];
  downloadCSV('projection.csv', rows);
}

function collectViewState() {
  return {
    method: qs('method-select').value,
    params: getProjectionParams(),
    mode: getCurrentMode(),
    session_value: qs('session-select').value,
    filters: getCurrentFilters(),
    sample: {
      enabled: qs('sample-enabled').checked,
      max_points: Number(qs('sample-max-points').value || 960),
      strategy: qs('sample-strategy').value,
    },
    oral_only: qs('oral-only-toggle').checked,
    search_text: qs('search-text').value,
    search_mode: qs('search-mode').value,
  };
}

function applyViewState(saved) {
  if (!saved) return;

  if (saved.method) {
    qs('method-select').value = saved.method;
    updateMethodParamVisibility();
  }

  if (saved.params) {
    if (saved.method === 'pca') {
      qs('pca-whiten').checked = !!saved.params.whiten;
      if (saved.params.random_state != null) qs('pca-random-state').value = saved.params.random_state;
    }
    if (saved.method === 'tsne') {
      if (saved.params.perplexity != null) qs('tsne-perplexity').value = saved.params.perplexity;
      if (saved.params.learning_rate != null) qs('tsne-learning-rate').value = saved.params.learning_rate;
      if (saved.params.n_iter != null) qs('tsne-n-iter').value = saved.params.n_iter;
      if (saved.params.init) qs('tsne-init').value = saved.params.init;
      if (saved.params.metric) qs('tsne-metric').value = saved.params.metric;
      if (saved.params.random_state != null) qs('tsne-random-state').value = saved.params.random_state;
      if (saved.params.pca_components_for_tsne_umap != null) qs('tsne-pca-pre').value = saved.params.pca_components_for_tsne_umap;
    }
    if (saved.method === 'umap') {
      if (saved.params.n_neighbors != null) qs('umap-n-neighbors').value = saved.params.n_neighbors;
      if (saved.params.min_dist != null) qs('umap-min-dist').value = saved.params.min_dist;
      if (saved.params.metric) qs('umap-metric').value = saved.params.metric;
      if (saved.params.spread != null) qs('umap-spread').value = saved.params.spread;
      if (saved.params.random_state != null) qs('umap-random-state').value = saved.params.random_state;
      if (saved.params.pca_components_for_tsne_umap != null) qs('umap-pca-pre').value = saved.params.pca_components_for_tsne_umap;
    }
  }

  if (saved.mode) {
    const radio = document.querySelector(`input[name="mode"][value="${saved.mode}"]`);
    if (radio) radio.checked = true;
    updateModeUI();
  }

  if (saved.session_value) {
    qs('session-select').value = saved.session_value;
  }

  if (saved.sample) {
    qs('sample-enabled').checked = !!saved.sample.enabled;
    if (saved.sample.max_points != null) qs('sample-max-points').value = saved.sample.max_points;
    if (saved.sample.strategy) qs('sample-strategy').value = saved.sample.strategy;
  }

  if (saved.oral_only != null) {
    qs('oral-only-toggle').checked = !!saved.oral_only;
  }

  if (saved.search_text != null) qs('search-text').value = saved.search_text;
  if (saved.search_mode) qs('search-mode').value = saved.search_mode;

  if (saved.filters) {
    FILTER_COLUMNS.forEach((col) => {
      const allowed = new Set(saved.filters[col] || []);
      document.querySelectorAll(`input[type="checkbox"][data-column="${col}"]`).forEach((cb) => {
        cb.checked = allowed.has(cb.value);
      });
    });
  }
}

function saveViewState() {
  const view = collectViewState();
  localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(view));
  const encoded = encodeURIComponent(JSON.stringify(view));
  const url = new URL(window.location.href);
  url.searchParams.set('state', encoded);
  window.history.replaceState({}, '', url);
}

function loadViewState() {
  const fromQuery = new URLSearchParams(window.location.search).get('state');
  if (fromQuery) {
    try {
      return JSON.parse(decodeURIComponent(fromQuery));
    } catch {
      return null;
    }
  }

  const raw = localStorage.getItem(VIEW_STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function runProjection() {
  setLoading(true);
  try {
    const payload = buildProjectPayload();
    const data = projectLocally(payload);

    state.currentPoints = data.points || [];
    state.selectedPoints = getHighlightedRows();
    renderSelectionTable();
    renderPlot(state.currentPoints, data.color_by, payload.mode);
    renderStats(data.stats);
    saveViewState();

    setStatus(`Projection complete (${payload.method.toUpperCase()}) — static mode.`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setLoading(false);
  }
}

function resetFilters() {
  FILTER_COLUMNS.forEach((col) => {
    document.querySelectorAll(`input[type="checkbox"][data-column="${col}"]`).forEach((cb) => {
      cb.checked = true;
    });
  });
  setStatus('Filters reset.');
}

function wireEvents() {
  qs('method-select').addEventListener('change', updateMethodParamVisibility);
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener('change', updateModeUI);
  });

  qs('run-btn').addEventListener('click', runProjection);
  qs('reset-filters-btn').addEventListener('click', resetFilters);
  qs('export-selected-btn').addEventListener('click', exportSelectedIds);
  qs('export-projection-btn').addEventListener('click', exportProjection);
  qs('nn-refresh-btn').addEventListener('click', refreshNeighbors);
  qs('detail-favorite-btn').addEventListener('click', () => {
    if (state.currentClickedPaperId) requestFavoriteToggle(state.currentClickedPaperId);
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-favorite-id]');
    if (!button) return;
    event.preventDefault(); event.stopPropagation(); requestFavoriteToggle(button.dataset.favoriteId);
  });
  qs('toggle-controls-btn').addEventListener('click', () => {
    const collapsed = qs('viz-layout').classList.contains('left-collapsed');
    setPanelCollapsed('left', !collapsed);
  });
  qs('toggle-inspector-btn').addEventListener('click', () => {
    const collapsed = qs('viz-layout').classList.contains('right-collapsed');
    setPanelCollapsed('right', !collapsed);
  });
  qs('focus-plot-btn').addEventListener('click', toggleFocusPlot);
  qs('fullscreen-btn').addEventListener('click', toggleFullscreen);
  qs('legend-show-all-btn').addEventListener('click', () => {
    state.hiddenCategories.clear();
    renderPlot(state.currentPoints, state.lastPlotMeta.colorBy, state.lastPlotMeta.mode);
  });

  qs('share-link-btn').addEventListener('click', async () => {
    saveViewState();
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setStatus('Share link copied to clipboard.');
    } catch {
      setStatus(`Share link: ${url}`);
    }
  });

  qs('selection-table').querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        state.sort.dir = 'asc';
      }
      renderSelectionTable();
    });
  });
}

async function initMeta() {
  const meta = await loadStaticBundle();
  state.meta = meta;
  initColorMaps(meta);

  const sessions = meta.available_sessions || [];
  qs('session-select').innerHTML = sessions.map((s) => `<option value="${s}">${s}</option>`).join('');

  renderFilters(meta.filters || {});
}

async function init() {
  try {
    const conference = await fetchJSON('../data/conference.json');
    VIEW_STATE_KEY = `conference-paper-navigator:${conference.id}:embedding-view:v1`;
    RANKING_STORAGE_KEY = `conference-paper-navigator:${conference.id}:ratings:v1`;
    document.title = `${conference.name} Embedding Dashboard`;
    const heading = document.getElementById('viz-conference-name');
    if (heading) heading.textContent = `${conference.short_name || conference.name} Embeddings`;
    const oralShortcut = document.getElementById('oral-only-control');
    if (oralShortcut && conference.id === 'ijcai-2026') oralShortcut.hidden = true;
    wireEvents();
    updateLayoutButtons();
    refreshRatingsFromStorage();
    updateMethodParamVisibility();
    updateModeUI();
    await initMeta();

    const saved = loadViewState();
    if (saved) {
      applyViewState(saved);
    }

    await runProjection();
    window.parent.postMessage({ type: 'viz_ready' }, window.location.origin);
  } catch (err) {
    setStatus(err.message, true);
  }
}

window.addEventListener('storage', (event) => {
  if (event.key !== RANKING_STORAGE_KEY) return;
  refreshRatingsFromStorage();
  renderSelectionTable();
  if (state.lastNeighbors.length > 0) renderNeighbors(state.lastNeighbors);
  if (state.currentPoints.length > 0) {
    renderPlot(state.currentPoints, state.lastPlotMeta.colorBy, state.lastPlotMeta.mode);
  }
});

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data || {};
  if (data.type === 'viz_resize') {
    requestPlotResize({ updateMargins: true });
    return;
  }
  if (data.type !== 'ranking_state_update') return;
  let rankingStateChanged = false;
  if (data.payload?.ratings && typeof data.payload.ratings === 'object') {
    state.ratings = data.payload.ratings;
    rankingStateChanged = true;
  }
  if (data.payload?.favorites && typeof data.payload.favorites === 'object') {
    state.favorites = data.payload.favorites;
    rankingStateChanged = true;
  }
  if (rankingStateChanged) {
    renderSelectionTable();
    if (state.lastNeighbors.length > 0) renderNeighbors(state.lastNeighbors);
    if (state.currentPoints.length > 0) {
      renderPlot(state.currentPoints, state.lastPlotMeta.colorBy, state.lastPlotMeta.mode);
    }
  }
});

window.addEventListener('resize', () => {
  requestPlotResize({ updateMargins: true });
});

document.addEventListener('fullscreenchange', updateFullscreenButton);

init();
