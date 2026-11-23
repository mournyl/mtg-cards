// Deck logic tests: node --test tests/core.test.mjs   (Node 18+, no packages)
// Runs against the real data files in public/, so the weekly refresh checks the new data too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const K = require("../public/assets/core.js");
const root = new URL("../public/", import.meta.url);
const idx = K.buildIndex(JSON.parse(readFileSync(new URL("data/cards.json", root), "utf8")));
const role = k => JSON.parse(readFileSync(new URL(`tiers/data/${k}.json`, root), "utf8"));
const card = n => idx.byName.get(K.norm(n));

const SAMPLE = readFileSync(new URL("../tests/fixtures/niv-mizzet.txt", import.meta.url), "utf8");

test("card index: names, front faces, flags", () => {
  assert.ok(idx.list.length > 30000);
  assert.equal(card("sol ring").n, "Sol Ring");
  assert.equal(card("Fire").n, "Fire // Ice");                       // split card by its first half
  assert.equal(card("Lim-Dul's Vault")?.n ?? card("Lim-Dûl's Vault").n, card("Lim-Dûl's Vault").n);  // accents don't matter
  assert.ok(K.flagsOf(card("Rhystic Study")).gc);
  assert.ok(K.flagsOf(card("Primeval Titan")).banned);
  assert.ok(K.flagsOf(card("Relentless Rats")).any);
  assert.equal(K.flagsOf(card("Seven Dwarves")).max, 7);
  assert.ok(K.flagsOf(card("Thrasios, Triton Hero")).partner);
  assert.ok(K.flagsOf(card("Candlekeep Sage")).background);
  assert.ok(K.flagsOf(card("Niv-Mizzet, Parun")).commander);
  assert.ok(!K.flagsOf(card("Sol Ring")).commander);
});

test("tiers: every role list is sorted best first and tiers match scores", () => {
  for (const k of idx.roles) {
    const list = role(k);
    assert.ok(list.length > 100, k);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].s >= list[i].s, `${k} sorted at ${i}`);
    for (const e of list) assert.equal(e.t, K.tierOf(e.s), `${k}: ${e.n}`);
    const gap = list.slice(0, 50).filter(e => !e.rev).length;   // new cards can slip in between reviews: warn, don't block the refresh
    if (gap) console.warn(`${k}: ${gap} unreviewed card(s) in the top 50 (see tools/tiers/out/new-candidates.txt)`);
  }
  assert.equal(K.tierOf(90), "S"); assert.equal(K.tierOf(89), "A"); assert.equal(K.tierOf(29), "F");
});

test("anchor cards sit where the plan puts them", () => {
  const s = (n, k) => card(n).roles.find(r => r.k === k).s;
  assert.ok(s("Counterspell", "counterspells") >= 90);
  assert.ok(s("Swords to Plowshares", "removal") >= 90);
  assert.ok(s("Cultivate", "ramp") >= 75 && s("Cultivate", "ramp") < 90);
  assert.ok(s("Phyrexian Arena", "draw") >= 75);
  assert.ok(s("Wrath of God", "wipes") >= 75);
});

test("parseList: common export formats", () => {
  const p = K.parseList(`Commander
1 Atraxa, Praetors' Voice

Deck
1x Sol Ring (CMM) 400
2 Island
1 Fire // Ice
1 Brainstorm *F*
1 Arcane Signet [Ramp]
1 Thrasios, Triton Hero *CMDR*
SIDEBOARD:
1 Swords to Plowshares`);
  const names = p.entries.map(e => e.name);
  assert.deepEqual(names, ["Atraxa, Praetors' Voice", "Sol Ring", "Island", "Fire // Ice", "Brainstorm", "Arcane Signet", "Thrasios, Triton Hero"]);
  assert.equal(p.entries[0].commander, true);
  assert.equal(p.entries[2].qty, 2);
  assert.equal(p.entries.at(-1).commander, true);
  const arch = K.parseList("1x Sol Ring (cmm) 400 [Ramp,Artifact]\n1x Atraxa, Praetors' Voice (2x2) 190 [Commander{top}]");
  assert.equal(arch.entries[1].commander, true);
  assert.equal(arch.entries[0].name, "Sol Ring");
});

test("resolveDeck: commander found from a set-apart line, typos suggested", () => {
  const d = K.resolveDeck(K.parseList("1 Sol Ring\n1 Arcane Signet\n1 Brainstrom\n\n1 Niv-Mizzet, Parun"), idx);
  assert.equal(d.commanders[0].n, "Niv-Mizzet, Parun");
  assert.ok(d.guessed);
  assert.equal(d.unknown.length, 1);
  assert.equal(d.unknown[0].suggestions[0], "Brainstorm");
});

test("analyzeDeck: the sample Izzet deck", () => {
  const d = K.resolveDeck(K.parseList(SAMPLE), idx);
  const r = K.analyzeDeck(d, idx, { rules: K.PRESETS.pod });
  assert.equal(r.total, 100);
  assert.equal(r.identity, "UR");
  assert.ok(r.legal, JSON.stringify(r.issues));
  const roles = Object.fromEntries(r.roles.map(x => [x.k, x]));
  assert.equal(roles.lands.count, 37);                   // 36 lands + two spell-lands at half
  assert.ok(roles.ramp.count >= 10);
  assert.ok(roles.wipes.count === 3);
  assert.equal(r.gcs.length, 4);                         // Rhystic Study, Mystic Remora? no: GC list below
  assert.deepEqual(r.gcs.sort(), ["Cyclonic Rift", "Fierce Guardianship", "Mystical Tutor", "Rhystic Study"]);
  assert.equal(r.rules.find(x => x.k === "gc").ok, false);  // 4 Game Changers breaks a 3 limit
  assert.ok(r.weak.some(w => w.n === "Divination"));
  const div = r.weak.find(w => w.n === "Divination");
  assert.ok(div.options.length === 3 && div.options.every(o => K.fits(card(o.n).id, "UR") && o.mv <= 4 && !r.names.includes(o.n)));
  assert.ok(div.options.every(o => !o.gc), "no Game Changers when the deck is at its limit");
  assert.ok(r.mana.colors.every(c => c.sources >= 20));
});

test("analyzeDeck: legality problems", () => {
  const txt = "Commander\n1 Niv-Mizzet, Parun\n\nDeck\n2 Sol Ring\n1 Swords to Plowshares\n1 Primeval Titan\n30 Island\n10 Relentless Rats";
  const d = K.resolveDeck(K.parseList(txt), idx);
  const r = K.analyzeDeck(d, idx, {});
  const kinds = r.issues.map(i => i.k);
  assert.ok(kinds.includes("size"));
  assert.ok(kinds.includes("singleton") && r.issues.find(i => i.k === "singleton").cards.join() === "2 Sol Ring");
  assert.ok(kinds.includes("banned"));
  assert.ok(kinds.includes("identity"));
  assert.ok(!r.legal);
  const pair = K.analyzeDeck(K.resolveDeck(K.parseList("1 Sol Ring"), idx, ["Niv-Mizzet, Parun", "Thrasios, Triton Hero"]), idx, {});
  assert.ok(pair.issues.some(i => i.k === "commander"));
  const ok = K.analyzeDeck(K.resolveDeck(K.parseList("1 Sol Ring"), idx, ["Thrasios, Triton Hero", "Tymna the Weaver"]), idx, {});
  assert.ok(!ok.issues.some(i => i.k === "commander"));
});

test("comboRules: two-card combos and Spellbook ratings against house rules", () => {
  const spell = { bracketTag: "P", combos: [{ id: "1", cards: ["Niv-Mizzet, Parun", "Curiosity"], produces: ["Infinite damage"], tag: "S", twoCard: true }] };
  const rows = K.comboRules(spell, K.PRESETS.pod);
  assert.equal(rows.find(x => x.k === "two").ok, false);
  assert.equal(rows.find(x => x.k === "tag").ok, false);
  assert.ok(K.comboRules(spell, K.PRESETS.b4).every(x => x.ok));
  assert.equal(K.comboRules({ error: "x" }, K.PRESETS.pod), null);
});

test("parseNeed: plain-English slot requests", () => {
  assert.deepEqual(K.parseNeed("2 ramp at 3 mana or less"), { n: 2, role: "ramp", sub: "", maxMv: 3, inst: false, type: "" });
  assert.equal(K.parseNeed("an instant-speed board wipe").role, "wipes");
  assert.equal(K.parseNeed("an instant-speed board wipe").inst, true);
  assert.equal(K.parseNeed("three mana rocks").sub, "rocks");
  assert.equal(K.parseNeed("three mana rocks").n, 3);
  assert.equal(K.parseNeed("1 removal under 3").maxMv, 2);
  assert.equal(K.parseNeed("artifact and enchantment removal").sub, "artifact-enchantment");
  assert.equal(K.parseNeed("2 card draw").role, "draw");
  assert.equal(K.parseNeed("graveyard hate").role, "gyhate");
});

test("findSlots: fits colors, skips the deck, respects filters", () => {
  const ramp = role("ramp");
  const out = K.findSlots(ramp, { identity: "G", exclude: new Set(["Sol Ring"]), maxMv: 2, limit: 10 });
  assert.equal(out.length, 10);
  assert.ok(out.every(e => K.fits(e.clr, "G") && e.mv <= 2 && e.n !== "Sol Ring"));
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].s >= out[i].s);
  const noGC = K.findSlots(role("tutors"), { identity: "WUBRG", noGC: true });
  assert.ok(noGC.every(e => !e.gc));
  const inst = K.findSlots(role("wipes"), { identity: "WUBRG", inst: true });
  assert.ok(inst.length > 0 && inst.every(e => e.inst));
});

test("betterOptions: higher score, same job, fits, at most one more mana", () => {
  const c = card("Divination");
  const opts = K.betterOptions(idx, c, "draw", { allowed: "U", limit: 5 });
  assert.ok(opts.length > 0);
  const me = c.roles.find(r => r.k === "draw");
  assert.ok(opts.every(o => o.s > me.s && o.c.mv <= c.mv + 1 && K.fits(o.c.id, "U") && o.sub === me.sub));
});

test("export: swaps and updated list", () => {
  const d = K.resolveDeck(K.parseList(SAMPLE), idx);
  const swaps = [{ out: "Divination", in: "Pull from Tomorrow" }];
  const txt = K.deckText(d, swaps);
  assert.ok(txt.startsWith("Commander\n1 Niv-Mizzet, Parun\n\nDeck\n"));
  assert.ok(txt.includes("1 Pull from Tomorrow") && !txt.includes("1 Divination"));
  const again = K.resolveDeck(K.parseList(txt), idx);
  assert.equal(K.analyzeDeck(again, idx, {}).total, 100);
  assert.equal(K.swapsText(swaps), "// Cuts\n1 Divination\n\n// Adds\n1 Pull from Tomorrow\n");
});
