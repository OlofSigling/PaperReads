// Friends, Goodreads-style, through the owner's Firebase project.
//
// Shared: the papers on your shelves (want / reading / read) with title,
// authors, ids, status, stars and dates; nothing else (notes, concerns,
// highlights and files stay on your devices). A paper marked private isn't
// shared. Firestore security rules (shown in Settings) let only accepted
// friends read a shelf.
//
// Firestore layout
//   users/{uid}                        { name, photo }                 any signed-in user may read
//   friendships/{uidA_uidB}            { members, requestedBy, status } members only
//   shelves/{uid}/papers/{paperId}     the shared fields               owner + accepted friends
const Social = (() => {
  const base = new URL('.', document.baseURI).href;
  const SHELVES = new Set(['want', 'reading', 'read']);
  let fb = null;
  let auth = null;
  let db = null;
  let user = null;
  let ready = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(user));

  // The config Firebase shows for a web app, pasted as JSON or as the
  // `const firebaseConfig = { … }` snippet.
  function parseConfig(text) {
    const m = /\{[\s\S]*\}/.exec(String(text || ''));
    if (!m) return null;
    const tryJson = (t) => {
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    };
    const o =
      tryJson(m[0]) ||
      tryJson(
        m[0]
          .replace(/\/\/[^\n]*/g, '')
          .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
          .replace(/'/g, '"')
          .replace(/,\s*}/g, '}')
      );
    return o && o.apiKey && o.projectId && o.authDomain ? { apiKey: o.apiKey, authDomain: o.authDomain, projectId: o.projectId, appId: o.appId || '' } : null;
  }
  const config = async () => DB.setting('firebaseConfig', null);

  function init() {
    if (!ready)
      ready = (async () => {
        const c = await config();
        if (!c) return false;
        fb = await import(base + 'vendor/firebase.min.mjs');
        const app = fb.initializeApp(c);
        auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence], popupRedirectResolver: fb.browserPopupRedirectResolver });
        db = fb.getFirestore(app);
        await new Promise((resolve) =>
          fb.onAuthStateChanged(auth, (u) => {
            user = u;
            emit();
            resolve();
          })
        );
        try {
          await fb.getRedirectResult(auth); // back from a redirect sign-in
        } catch {}
        if (user) await saveProfile();
        return true;
      })().catch((err) => {
        ready = null;
        throw err;
      });
    return ready;
  }

  async function signIn() {
    if (!(await init())) throw new Error('Friends aren’t set up yet (Settings → Friends).');
    const provider = new fb.GoogleAuthProvider();
    try {
      await fb.signInWithPopup(auth, provider);
    } catch (err) {
      // popups blocked or unsupported (some installed apps): go to Google's page instead
      const code = err.code || '';
      if (/popup-blocked|operation-not-supported/.test(code)) return fb.signInWithRedirect(auth, provider);
      if (/popup-closed|cancelled-popup/.test(code)) throw new Error('Sign-in was cancelled.');
      throw new Error(friendly(err));
    }
    await saveProfile();
    schedule(500);
  }
  async function signOutNow() {
    if (auth) await fb.signOut(auth);
  }

  function friendly(err) {
    const code = err.code || '';
    if (code.includes('unauthorized-domain')) return `This site isn’t allowed to sign in yet: add ${location.hostname} under Authentication → Settings → Authorised domains in Firebase.`;
    if (code.includes('permission-denied')) return 'Firebase refused this (the security rules may be missing: see Settings → Friends).';
    if (code.includes('unavailable') || code.includes('network')) return 'Couldn’t reach Firebase. Are you online?';
    return err.message || String(err);
  }

  const me = () => user && user.uid;
  const pairId = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  async function saveProfile() {
    await fb.setDoc(fb.doc(db, 'users', me()), { name: user.displayName || 'PaperReads reader', photo: user.photoURL || '', updatedAt: Date.now() }, { merge: true });
  }
  async function profile(uid) {
    await init();
    const s = await fb.getDoc(fb.doc(db, 'users', uid));
    return s.exists() ? { uid, ...s.data() } : null;
  }

  // ---------------------------------------------------------------- friends
  async function friendships() {
    await init();
    if (!user) return [];
    const snap = await fb.getDocs(fb.query(fb.collection(db, 'friendships'), fb.where('members', 'array-contains', me())));
    return snap.docs.map((d) => {
      const f = d.data();
      const other = f.members.find((m) => m !== me());
      return { id: d.id, other, name: (f.names && f.names[other]) || 'Someone', status: f.status, incoming: f.status === 'pending' && f.requestedBy !== me() };
    });
  }

  async function addFriend(uid) {
    await init();
    if (!user) throw new Error('Sign in first.');
    if (uid === me()) throw new Error('That’s your own link.');
    const existing = (await friendships()).find((f) => f.other === uid);
    if (existing) {
      if (existing.incoming) return accept(existing.id), 'accepted';
      return existing.status === 'accepted' ? 'already' : 'pending';
    }
    const them = await profile(uid);
    if (!them) throw new Error('No PaperReads reader found for that link.');
    const members = [me(), uid].sort();
    try {
      await fb.setDoc(fb.doc(db, 'friendships', pairId(me(), uid)), {
        members,
        requestedBy: me(),
        status: 'pending',
        names: { [me()]: user.displayName || 'PaperReads reader', [uid]: them.name },
        createdAt: Date.now(),
      });
    } catch (err) {
      throw new Error(friendly(err));
    }
    return 'requested';
  }
  async function accept(id) {
    await fb.updateDoc(fb.doc(db, 'friendships', id), { status: 'accepted', acceptedAt: Date.now() });
  }
  async function remove(id) {
    await fb.deleteDoc(fb.doc(db, 'friendships', id));
  }

  // A link that adds you; it carries the (public) Firebase config so a
  // friend's app can join even if it wasn't set up.
  async function addLink() {
    const c = await config();
    const pack = btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${location.origin}${location.pathname}#/friends?add=${encodeURIComponent(me())}&c=${pack}`;
  }
  function configFromLink(packed) {
    try {
      return parseConfig(atob(packed.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- shelves
  function shared(p) {
    return {
      title: p.title || '',
      authors: (p.authors || []).slice(0, 6),
      year: p.year || null,
      venue: p.venue || '',
      doi: p.doi || '',
      arxiv: p.arxiv || '',
      url: p.url || '',
      status: p.status,
      rating: p.rating || 0,
      startedAt: p.startedAt || null,
      finishedAt: p.finishedAt || null,
    };
  }

  // Bring the shared copy of your shelves up to date: only what changed.
  let publishing = null;
  async function publish() {
    if (publishing) return publishing;
    publishing = (async () => {
      if (!(await init()) || !user || !navigator.onLine) return 0;
      const papers = (await DB.all('papers')).filter((p) => SHELVES.has(p.status) && !p.private);
      const was = (await DB.setting(`socialPublished:${me()}`, {})) || {};
      const now = {};
      const ops = [];
      for (const p of papers) {
        const data = shared(p);
        const key = JSON.stringify(data);
        now[p.id] = key;
        // when the shared fields last changed, the same on all your devices
        const t = Math.max(0, ...['status', 'rating', 'startedAt', 'finishedAt', 'title'].map((k) => (p.ft && p.ft[k]) || 0)) || p.updatedAt || Date.now();
        if (was[p.id] !== key) ops.push(['set', p.id, { ...data, updatedAt: t }]);
      }
      for (const id of Object.keys(was)) if (!(id in now)) ops.push(['del', id]);
      for (let i = 0; i < ops.length; i += 400) {
        const batch = fb.writeBatch(db);
        for (const [op, id, data] of ops.slice(i, i + 400)) {
          const ref = fb.doc(db, 'shelves', me(), 'papers', id);
          if (op === 'set') batch.set(ref, data);
          else batch.delete(ref);
        }
        await batch.commit();
      }
      await DB.quietly(() => DB.setSetting(`socialPublished:${me()}`, now));
      return ops.length;
    })().finally(() => (publishing = null));
    return publishing;
  }
  let timer = null;
  function schedule(ms = 8000) {
    clearTimeout(timer);
    timer = setTimeout(() => publish().catch(() => {}), ms);
  }

  async function shelf(uid) {
    await init();
    const snap = await fb.getDocs(fb.collection(db, 'shelves', uid, 'papers'));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // Recent shelf changes across friends, newest first.
  async function feed(friends, per = 12) {
    await init();
    const lists = await Promise.all(
      friends.map((f) =>
        fb
          .getDocs(fb.query(fb.collection(db, 'shelves', f.other, 'papers'), fb.orderBy('updatedAt', 'desc'), fb.limit(per)))
          .then((s) => s.docs.map((d) => ({ ...d.data(), id: d.id, who: f.name, uid: f.other })))
          .catch(() => [])
      )
    );
    return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function start() {
    if (!(await config())) return;
    try {
      await init();
      if (user) schedule(3000);
    } catch {}
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && timer) {
        clearTimeout(timer);
        publish().catch(() => {});
      }
    });
  }

  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    function pair(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
    function friends(a, b) {
      let f = /databases/$(database)/documents/friendships/$(pair(a, b));
      return exists(f) && get(f).data.status == 'accepted';
    }
    match /users/{uid} {
      allow read: if signedIn();
      allow write: if signedIn() && request.auth.uid == uid;
    }
    match /friendships/{id} {
      allow read: if signedIn() && request.auth.uid in resource.data.members;
      allow create: if signedIn()
        && request.resource.data.requestedBy == request.auth.uid
        && request.resource.data.status == 'pending'
        && request.auth.uid in request.resource.data.members
        && request.resource.data.members.size() == 2
        && request.resource.data.members[0] != request.resource.data.members[1]
        && id == pair(request.resource.data.members[0], request.resource.data.members[1]);
      allow update: if signedIn()
        && request.auth.uid in resource.data.members
        && request.auth.uid != resource.data.requestedBy
        && resource.data.status == 'pending'
        && request.resource.data.status == 'accepted'
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'acceptedAt']);
      allow delete: if signedIn() && request.auth.uid in resource.data.members;
    }
    match /shelves/{uid}/papers/{pid} {
      allow read: if signedIn() && (request.auth.uid == uid || friends(request.auth.uid, uid));
      allow write: if signedIn() && request.auth.uid == uid;
    }
  }
}`;

  return {
    init,
    start,
    signIn,
    signOut: signOutNow,
    parseConfig,
    config,
    configFromLink,
    get user() {
      return user;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    friendships,
    addFriend,
    accept,
    remove,
    addLink,
    profile,
    shelf,
    feed,
    publish,
    schedule,
    friendly,
    RULES,
  };
})();
