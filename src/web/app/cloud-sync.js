import { syncFingerprint } from "./sync-fingerprint.js";

const FIREBASE_SDK_VERSION = "12.16.0";
const SAVE_DELAY_MS = 500;
const MAX_SYNC_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;

export function isRetryableSyncError(error) {
  const code = String(error?.code || "").replace(/^firestore\//, "");
  if (["aborted", "failed-precondition", "unavailable", "deadline-exceeded"].includes(code)) return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("stored version")
    || message.includes("required base version")
    || message.includes("contention")
    || message.includes("transaction was aborted");
}

export function retryDelayMs(attempt) {
  return RETRY_BASE_DELAY_MS * (2 ** attempt);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function initializeCloudSync(options) {
  const {
    configUrl,
    conferenceId,
    signInButton,
    signOutButton,
    statusElement,
    getState,
    mergeStates,
    applyState,
    onUserChanged,
    onError,
  } = options;

  let runtimeConfig;
  try {
    const response = await fetch(configUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`configuration request failed (${response.status})`);
    runtimeConfig = await response.json();
  } catch (error) {
    statusElement.textContent = "Cloud sync unavailable";
    onError(`Could not load cloud-sync configuration: ${error.message}`);
    return { scheduleSave() {}, isEnabled: false };
  }

  if (!runtimeConfig.enabled) {
    statusElement.textContent = "Local storage only";
    signInButton.hidden = true;
    signOutButton.hidden = true;
    return { scheduleSave() {}, isEnabled: false };
  }
  if (!runtimeConfig.firebase?.apiKey || !runtimeConfig.firebase?.projectId || !runtimeConfig.firebase?.authDomain) {
    statusElement.textContent = "Cloud sync misconfigured";
    onError("Cloud sync is enabled, but the Firebase web configuration is incomplete.");
    return { scheduleSave() {}, isEnabled: false };
  }

  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
  const [{ initializeApp }, authApi, firestoreApi] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  const app = initializeApp(runtimeConfig.firebase);
  const auth = authApi.getAuth(app);
  const db = firestoreApi.getFirestore(app);
  const provider = new authApi.GoogleAuthProvider();
  let currentUser = null;
  let unsubscribe = null;
  let saveTimer = null;
  let syncStatusTimer = null;
  let syncInFlight = null;
  let pendingSync = null;

  function setSignedOutUI() {
    signInButton.hidden = false;
    signOutButton.hidden = true;
    statusElement.textContent = "Signed out · saved on this device";
  }

  function setSignedInUI(user, detail = "Syncing…") {
    signInButton.hidden = true;
    signOutButton.hidden = false;
    const identity = user.displayName || user.email || "Signed in";
    statusElement.textContent = `${identity} · ${detail}`;
  }

  function documentFor(user) {
    return firestoreApi.doc(db, "users", user.uid, "conferences", conferenceId);
  }

  function showSlowSync(user) {
    clearTimeout(syncStatusTimer);
    syncStatusTimer = setTimeout(() => {
      if (currentUser?.uid === user.uid) setSignedInUI(user, "Syncing…");
    }, 800);
  }

  function showSynced(user) {
    clearTimeout(syncStatusTimer);
    if (currentUser?.uid === user.uid) setSignedInUI(user, "Synced");
  }

  async function syncState(candidate = getState(), user = currentUser) {
    if (!user || currentUser?.uid !== user.uid) return;
    const reference = documentFor(user);
    showSlowSync(user);
    const merged = await firestoreApi.runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(reference);
      const remote = snapshot.exists() ? snapshot.data().state : null;
      const next = remote ? mergeStates(candidate, remote) : candidate;
      transaction.set(reference, {
        schema_version: 1,
        conference_id: conferenceId,
        state: next,
        updated_at: firestoreApi.serverTimestamp(),
      });
      return next;
    });
    if (currentUser?.uid !== user.uid) return;
    if (syncFingerprint(merged) !== syncFingerprint(getState())) applyState(merged);
    showSynced(user);
  }

  async function syncStateWithRetry(candidate, user) {
    let latest = candidate;
    for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
      try {
        return await syncState(latest, user);
      } catch (error) {
        const canRetry = currentUser?.uid === user.uid
          && isRetryableSyncError(error)
          && attempt + 1 < MAX_SYNC_ATTEMPTS;
        if (!canRetry) throw error;
        setSignedInUI(user, `Retrying sync (${attempt + 1}/${MAX_SYNC_ATTEMPTS - 1})…`);
        await delay(retryDelayMs(attempt));
        // Include edits and snapshots received while Firestore was resolving contention.
        latest = mergeStates(getState(), latest);
      }
    }
  }

  async function drainSyncQueue() {
    while (pendingSync) {
      const job = pendingSync;
      pendingSync = null;
      if (!job.user || currentUser?.uid !== job.user.uid) continue;
      try {
        await syncStateWithRetry(job.candidate, job.user);
      } catch (error) {
        clearTimeout(syncStatusTimer);
        if (currentUser?.uid === job.user.uid) setSignedInUI(job.user, "Sync failed · saved locally");
        onError(`Cloud sync failed: ${error.message}`);
      }
    }
  }

  function queueSync(candidate, user = currentUser) {
    if (!user || currentUser?.uid !== user.uid) return Promise.resolve();
    // Only the newest local snapshot needs to be written; merge semantics preserve
    // timestamped additions and deletions from earlier snapshots and other devices.
    pendingSync = { candidate: structuredClone(candidate), user };
    if (!syncInFlight) {
      syncInFlight = drainSyncQueue().finally(() => {
        syncInFlight = null;
        if (pendingSync) queueSync(pendingSync.candidate, pendingSync.user);
      });
    }
    return syncInFlight;
  }

  function scheduleSave(candidate = getState()) {
    if (!currentUser) return;
    clearTimeout(saveTimer);
    const snapshot = structuredClone(candidate);
    const user = currentUser;
    saveTimer = setTimeout(() => queueSync(snapshot, user), SAVE_DELAY_MS);
  }

  function subscribe(user) {
    unsubscribe?.();
    unsubscribe = firestoreApi.onSnapshot(
      documentFor(user),
      (snapshot) => {
        if (!snapshot.exists() || currentUser?.uid !== user.uid) return;
        try {
          const remote = snapshot.data().state;
          const merged = mergeStates(getState(), remote);
          if (syncFingerprint(merged) !== syncFingerprint(getState())) applyState(merged);
          if (syncFingerprint(merged) !== syncFingerprint(remote)) scheduleSave(merged);
          else if (!snapshot.metadata.hasPendingWrites) showSynced(user);
        } catch (error) {
          onError(`Could not apply cloud rankings: ${error.message}`);
        }
      },
      (error) => {
        setSignedInUI(user, "Sync failed · saved locally");
        onError(`Cloud listener failed: ${error.message}`);
      },
    );
  }

  setSignedOutUI();
  signInButton.addEventListener("click", async () => {
    try {
      await authApi.signInWithPopup(auth, provider);
    } catch (error) {
      onError(`Google sign-in failed: ${error.message}`);
    }
  });
  signOutButton.addEventListener("click", async () => {
    try {
      await authApi.signOut(auth);
    } catch (error) {
      onError(`Sign-out failed: ${error.message}`);
    }
  });

  authApi.onAuthStateChanged(auth, async (user) => {
    clearTimeout(saveTimer);
    clearTimeout(syncStatusTimer);
    unsubscribe?.();
    unsubscribe = null;
    currentUser = user;
    try {
      const local = onUserChanged(user);
      if (!user) {
        setSignedOutUI();
        return;
      }
      setSignedInUI(user);
      await queueSync(local, user);
      if (currentUser?.uid !== user.uid) return;
      subscribe(user);
    } catch (error) {
      if (user) setSignedInUI(user, "Sync failed · saved locally");
      onError(`Could not initialize cloud sync: ${error.message}`);
    }
  });

  return { scheduleSave, isEnabled: true };
}
