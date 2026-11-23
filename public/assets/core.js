/* mournyl mtg — deck logic shared by the deck checker, slot finder and card search.
   No DOM and no network: everything here works on the card index (data/cards.json) and the
   role lists (tiers/data/<role>.json), so it also runs under Node for the tests in tests/core.test.mjs. */
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
  const COUNTS = 30;   // a card counts toward a role from D tier (score 30) up

  const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"')
    .replace(/æ/gi, "ae").replace(/\s+/g, " ").trim().toLowerCase();
  const fits = (id, allowed) => { for (const ch of id || "") if (!allowed.includes(ch)) return false; return true; };

  // ---------- card index ----------
  function buildIndex(d) {
    const R = d.roles, list = [], byName = new Map(), byRole = Object.fromEntries(R.map(k => [k, []]));
    for (const r of d.rows) {
      const c = { n: r[0], mv: r[1], ty: r[2], id: r[3], cost: r[4] ? r[4].split(",") : [], prod: r[5], fl: r[6], roles: [] };
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
    return { built: d.built, roles: R, subs: d.subs, list, byName, byRole };
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

  // ---------- decklist text ----------
  const SKIP_SECTIONS = /^(sideboard|maybeboard|maybe|considering|tokens?|acquireboard|attractions?|stickers?|contraptions?|about|companion)\b/i;
  const CMD_SECTIONS = /^(commanders?|command zone|cmdr)\b/i;
  const MAIN_SECTIONS = /^(deck|main ?deck|mainboard|main|library|creatures?|instants?|sorcer(y|ies)|artifacts?|enchantments?|planeswalkers?|lands?|battles?|other|spells?)\b/i;
  function parseList(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const out = [], blocks = [[]];
    let section = "main";
    lines.forEach((raw, i) => {
      let s = raw.trim();
      if (!s) { if (blocks[blocks.length - 1].length) blocks.push([]); return; }
      if (/^(\/\/|#(?! ?!))/.test(s) && !/^\/\/\s*commander/i.test(s)) {
        const h = s.replace(/^[/#\s]+/, "").replace(/\s*\(\d+\)\s*$/, "").replace(/:$/, "");
        if (CMD_SECTIONS.test(h)) section = "commander"; else if (SKIP_SECTIONS.test(h)) section = "skip"; else if (MAIN_SECTIONS.test(h)) section = "main";
        return;
      }
      const head = s.replace(/^\/\/\s*/, "").replace(/\s*\(\d+\)\s*$/, "").replace(/:\s*$/, "").trim();
      if (!/^\d/.test(head) && !/\s/.test(head.replace(/^(main ?deck|command zone)$/i, "x"))) {
        if (CMD_SECTIONS.test(head)) { section = "commander"; return; }
        if (SKIP_SECTIONS.test(head)) { section = "skip"; return; }
        if (MAIN_SECTIONS.test(head) && !/^lands? /i.test(head)) { section = "main"; return; }
      }
      if (/^(main ?deck|command zone|sideboard:?|maybeboard:?)$/i.test(head)) { section = /command/i.test(head) ? "commander" : /side|maybe/i.test(head) ? "skip" : "main"; return; }
      if (/^SB:\s*/i.test(s)) return;                                  // MTGO sideboard lines
      let cmd = false;
      const m = /^(\d+)\s*[xX]?\s+(.+)$/.exec(s) || /^[xX](\d+)\s+(.+)$/.exec(s);
      let qty = 1, name = s;
      if (m) { qty = +m[1]; name = m[2]; }
      if (/\*CMDR\*|\[\s*commander|#\s*!commander|\(commander\)/i.test(name)) cmd = true;
      name = name.replace(/\s*\*CMDR\*/ig, "").replace(/\s*#\s*!?commander.*$/i, "").replace(/\s*\(commander\)/ig, "")
        .replace(/\s*\[[^\]]*\]/g, "")                                  // Archidekt categories
        .replace(/\s*\^[^^]*\^/g, "")                                  // Archidekt color tags
        .replace(/\s*\*[FE]\*\s*$/i, "").replace(/\s*\*foil\*\s*$/i, "")
        .replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+[A-Za-z0-9★†-]+)?\s*$/, "") // (SET) 123
        .replace(/\s+\[[A-Za-z0-9]{2,6}\](\s+[A-Za-z0-9-]+)?\s*$/, "")
        .replace(/\s+#\S.*$/, "")                                       // tags
        .replace(/\s+\/\s+/, " // ").replace(/\s*\/\/\s*/, " // ").trim();
      if (!name) return;
      const entry = { raw, line: i + 1, qty, name, commander: cmd || section === "commander" };
      if (section === "skip") return;
      out.push(entry); blocks[blocks.length - 1].push(entry);
    });
    return { entries: out, blocks: blocks.filter(b => b.length) };
  }

  // bounded edit distance (gives up past `max`)
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  function suggest(idx, name, n = 3) {
    const q = norm(name), max = Math.max(2, Math.min(4, Math.floor(q.length / 5))), hits = [];
    for (const c of idx.list) {
      const k = norm(c.n), f = k.split(" // ")[0];
      let d = lev(q, f, max); if (d > max && k !== f) d = Math.min(d, lev(q, k, max));
      if (d <= max) hits.push([d, c]);
      else if (q.length >= 5 && (f.startsWith(q) || k.includes(q))) hits.push([max + 0.5, c]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1].n.length - b[1].n.length);
    return hits.slice(0, n).map(h => h[1]);
  }

  // Turn parsed lines into cards. `commanderNames` (optional) overrides markers in the text.
  function resolveDeck(parsed, idx, commanderNames) {
    const cards = new Map(), unknown = [];
    let cmdNames = (commanderNames || []).map(norm).filter(Boolean);
    for (const e of parsed.entries) {
      const c = idx.byName.get(norm(e.name)) || idx.byName.get(norm(e.name.split(" // ")[0]));
      if (!c) { unknown.push({ ...e, suggestions: suggest(idx, e.name).map(x => x.n) }); continue; }
      const cur = cards.get(c.n) || { card: c, qty: 0, lines: [], commander: false };
      cur.qty += e.qty; cur.lines.push(e.line); cur.commander = cur.commander || e.commander;
      cards.set(c.n, cur);
    }
    let commanders = [];
    if (cmdNames.length) commanders = cmdNames.map(n => idx.byName.get(n)).filter(Boolean);
    else commanders = [...cards.values()].filter(x => x.commander).map(x => x.card);
    let guessed = false;
    if (!commanders.length && parsed.blocks.length > 1) {        // e.g. "1 Commander" set apart by a blank line at the top or bottom
      for (const b of [parsed.blocks[parsed.blocks.length - 1], parsed.blocks[0]]) {
        if (b.length > 2) continue;
        const cs = b.map(e => idx.byName.get(norm(e.name))).filter(Boolean);
        if (cs.length === b.length && cs.every(c => flagsOf(c).commander)) { commanders = cs; guessed = true; break; }
      }
    }
    commanders = commanders.slice(0, 2);
    const main = [...cards.values()].filter(x => !commanders.includes(x.card));
    for (const c of commanders) {                                   // a commander listed in the deck counts once
      const x = cards.get(c.n); if (x && x.qty > 1) main.push({ ...x, qty: x.qty - 1 });
    }
    return { commanders, main, unknown, guessed };
  }

  // ---------- house rules ----------
  const PRESETS = {
    pod: { name: "My pod (Bracket 3 house rules)", maxGC: 3, mld: false, extra: "no-chain", twoCard: false, blockTags: ["S", "R"] },
    b2: { name: "Casual (no Game Changers, no combos)", maxGC: 0, mld: false, extra: "no-chain", twoCard: false, blockTags: ["P", "S", "R"] },
    b4: { name: "Optimized (anything goes)", maxGC: 99, mld: true, extra: "any", twoCard: true, blockTags: [] },
  };
  const TAG_NAMES = { R: "Ruthless", S: "Spicy", P: "Powerful", O: "Oddball", C: "Core", E: "Exhibition", B: "Banned" };

  // ---------- role targets ----------
  const TARGETS = [
    { k: "lands", label: "Lands", min: 36, max: 38, note: "Basics and nonbasics; spell-lands count as half" },
    { k: "ramp", label: "Ramp", min: 10, max: 12, roles: ["ramp"], note: "Rocks, dorks, land ramp, cost cutters" },
    { k: "draw", label: "Card draw", min: 10, max: 14, roles: ["draw"], half: { draw: ["cantrip"] }, note: "Burst draw and engines; cantrips count as half" },
    { k: "removal", label: "Targeted removal", min: 8, max: 12, roles: ["removal", "counterspells"], note: "Removal, bounce and counterspells" },
    { k: "wipes", label: "Board wipes", min: 2, max: 3, roles: ["wipes"], note: "Any wipe, one-sided ones included" },
    { k: "protection", label: "Protection", min: 2, max: 4, roles: ["protection"], note: "Hexproof, indestructible, phasing, counter-protection" },
    { k: "gyhate", label: "Graveyard hate", min: 1, max: 2, roles: ["gyhate"], note: "One-shot or repeatable" },
    { k: "tutors", label: "Tutors", min: 0, max: 99, roles: ["tutors"], info: true, note: "No target; shown for reference" },
    { k: "recursion", label: "Recursion", min: 0, max: 99, roles: ["recursion"], info: true, note: "No target; shown for reference" },
  ];

  function pipsOf(cost) {
    const p = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const t of cost) {
      const cs = t.replace("/P", "").split("/").filter(x => "WUBRG".includes(x));
      if (!cs.length) continue;
      const w = t.includes("/") && !/^[WUBRG]\/P$/.test(t) ? 0.5 : 1;
      cs.forEach(x => p[x] += cs.length > 1 ? w : (t.startsWith("2/") ? 0.5 : w));
    }
    return p;
  }

  // deck = resolveDeck(...); opt = { rules, targets }
  function analyzeDeck(deck, idx, opt = {}) {
    const rules = opt.rules || PRESETS.pod;
    const targets = opt.targets || TARGETS;
    const cmds = deck.commanders, identity = "WUBRG".split("").filter(k => cmds.some(c => c.id.includes(k))).join("");
    const all = [...cmds.map(c => ({ card: c, qty: 1, commander: true })), ...deck.main];
    const names = new Set(all.map(x => x.card.n));
    const total = all.reduce((a, x) => a + x.qty, 0);
    const issues = [];
    // legality
    if (!cmds.length) issues.push({ k: "commander", sev: "bad", msg: "No commander found. Mark it in the list or pick it above." });
    cmds.forEach(c => { if (!flagsOf(c).commander) issues.push({ k: "commander", sev: "bad", msg: `${c.n} can't be your commander.`, cards: [c.n] }); });
    if (cmds.length === 2) {
      const [a, b] = cmds.map(flagsOf);
      const ok = (a.partner && b.partner) || (a.partner && b.background) || (b.partner && a.background);
      if (!ok) issues.push({ k: "commander", sev: "bad", msg: `${cmds[0].n} and ${cmds[1].n} can't be commanders together (no partner or Background).`, cards: cmds.map(c => c.n) });
    }
    if (total !== 100) issues.push({ k: "size", sev: "bad", msg: `${total} cards with the commander${cmds.length > 1 ? "s" : ""}; Commander decks are exactly 100.` });
    const dupes = all.filter(x => { const f = flagsOf(x.card); return x.qty > 1 && !f.basic && !f.any && !(f.max && x.qty <= f.max); });
    if (dupes.length) issues.push({ k: "singleton", sev: "bad", msg: "More than one copy of a card that isn't a basic land.", cards: dupes.map(x => `${x.qty} ${x.card.n}`) });
    const banned = all.filter(x => flagsOf(x.card).banned);
    if (banned.length) issues.push({ k: "banned", sev: "bad", msg: "Banned in Commander.", cards: banned.map(x => x.card.n) });
    const off = cmds.length ? deck.main.filter(x => !fits(x.card.id, identity)) : [];
    if (off.length) issues.push({ k: "identity", sev: "bad", msg: `Outside the commander's color identity (${identity || "colorless"}).`, cards: off.map(x => x.card.n) });
    if (deck.unknown && deck.unknown.length) issues.push({ k: "unknown", sev: "warn", msg: `${deck.unknown.length} line${deck.unknown.length > 1 ? "s" : ""} didn't match a Commander-legal card.`, cards: deck.unknown.map(u => u.name) });

    // roles
    const roleRows = targets.map(T => {
      const rows = [];
      let count = 0;
      for (const x of deck.main) {
        const c = x.card, f = flagsOf(c);
        if (T.k === "lands") {
          if (f.land) { rows.push({ n: c.n, w: x.qty, t: (c.roles.find(r => r.k === "lands") || {}).t || (f.basic ? "" : null) }); count += x.qty; }
          else if (f.mdfc) { rows.push({ n: c.n, w: 0.5, t: (c.roles.find(r => r.k === "lands") || {}).t }); count += 0.5 * x.qty; }
          continue;
        }
        const hits = c.roles.filter(r => T.roles.includes(r.k));
        if (!hits.length) continue;
        const best = hits.sort((a, b) => b.s - a.s)[0];
        if (best.s < COUNTS) { rows.push({ n: c.n, w: 0, t: best.t, weak: true, role: best.k }); continue; }
        const half = T.half && T.half[best.k] && T.half[best.k].includes(best.sub) && !hits.some(h => h.s >= COUNTS && !(T.half[h.k] || []).includes(h.sub));
        const w = half ? 0.5 : 1;
        rows.push({ n: c.n, w, t: best.t, role: best.k, sub: best.sub, s: best.s }); count += w;
      }
      rows.sort((a, b) => (b.w > 0) - (a.w > 0) || (b.s || 0) - (a.s || 0));
      const status = T.info ? "info" : count < T.min ? "low" : count > T.max ? "high" : "ok";
      return { ...T, count, rows, status };
    });

    // mana
    const curve = [0, 0, 0, 0, 0, 0, 0, 0];
    let mvSum = 0, spells = 0;
    const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 }, sources = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const x of all) {
      const c = x.card, f = flagsOf(c);
      if (!f.land) {
        if (!x.commander) { curve[Math.min(7, c.mv)] += x.qty; mvSum += c.mv * x.qty; spells += x.qty; }
        const p = pipsOf(c.cost); for (const k in p) pips[k] += p[k] * x.qty;
      }
      if (x.commander) continue;
      const prod = c.prod || "";
      const w = f.land ? 1 : f.mdfc ? 0.5 : c.roles.some(r => r.k === "ramp" && r.s >= COUNTS && (r.sub === "rocks" || r.sub === "dorks")) ? 1 : 0;
      if (w) for (const k of "WUBRG") if (prod.includes(k) && identity.includes(k)) sources[k] += w * x.qty;
    }
    const pipTotal = Object.values(pips).reduce((a, b) => a + b, 0) || 1;
    const srcTotal = Object.values(sources).reduce((a, b) => a + b, 0) || 1;
    const colors = identity.split("").map(k => {
      const share = pips[k] / pipTotal, sshare = sources[k] / srcTotal;
      const short = pips[k] >= 4 && (sources[k] < 8 || sshare < share * 0.75);
      return { k, pips: Math.round(pips[k] * 10) / 10, share, sources: sources[k], sshare, short };
    });
    const landRow = roleRows.find(r => r.k === "lands");
    const mana = { lands: landRow ? landRow.count : 0, curve, avg: spells ? mvSum / spells : 0, spells, colors };

    // bracket and house rules
    const gcs = all.filter(x => flagsOf(x.card).gc).map(x => x.card.n);
    const mld = all.filter(x => flagsOf(x.card).mld).map(x => x.card.n);
    const extra = all.filter(x => flagsOf(x.card).extra).map(x => x.card.n);
    const ruleRows = [
      { k: "gc", label: `Game Changers: ${gcs.length} (max ${rules.maxGC >= 99 ? "no limit" : rules.maxGC})`, ok: gcs.length <= rules.maxGC, cards: gcs },
      { k: "mld", label: rules.mld ? "Mass land destruction allowed" : "No mass land destruction", ok: rules.mld || !mld.length, cards: mld },
      { k: "extra", label: rules.extra === "any" ? "Extra turns allowed" : rules.extra === "none" ? "No extra turns" : "No chained extra turns",
        ok: rules.extra === "any" || (rules.extra === "none" ? !extra.length : extra.length <= 1),
        warn: rules.extra === "no-chain" && extra.length === 1, cards: extra },
    ];

    // weak links: a card whose best job is D or F, with replacements that fit
    const atCap = gcs.length >= rules.maxGC;
    const weak = [];
    for (const x of deck.main) {
      const c = x.card, f = flagsOf(c);
      if (f.basic || !c.roles.length) continue;
      const best = c.roles.slice().sort((a, b) => b.s - a.s)[0];
      if (best.s >= 45) continue;
      if (best.k === "lands" && !f.land) continue;
      const opts = betterOptions(idx, c, best.k, { allowed: cmds.length ? identity : c.id, exclude: names, limit: 3, noGC: atCap });
      weak.push({ n: c.n, role: best.k, t: best.t, s: best.s, sub: best.sub, rev: best.rev, options: opts.map(o => ({ n: o.c.n, s: o.s, t: o.t, mv: o.c.mv, cost: o.c.cost, gc: o.c.fl.includes("g") })) });
    }
    weak.sort((a, b) => a.s - b.s);

    return { identity, total, issues, legal: !issues.some(i => i.sev === "bad"), roles: roleRows, mana, rules: ruleRows, gcs, weak, names: [...names] };
  }

  // Spellbook results (from /api/spellbook) folded into the house-rules check
  function comboRules(spell, rules) {
    if (!spell || spell.error) return null;
    const combos = spell.combos || [];
    const two = combos.filter(c => c.twoCard);
    const tagged = combos.filter(c => rules.blockTags.includes(c.tag));
    return [
      { k: "two", label: rules.twoCard ? "Two-card infinite combos allowed" : "No two-card infinite combos", ok: rules.twoCard || !two.length, combos: two },
      { k: "tag", label: rules.blockTags.length ? `Nothing Spellbook rates ${rules.blockTags.map(t => TAG_NAMES[t]).join(" or ")}` : "Any Spellbook rating allowed",
        ok: !tagged.length && !rules.blockTags.includes(spell.bracketTag), combos: tagged, deckTag: spell.bracketTag },
    ];
  }

  // ---------- slot finder ----------
  const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };
  const NEEDS = [
    [/mana rocks?|\brocks?\b/, "ramp", "rocks"], [/mana dorks?|\bdorks?\b/, "ramp", "dorks"], [/land ramp|ramp spells?/, "ramp", "lands"],
    [/\bramp\b|mana/, "ramp", ""],
    [/draw engines?|\bengines?\b/, "draw", "engine"], [/cantrips?|loot/, "draw", "cantrip"], [/impulse/, "draw", "impulse"],
    [/card draw|\bdraw\b|card advantage/, "draw", ""],
    [/counterspells?|\bcounters?\b/, "counterspells", ""],
    [/board ?wipes?|\bwipes?\b|sweepers?|wraths?/, "wipes", ""],
    [/artifact (and|or|\/) enchantment removal|artifact removal|enchantment removal/, "removal", "artifact-enchantment"],
    [/creature removal/, "removal", "creature"], [/\bbounce\b/, "removal", "bounce"],
    [/removal|kill spells?|answers?/, "removal", ""],
    [/tutors?/, "tutors", ""], [/protection|protect/, "protection", ""],
    [/graveyard hate|gy hate|grave ?hate/, "gyhate", ""], [/recursion|reanimat|recur/, "recursion", ""],
    [/utility lands?/, "lands", "utility"], [/spell-?lands?|mdfcs?/, "lands", "spell-lands"], [/fixing|dual lands?|duals|\blands?\b/, "lands", "fixing"],
  ];
  function parseNeed(text) {
    const t = " " + String(text || "").toLowerCase() + " ";
    const out = { n: null, role: "", sub: "", maxMv: null, inst: false, type: "" };
    const num = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\b(?! mana(?! rocks?| dorks?)| or less| cmc| mv)/.exec(t.replace(/\b(at|under|below|max|mv|cmc)\s+\d+/g, " "));
    if (num) out.n = /^\d+$/.test(num[1]) ? +num[1] : WORDS[num[1]];
    let m;
    if ((m = /(?:at|for)?\s*(\d+)\s*(?:mana|mv|cmc)?\s*or (?:less|under|cheaper|fewer)/.exec(t))) out.maxMv = +m[1];
    else if ((m = /(?:under|below|less than)\s*(\d+)/.exec(t))) out.maxMv = Math.max(0, +m[1] - 1);
    else if ((m = /(?:max|<=|≤|up to)\s*(\d+)/.exec(t))) out.maxMv = +m[1];
    else if ((m = /(?:at|costing)\s*(\d+)\s*(?:mana|mv|cmc)/.exec(t))) out.maxMv = +m[1];
    if (/instant|flash/.test(t)) out.inst = true;
    if ((m = /\b(creature|artifact|enchantment|sorcery|planeswalker)s?\b/.exec(t)) && !/(artifact|enchantment|creature) (removal|and|or)/.test(t)) out.type = m[1][0].toUpperCase() + m[1].slice(1);
    for (const [re, role, sub] of NEEDS) if (re.test(t)) { out.role = role; out.sub = sub; break; }
    return out;
  }
  // entries = one role list (tiers/data/<role>.json); opt = { identity, exclude:Set, sub, maxMv, inst, type, noGC, reviewedOnly, limit }
  function findSlots(entries, opt = {}) {
    const out = [];
    for (const e of entries) {
      if (opt.sub && e.sub !== opt.sub) continue;
      if (opt.identity != null && !fits(e.clr, opt.identity)) continue;
      if (opt.exclude && (opt.exclude.has(e.n) || opt.exclude.has(e.n.split(" // ")[0]))) continue;
      if (opt.maxMv != null && e.mv > opt.maxMv) continue;
      if (opt.inst && !e.inst) continue;
      if (opt.type && !new RegExp("\\b" + opt.type + "\\b").test(e.ty)) continue;
      if (opt.noGC && e.gc) continue;
      if (opt.reviewedOnly && !e.rev) continue;
      out.push(e);
      if (opt.limit && out.length >= opt.limit) break;
    }
    return out;    // role lists are already sorted best first
  }

  // ---------- export ----------
  function swapsText(swaps) {
    const cuts = swaps.map(s => `1 ${s.out}`), adds = swaps.map(s => `1 ${s.in}`);
    return `// Cuts\n${cuts.join("\n")}\n\n// Adds\n${adds.join("\n")}\n`;
  }
  function deckText(deck, swaps = []) {
    const out = new Map(swaps.map(s => [s.out, s.in]));
    const lines = [];
    for (const x of deck.main) {
      if (out.has(x.card.n)) { if (x.qty > 1) lines.push(`${x.qty - 1} ${x.card.n}`); lines.push(`1 ${out.get(x.card.n)}`); }
      else lines.push(`${x.qty} ${x.card.n}`);
    }
    return (deck.commanders.length ? `Commander\n${deck.commanders.map(c => `1 ${c.n}`).join("\n")}\n\n` : "") + `Deck\n${lines.join("\n")}\n`;
  }

  return { TIERS, tierOf, COUNTS, norm, fits, buildIndex, flagsOf, betterOptions, BROADER, parseList, lev, suggest, resolveDeck,
    PRESETS, TAG_NAMES, TARGETS, pipsOf, analyzeDeck, comboRules, parseNeed, findSlots, swapsText, deckText };
});
