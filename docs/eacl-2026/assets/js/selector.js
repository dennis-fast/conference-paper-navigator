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

export function chooseNextPair(items, state) {
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
