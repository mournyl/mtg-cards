/* mournyl mtg — shared helpers for the tier lists, My decks and card search.
   Data comes from the site's own files (built weekly by tools/tiers/build.py):
     data/cards.json        every Commander-legal card: mana value, types, identity, cost, flags, role scores, function tags
     data/tier-index.json   card name -> [role, score, sub, rank, reviewed]
     tiers/data/<role>.json one entry per card in a role list (score, tier, reason, rules text)
   Scryfall is only asked for images of cards on screen, one request at a time, 550 ms apart
   (its limit is 2 a second); if Scryfall can't be reached the pages stay in text mode. */
(() => {
  "use strict";
  const C = window.MTGCore;
  if (!C) throw new Error("Load assets/core.js before assets/mtg.js");
  const ROOT = new URL("..", document.currentScript ? document.currentScript.src : location.href);
  const PREVIEW = !!window.MTG_PREVIEW;
  const url = p => new URL(p, ROOT).href;
  const PAGES = { search: "", tiers: "tiers/", decks: "decks/", users: "users/", saved: "#saved" };
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
  // ---------- card size: Large, Full or Medium cards, or Condensed (names only). One setting for every page,
  // picked from the bar just under the header, below Saved and the account button. ----------
  const SIZES = [["large", "Large"], ["full", "Full"], ["medium", "Medium"], ["condensed", "Condensed"]];
  const cardSize = () => { const v = store.get("cardsize", "full"); return SIZES.some(x => x[0] === v) ? v : "full"; };
  document.documentElement.dataset.size = cardSize();
  const condensed = () => cardSize() === "condensed";
  function setCardSize(v) {
    if (!SIZES.some(x => x[0] === v) || v === cardSize()) return;
    store.set("cardsize", v); document.documentElement.dataset.size = v;
    document.querySelectorAll("button[data-size]").forEach(b => b.setAttribute("aria-pressed", b.dataset.size === v));
    document.dispatchEvent(new CustomEvent("mtg:size", { detail: v }));
  }
  const sizeButtons = () => SIZES.map(([k, l]) => `<button type="button" data-size="${k}" aria-pressed="${k === cardSize()}">${l}</button>`).join("");
  const sizeTabs = () => `<div class="sizetabs"><span class="lab" aria-hidden="true">Card size</span><div class="seg" role="group" aria-label="Card size">${sizeButtons()}</div></div>`;
  document.addEventListener("click", e => { const b = e.target.closest("button[data-size]"); if (b) setCardSize(b.dataset.size); });
  function sizeBar() {
    const hdr = document.querySelector("header");
    if (!hdr || document.querySelector(".sizetop")) return;
    hdr.insertAdjacentHTML("afterend", `<div class="sizetop"><div class="wrap">${sizeTabs()}</div></div>`);
  }

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
    { t: "D", min: 30, h: "Outclassed", d: "Works, but something more efficient or broader does it better." },
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

  // ---------- tags under cards: one per row, a 28px block (tier letter or line icon) + label ----------
  const P = d => `<path d="${d}"/>`, CI = (x, y, r, more = "") => `<circle cx="${x}" cy="${y}" r="${r}"${more}/>`;
  const SHIELD = P("M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z");
  const TAG_ICONS = {
    // jobs
    counter: CI(12, 12, 9) + P("m5.6 5.6 12.8 12.8"),
    ramp: P("M12 21v-9") + P("M12 12c0-4.4 3-7.5 8-7.5 0 5-3 7.5-8 7.5z") + P("M12 15c0-3.3-2.2-5.5-6.5-5.5 0 3.9 2.2 5.5 6.5 5.5z"),
    draw: `<rect x="8" y="3" width="12" height="16" rx="2"/>` + P("M5 7v12a2 2 0 0 0 2 2h9"),
    removal: CI(12, 12, 7) + CI(12, 12, 1.5) + P("M12 2v4M12 18v4M2 12h4M18 12h4"),
    wipes: `<rect x="4" y="4" width="16" height="16" rx="2"/>` + P("M4 20 20 4"),
    tutor: CI(11, 11, 7) + P("m20 20-4-4"),
    shield: SHIELD,
    grave: P("M6 21V10a6 6 0 0 1 12 0v11") + P("M4 21h16") + P("m10 10 4 4M14 10l-4 4"),
    rise: P("M4 21h16") + P("M12 17V4") + P("m7 9 5-5 5 5"),
    land: P("m3 20 6-10 4 6 3-4 5 8z"),
    bounce: P("M9 14 4 9l5-5") + P("M4 9h11a5 5 0 0 1 0 10h-3"),
    flame: P("M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.8 2.5-5 .2 1.7 1 2.7 2 3 0-3 0-5.2.5-8z"),
    tokens: `<rect x="3" y="7" width="14" height="14" rx="2"/>` + P("M7 3h12a2 2 0 0 1 2 2v12") + P("M10 11v6M7 14h6"),
    // sub-lists
    bolt: P("M13 2 4 14h7l-1 8 9-12h-7l1-8z"),
    creature: CI(12, 8, 4) + P("M4 21c0-4 3.6-7 8-7s8 3 8 7"),
    creatures: CI(9, 8, 3.5) + P("M2 21c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5") + P("M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2.4.9 4 3.2 4 6.2"),
    permanent: P("M12 3 20 7.5v9L12 21 4 16.5v-9z") + P("M4 7.5 12 12l8-4.5M12 12v9"),
    ability: CI(12, 12, 3) + P("M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"),
    rock: CI(12, 12, 8) + CI(12, 12, 3),
    plus: P("M12 5v14M5 12h14"),
    repeat: P("M17 2l4 4-4 4") + P("M3 11V9a3 3 0 0 1 3-3h15") + P("M7 22l-4-4 4-4") + P("M21 13v2a3 3 0 0 1-3 3H3"),
    eye: P("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z") + CI(12, 12, 3),
    card: `<rect x="6" y="3" width="12" height="18" rx="2"/>` + P("M10 8h4"),
    funnel: P("M3 5h18l-7 8v6l-4 2v-8z"),
    board: `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
    sword: P("M21 3h-5L6 13l5 5L21 8z") + P("m4 15 5 5M3 21l3-3"),
    play: P("M7 4v16l13-8z"),
    // kinds of protection
    hexproof: P("M12 3 20 7.5v9L12 21 4 16.5v-9z"),
    shroud: P("M3 3l18 18") + P("M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7-.5 1.2-1.5 2.7-2.9 4") + P("M6.6 6.6C4.4 8 2.8 10.1 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5.1-1.5"),
    indestructible: P("M6.5 4h11L21 9l-9 11L3 9z") + P("M3 9h18"),
    phasing: CI(12, 12, 8.5, ' stroke-dasharray="3.2 3"') + CI(12, 12, 2.5),
    blink: P("M4.5 11A8 8 0 0 1 18 6.7L20 9") + P("M20 4v5h-5") + P("M19.5 13A8 8 0 0 1 6 17.3L4 15") + P("M4 20v-5h5"),
    protection: SHIELD + P("m9 12 2 2 4-4"),
    ward: SHIELD + P("M12 8v4.5M12 16h.01"),
    redirect: P("M4 18v-3a6 6 0 0 1 6-6h10") + P("m16 5 4 4-4 4"),
    returns: P("M3.5 12a8.5 8.5 0 1 0 2.8-6.3L3.5 8") + P("M3.5 3.5V8H8"),
    prevent: SHIELD + P("M9 12h6"),
    uncounterable: `<rect x="5" y="11" width="14" height="10" rx="2"/>` + P("M8 11V7.5a4 4 0 0 1 8 0V11"),
    // flags
    star: P("m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"),
    crown: P("M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"),
    free: CI(12, 12, 9) + `<ellipse cx="12" cy="12" rx="3" ry="5"/>`,
    soft: CI(12, 12, 9, ' stroke-dasharray="4 3"') + P("m5.6 5.6 12.8 12.8"),
    sparkle: P("M12 3c.6 4.5 2.5 6.4 7 7-4.5.6-6.4 2.5-7 7-.6-4.5-2.5-6.4-7-7 4.5-.6 6.4-2.5 7-7z"),
    unrev: CI(12, 12, 9) + P("M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.6h.01"),
    identity: CI(9, 12, 6) + CI(15, 12, 6),
    dot: CI(12, 12, 3),
    // function tags
    edict: P("M12 4v10") + P("m7 10 5 5 5-5") + P("M5 20h14"),
    pinger: CI(12, 12, 2.5) + P("M12 3v4M12 17v4M3 12h4M17 12h4"),
    steal: P("M4 12h12") + P("m12 8 4 4-4 4") + P("M20 4v16"),
    tapper: `<rect x="3" y="7" width="18" height="11" rx="2"/>` + P("M7 4h10"),
    lock: `<rect x="5" y="11" width="14" height="10" rx="2"/>` + P("M8 11V7.5a4 4 0 0 1 8 0V11"),
    cloud: P("M7 18a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 8.6 4.7 4.7 0 0 1 17.5 18z"),
    tagcut: P("M3 12V4h8l10 10-8 8z") + CI(7.5, 7.5, 1.2),
    gem: P("M6 3h12l3 6-9 12L3 9z") + P("M3 9h18M9 3l3 6 3-6"),
    regen: SHIELD + P("M12 9v6M9 12h6"),
    counters: `<rect x="4" y="4" width="16" height="16" rx="3"/>` + P("M12 8v8M8 12h8"),
    altar: P("M4 20h16") + P("M6 20v-6h12v6") + P("M12 14v-3") + P("M10.5 8.5c0-1.7 1.5-3.5 1.5-3.5s1.5 1.8 1.5 3.5a1.5 1.5 0 0 1-3 0z"),
    skull: P("M5 11a7 7 0 0 1 14 0c0 2.6-1.4 4.1-3 5v3H8v-3c-1.6-.9-3-2.4-3-5z") + CI(9.5, 11, 1.2) + CI(14.5, 11, 1.2),
    heart: P("M12 20s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.3a4.1 4.1 0 0 1 7.5 2.3C19.5 15.4 12 20 12 20z"),
    drain: P("M12 20s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.3a4.1 4.1 0 0 1 7.5 2.3C19.5 15.4 12 20 12 20z") + P("M9 12h6"),
    mill: P("M5 5h14M5 9h14M5 13h14") + P("m12 16 0 5M9.5 18.5 12 21l2.5-2.5"),
    discard: `<rect x="6" y="3" width="12" height="18" rx="2"/>` + P("m10 10 4 4M14 10l-4 4"),
    copy: `<rect x="8" y="8" width="12" height="12" rx="2"/>` + P("M4 16V6a2 2 0 0 1 2-2h10"),
    clone: P("M12 3v18") + P("M8 7 4 12l4 5") + P("m16 7 4 5-4 5"),
    landfall: P("m3 20 6-9 4 5 3-3 5 7z") + P("M15 3v5M12.5 5.5 15 8l2.5-2.5"),
    double: P("M5 7l6 10M11 7l-6 10") + P("M14 10a2.5 2.5 0 1 1 4.2 1.8L14 17h5"),
    swap: P("M7 20V4") + P("m4 7 3-3 3 3") + P("M17 4v16") + P("m14 17 3 3 3-3"),
    up: P("M12 20V5") + P("m6 11 6-6 6 6"),
    chart: P("M4 20h16") + P("M7 16v-3M12 16V9M17 16V5"),
    untap: P("M20 12a8 8 0 1 1-2.3-5.7") + P("M20 4v5h-5"),
    target: CI(12, 12, 9) + CI(12, 12, 5) + CI(12, 12, 1),
    wing: P("M3 18c5 0 10-2.5 13.5-8.5L21 4c-.8 7-4.5 12.3-11 14z") + P("M7 14h6"),
    speed: P("M4 8h7M2 12h9M4 16h7") + P("m14 6 6 6-6 6"),
    wall: `<rect x="3" y="5" width="18" height="14" rx="1"/>` + P("M3 12h18M9 5v7M15 12v7"),
    clock: CI(12, 12, 9) + P("M12 7v5l3 2"),
    goad: P("M5 19 19 5") + P("M10 5h9v9"),
    vote: `<rect x="4" y="4" width="16" height="16" rx="3"/>` + P("m8 12 3 3 5-6"),
    enter: P("M10 17l5-5-5-5") + P("M15 12H3") + P("M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"),
    halo: `<ellipse cx="12" cy="5.5" rx="6" ry="2"/>` + CI(12, 15, 5),
    vehicle: P("M3 16l2-6h14l2 6z") + CI(7, 18, 2) + CI(17, 18, 2),
    book: P("M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z") + P("M4 19V5M8 7h6"),
    face: CI(12, 12, 9) + P("M9 10h.01M15 10h.01") + P("M8.5 15.5c2.2-1.6 4.8-1.6 7 0"),
  };
  // function tag -> icon
  const FTAG_ICON = { removal: "removal", edict: "edict", wipe: "wipes", counter: "counter", bounce: "bounce", pinger: "pinger", burn: "flame",
    steal: "steal", gyhate: "grave", tapper: "tapper", stax: "lock", fog: "cloud", ramp: "ramp", landramp: "land", costreduce: "tagcut", treasure: "gem",
    draw: "draw", select: "eye", tutor: "tutor", protect: "shield", phasing: "phasing", blink: "blink", regen: "regen", resilient: "indestructible",
    reanimate: "rise", recursion: "returns", cheat: "play", tokens: "tokens", counters: "counters", proliferate: "sparkle", sacoutlet: "altar",
    death: "skull", lifegain: "heart", drain: "drain", mill: "mill", discard: "discard", copy: "copy", clone: "clone", landfall: "landfall",
    spellpayoff: "bolt", gycast: "grave", double: "double", swap: "swap", anthem: "creatures", pump: "up", buff: "plus", scaling: "chart",
    extracombat: "sword", untap: "untap", lure: "target", animate: "sparkle", manasink: "funnel", evasion: "wing", deathtouch: "face",
    firststrike: "sword", haste: "speed", flash: "bolt", defender: "wall", keyword: "ability", vanilla: "card", extraturn: "clock", goad: "goad",
    monarch: "crown", vote: "vote", kindred: "creatures", fixing: "identity", utilityland: "ability", basic: "land", monoland: "land",
    etb: "enter", attack: "sword", aura: "halo", equipment: "sword", vehicle: "vehicle", saga: "book", planeswalker: "star",
    abilityremove: "lock", landdestroy: "land", wheel: "draw", freecast: "play", pillowfort: "wall", selfmill: "mill", triggerdouble: "copy",
    doubler: "double", damageamp: "flame", artifactpay: "sparkle", enchantpay: "halo", poison: "skull", cmdrpay: "crown", grouphug: "heart",
    lifecost: "heart", selfdiscard: "discard", sacrifice: "altar", exilecost: "grave", helpsopp: "vote", upkeep: "clock", tapped: "untap",
    symmetric: "swap", restricted: "wall" };
  // tier-list keys and card-search role keys
  const ROLE_ICON = { counterspells: "counter", counter: "counter", ramp: "ramp", draw: "draw", removal: "removal", wipes: "wipes", wipe: "wipes",
    tutors: "tutor", tutor: "tutor", protection: "shield", protect: "shield", gyhate: "grave", recursion: "rise", lands: "land",
    bounce: "bounce", burn: "flame", tokens: "tokens" };
  const SUB_ICON = {
    counterspells: { spells: "bolt", creatures: "creature", permanents: "permanent", abilities: "ability", stack: "bounce" },
    ramp: { rocks: "rock", dorks: "creature", lands: "land", other: "plus" },
    draw: { burst: "draw", engine: "repeat", impulse: "eye", cantrip: "card" },
    removal: { any: "removal", creature: "creature", "artifact-enchantment": "permanent", damage: "flame", bounce: "bounce" },
    wipes: { creatures: "creatures", nonland: "wipes", "artifacts-enchantments": "permanent" },
    tutors: { any: "tutor", creature: "creature", "instant-sorcery": "bolt", "artifact-enchantment": "permanent", other: "funnel" },
    protection: { board: "board", one: "creature", equipment: "sword", counter: "uncounterable" },
    gyhate: { "one-shot": "grave", repeatable: "repeat" },
    recursion: { reanimate: "rise", "to-hand": "returns", cast: "play" },
    lands: { fixing: "identity", utility: "ability", "spell-lands": "draw" },
  };
  const subIcon = (role, sub) => (SUB_ICON[role] || {})[sub] || ROLE_ICON[role] || "dot";
  const tagIcon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAG_ICONS[k] || TAG_ICONS.dot}</svg>`;
  // o: { tier | icon, text | html, rank, href | role, title }
  function tag(o) {
    const blk = o.tier ? `<b class="ti t${o.tier}">${o.tier}</b>` : `<span class="ti">${tagIcon(o.icon)}</span>`;
    const body = blk + `<span class="tx">${o.html ?? esc(o.text)}</span>` + (o.rank ? `<span class="rk">${esc(o.rank)}</span>` : "");
    const t = o.title ? ` title="${esc(o.title)}"` : "";
    if (o.href) return `<a class="tag" href="${o.href}"${t} onclick="event.stopPropagation()">${body}</a>`;
    if (o.role) return `<button type="button" class="tag" data-role="${o.role}"${t}>${body}</button>`;
    return `<span class="tag"${t}>${body}</span>`;
  }
  const idTag = id => tag({ icon: "identity", html: `<span class="ids">${idSyms(id)}</span><span class="mut">Color identity</span>`, title: "Color identity" });
  // a tier row under a tile: the full list name, or its short name where tiles are narrow (CSS picks)
  const tierLabel = k => { const R = ROLE_INFO[k]; return R.short && R.short !== R.label ? `<span class="lg">${esc(R.label)}</span><span class="sh">${esc(R.short)}</span>` : esc(R.label); };
  // a function tag; on card search it filters in place (data-role), elsewhere it links to card search
  function ftag(idx, k, here) {
    const t = idx && idx.tagInfo[k]; if (!t) return "";
    const o = { icon: FTAG_ICON[k] || "dot", text: t.label, title: `${t.group}: find more cards tagged ${t.label.toLowerCase()}` };
    return tag(here ? { ...o, role: k } : { ...o, href: page("search", "role=" + k) });
  }
  // function tags under a card tile, after its tier rows (roleKeys = the tier lists shown already)
  const ftags = (idx, c, n = 3, roleKeys = [], here) => c ? C.showTags(c, n, roleKeys).map(k => ftag(idx, k, here)).join("") : "";

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

  // ---------- Scryfall: images for cards on screen ----------
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

  // small log-in / sign-up dialog for pages other than card search (same /api/login and /api/signup)
  function login(sub) {
    return new Promise(resolve => {
      const box = document.createElement("div");
      box.className = "modal open";
      box.innerHTML = `<div class="sheet small" role="dialog" aria-modal="true" aria-label="Log in"><button type="button" class="close" aria-label="Close">×</button>
        <form class="form" novalidate><h2 class="sec-h" style="text-align:center;margin:0;font:400 40px/1 var(--gothic)">mournyl</h2><p class="muted" style="text-align:center;margin:0" id="lgSub">${esc(sub || "Log in to save cards")}</p>
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

  // the Users page lists everyone unless they hide their profile
  async function setProfileHidden(hidden) {
    const r = await api("PUT", "/api/me/profile", { hidden: !!hidden });
    meP = null;
    return r.hidden;
  }

  // ---------- Saved + profile, top right on every page ----------
  // Favorites live in the account when logged in, otherwise in this browser (same key the card search uses).
  async function initAccount() {
    const acct = $("navAcct"), saved = $("navSaved"), count = $("savedCount");
    if (!acct) return;
    const m = await me();
    let n = 0;
    if (m.online && m.user) { try { n = (await api("GET", "/api/saved")).favorites.length; } catch { /* keep 0 */ } }
    else { try { n = (JSON.parse(localStorage.getItem("mournyl-mtg-saved") || "{}").favorites || []).length; } catch { /* storage off */ } }
    if (count) { count.hidden = !n; count.textContent = n; }
    if (saved && saved.tagName === "A") saved.href = page("saved");
    acct.textContent = m.user ? m.user.username : m.online ? "Log in" : "This device";
    acct.title = m.online ? "" : "No server here; saves stay in this browser";
    acct.onclick = async e => {
      if (!m.online) return toast("No server here; saves stay in this browser");
      if (!m.user) { if (await login("Log in to save cards")) { meP = null; initAccount(); } return; }
      document.querySelector(".menu")?.remove();
      const r = e.currentTarget.getBoundingClientRect(), menu = document.createElement("div");
      menu.className = "menu";
      menu.innerHTML = `<div class="ttl">Signed in as ${esc(m.user.username)}</div>` +
        `<a class="menu-a" href="${page("users", "u-" + encodeURIComponent(m.user.username))}">My profile</a>` +
        `<button type="button" data-hide>${m.user.hidden ? "Show my profile on Users" : "Hide my profile from Users"}</button>` +
        `<button type="button" data-out>Log out</button>`;
      menu.style.top = r.bottom + 6 + "px"; menu.style.left = Math.max(8, r.right - 220) + "px";
      document.body.appendChild(menu);
      menu.querySelector("[data-out]").onclick = async () => { menu.remove(); try { await api("POST", "/api/logout", {}); } catch { /* already out */ } meP = null; toast("Logged out"); initAccount(); };
      menu.querySelector("[data-hide]").onclick = async () => {
        menu.remove();
        try { const r2 = await setProfileHidden(!m.user.hidden); toast(r2 ? "Your profile is hidden from Users" : "Your profile shows on Users"); }
        catch (err) { toast(err.message); }
        initAccount();
      };
      setTimeout(() => document.addEventListener("mousedown", function off(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", off); } }), 0);
    };
  }

  // ---------- header ----------
  function initNav(active) {
    sizeBar();
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

  // ---------- card sheets and the Back button ----------
  // Each card opened in a sheet gets its own history entry (same address), so Back walks back through the
  // cards you looked at, then closes the sheet, and Forward brings them back. ns keeps different sheets apart.
  function sheetHistory(ns, show, hide) {
    let settle = null;
    const mine = st => !!(st && st.mtgSheet && st.mtgSheet.ns === ns);
    addEventListener("popstate", e => {
      if (mine(e.state)) show(e.state.mtgSheet.key); else hide();
      if (settle) { const f = settle; settle = null; f(); }
    });
    return {
      push(key, label) {
        const st = history.state && typeof history.state === "object" ? history.state : {}, nested = mine(st);
        const sh = { ns, key, label, depth: nested ? st.mtgSheet.depth + 1 : 1, prev: nested ? st.mtgSheet.label : "" };
        try { history.pushState({ ...st, mtgSheet: sh }, ""); } catch { /* history off */ }
      },
      prev: () => mine(history.state) ? history.state.mtgSheet.prev : "",
      current: () => mine(history.state) ? history.state.mtgSheet.key : null,
      // hide now; resolve once the history is back where it was before the first card
      close() {
        const d = mine(history.state) ? history.state.mtgSheet.depth : 0;
        hide();
        if (!d) return Promise.resolve();
        return new Promise(res => { settle = res; history.go(-d); setTimeout(() => { if (settle === res) { settle = null; res(); } }, 600); });
      },
    };
  }

  // ---------- card sheet: rules text, tier in every role, better options ----------
  let modal, sheet, opener = null, ctxOpt = {}, navObj = null;
  const nav = () => navObj ||= sheetHistory("card", name => openCard(name, { ...ctxOpt, keepOpener: true, fromHistory: true }), hideCard);
  function ensureModal() {
    if (modal) return;
    modal = document.createElement("div"); modal.className = "modal"; modal.id = "cardModal";
    modal.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Card details"></div>`;
    document.body.appendChild(modal); sheet = modal.firstElementChild;
    modal.addEventListener("click", e => {
      if (e.target === modal || e.target.closest(".close")) return closeCard();
      if (e.target.closest("[data-sheet-back]")) return history.back();
      const b = e.target.closest("[data-open]"); if (b) { e.preventDefault(); openCard(b.dataset.open, { ...ctxOpt, keepOpener: true }); return; }
      const d = e.target.closest("[data-adddeck]"); if (d) { deckMenu(d, d.dataset.adddeck); return; }
      const ar = e.target.closest("[data-addrec]");
      if (ar && ctxOpt.deck) {
        addToDeck(ctxOpt.deck, ar.dataset.addrec).then(ok => {
          if (!ok) return;
          toast(`Added ${ar.dataset.addrec} to ${ctxOpt.deck.name}`);
          const cur = nav().current(); if (cur) openCard(cur, { ...ctxOpt, keepOpener: true, fromHistory: true });
        });
        return;
      }
      // a link to a list on this page: hide the sheet and let the link go; Back comes back to this card
      const a = e.target.closest("a[href]");
      if (a && a.target !== "_blank" && new URL(a.href, location.href).pathname === location.pathname) hideCard();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("open") && !document.querySelector(".menu")) closeCard(); });
  }
  function hideCard() {
    if (!modal || !modal.classList.contains("open")) return;
    modal.classList.remove("open"); document.body.style.overflow = "";
    document.querySelector(".menu")?.remove();
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }
  const closeCard = () => modal ? nav().close() : Promise.resolve();
  const isOpen = () => !!modal && modal.classList.contains("open");
  const slug = s => s.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-");
  const pct = e => (e >= 10 ? e.toFixed(0) : e.toFixed(1)) + "%";

  // a card that isn't in data/cards.json (very new, or a name the list spells differently): build what the sheet needs from Scryfall
  const TYPE_LETTER = { Land: "L", Creature: "C", Artifact: "A", Enchantment: "E", Instant: "I", Sorcery: "S", Planeswalker: "P", Battle: "B" };
  async function stubCard(name) {
    if (!scry(name)) await scryfall([name]);
    const s = scry(name), front = s ? (s.card_faces ? s.card_faces[0] : s) : null;
    const ty = front ? Object.keys(TYPE_LETTER).filter(w => (front.type_line || s.type_line || "").split(" // ")[0].includes(w)).map(w => TYPE_LETTER[w]).join("") : "";
    return { n: s ? s.name : String(name), mv: s ? s.cmc || 0 : 0, ty, id: s ? (s.color_identity || []).join("") : "",
      cost: ((front && front.mana_cost) || "").match(/\{[^}]+\}/g)?.map(t => t.slice(1, -1)) || [], prod: "", fl: "", roles: [], tags: [] };
  }

  // ---------- recommendations for a card opened from a deck ----------
  // Cards that do the same job (same sub-list first), fit the deck's colors, and aren't in the deck yet.
  // A card on no list (or whose job the deck already covers fully) gets picks for the jobs the deck has least of.
  const JOBS = ["ramp", "draw", "removal", "wipes", "counterspells", "protection", "tutors", "recursion", "gyhate"];
  function deckRecs(idx, c, deck) {
    const have = new Set(deck.cards.map(e => norm(e.n))); have.add(norm(c.n));
    const inDeck = deck.cards.map(e => findCard(idx, e.n)).filter(Boolean);
    const cmd = deck.commander && findCard(idx, deck.commander);
    let allowed = cmd ? cmd.id : "WUBRG".split("").filter(l => inDeck.some(x => x.id.includes(l))).join("");
    if (!allowed && !cmd) allowed = c.id;
    const ok = x => !have.has(norm(x.c.n)) && fits(x.c.id, allowed) && !flags(x.c).banned;
    const where = cmd ? `for ${cmd.n.split(",")[0]}` : "for this deck";
    const pick = (k, sub, n) => {
      const same = [], other = [];
      for (const x of idx.byRole[k] || []) {
        if (!ok(x)) continue;
        if (sub && x.sub === sub) { same.push(x); if (same.length >= n) break; }
        else if (other.length < n) other.push(x);
      }
      return same.concat(other).slice(0, n);
    };
    const out = [];
    for (const r of c.roles.slice().sort((a, b) => b.s - a.s).slice(0, 3)) {
      if (r.k === "lands" && !c.ty.includes("L")) continue;
      const items = pick(r.k, r.sub, 5);
      if (items.length) out.push({ title: `Recommended ${ROLE_INFO[r.k].label.toLowerCase()} ${where}`, items });
    }
    if (out.length) return out;
    if (c.ty.includes("L")) { const items = pick("lands", "", 5); return items.length ? [{ title: `Recommended lands ${where}`, items }] : []; }
    const count = k => inDeck.filter(x => x.roles.some(r => r.k === k)).length;
    for (const k of JOBS.slice().sort((a, b) => count(a) - count(b)).slice(0, 2)) {
      const items = pick(k, "", 3);
      if (items.length) out.push({ title: `Recommended ${ROLE_INFO[k].label.toLowerCase()} ${where}`, note: `This deck has ${count(k)} so far.`, items });
    }
    return out;
  }
  function recHtml(secs) {
    if (!secs.length) return "";
    return secs.map(sec => `<h3>${esc(sec.title)}</h3>${sec.note ? `<p class="muted" style="margin:-4px 0 8px;font-size:13px">${esc(sec.note)}</p>` : ""}<div class="better">` +
      sec.items.map(o => `<div class="rec"><button type="button" data-open="${esc(o.c.n)}">${tb(o.t)}<span>${esc(o.c.n)}</span><span class="muted">${o.s}</span>${cost(o.c.cost)}</button>` +
        (ctxOpt.deckEdit ? `<button type="button" class="addrec" data-addrec="${esc(o.c.n)}" aria-label="Add ${esc(o.c.n)} to ${esc(ctxOpt.deck.name)}">+ Add</button>` : "") + `</div>`).join("") + `</div>`).join("");
  }

  // opt.allowed (color identity to fit), opt.exclude (Set of names already in the deck), opt.noGC, opt.onPick(name),
  // opt.deck (opened from a deck: recommendations instead of "better" cards), opt.deckEdit (show "+ Add" on them)
  async function openCard(name, opt = {}) {
    ensureModal();
    if (!opt.keepOpener) opener = document.activeElement;
    ctxOpt = { allowed: opt.allowed, exclude: opt.exclude, noGC: opt.noGC, onPick: opt.onPick, pickLabel: opt.pickLabel, deck: opt.deck, deckEdit: opt.deckEdit };
    const idx = await loadCards();
    let c = findCard(idx, name);
    if (!c) c = await stubCard(name);   // not in the site's card list: still open it, with what Scryfall knows
    const roles = c.roles.slice().sort((a, b) => b.s - a.s);
    const files = await Promise.all(roles.map(x => loadRole(x.k).catch(() => null)));
    const entries = roles.map((x, i) => files[i]?.byN.get(c.n) || null);
    const e0 = entries.find(Boolean);
    if (!opt.fromHistory) nav().push(c.n, c.n);
    const render = () => {
      const f = flags(c), s = scry(c.n), big = img(c.n, "large");
      const faces = e0 ? e0.o : (s ? (s.card_faces || [s]).map(x => ({ n: x.name, c: (x.mana_cost || "").match(/\{[^}]+\}/g)?.map(t => t.slice(1, -1)) || [], ty: x.type_line || s.type_line, pt: x.power != null ? `${x.power}/${x.toughness}` : "", o: x.oracle_text || "" }))
        : [{ n: c.n, c: c.cost, ty: c.ty.split("").map(l => TYPE_NAMES[l]).filter(Boolean).join(" "), pt: "", o: "" }]);
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
      const better = ctxOpt.deck ? recHtml(deckRecs(idx, c, ctxOpt.deck)) : roles.filter(x => x.k !== "lands" || c.ty.includes("L")).map(x => {
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
      ].filter(Boolean).join("");
      const prev = nav().prev();
      sheet.innerHTML = `
        <button type="button" class="close" aria-label="Close">×</button>
        ${prev ? `<button type="button" class="sheetback" data-sheet-back>← Back to ${esc(prev)}</button>` : ""}
        <div><div class="bigimgbox" style="aspect-ratio:488/680;border-radius:4.75%/3.5%;overflow:hidden">${big ? `<img class="bigimg" src="${big}" alt="${esc(c.n)}">` : ""}</div>
          ${ctxOpt.onPick ? `<button type="button" class="btn primary" id="sheetPick" style="width:100%;justify-content:center;margin-top:12px">${esc(ctxOpt.pickLabel || "Add to deck")}</button>`
            : `<button type="button" class="btn" data-adddeck="${esc(c.n)}" style="width:100%;justify-content:center;margin-top:12px">+ Add to deck</button>`}</div>
        <div>
          ${faces.map(fc => `<div class="face"><div class="nameline"><h2>${esc(fc.n)}</h2>${cost(fc.c)}</div>
            <div class="typeline">${esc(fc.ty)}${fc.pt ? ` · ${esc(fc.pt)}` : ""}</div><div class="oracle">${para(fc.o) || `<p class="muted">Rules text loads from Scryfall when it can be reached.</p>`}</div></div>`).join("")}
          ${c.tags && c.tags.some(k => !C.TYPE_ONLY.has(k) && !C.DOWNSIDES.has(k)) ? `<h3>What it does</h3><div class="tags wide">${c.tags.filter(k => !C.TYPE_ONLY.has(k) && !C.DOWNSIDES.has(k)).map(k => ftag(idx, k)).join("")}</div>` : ""}
          ${c.tags && c.tags.some(k => C.DOWNSIDES.has(k)) ? `<h3>Downsides</h3><div class="tags wide down">${c.tags.filter(k => C.DOWNSIDES.has(k)).map(k => ftag(idx, k)).join("")}</div>` : ""}
          ${roles.length ? `<h3>Tiers</h3><div class="troles">${tierRows}</div>` : `<p class="muted">Not on any tier list yet.</p>`}
          ${better}
          <div class="meta"><span>Mana value <b>${c.mv}</b></span><span>Identity <b>${c.id ? idSyms(c.id) : "Colorless"}</b></span></div>
          ${badges ? `<div class="roles" style="margin-bottom:12px">${badges}</div>` : ""}
          <div class="links"><a class="btn small" href="${esc(sfUrl)}" target="_blank" rel="noopener">Scryfall</a>
            <a class="btn small" href="${esc(edUrl)}" target="_blank" rel="noopener">EDHREC</a>
            <a class="btn small" href="${esc(sbUrl)}" target="_blank" rel="noopener">Combos (Spellbook)</a></div>
        </div>`;
      const pick = sheet.querySelector("#sheetPick");
      if (pick) pick.onclick = () => { ctxOpt.onPick(c.n); closeCard(); };
    };
    render();
    modal.classList.add("open"); document.body.style.overflow = "hidden";
    modal.scrollTop = 0;
    (sheet.querySelector("[data-sheet-back]") || sheet.querySelector(".close")).focus();
    if (!scry(c.n)) scryfall([c.n]).then(ok => { if (ok && isOpen() && nav().current() === c.n) render(); });
  }
  let hubNames = null;
  loadHubNames();
  function loadHubNames() { loadHub().then(h => { hubNames = {}; h.roles.forEach(r => { hubNames[r.key] = Object.fromEntries(r.subs.map(s => [s.key, s.name])); }); }).catch(() => {}); }
  const hubSubName = (k, sub) => (hubNames && hubNames[k] && hubNames[k][sub]) || sub;


  // ---------- decks (My decks): in the account when logged in, otherwise in this browser ----------
  // A deck is { id, name, commander, cards: [{ n: name, q: count, cat?: group you moved it to }], updated }.
  // Everything else about a card (type, mana value, tiers) comes from data/cards.json.
  const DKEY = "mtg-decks";
  let deckList = [], deckMode = "local", deckUser = null, deckP = null, deckErr = "";
  const saving = new Map();
  function loadDecks(force) {
    if (force) deckP = null;
    return deckP ||= me().then(async m => {
      deckMode = m.online ? "remote" : "local"; deckUser = m.user; deckErr = "";
      if (!m.online) deckList = store.get(DKEY, []);
      else if (!m.user) deckList = [];
      else {
        try { deckList = (await api("GET", "/api/decks")).decks; }
        catch (e) { deckList = []; deckErr = e.message || "the server didn't answer"; deckP = null; }   // try again next time
      }
      return deckList;
    });
  }
  const decksChanged = () => document.dispatchEvent(new CustomEvent("mtg:decks"));
  const deckInfo = () => ({ mode: deckMode, user: deckUser, decks: deckList, error: deckErr });
  // true when the visitor still has to log in (and didn't)
  async function deckLogin() {
    await loadDecks();
    if (deckMode !== "remote" || deckUser) return false;
    const u = await login("Log in to build decks");
    if (!u) return true;
    await loadDecks(true); initAccount(); decksChanged();
    return false;
  }
  async function pushDeck(d) {
    const s = saving.get(d.id) || {}; saving.set(d.id, s);
    if (s.busy) { s.again = true; return; }
    s.busy = true;
    try { do { s.again = false; await api("PUT", `/api/decks/${d.id}`, { name: d.name, commander: d.commander, cards: d.cards }); } while (s.again); }
    catch (e) { toast(e.status === 401 ? "Log in again to keep saving this deck" : "Couldn't save the deck: " + e.message); }
    finally { s.busy = false; }
  }
  function saveDeck(d) {
    d.updated = Date.now();
    if (deckMode === "local") store.set(DKEY, deckList); else pushDeck(d);
    decksChanged();
  }
  async function createDeck(name, cards = []) {
    name = String(name || "").trim().slice(0, 60) || "New deck";
    if (await deckLogin()) return null;
    let d;
    if (deckMode === "remote") { try { d = (await api("POST", "/api/decks", { name, cards })).deck; } catch (e) { toast(e.message); return null; } }
    else d = { id: "d" + Date.now().toString(36), name, commander: "", cards, updated: Date.now() };
    deckList.unshift(d);
    if (deckMode === "local") store.set(DKEY, deckList);
    decksChanged();
    return d;
  }
  async function deleteDeck(d) {
    if (deckMode === "remote") { try { await api("DELETE", `/api/decks/${d.id}`); } catch (e) { toast(e.message); return false; } }
    deckList = deckList.filter(x => x !== d);
    if (deckMode === "local") store.set(DKEY, deckList);
    decksChanged();
    return true;
  }
  const inDeck = (d, name) => d.cards.find(x => norm(x.n) === norm(name)) || null;
  // basics and "any number of" cards stack; everything else is one copy (Commander)
  async function addToDeck(d, name, q = 1) {
    const idx = await loadCards(), c = findCard(idx, name), n = c ? c.n : String(name).trim();
    const have = inDeck(d, n);
    if (have) {
      const f = c ? flags(c) : {};
      if (!(f.basic || f.any || f.max)) { toast(`${n} is already in ${d.name}`); return false; }
      have.q = Math.min(f.max || 99, have.q + q);
    } else d.cards.push({ n, q });
    saveDeck(d);
    return true;
  }
  function removeFromDeck(d, name) {
    d.cards = d.cards.filter(x => norm(x.n) !== norm(name));
    if (d.commander && norm(d.commander) === norm(name)) d.commander = "";
    saveDeck(d);
  }
  // "Add <card> to…" menu: every deck (✓ = in it; click again to take it out) and a new-deck box
  async function deckMenu(anchor, name) {
    if (await deckLogin()) return;
    if (deckErr) { await loadDecks(true); if (deckErr) return toast(`Your decks didn't load: ${deckErr}`); }
    document.querySelector(".menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "menu deckmenu"; menu.setAttribute("role", "dialog"); menu.setAttribute("aria-label", `Add ${name} to a deck`);
    const draw = () => {
      menu.innerHTML = `<div class="ttl">Add ${esc(name)} to…</div>` +
        deckList.map((d, i) => `<button type="button" data-i="${i}"><span>${esc(d.name)}</span><span>${inDeck(d, name) ? "✓" : ""}</span></button>`).join("") +
        `<form><input placeholder="New deck name" maxlength="60" aria-label="New deck name"><button class="btn primary small" type="submit">Add</button></form>` +
        `<a class="melink-sm" href="${page("decks")}">Open My Decks</a>`;
      menu.querySelectorAll("button[data-i]").forEach(b => b.onclick = async () => {
        const d = deckList[+b.dataset.i];
        if (inDeck(d, name)) { removeFromDeck(d, name); toast(`Took ${name} out of ${d.name}`); }
        else if (await addToDeck(d, name)) toast(`Added to ${d.name}`);
        draw();
      });
      menu.querySelector("form").onsubmit = async ev => {
        ev.preventDefault();
        const d = await createDeck(menu.querySelector("input").value, []);
        if (d && await addToDeck(d, name)) { toast(`Added to ${d.name}`); draw(); }
      };
    };
    draw();
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
    menu.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
    (deckList.length ? menu.querySelector("button[data-i]") : menu.querySelector("input")).focus();
    const off = ev => { if (!menu.contains(ev.target) && ev.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc2); } };
    const esc2 = ev => { if (ev.key === "Escape") { ev.stopPropagation(); menu.remove(); anchor.focus(); document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc2); } };
    setTimeout(() => { document.addEventListener("mousedown", off); document.addEventListener("keydown", esc2); }, 0);
  }

  // a card sheet that was open when the page was reloaded comes back
  if (history.state && history.state.mtgSheet && history.state.mtgSheet.ns === "card") setTimeout(() => openCard(history.state.mtgSheet.key, { fromHistory: true }), 0);

  window.MTG = {
    ROOT, PREVIEW, url, page, $, esc, cap, sleep, fmt, norm, store, toast, getJSON,
    TIERS, TIER, tierOf, tb, ROLE_INFO, COLORS, TYPE_NAMES, fits, BROADER,
    loadSprite, sym, bigSym, syms, cost, para, idSyms, tag, idTag, tagIcon, subIcon, ROLE_ICON, FTAG_ICON, ftag, ftags, tierLabel, showTags: C.showTags, mainTag: C.mainTag, GENERIC: C.GENERIC, DOWNSIDES: C.DOWNSIDES, ROLE_TAGS: C.ROLE_TAGS,
    loadCards, loadHub, loadTierIndex, loadRole, findCard, flags, betterOptions, hubSubName,
    scryfall, scry, img, hasImages, api, me, refreshMe: () => { meP = null; deckP = null; }, login, initNav, initAccount, openCard, closeCard, isCardOpen: isOpen, pct,
    sheetHistory, setProfileHidden, cardSize, setCardSize, condensed, sizeButtons, sizeTabs, sizeBar, loadDecks, deckInfo, deckLogin, createDeck, saveDeck, deleteDeck, addToDeck, removeFromDeck, inDeck, deckMenu,
  };
})();
