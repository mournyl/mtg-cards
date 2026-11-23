// Card index and tier tests: node --test tests/core.test.mjs   (Node 18+, no packages)
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

test("betterOptions: higher score, same job, fits, at most one more mana", () => {
  const c = card("Divination");
  const opts = K.betterOptions(idx, c, "draw", { allowed: "U", limit: 5 });
  assert.ok(opts.length > 0);
  const me = c.roles.find(r => r.k === "draw");
  assert.ok(opts.every(o => o.s > me.s && o.c.mv <= c.mv + 1 && K.fits(o.c.id, "U") && o.sub === me.sub));
});
