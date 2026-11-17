/* =====================================================================
   Legnano Chapter - ponte tra l'app e Supabase
   Fornisce all'app gli stessi servizi che aveva su Claude
   (claude.use("db" | "user" | "downloads")) usando Supabase:
   database, login con email e password, aggiornamenti in tempo reale.
   ===================================================================== */
(function () {
  const SUPABASE_URL = "https://qnpletkpewqhtzsnrcqb.supabase.co";
  const SUPABASE_KEY = "sb_publishable_nrjLtGqEuWJO8Xm11tK_qg_MMNIHgnw"; // chiave pubblica

  const SB = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  window.__sb = SB;

  /* ---------------- errori: stesso formato dell'app ---------------- */
  function wrap(e) {
    const err = new Error((e && e.message) || "Errore");
    const deny = ["42501", "P0002", "PGRST301", "PGRST116"];
    err.code = e && deny.includes(e.code) ? "invalid_argument" : (e && e.code) || "unknown";
    return err;
  }
  const newId = () => {
    const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = ""; const r = crypto.getRandomValues(new Uint8Array(20));
    r.forEach(n => (s += c[n % c.length])); return s;
  };

  /* ---------------- tempo reale: un canale per collezione ---------------- */
  const watchers = new Map();
  function watch(col, fn) {
    let w = watchers.get(col);
    if (!w) {
      w = { fns: new Set(), t: null };
      w.ch = SB.channel("docs-" + col)
        .on("postgres_changes",
            { event: "*", schema: "public", table: "docs", filter: "collection=eq." + col },
            () => { clearTimeout(w.t); w.t = setTimeout(() => w.fns.forEach(f => f()), 120); })
        .subscribe();
      watchers.set(col, w);
    }
    w.fns.add(fn);
    return () => w.fns.delete(fn);
  }

  /* ---------------- snapshot ---------------- */
  const docSnap = (id, row) => ({ id, exists: !!row, data: () => (row ? row.data : undefined) });
  const colSnap = rows => ({
    docs: rows.map(r => ({ id: r.id, exists: true, data: () => r.data })),
    size: rows.length, empty: !rows.length
  });

  /* ---------------- riferimenti documento ---------------- */
  class DocRef {
    constructor(col, id) { this.col = col; this.id = id; }
    async get() {
      const { data, error } = await SB.from("docs").select("id,data")
        .eq("collection", this.col).eq("id", this.id).maybeSingle();
      if (error) throw wrap(error);
      return docSnap(this.id, data);
    }
    async set(obj) {
      const { error } = await SB.from("docs").upsert(
        { collection: this.col, id: this.id, data: obj || {}, updated_at: new Date().toISOString() },
        { onConflict: "collection,id" });
      if (error) throw wrap(error);
    }
    async update(patch) {
      const { error } = await SB.rpc("doc_update", { p_collection: this.col, p_id: this.id, p_patch: patch || {} });
      if (error) throw wrap(error);
    }
    async delete() {
      const { error } = await SB.from("docs").delete().eq("collection", this.col).eq("id", this.id);
      if (error) throw wrap(error);
    }
    onSnapshot(cb, onErr) {
      const load = () => this.get().then(cb, onErr || (() => {}));
      load();
      return watch(this.col, load);
    }
  }

  /* ---------------- riferimenti collezione ---------------- */
  class ColRef {
    constructor(col, ord, lim) { this.col = col; this.ord = ord || null; this.lim = lim || null; }
    doc(id) { return new DocRef(this.col, id); }
    orderBy(field, dir) { return new ColRef(this.col, { field, desc: dir === "desc" }, this.lim); }
    limit(n) { return new ColRef(this.col, this.ord, n); }
    async add(obj) { const ref = new DocRef(this.col, newId()); await ref.set(obj); return ref; }
    async get() {
      let q = SB.from("docs").select("id,data").eq("collection", this.col);
      if (this.ord) q = q.order("data->>" + this.ord.field, { ascending: !this.ord.desc });
      if (this.lim) q = q.limit(this.lim);
      const { data, error } = await q;
      if (error) throw wrap(error);
      return colSnap(data || []);
    }
    onSnapshot(cb, onErr) {
      const load = () => this.get().then(cb, onErr || (() => {}));
      load();
      return watch(this.col, load);
    }
  }

  const db = {
    collection: c => new ColRef(c),
    doc: path => { const [c, ...rest] = path.split("/"); return new DocRef(c, rest.join("/")); }
  };

  /* ---------------- utente ---------------- */
  function makeUser(session) {
    const u = session.user;
    let ownerP = null, rolesP = null;
    const isOwner = () => ownerP || (ownerP = SB.rpc("app_is_owner").then(r => !!r.data, () => false));
    const roles = () => rolesP || (rolesP = db.doc("config/roles").get()
      .then(s => (s.exists && s.data().roles) || {}, () => ({})));
    return {
      id: async () => u.id,
      isOwner,
      canEdit: async () => (await isOwner()) || !!(await roles())[u.id],
      can: async () => true,
      me: async () => {
        try {
          const s = await db.collection("directory").doc(u.id).get();
          const d = s.exists ? s.data() : null;
          const n = d ? `${d.nome || ""} ${d.cognome || ""}`.trim() : "";
          return { name: n || u.email.split("@")[0] };
        } catch { return { name: u.email }; }
      },
      profiles: async ids => {
        const out = {};
        if (!ids.length) return out;
        const { data } = await SB.from("docs").select("id,data")
          .eq("collection", "directory").in("id", ids);
        (data || []).forEach(r => {
          out[r.id] = { name: `${r.data.nome || ""} ${r.data.cognome || ""}`.trim() };
        });
        return out;
      }
    };
  }

  /* ---------------- download (esporta CSV) ---------------- */
  const downloads = {
    save: async ({ filename, data, mimeType }) => {
      const blob = new Blob(["﻿" + data], { type: mimeType || "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename || "export.csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  };

  /* ---------------- login ---------------- */
  let resolveSession;
  const sessionReady = new Promise(r => (resolveSession = r));

  function loginUI() {
    const box = document.createElement("div");
    box.id = "lc-login";
    box.innerHTML = `
      <style>
        #lc-login{position:fixed;inset:0;z-index:100;background:var(--bg);display:grid;place-items:center;padding:20px}
        #lc-login form{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:26px 22px}
        #lc-login h1{font:700 30px/1 var(--cond);margin:0 0 4px}
        #lc-login p.s{margin:0 0 18px;color:var(--muted)}
        #lc-login label{display:block;font:600 15px var(--cond);margin:12px 0 4px;color:var(--muted)}
        #lc-login input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);font:16px var(--body);color:var(--ink)}
        #lc-login .go{width:100%;margin-top:18px;padding:13px;border:0;border-radius:12px;background:var(--amber);color:var(--amber-ink);font:600 19px var(--cond);cursor:pointer}
        #lc-login .alt{display:flex;justify-content:space-between;margin-top:14px;font-size:14px}
        #lc-login .alt a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--amber);text-underline-offset:3px;cursor:pointer}
        #lc-login .msg{margin-top:12px;font-size:14px;color:var(--red);min-height:1em}
        #lc-login .msg.ok{color:var(--green)}
        #lc-login .back{display:block;text-align:center;margin-top:16px;color:var(--muted);font-size:14px}
      </style>
      <form autocomplete="on">
        <h1>Area riservata</h1>
        <p class="s" id="lcSub">Accedi con email e password del chapter.</p>
        <label for="lcEmail">Email</label>
        <input id="lcEmail" type="email" autocomplete="email" required>
        <label for="lcPwd">Password</label>
        <input id="lcPwd" type="password" autocomplete="current-password" minlength="6" required>
        <button class="go" type="submit" id="lcGo">Accedi</button>
        <div class="msg" id="lcMsg" role="status"></div>
        <div class="alt">
          <a id="lcMode">Primo accesso? Crea l'account</a>
          <a id="lcReset">Password dimenticata</a>
        </div>
        <a class="back" href="../">‹ Torna al sito</a>
      </form>`;
    document.body.appendChild(box);
    let signup = false;
    const $ = id => box.querySelector("#" + id);
    const msg = (t, ok) => { $("lcMsg").textContent = t; $("lcMsg").className = "msg" + (ok ? " ok" : ""); };
    $("lcMode").onclick = () => {
      signup = !signup;
      $("lcGo").textContent = signup ? "Crea account" : "Accedi";
      $("lcSub").textContent = signup ? "Scegli email e password (almeno 6 caratteri)." : "Accedi con email e password del chapter.";
      $("lcMode").textContent = signup ? "Hai già un account? Accedi" : "Primo accesso? Crea l'account";
      $("lcPwd").autocomplete = signup ? "new-password" : "current-password";
      msg("");
    };
    $("lcReset").onclick = async () => {
      const email = $("lcEmail").value.trim();
      if (!email) return msg("Scrivi prima la tua email.");
      const { error } = await SB.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] });
      msg(error ? "Invio non riuscito: " + error.message : "Ti abbiamo inviato una mail per reimpostare la password.", !error);
    };
    box.querySelector("form").onsubmit = async ev => {
      ev.preventDefault();
      const email = $("lcEmail").value.trim(), password = $("lcPwd").value;
      $("lcGo").disabled = true; msg("");
      const { data, error } = signup
        ? await SB.auth.signUp({ email, password })
        : await SB.auth.signInWithPassword({ email, password });
      $("lcGo").disabled = false;
      if (error) {
        const m = /Invalid login/i.test(error.message) ? "Email o password non corrette."
                : /already registered/i.test(error.message) ? "Questa email ha già un account: usa Accedi."
                : error.message;
        return msg(m);
      }
      if (!data.session) return msg("Account creato: controlla la mail per confermarlo, poi accedi.", true);
      box.remove(); resolveSession(data.session);
    };
  }

  function logoutButton() {
    const top = document.querySelector("header.top");
    if (!top || document.getElementById("lcNav")) return;
    const css = "border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:99px;padding:4px 10px;font:600 14px var(--cond);cursor:pointer;text-decoration:none;white-space:nowrap";
    const nav = document.createElement("span");
    nav.id = "lcNav";
    nav.style.cssText = "display:flex;gap:6px;flex:none;margin-left:8px";
    // Torna al sito: resta collegato
    const s = document.createElement("a");
    s.id = "lcSite"; s.href = "../"; s.textContent = "‹ Sito"; s.title = "Torna al sito (resti collegato)";
    s.style.cssText = css;
    // Esci: chiude la sessione e torna alla schermata di accesso
    const b = document.createElement("button");
    b.id = "lcOut"; b.type = "button"; b.textContent = "Esci"; b.title = "Esci dall'area riservata";
    b.style.cssText = css;
    b.onclick = async () => { await SB.auth.signOut(); location.reload(); };
    nav.appendChild(s); nav.appendChild(b); top.appendChild(nav);
    // Intestazione su una riga anche sui telefoni stretti
    const st = document.createElement("style");
    st.textContent = "header.top{flex-wrap:nowrap!important;gap:6px}header.top .brand{min-width:0;flex:1 1 auto}header.top .brand small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}header.top .role{flex:none}@media (max-width:400px){header.top .brand{font-size:19px}}";
    document.head.appendChild(st);
  }

  SB.auth.getSession().then(({ data }) => {
    const start = () => {
      if (data.session) resolveSession(data.session); else loginUI();
    };
    if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
  });
  sessionReady.then(s => {
    SB.realtime.setAuth(s.access_token);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", logoutButton);
    else logoutButton();
  });

  /* ---------------- stessa interfaccia di Claude ---------------- */
  window.claude = {
    use: async name => {
      const s = await sessionReady;
      if (name === "db") return db;
      if (name === "user") return makeUser(s);
      if (name === "downloads") return downloads;
      return null;
    }
  };
})();
