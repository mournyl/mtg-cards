/* mournyl mtg — shared helpers for the tier lists, deck checker, slot finder and card search.
   Data comes from the site's own files (built weekly by tools/tiers/build.py):
     data/cards.json        every Commander-legal card: mana value, types, identity, cost, flags, role scores
     data/tier-index.json   card name -> [role, score, sub, rank, reviewed]
     tiers/data/<role>.json one entry per card in a role list (score, tier, reason, rules text)
   Scryfall is only asked for images and prices of cards on screen, one request at a time, 550 ms apart
   (its limit is 2 a second); if Scryfall can't be reached the pages stay in text mode. */
(() => {
  "use strict";
  const C = window.MTGCore;
  if (!C) throw new Error("Load assets/core.js before assets/mtg.js");
  const ROOT = new URL("..", document.currentScript ? document.currentScript.src : location.href);
  const PREVIEW = !!window.MTG_PREVIEW;
  const url = p => new URL(p, ROOT).href;
  const PAGES = { search: "", tiers: "tiers/", deck: "deck/", build: "build/", saved: "#saved" };
  // MTG_PREVIEW is set only by the stand-alone preview build (no server, no card search): links use explicit files
  function page(key, hash) {
    let p = PAGES[key] ?? "";
    if (key === "saved") p = "#saved";
    else if (PREVIEW) p = key === "search" ? "index.html" : p + "index.html";
    return url(p) + (hash ? "#" + hash : "");
  }

  // ---------- small helpers ----------
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => Number(n).toLocaleString("en-US");
  const norm = C.norm;
  async function getJSON(p) {
    const r = await fetch(url(p));
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return r.json();
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem("mournyl-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("mournyl-" + k, JSON.stringify(v)); } catch { /* storage off */ } },
  };
  let toastT;
  function toast(msg) {
    let t = $("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2400);
  }

  // ---------- tiers ----------
  const TIERS = [
    { t: "S", min: 90, h: "Staples", d: "Play it in almost any deck that can." },
    { t: "A", min: 75, h: "Excellent", d: "Near auto-include when the deck needs this job done." },
    { t: "B", min: 60, h: "Strong", d: "Great in the right deck or against the right table." },
    { t: "C", min: 45, h: "Playable", d: "Filler, or a narrow answer that needs the right deck." },
    { t: "D", min: 30, h: "Outclassed", d: "Works, but something cheaper or broader does it better." },
    { t: "F", min: 0, h: "Don't bother", d: "Rarely does anything in Commander." },
  ];
  const tierOf = C.tierOf;
  const TIER = Object.fromEntries(TIERS.map(T => [T.t, T]));
  const tb = t => `<span class="tb t${t}" title="${t} tier">${t}</span>`;
  const ROLE_INFO = {
    counterspells: { label: "Counterspells", short: "Counter", col: "#6fa8ff" },
    ramp: { label: "Ramp", short: "Ramp", col: "#6fcf7f" },
    draw: { label: "Card draw", short: "Draw", col: "#a98cf0" },
    removal: { label: "Targeted removal", short: "Removal", col: "#e07a7a" },
    wipes: { label: "Board wipes", short: "Wipes", col: "#ff9d5c" },
    tutors: { label: "Tutors", short: "Tutor", col: "#e0b85c" },
    protection: { label: "Protection", short: "Protection", col: "#f0e08c" },
    gyhate: { label: "Graveyard hate", short: "GY hate", col: "#b0a4c8" },
    recursion: { label: "Recursion", short: "Recursion", col: "#9ccc65" },
    lands: { label: "Lands", short: "Land", col: "#c8b89a" },
  };
  const BROADER = C.BROADER;
  const COLORS = [
    { k: "W", slug: "white", name: "white" }, { k: "U", slug: "blue", name: "blue" }, { k: "B", slug: "black", name: "black" },
    { k: "R", slug: "red", name: "red" }, { k: "G", slug: "green", name: "green" }, { k: "C", slug: "colorless", name: "colorless" },
  ];
  const fits = C.fits;
  const TYPE_NAMES = { L: "Land", C: "Creature", A: "Artifact", E: "Enchantment", I: "Instant", S: "Sorcery", P: "Planeswalker", B: "Battle" };

  // ---------- mana symbols (inline sprite) ----------
  let spriteIds = new Set(), spriteP;
  function loadSprite() {
    return spriteP ||= fetch(url("assets/sprite.svg")).then(r => r.ok ? r.text() : "").catch(() => "").then(txt => {
      if (!txt.includes("<symbol")) return;
      let box = $("spritebox");
      if (!box) { box = document.createElement("div"); box.id = "spritebox"; box.hidden = true; document.body.prepend(box); }
      box.innerHTML = txt;
      spriteIds = new Set([...box.querySelectorAll("symbol")].map(s => s.id.replace(/^ms-/, "")));
    });
  }
  function sym(x) {
    let id = String(x).replace(/\//g, "").toUpperCase();
    if (!spriteIds.has(id) && id.length === 2 && spriteIds.has(id[1] + id[0])) id = id[1] + id[0];
    const label = esc(`{${x}}`);
    return spriteIds.has(id)
      ? `<svg class="ms" viewBox="0 0 32 32" role="img" aria-label="${label}"><title>${label}</title><use href="#ms-${id}"/></svg>`
      : `<span class="tp" title="${label}">${esc(x)}</span>`;
  }
  const bigSym = k => spriteIds.has(k) ? `<svg viewBox="0 0 32 32" aria-hidden="true"><use href="#ms-${k}"/></svg>` : `<span class="tp" style="font-size:22px">${esc(k)}</span>`;
  const syms = s => esc(s).replace(/\{([^}]+)\}/g, (_, x) => sym(x));
  const cost = toks => `<span class="cost">${(toks || []).map(sym).join("")}</span>`;
  const para = s => (s || "").split("\n").map(l => `<p>${syms(l)}</p>`).join("");
  const idSyms = id => id ? id.split("").map(sym).join("") : sym("C");

  // ---------- data ----------
  let cardsP, hubP, tierIdxP;
  const roleP = new Map();
  const loadCards = () => cardsP ||= getJSON("data/cards.json").then(C.buildIndex);
  const loadHub = () => hubP ||= getJSON("tiers/data/index.json");
  const loadTierIndex = () => tierIdxP ||= getJSON("data/tier-index.json");
  function loadRole(k) {
    if (!roleP.has(k)) roleP.set(k, getJSON(`tiers/data/${k}.json`).then(list => {
      const byN = new Map(list.map(e => [e.n, e])); return { list, byN };
    }));
    return roleP.get(k);
  }
  const findCard = (idx, name) => idx.byName.get(norm(name)) || null;
  const flags = C.flagsOf;

  const betterOptions = C.betterOptions;

  // ---------- Scryfall: images and prices for cards on screen ----------
  const SF = "https://api.scryfall.com";
  const sf = new Map(), asked = new Set();
  let last = 0, chain = Promise.resolve(), sfDown = false, downUntil = 0;
  function paced(fn) {
    const run = chain.then(async () => {
      const wait = Math.max(0, last + 550 - Date.now()); if (wait) await sleep(wait);
      last = Date.now(); return fn();
    });
    chain = run.catch(() => {});
    return run;
  }
  const keep = c => { sf.set(c.name, c); if (c.card_faces?.[0]?.name) sf.set(c.card_faces[0].name, c); };
  async function scryfall(names) {
    const want = [...new Set(names)].filter(n => n && !asked.has(n) && !sf.has(n));
    if (sfDown && Date.now() < downUntil) return false;
    want.forEach(n => asked.add(n));
    let got = false;
    for (let i = 0; i < want.length; i += 75) {
      const ids = want.slice(i, i + 75).map(name => ({ name }));
      try {
        const body = await paced(async () => {
          const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
          try {
            const res = await fetch(`${SF}/cards/collection`, { method: "POST", signal: ctl.signal,
              headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ identifiers: ids }) });
            if (res.status === 429) { sfDown = true; downUntil = Date.now() + 31000; throw new Error("429"); }
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          } finally { clearTimeout(timer); }
        });
        (body.data || []).forEach(keep); got = got || !!(body.data || []).length;
        const retry = (body.not_found || []).map(x => x.name).filter(n => n.includes(" // ")).map(n => ({ name: n.split(" // ")[0] }));
        if (retry.length) {
          const b2 = await paced(() => fetch(`${SF}/cards/collection`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifiers: retry }) }).then(r => r.ok ? r.json() : {}));
          (b2.data || []).forEach(keep);
        }
      } catch (e) {
        want.slice(i).forEach(n => asked.delete(n));
        if (e.message !== "429") { sfDown = true; downUntil = Date.now() + 5 * 60000; }
        return got;
      }
    }
    return got;
  }
  const scry = name => sf.get(name) || sf.get(String(name).split(" // ")[0]) || null;
  function img(name, size = "normal") {
    const c = scry(name); if (!c) return null;
    const iu = c.image_uris || c.card_faces?.[0]?.image_uris;
    return iu ? (iu[size] || iu.normal) : null;
  }
  const hasImages = () => sf.size > 0;

  // ---------- server (Worker + D1); pages work without it, saving only on this device ----------
  async function api(method, path, body) {
    const opt = { method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
    const r = await fetch(url(path.replace(/^\//, "")), opt);
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) { const e = new Error("The site's server isn't reachable here"); e.status = 0; e.offline = true; throw e; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  let meP;
  const me = () => meP ||= (PREVIEW || location.protocol === "file:" ? Promise.resolve({ online: false, user: null })
    : api("GET", "/api/me").then(r => ({ online: true, user: r.user })).catch(() => ({ online: false, user: null })));

  // saved decks: the account's decks on the server when logged in, otherwise this browser only
  const LOCAL_DECKS = "decks";
  const decks = {
    async where() { const m = await me(); return m.online && m.user ? "server" : "local"; },
    async list() {
      if (await this.where() === "server") return (await api("GET", "/api/decks")).decks;
      return store.get(LOCAL_DECKS, []).map(({ id, name, commander, updated_at, last }) => ({ id, name, commander, updated_at, last }));
    },
    async get(id) {
      if (await this.where() === "server") return (await api("GET", `/api/decks/${id}`)).deck;
      return store.get(LOCAL_DECKS, []).find(d => String(d.id) === String(id)) || null;
    },
    async save(d) {                       // d: { id?, name, commander, list, settings }
      if (await this.where() === "server") {
        if (d.id && !String(d.id).startsWith("l")) { await api("PATCH", `/api/decks/${d.id}`, d); return d.id; }
        return (await api("POST", "/api/decks", d)).deck.id;
      }
      const all = store.get(LOCAL_DECKS, []), now = Date.now();
      let x = d.id && all.find(y => String(y.id) === String(d.id));
      if (!x) { x = { id: "l" + now, checks: [], created_at: now }; all.unshift(x); }
      Object.assign(x, { name: d.name, commander: d.commander, list: d.list, settings: d.settings, updated_at: now });
      store.set(LOCAL_DECKS, all.slice(0, 50)); return x.id;
    },
    async remove(id) {
      if (await this.where() === "server" && !String(id).startsWith("l")) return api("DELETE", `/api/decks/${id}`);
      store.set(LOCAL_DECKS, store.get(LOCAL_DECKS, []).filter(d => String(d.id) !== String(id)));
    },
    async addCheck(id, summary) {
      if (await this.where() === "server" && !String(id).startsWith("l")) return api("POST", `/api/decks/${id}/checks`, { summary });
      const all = store.get(LOCAL_DECKS, []), x = all.find(d => String(d.id) === String(id)); if (!x) return;
      x.checks = [{ created_at: Date.now(), summary }, ...(x.checks || [])].slice(0, 20); x.last = summary; store.set(LOCAL_DECKS, all);
    },
  };
  // the deck being worked on, shared by the deck checker, slot finder and card search (this tab only)
  const draft = {
    get() { try { return JSON.parse(sessionStorage.getItem("mournyl-deck-draft") || "null"); } catch { return null; } },
    set(d) { try { sessionStorage.setItem("mournyl-deck-draft", JSON.stringify(d)); } catch { /* storage off */ } },
  };

  // small log-in / sign-up dialog for pages other than card search (same /api/login and /api/signup)
  function login(sub) {
    return new Promise(resolve => {
      const box = document.createElement("div");
      box.className = "modal open";
      box.innerHTML = `<div class="sheet small" role="dialog" aria-modal="true" aria-label="Log in"><button type="button" class="close" aria-label="Close">×</button>
        <form class="form" novalidate><h2 class="sec-h" style="text-align:center;margin:0">mournyl</h2><p class="muted" style="text-align:center;margin:0" id="lgSub">${esc(sub || "Log in to save decks")}</p>
        <label>Username<input name="u" autocomplete="username" required></label>
        <label>Password<input name="p" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit" style="justify-content:center">Log in</button><div class="msg bad" id="lgMsg"></div>
        <p class="muted" style="text-align:center;margin:0;font-size:13px"><a href="#" id="lgSwap">No account? Sign up</a></p></form></div>`;
      document.body.appendChild(box);
      let mode = "login";
      const form = box.querySelector("form"), done = u => { box.remove(); resolve(u); };
      box.addEventListener("click", e => { if (e.target === box || e.target.closest(".close")) done(null); });
      box.querySelector("#lgSwap").onclick = e => {
        e.preventDefault(); mode = mode === "login" ? "signup" : "login";
        form.querySelector("button[type=submit]").textContent = mode === "login" ? "Log in" : "Create account";
        e.target.textContent = mode === "login" ? "No account? Sign up" : "Have an account? Log in";
        form.p.autocomplete = mode === "login" ? "current-password" : "new-password";
      };
      form.onsubmit = async e => {
        e.preventDefault();
        try {
          const r = await api("POST", mode === "login" ? "/api/login" : "/api/signup", { username: form.u.value.trim(), password: form.p.value });
          meP = Promise.resolve({ online: true, user: r.user }); toast(`Welcome, ${r.user.username}`); done(r.user);
        } catch (err) { box.querySelector("#lgMsg").textContent = err.message; }
      };
      setTimeout(() => form.u.focus(), 30);
    });
  }

  // ---------- header ----------
  function initNav(active) {
    document.querySelectorAll("[data-page]").forEach(a => {
      if (PREVIEW && (a.dataset.page === "saved" || (a.dataset.page === "search" && !a.classList.contains("logo")))) { a.hidden = true; return; }
      a.href = page(a.dataset.page, a.dataset.hash);
      if (a.dataset.page === active) a.setAttribute("aria-current", "page");
    });
    const hdr = document.querySelector("header");
    if (hdr) {
      const setHH = () => document.documentElement.style.setProperty("--hh", (getComputedStyle(hdr).position === "sticky" ? hdr.offsetHeight : 0) + "px");
      if ("ResizeObserver" in window) new ResizeObserver(setHH).observe(hdr); else addEventListener("resize", setHH);
      setHH();
    }
  }

  // ---------- card sheet: rules text, tier in every role, better options, feedback ----------
  let modal, sheet, opener = null, ctxOpt = {};
  function ensureModal() {
    if (modal) return;
    modal = document.createElement("div"); modal.className = "modal"; modal.id = "cardModal";
    modal.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Card details"></div>`;
    document.body.appendChild(modal); sheet = modal.firstElementChild;
    modal.addEventListener("click", e => {
      if (e.target === modal || e.target.closest(".close")) return closeCard();
      const b = e.target.closest("[data-open]"); if (b) { e.preventDefault(); openCard(b.dataset.open, { ...ctxOpt, keepOpener: true }); }
      const f = e.target.closest("[data-feedback]"); if (f) showFeedback(f.dataset.feedback);
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("open")) closeCard(); });
  }
  function closeCard() {
    if (!modal) return;
    modal.classList.remove("open"); document.body.style.overflow = "";
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }
  const isOpen = () => !!modal && modal.classList.contains("open");
  const slug = s => s.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-");
  const pct = e => (e >= 10 ? e.toFixed(0) : e.toFixed(1)) + "%";

  // opt.allowed (color identity to fit), opt.exclude (Set of names already in the deck), opt.noGC, opt.onPick(name)
  async function openCard(name, opt = {}) {
    ensureModal();
    if (!opt.keepOpener) opener = document.activeElement;
    ctxOpt = { allowed: opt.allowed, exclude: opt.exclude, noGC: opt.noGC, onPick: opt.onPick, pickLabel: opt.pickLabel };
    const idx = await loadCards();
    const c = findCard(idx, name);
    if (!c) { toast(`${name} isn't in the card index`); return; }
    const roles = c.roles.slice().sort((a, b) => b.s - a.s);
    const files = await Promise.all(roles.map(x => loadRole(x.k).catch(() => null)));
    const entries = roles.map((x, i) => files[i]?.byN.get(c.n) || null);
    const e0 = entries.find(Boolean);
    const render = () => {
      const f = flags(c), s = scry(c.n), big = img(c.n, "large");
      const faces = e0 ? e0.o : (s ? (s.card_faces || [s]).map(x => ({ n: x.name, c: (x.mana_cost || "").match(/\{[^}]+\}/g)?.map(t => t.slice(1, -1)) || [], ty: x.type_line || s.type_line, pt: x.power != null ? `${x.power}/${x.toughness}` : "", o: x.oracle_text || "" }))
        : [{ n: c.n, c: c.cost, ty: c.ty.split("").map(l => TYPE_NAMES[l]).filter(Boolean).join(" "), pt: "", o: "" }]);
      const pr = s?.prices || {};
      const showPrices = store.get("prices", false);
      const prices = [pr.usd && `USD $${pr.usd}`, pr.usd_foil && `Foil $${pr.usd_foil}`, pr.eur && `EUR €${pr.eur}`, pr.tix && `MTGO ${pr.tix} tix`].filter(Boolean);
      const front = c.n.split(" // ")[0];
      const sfUrl = s?.scryfall_uri || `https://scryfall.com/search?q=${encodeURIComponent(`!"${c.n}"`)}`;
      const edUrl = s?.related_uris?.edhrec || `https://edhrec.com/cards/${slug(front)}`;
      const sbUrl = `https://commanderspellbook.com/search/?q=${encodeURIComponent(`card:"${front}"`)}`;
      const total = k => idx.byRole[k].length;
      const tierRows = roles.map((x, i) => {
        const e = entries[i], info = ROLE_INFO[x.k];
        return `<div class="trole">${tb(x.t)}<a href="${page("tiers", x.k)}"><b>${esc(info.label)}</b></a>
          <span class="muted">${esc(idx.subs[x.k] ? (hubSubName(x.k, x.sub)) : x.sub)} · #${fmt(x.r)} of ${fmt(total(x.k))} · score ${x.s}${x.rev ? "" : " · unreviewed"}${e?.e != null ? ` · EDHREC ${pct(e.e)}` : ""}</span></div>
          ${e ? `<p class="why" style="margin:-2px 0 6px 34px">${syms(e.why)}</p>` : ""}`;
      }).join("");
      const better = roles.filter(x => x.k !== "lands" || c.ty.includes("L")).map(x => {
        const opts = betterOptions(idx, c, x.k, { allowed: ctxOpt.allowed ?? c.id, exclude: ctxOpt.exclude, noGC: ctxOpt.noGC, limit: 4 });
        if (!opts.length) return "";
        return `<h3>Better ${esc(ROLE_INFO[x.k].label.toLowerCase())} ${ctxOpt.allowed != null ? "for this deck" : "in these colors"}</h3><div class="better">` +
          opts.map(o => `<button type="button" data-open="${esc(o.c.n)}">${tb(o.t)}<span>${esc(o.c.n)}</span><span class="muted">${o.s}</span>${cost(o.c.cost)}</button>`).join("") + `</div>`;
      }).join("");
      const badges = [
        f.gc && `<span class="badge" style="--bc:var(--dot-gc)">Game Changer</span>`,
        f.banned && `<span class="badge" style="--bc:var(--danger)">Banned in Commander</span>`,
        f.mld && `<span class="badge" style="--bc:var(--danger)">Mass land destruction</span>`,
        f.extra && `<span class="badge" style="--bc:var(--warn)">Extra turn</span>`,
        c.id.length > 1 && `<span class="badge ids" title="Color identity">${idSyms(c.id)}</span>`,
      ].filter(Boolean).join("");
      sheet.innerHTML = `
        <button type="button" class="close" aria-label="Close">×</button>
        <div>${big ? `<img class="bigimg" src="${big}" alt="${esc(c.n)}">`
          : `<div class="bigtext"><span class="L">${roles[0] ? roles[0].t : "·"}</span><span class="nm">${esc(c.n)}</span>${cost(c.cost)}</div>`}
          ${ctxOpt.onPick ? `<button type="button" class="btn primary" id="sheetPick" style="width:100%;justify-content:center;margin-top:12px">${esc(ctxOpt.pickLabel || "Add to deck")}</button>` : ""}</div>
        <div>
          ${faces.map(fc => `<div class="face"><div class="nameline"><h2>${esc(fc.n)}</h2>${cost(fc.c)}</div>
            <div class="typeline">${esc(fc.ty)}${fc.pt ? ` · ${esc(fc.pt)}` : ""}</div><div class="oracle">${para(fc.o) || `<p class="muted">Rules text loads from Scryfall when it can be reached.</p>`}</div></div>`).join("")}
          ${roles.length ? `<h3>Tiers</h3><div class="troles">${tierRows}</div>` : `<p class="muted">Not on any tier list yet.</p>`}
          ${better}
          <div class="meta"><span>Mana value <b>${c.mv}</b></span><span>Identity <b>${c.id ? idSyms(c.id) : "Colorless"}</b></span></div>
          ${badges ? `<div class="roles" style="margin-bottom:12px">${badges}</div>` : ""}
          ${showPrices && prices.length ? `<h3>Prices</h3><div class="prices">${prices.map(p => `<span>${esc(p)}</span>`).join("")}</div>` : ""}
          <div class="links"><a class="btn small" href="${esc(sfUrl)}" target="_blank" rel="noopener">Scryfall</a>
            <a class="btn small" href="${esc(edUrl)}" target="_blank" rel="noopener">EDHREC</a>
            <a class="btn small" href="${esc(sbUrl)}" target="_blank" rel="noopener">Combos (Spellbook)</a>
            ${roles.length ? `<button type="button" class="btn small" data-feedback="${esc(c.n)}">Suggest a tier</button>` : ""}</div>
          <div id="fbBox"></div>
        </div>`;
      const pick = sheet.querySelector("#sheetPick");
      if (pick) pick.onclick = () => { ctxOpt.onPick(c.n); closeCard(); };
    };
    render();
    modal.classList.add("open"); document.body.style.overflow = "hidden";
    sheet.querySelector(".close").focus();
    if (!scry(c.n)) scryfall([c.n]).then(ok => { if (ok && isOpen() && sheet.querySelector(".nameline h2")) render(); });
  }
  let hubNames = null;
  loadHubNames();
  function loadHubNames() { loadHub().then(h => { hubNames = {}; h.roles.forEach(r => { hubNames[r.key] = Object.fromEntries(r.subs.map(s => [s.key, s.name])); }); }).catch(() => {}); }
  const hubSubName = (k, sub) => (hubNames && hubNames[k] && hubNames[k][sub]) || sub;

  async function showFeedback(name) {
    const idx = await loadCards(), c = findCard(idx, name), box = sheet.querySelector("#fbBox");
    if (!c || !box) return;
    box.innerHTML = `<form class="form" id="fbForm" style="margin-top:16px;border-top:1px solid var(--line);padding-top:16px">
      <h3 style="margin:0">Suggest a tier</h3>
      <div class="row2"><label>List<select name="role">${c.roles.map(x => `<option value="${x.k}">${esc(ROLE_INFO[x.k].label)} (now ${x.t})</option>`).join("")}</select></label>
        <label>Should be<select name="tier">${TIERS.map(T => `<option>${T.t}</option>`).join("")}</select></label></div>
      <label>Why (optional)<textarea name="note" rows="3" maxlength="500" placeholder="What does the card do better or worse than its tier says?"></textarea></label>
      <div class="row2"><button class="btn primary small" type="submit">Send</button><span class="msg" id="fbMsg"></span></div></form>`;
    const form = box.querySelector("form");
    form.tier.value = c.roles[0] ? c.roles[0].t : "C";
    form.onsubmit = async ev => {
      ev.preventDefault();
      const x = c.roles.find(r => r.k === form.role.value);
      const body = { role: x.k, card: c.n, tier: x.t, suggested: form.tier.value, note: form.note.value.trim() };
      const msg = box.querySelector("#fbMsg"); msg.className = "msg"; msg.textContent = "Sending…";
      try { await api("POST", "/api/feedback", body); msg.textContent = "Thanks, it's in the review queue."; form.querySelector("button").disabled = true; }
      catch (e) { msg.className = "msg bad"; msg.textContent = e.offline ? "This preview has no server, so feedback can't be sent from here." : e.message; }
    };
    form.role.focus();
  }

  window.MTG = {
    ROOT, PREVIEW, url, page, $, esc, cap, sleep, fmt, norm, store, toast, getJSON,
    TIERS, TIER, tierOf, tb, ROLE_INFO, COLORS, TYPE_NAMES, fits, BROADER,
    loadSprite, sym, bigSym, syms, cost, para, idSyms,
    loadCards, loadHub, loadTierIndex, loadRole, findCard, flags, betterOptions, hubSubName,
    scryfall, scry, img, hasImages, api, me, refreshMe: () => { meP = null; }, login, decks, draft, initNav, openCard, closeCard, isCardOpen: isOpen, pct,
  };
})();
