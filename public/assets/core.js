/* mournyl mtg — card index and tier logic shared by the tier lists and card search.
   No DOM and no network, so it also runs under Node for the tests in tests/core.test.mjs. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MTGCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- tiers ----------
  const TIERS = [
    { t: "S", min: 90 }, { t: "A", min: 75 }, { t: "B", min: 60 }, { t: "C", min: 45 }, { t: "D", min: 30 }, { t: "F", min: 0 },
  ];
  const tierOf = s => (TIERS.find(T => s >= T.min) || TIERS[5]).t;

  const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"')
    .replace(/æ/gi, "ae").replace(/\s+/g, " ").trim().toLowerCase();
  const fits = (id, allowed) => { for (const ch of id || "") if (!allowed.includes(ch)) return false; return true; };

  // ---------- function tags (tools/tiers/tags.py) ----------
  // Card-type tags alone don't say what a card does; generic ones show only when nothing more specific fits.
  const TYPE_ONLY = new Set(["aura", "equipment", "vehicle", "saga", "planeswalker"]);
  const GENERIC = new Set([...TYPE_ONLY, "etb", "attack", "keyword", "evasion", "firststrike", "deathtouch", "haste", "flash", "defender",
    "vanilla", "basic", "monoland"]);
  // what a card costs you (tools/tiers/tags.py, group "Downsides"): shown apart, never as what a card does
  const DOWNSIDES = new Set(["lifecost", "selfdiscard", "sacrifice", "exilecost", "helpsopp", "upkeep", "tapped", "symmetric", "restricted"]);
  // the tags that repeat what a tier list already says
  const ROLE_TAGS = { counterspells: ["counter"], ramp: ["ramp"], draw: ["draw"], removal: ["removal"], wipes: ["wipe"], tutors: ["tutor"],
    protection: ["protect"], gyhate: ["gyhate"], recursion: ["recursion", "reanimate"], lands: ["fixing", "utilityland", "basic", "monoland"] };
  // up to n tags to show under a card, most specific first, skipping what its tier rows already say
  function showTags(c, n = 3, roleKeys = []) {
    const skip = new Set(); for (const k of roleKeys) for (const t of ROLE_TAGS[k] || []) skip.add(t);
    const tags = (c.tags || []).filter(k => !skip.has(k) && !TYPE_ONLY.has(k) && !DOWNSIDES.has(k));
    const specific = tags.filter(k => !GENERIC.has(k));
    return (specific.length ? specific : tags).slice(0, n);
  }
  const mainTag = c => (c.tags || []).find(k => !GENERIC.has(k) && !DOWNSIDES.has(k)) || null;

  // ---------- card index ----------
  function buildIndex(d) {
    const R = d.roles, list = [], byName = new Map(), byRole = Object.fromEntries(R.map(k => [k, []]));
    const TAGS = (d.tags || []).map(([k, label, group]) => ({ k, label, group })), code = d.tagcode || "";
    const byTag = Object.fromEntries(TAGS.map(t => [t.k, []])), ti = (d.cols || []).indexOf("tags");
    for (const r of d.rows) {
      const c = { n: r[0], mv: r[1], ty: r[2], id: r[3], cost: r[4] ? r[4].split(",") : [], prod: r[5], fl: r[6], roles: [], tags: [] };
      if (ti >= 0 && r[ti]) for (const ch of r[ti]) { const t = TAGS[code.indexOf(ch)]; if (t) { c.tags.push(t.k); byTag[t.k].push(c); } }
      if (r[7]) for (const s of r[7].split(",")) {
        const m = /^(\d+):(\d+):(\d+):(\d+)(u?)$/.exec(s); if (!m) continue;
        const k = R[+m[1]], x = { k, s: +m[2], t: tierOf(+m[2]), sub: d.subs[k][+m[3]], r: +m[4], rev: !m[5], c };
        c.roles.push(x); byRole[k].push(x);
      }
      list.push(c); byName.set(norm(c.n), c);
    }
    for (const c of list) {
      const f = c.n.split(" // ")[0];
      if (f !== c.n && !byName.has(norm(f))) byName.set(norm(f), c);
    }
    for (const k of R) byRole[k].sort((a, b) => b.s - a.s || a.c.mv - b.c.mv || (a.c.n < b.c.n ? -1 : 1));
    return { built: d.built, roles: R, subs: d.subs, list, byName, byRole, tags: TAGS, tagInfo: Object.fromEntries(TAGS.map(t => [t.k, t])), byTag };
  }
  const flagsOf = c => ({ gc: c.fl.includes("g"), banned: c.fl.includes("b"), mld: c.fl.includes("m"), extra: c.fl.includes("x"),
    any: c.fl.includes("n"), max: +(c.fl.match(/\d/) || [0])[0], partner: c.fl.includes("p"), background: c.fl.includes("k"),
    commander: c.ty.includes("K") || c.fl.includes("k"), basic: c.ty.includes("Y"), land: c.ty.includes("L"), mdfc: c.ty.includes("M") });

  const BROADER = { removal: { creature: ["any"], "artifact-enchantment": ["any"], damage: ["any", "creature"], bounce: ["any"] }, wipes: { creatures: ["nonland"] } };
  function betterOptions(idx, card, roleKey, opt = {}) {
    const me = card.roles.find(x => x.k === roleKey); if (!me) return [];
    const allowed = opt.allowed ?? card.id, exclude = opt.exclude || new Set(), limit = opt.limit || 5;
    const subs = [me.sub, ...((BROADER[roleKey] || {})[me.sub] || [])];
    const out = [];
    for (const x of idx.byRole[roleKey]) {
      if (x.s <= me.s) break;
      const c = x.c;
      if (c === card || !subs.includes(x.sub) || exclude.has(c.n) || c.fl.includes("b")) continue;
      if (c.mv > card.mv + (opt.mvSlack ?? 1) || !fits(c.id, allowed)) continue;
      if (opt.noGC && c.fl.includes("g")) continue;
      if (roleKey === "lands" && me.sub === "fixing" && allowed.length >= 2 && [...allowed].filter(k => c.prod.includes(k)).length < 2) continue;
      out.push(x); if (out.length >= limit) break;
    }
    return out;
  }

  return { TIERS, tierOf, norm, fits, buildIndex, flagsOf, betterOptions, BROADER, TYPE_ONLY, GENERIC, DOWNSIDES, ROLE_TAGS, showTags, mainTag };
});
