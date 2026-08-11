# Firebase cloud-sync setup

Cloud sync is disabled by default. Complete these steps before setting `enabled` to `true`; otherwise the public app either cannot sign users in or will be denied access to Firestore.

## 1. Create the project

1. Open the [Firebase console](https://console.firebase.google.com/) and create a project on the no-cost Spark plan. Google Analytics is not required.
2. Add a **Web app** to the project. Firebase will display its public configuration object.
3. Under **Authentication → Sign-in method**, enable **Google**.
4. Under **Authentication → Settings → Authorized domains**, add `dennis-fast.github.io`.
5. Create a **Cloud Firestore** database. Choose a nearby region and start with production rules.

## 2. Deploy the private-user rules

The repository's `firestore.rules` permits access only when the signed-in user's UID matches the `/users/{userId}` path and denies every other document path.

Either paste `firestore.rules` into **Firestore Database → Rules** in the Firebase console and publish it, or use the CLI:

```bash
npm install --global firebase-tools
firebase login
firebase use --add YOUR_FIREBASE_PROJECT_ID
firebase deploy --only firestore:rules
```

Do not enable cloud sync while Firestore has test-mode or otherwise public rules.

## 3. Add the web configuration

Copy the values Firebase gives you into `src/web/firebase-config.json` and switch `enabled` to `true`:

```json
{
  "enabled": true,
  "firebase": {
    "apiKey": "...",
    "authDomain": "YOUR_PROJECT.firebaseapp.com",
    "projectId": "YOUR_PROJECT",
    "storageBucket": "YOUR_PROJECT.firebasestorage.app",
    "messagingSenderId": "...",
    "appId": "..."
  }
}
```

Firebase web configuration identifies the project and is public by design. Authorization comes from Firebase Authentication and the deployed Firestore security rules.

## 4. Build and verify

```bash
make build-all
make test
make serve
```

Open `http://localhost:8000/docs/ijcai-2026/`, sign in, create a comparison, and confirm that Firestore contains:

```text
users/{your-firebase-uid}/conferences/ijcai-2026
```

Open a private browser window, sign into the same Google account, and verify that the ranking appears. Then sign in with a different account and verify that it sees an independent empty ranking.

## Synchronization behavior

- Signing out keeps the account's latest ranking in the conference's local browser key, so progress remains visible and editable on that device.
- Signed-out changes are merged back into Firestore when the same Firebase UID signs in again.
- Signed-in browser caches are additionally namespaced by Firebase UID.
- On first sign-in, the app asks before importing existing guest comparisons.
- Firestore transactions merge comparisons from multiple devices by stable event ID.
- Undo and reset are synchronized using deletion markers.
- If Firebase is unavailable, changes remain local and the status reports the sync failure.
- JSON export/import remains available as an independent backup.

The local copy remains readable after sign-out. On a shared device, clear the site's browser data when you are finished if you do not want the next browser user to see it.
