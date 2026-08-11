import { syncFingerprint } from "./sync-fingerprint.js";

const FIREBASE_SDK_VERSION = "12.16.0";
const SAVE_DELAY_MS = 500;

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
  let syncInFlight = Promise.resolve();

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

  function queueSync(candidate, user = currentUser) {
    syncInFlight = syncInFlight
      .then(() => syncState(candidate, user))
      .catch((error) => {
        clearTimeout(syncStatusTimer);
        if (currentUser) setSignedInUI(currentUser, "Sync failed · saved locally");
        onError(`Cloud sync failed: ${error.message}`);
      });
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
