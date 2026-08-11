export function mergeComparisonData(local, remote) {
  const resetAt = [local.reset_at, remote.reset_at].filter(Boolean).sort().at(-1) || "";
  const tombstones = new Set([...local.history_tombstones, ...remote.history_tombstones]);
  const entries = new Map();
  for (const entry of [...remote.history, ...local.history]) entries.set(entry.id, entry);
  const history = [...entries.values()]
    .filter((entry) => !tombstones.has(entry.id) && (!resetAt || (entry.ts && entry.ts > resetAt)))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const localIsNewer = (local.modified_at || "") >= (remote.modified_at || "");
  return {
    history,
    history_tombstones: [...tombstones].sort(),
    reset_at: resetAt,
    localIsNewer,
  };
}
