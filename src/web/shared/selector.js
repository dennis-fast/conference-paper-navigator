// selector.js
function randInt(n){ return Math.floor(Math.random() * n); }

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function getMuPriority(state) {
  return (state.muPriority ?? "highest").toLowerCase();
}

function getNStrategy(state) {
  return (state.resolveTieNMatches ?? "minimal").toLowerCase();
}

function applyWinsFilter(items, state) {
  if (!state.winsOnly) return items;
  return items.filter((x) => Number(x.wins ?? 0) >= 1);
}

function orderByMuPriority(items, state) {
  const priority = getMuPriority(state);
  if (priority === "lowest") {
    return [...items].sort((a, b) => a.mu - b.mu);
  }
  if (priority === "random") {
    return shuffle(items);
  }
  return [...items].sort((a, b) => b.mu - a.mu);
}

function selectGroupByN(items, state) {
  if (items.length <= 1) return items;
  const grouped = new Map();
  for (const item of items) {
    const key = Number(item.n ?? 0);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const nValues = [...grouped.keys()].sort((a, b) => a - b);
  const strategy = getNStrategy(state);
  let targetN = nValues[0];
  if (strategy === "maximal") {
    targetN = nValues[nValues.length - 1];
  } else if (strategy === "random") {
    targetN = nValues[randInt(nValues.length)];
  }
  return grouped.get(targetN) ?? items;
}

function pickTwoFromPool(pool, lastIds, state) {
  const candidates = selectGroupByN(pool, state);
  const first = pickNotIn(candidates, lastIds) ?? candidates[0];
  if (!first) return null;
  const secondCandidates = candidates.filter((x) => x.id !== first.id);
  if (secondCandidates.length === 0) return null;
  const second = pickNotIn(secondCandidates, lastIds) ?? secondCandidates[0];
  if (!second) return null;
  return [first, second];
}

function chooseLegacyPair(items, state) {
  // items: [{id, mu, sigma, ...}, ...] already filtered
  if (items.length < 2) return null;

  const effectiveItems = applyWinsFilter(items, state);
  if (effectiveItems.length < 2) return null;
  const prioritized = orderByMuPriority(effectiveItems, state);

  const last = state.lastPair ?? [];
  const lastIds = new Set(last.map(x => x?.id).filter(Boolean));

  const mode = state.mode ?? "active";
  if (mode === "resolve_ties") {
    const tiePair = chooseTieResolutionPair(prioritized, state, lastIds);
    if (tiePair) return tiePair;
  }

  if (mode === "random") {
    return pickTwoFromPool(prioritized, lastIds, state);
  }

  // Active: pick high uncertainty item, then opponent close in mu (≈ 50/50),
  // with diversity constraints to avoid same-category spam.
  const focusCount = Math.max(2, Math.ceil(prioritized.length * 0.4));
  const focusPool = prioritized.slice(0, focusCount);

  // pick candidate A among top uncertain
  const byUnc = [...focusPool].sort((x,y) => y.sigma - x.sigma);
  const poolA = byUnc.slice(0, Math.min(40, byUnc.length));
  const poolAByN = selectGroupByN(poolA, state);

  // lightly avoid repeats
  const A = pickNotIn(poolAByN, lastIds) ?? poolAByN[0];
  if (!A) return null;

  // opponent candidates: close mu and high sigma
  const candidates = prioritized
    .filter(x => x.id !== A.id)
    .map(x => ({
      x,
      closeness: Math.abs(x.mu - A.mu),
      info: x.sigma
    }))
    .sort((u,v) => (u.closeness - v.closeness) || (v.info - u.info));

  // Diversity constraint: prefer different primary category when possible
  const Acat = A.cat1 ?? "";
  const diverse = candidates.filter(c => (c.x.cat1 ?? "") !== Acat);
  const poolB = (diverse.length ? diverse : candidates).slice(0, 30);

  // Bubble mode: focus on boundary near topN
  if (mode === "bubble") {
    const topN = Math.max(10, Number(state.topN ?? 60));
    const boundarySource = getMuPriority(state) === "lowest" ? [...prioritized].reverse() : prioritized;
    const boundary = boundarySource.slice(0, topN + 20); // include bubble region
    const boundaryIds = new Set(boundary.map(x => x.id));
    if (boundaryIds.has(A.id)) {
      const poolB2 = poolB.filter(c => boundaryIds.has(c.x.id));
      if (poolB2.length) {
        const chosenBPool = selectGroupByN(poolB2.map((p) => p.x), state);
        const B2 = pickNotIn(chosenBPool, lastIds) ?? chosenBPool[0];
        if (B2) return [A, B2];
      }
    }
  }

  // avoid showing same opponent repeatedly
  const finalBPool = selectGroupByN(poolB.map(p => p.x), state);
  const B = pickNotIn(finalBPool, lastIds) ?? finalBPool[0];
  if (!B) return null;
  return [A, B];
}

function selectedFavoriteCount(state) {
  return Object.values(state.favorites || {}).filter((favorite) => favorite?.selected).length;
}

function scheduledPresentations(item, kinds) {
  return (item.presentations || []).filter((presentation) => kinds.includes(presentation.type));
}

function scheduleKey(presentation) {
  return `${presentation.date || "Unscheduled"}|||${presentation.time || "Time unavailable"}`;
}

function smartResult(pair, reason, stage, target = null) {
  return pair ? { pair, reason, stage, target } : null;
}

function underexploredClusters(items, state) {
  const explored = new Set(items.filter((item) => item.n > 0 || item.favorite).map((item) => item.cluster).filter((value) => value != null));
  return new Set(items.map((item) => item.cluster).filter((value) => value != null && !explored.has(value)));
}

function chooseDiscoveryPair(items, state, lastIds) {
  const unexplored = underexploredClusters(items, state);
  const ordered = [...items].sort((a, b) => {
    const clusterA = unexplored.has(a.cluster) ? 1 : 0;
    const clusterB = unexplored.has(b.cluster) ? 1 : 0;
    const representativeA = a.representative ? 1 : 0;
    const representativeB = b.representative ? 1 : 0;
    return (clusterB - clusterA) || (representativeB - representativeA) || (a.n - b.n) || (b.sigma - a.sigma) || a.id.localeCompare(b.id);
  });
  const A = pickNotIn(ordered, lastIds) || ordered[0];
  if (!A) return null;
  const opponents = ordered
    .filter((item) => item.id !== A.id)
    .sort((a, b) => {
      const differentA = a.cluster !== A.cluster ? 1 : 0;
      const differentB = b.cluster !== A.cluster ? 1 : 0;
      return (differentB - differentA) || (a.n - b.n) || Math.abs(a.mu - A.mu) - Math.abs(b.mu - A.mu);
    });
  const B = pickNotIn(opponents, lastIds) || opponents[0];
  return B ? [A, B] : null;
}

function pairRepeatCount(state, a, b) {
  return (state.history || []).filter((entry) => (
    (String(entry.a) === a.id && String(entry.b) === b.id)
    || (String(entry.a) === b.id && String(entry.b) === a.id)
  )).length;
}

function oralPairForSlot(items, key, lastIds, state) {
  const records = items.flatMap((item) => scheduledPresentations(item, ["oral"])
    .filter((presentation) => scheduleKey(presentation) === key)
    .map((presentation) => ({ item, room: presentation.location || "Location unavailable" })));
  const rooms = new Map();
  for (const record of records) {
    if (!rooms.has(record.room)) rooms.set(record.room, []);
    rooms.get(record.room).push(record.item);
  }
  if (rooms.size < 2) return null;
  const contenders = [...rooms.entries()].map(([room, roomItems]) => ({
    room,
    item: [...roomItems].sort((a, b) => b.mu - a.mu || b.sigma - a.sigma)[0],
  })).sort((a, b) => b.item.mu - a.item.mu);
  let best = null;
  for (let left = 0; left < contenders.length; left += 1) {
    for (let right = left + 1; right < contenders.length; right += 1) {
      const A = contenders[left].item;
      const B = contenders[right].item;
      const repeatPenalty = (lastIds.has(A.id) || lastIds.has(B.id) ? 80 : 0) + 120 * pairRepeatCount(state, A, B);
      const value = A.sigma + B.sigma - Math.abs(A.mu - B.mu) - repeatPenalty;
      if (!best || value > best.value) best = { pair: [A, B], value };
    }
  }
  return best?.pair || null;
}

function posterPairForBlock(items, key, targetCount, lastIds, state) {
  const candidates = items.filter((item) => scheduledPresentations(item, ["poster", "demo"])
    .some((presentation) => scheduleKey(presentation) === key));
  if (candidates.length < 2) return null;
  const ranked = [...candidates].sort((a, b) => b.mu - a.mu);
  const boundary = Math.max(1, Math.min(ranked.length - 1, targetCount));
  const pool = ranked.slice(Math.max(0, boundary - 4), Math.min(ranked.length, boundary + 4));
  let best = null;
  for (let left = 0; left < pool.length; left += 1) {
    for (let right = left + 1; right < pool.length; right += 1) {
      const A = pool[left]; const B = pool[right];
      const repeatPenalty = (lastIds.has(A.id) || lastIds.has(B.id) ? 80 : 0) + 120 * pairRepeatCount(state, A, B);
      const value = A.sigma + B.sigma - Math.abs(A.mu - B.mu) - repeatPenalty;
      if (!best || value > best.value) best = { pair: [A, B], value };
    }
  }
  return best?.pair || null;
}

function allScheduleKeys(items, kinds) {
  const counts = new Map();
  for (const item of items) {
    for (const presentation of scheduledPresentations(item, kinds)) {
      const key = scheduleKey(presentation);
      if (!counts.has(key)) counts.set(key, { papers: new Set(), rooms: new Set() });
      counts.get(key).papers.add(item.id);
      if (presentation.location) counts.get(key).rooms.add(presentation.location);
    }
  }
  return [...counts.entries()].filter(([, value]) => value.papers.size >= 2);
}

function chooseAutomaticDecisionPair(items, state, lastIds) {
  const oralKeys = allScheduleKeys(items, ["oral"]).filter(([, value]) => value.rooms.size >= 2).map(([key]) => key);
  const posterKeys = allScheduleKeys(items, ["poster", "demo"]).map(([key]) => key);
  const preferPoster = (state.history?.length || 0) % 3 === 2;
  const attempts = preferPoster ? ["poster", "oral"] : ["oral", "poster"];
  for (const kind of attempts) {
    const keys = kind === "oral" ? oralKeys : posterKeys;
    let best = null;
    for (const key of keys) {
      const pair = kind === "oral"
        ? oralPairForSlot(items, key, lastIds, state)
        : posterPairForBlock(items, key, Number(state.posterTarget || 10), lastIds, state);
      if (!pair) continue;
      const value = pair[0].sigma + pair[1].sigma - Math.abs(pair[0].mu - pair[1].mu);
      if (!best || value > best.value) best = { pair, key, kind, value };
    }
    if (best) {
      const label = best.key.replace("|||", " · ");
      const reason = best.kind === "oral"
        ? `This comparison could change your room choice for ${label}.`
        : `These papers are near the must-visit cutoff for ${label}.`;
      return smartResult(best.pair, reason, "Decide", { kind: best.kind, key: best.key });
    }
  }
  return null;
}

function chooseTopBoundaryPair(items, state, lastIds) {
  const ranked = [...items].sort((a, b) => b.mu - a.mu);
  const boundary = Math.max(1, Math.min(ranked.length - 1, Number(state.topN || 60)));
  const pool = ranked.slice(Math.max(0, boundary - 6), Math.min(ranked.length, boundary + 6));
  let best = null;
  for (let left = 0; left < pool.length; left += 1) {
    for (let right = left + 1; right < pool.length; right += 1) {
      const A = pool[left]; const B = pool[right];
      const repeatPenalty = (lastIds.has(A.id) || lastIds.has(B.id) ? 80 : 0) + 120 * pairRepeatCount(state, A, B);
      const value = A.sigma + B.sigma - Math.abs(A.mu - B.mu) - repeatPenalty;
      if (!best || value > best.value) best = { pair: [A, B], value };
    }
  }
  return best?.pair || null;
}

function chooseSmartPair(items, state) {
  if (items.length < 2) return null;
  const lastIds = new Set((state.lastPair || []).map((item) => item?.id).filter(Boolean));
  const comparisons = (state.history || []).filter((entry) => entry.outcome != null).length;
  const favorites = selectedFavoriteCount(state);
  const coveredClusters = new Set(items.filter((item) => item.n > 0 || item.favorite).map((item) => item.cluster).filter((value) => value != null));
  const totalClusters = new Set(items.map((item) => item.cluster).filter((value) => value != null)).size;
  const discovery = comparisons < 15 || (totalClusters > 0 && coveredClusters.size / totalClusters < 0.3);

  const target = state.smartTarget;
  if (target?.kind === "oral" && target.key) {
    const pair = oralPairForSlot(items, target.key, lastIds, state);
    if (pair) return smartResult(pair, `Resolving your room choice for ${target.key.replace("|||", " · ")}.`, "Decide", target);
  }
  if (target?.kind === "poster" && target.key) {
    const pair = posterPairForBlock(items, target.key, Number(state.posterTarget || 10), lastIds, state);
    if (pair) return smartResult(pair, `Refining the must-visit cutoff for ${target.key.replace("|||", " · ")}.`, "Decide", target);
  }

  if (discovery) {
    const pair = chooseDiscoveryPair(items, state, lastIds);
    const prompt = favorites
      ? "Exploring a new semantic area to learn beyond your favorites."
      : "Broad preference discovery: comparing representative papers from different topics.";
    return smartResult(pair, prompt, "Discover");
  }

  if (comparisons < 35) {
    const pair = chooseLegacyPair(items, { ...state, mode: "active" });
    return smartResult(pair, "Learning the shape of your preferences before concentrating on schedule conflicts.", "Learn");
  }

  // Most questions alter an actual schedule decision. One in twelve refines
  // the global shortlist boundary and one in twelve explores broadly.
  const cycle = (state.history?.length || 0) % 12;
  if (![5, 11].includes(cycle)) {
    const decision = chooseAutomaticDecisionPair(items, state, lastIds);
    if (decision) return decision;
  }
  if (cycle === 11) {
    const pair = chooseTopBoundaryPair(items, state, lastIds);
    if (pair) return smartResult(pair, `Refining the boundary of your global top ${Number(state.topN || 60)} shortlist.`, "Refine");
  }
  if (cycle === 5) {
    const pair = chooseDiscoveryPair(items, state, lastIds);
    if (pair) return smartResult(pair, "Exploring an underrepresented semantic area for possible hidden gems.", "Explore");
  }
  const fallback = chooseLegacyPair(items, { ...state, mode: "active" });
  return smartResult(fallback, "Learning an uncertain part of your general preference ranking.", "Learn");
}

export function chooseNextPair(items, state) {
  if ((state.mode || "smart") === "smart") return chooseSmartPair(items, state);
  const pair = chooseLegacyPair(items, state);
  const labels = {
    random: "Random comparison from the current filters.",
    bubble: "Refining the boundary of your global top-N list.",
    resolve_ties: "Resolving papers with equal current scores.",
    active: "Uncertainty-aware global ranking comparison.",
  };
  return smartResult(pair, labels[state.mode] || labels.active, "Advanced");
}

function chooseTieResolutionPair(items, state, lastIds) {
  const groupedByMu = new Map();
  for (const item of items) {
    const key = Number(item.mu).toFixed(6);
    if (!groupedByMu.has(key)) groupedByMu.set(key, []);
    groupedByMu.get(key).push(item);
  }

  const tiedGroups = [...groupedByMu.entries()]
    .map(([muKey, group]) => ({ mu: Number(muKey), group }))
    .filter((entry) => entry.group.length >= 2);

  const muPriority = getMuPriority(state);
  if (muPriority === "lowest") {
    tiedGroups.sort((a, b) => a.mu - b.mu);
  } else if (muPriority === "random") {
    tiedGroups.sort(() => Math.random() - 0.5);
  } else {
    tiedGroups.sort((a, b) => b.mu - a.mu);
  }

  if (tiedGroups.length === 0) return null;

  const strategy = getNStrategy(state);

  for (const tieGroupEntry of tiedGroups) {
    const topTieGroup = tieGroupEntry.group;

    const candidatePool = applyWinsFilter(topTieGroup, state);

    const groupedByN = new Map();
    for (const item of candidatePool) {
      const key = Number(item.n ?? 0);
      if (!groupedByN.has(key)) groupedByN.set(key, []);
      groupedByN.get(key).push(item);
    }

    const availableN = [...groupedByN.keys()]
      .filter((nValue) => (groupedByN.get(nValue) ?? []).length >= 2)
      .sort((a, b) => a - b);

    if (availableN.length > 0) {
      let targetN = availableN[0];
      if (strategy === "maximal") {
        targetN = availableN[availableN.length - 1];
      } else if (strategy === "random") {
        targetN = availableN[randInt(availableN.length)];
      }

      const selectedGroup = groupedByN.get(targetN) ?? [];
      const first = pickNotIn(selectedGroup, lastIds) ?? selectedGroup[0];
      const secondCandidates = selectedGroup.filter((x) => x.id !== first.id);
      const second = pickNotIn(secondCandidates, lastIds) ?? secondCandidates[0];
      if (first && second) return [first, second];
    }

    const fallbackPair = pickTwoFromPool(candidatePool, lastIds, state);
    if (fallbackPair) return fallbackPair;
  }

  return null;
}

function pickNotIn(arr, bannedSet) {
  for (const x of arr) {
    if (!bannedSet.has(x.id)) return x;
  }
  return null;
}
