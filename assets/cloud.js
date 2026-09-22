/*
 * Preflight: accounts and synced progress (Firebase Auth + Firestore).
 * Loaded as a module after app.js. The app works without it; when this loads,
 * it exposes window.FlightDeckCloud and fires a "fd-auth" event on sign-in/out.
 */
const VERSION = '12.19.0';
const OWNER_EMAILS = ['andemarco15@gmail.com', 'antonio@onthespotcorp.com'];
const cfg = window.P107_FIREBASE;
const cloud = { available: false, ready: false, user: null };
window.FlightDeckCloud = cloud;

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function toUser(u) {
  if (!u) return null;
  return {
    uid: u.uid,
    name: u.displayName || '',
    email: u.email || '',
    photo: u.photoURL || '',
    provider: (u.providerData[0] && u.providerData[0].providerId) || 'password',
    owner: OWNER_EMAILS.includes((u.email || '').toLowerCase()),
  };
}

async function start() {
  if (!cfg || !cfg.apiKey || !cfg.projectId) {
    cloud.ready = true;
    emit('fd-auth', { user: null, available: false });
    return;
  }
  const base = `https://www.gstatic.com/firebasejs/${VERSION}`;
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  const app = initializeApp(cfg);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const ref = () => F.doc(db, 'users', auth.currentUser.uid);
  const profileRef = (uid) => F.doc(db, 'profiles', uid || auth.currentUser.uid);
  const OWNERS = OWNER_EMAILS;

  cloud.available = true;

  cloud.signInGoogle = async () => {
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await A.signInWithPopup(auth, provider);
    } catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
        await A.signInWithRedirect(auth, provider);
        return;
      }
      throw e;
    }
  };
  cloud.signUpEmail = async (name, email, password) => {
    const cred = await A.createUserWithEmailAndPassword(auth, email, password);
    if (name) {
      await A.updateProfile(cred.user, { displayName: name });
      cloud.user = toUser(auth.currentUser);
      emit('fd-auth', { user: cloud.user, available: true, profileUpdated: true });
    }
  };
  cloud.signInEmail = (email, password) => A.signInWithEmailAndPassword(auth, email, password);
  cloud.resetPassword = (email) => A.sendPasswordResetEmail(auth, email);
  cloud.signOut = () => A.signOut(auth);

  cloud.load = async () => {
    if (!auth.currentUser) return null;
    const snap = await F.getDoc(ref());
    if (!snap.exists()) return null;
    const d = snap.data();
    try {
      return typeof d.progress === 'string' ? JSON.parse(d.progress) : null;
    } catch (e) {
      return null;
    }
  };
  cloud.save = async (state) => {
    if (!auth.currentUser) return;
    await F.setDoc(ref(), { progress: JSON.stringify(state), updatedAt: F.serverTimestamp(), v: 1 });
  };
  // Each signed-in person keeps their own profile row up to date. Roles are set
  // by an admin; the two owner emails are always admin.
  cloud.syncProfile = async () => {
    const u = auth.currentUser;
    if (!u) return null;
    const owner = OWNERS.includes((u.email || '').toLowerCase());
    const snap = await F.getDoc(profileRef());
    const fields = {
      name: u.displayName || '',
      email: u.email || '',
      photo: u.photoURL || '',
      provider: (u.providerData[0] && u.providerData[0].providerId) || 'password',
      lastSeen: F.serverTimestamp(),
    };
    if (!snap.exists()) {
      await F.setDoc(profileRef(), Object.assign({ role: owner ? 'admin' : 'basic', createdAt: F.serverTimestamp() }, fields));
      return owner ? 'admin' : 'basic';
    }
    const role = snap.data().role || 'basic';
    if (owner && role !== 'admin') {
      await F.setDoc(profileRef(), Object.assign({ role: 'admin' }, fields), { merge: true });
      return 'admin';
    }
    await F.setDoc(profileRef(), fields, { merge: true });
    return role;
  };

  cloud.listProfiles = async () => {
    const snap = await F.getDocs(F.collection(db, 'profiles'));
    return snap.docs.map((d) => {
      const v = d.data();
      return {
        uid: d.id,
        name: v.name || '',
        email: v.email || '',
        photo: v.photo || '',
        provider: v.provider || '',
        role: v.role || 'basic',
        createdAt: v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : null,
        lastSeen: v.lastSeen && v.lastSeen.toMillis ? v.lastSeen.toMillis() : null,
        owner: OWNERS.includes((v.email || '').toLowerCase()),
      };
    });
  };

  cloud.setRole = (uid, role) => F.updateDoc(profileRef(uid), { role });

  cloud.deleteAccount = async () => {
    if (!auth.currentUser) return;
    await F.deleteDoc(ref());
    try { await F.deleteDoc(profileRef()); } catch (e) { /* profile may already be gone */ }
    await A.deleteUser(auth.currentUser);
  };
  cloud.reauthenticate = async (password) => {
    const u = auth.currentUser;
    if (!u) return;
    if (password) await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, password));
    else await A.reauthenticateWithPopup(u, new A.GoogleAuthProvider());
  };

  try { await A.getRedirectResult(auth); } catch (e) { emit('fd-auth-error', { error: e }); }

  A.onAuthStateChanged(auth, (u) => {
    cloud.user = toUser(u);
    cloud.ready = true;
    emit('fd-auth', { user: cloud.user, available: true });
  });
}

start().catch((e) => {
  cloud.ready = true;
  cloud.available = false;
  emit('fd-auth', { user: null, available: false, error: String(e && e.message || e) });
});
