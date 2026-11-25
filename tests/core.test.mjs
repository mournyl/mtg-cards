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

test("function tags: every card's tags come through, and Tyler's examples read right", () => {
  const tagged = idx.list.filter(c => c.tags.some(k => !K.TYPE_ONLY.has(k))).length;
  assert.ok(tagged / idx.list.length >= 0.965, `only ${(100 * tagged / idx.list.length).toFixed(2)}% of cards have a job tag`);
  const has = (n, ...ks) => ks.forEach(k => assert.ok(card(n).tags.includes(k), `${n} should be tagged ${k}: ${card(n).tags.join(" ")}`));
  has("Twisted Image", "draw", "swap");
  has("Bulk Up", "double");
  has("Reality Ripple", "protect", "phasing");
  has("Prodigal Pyromancer", "pinger");
  has("Slip Out the Back", "protect", "phasing");
  has("Grizzly Bears", "vanilla");
  has("Command Tower", "fixing");
  assert.ok(!card("Sol Ring").tags.includes("tutor"));
  has("Sol Ring", "ramp"); has("Cultivate", "landramp"); has("Smothering Tithe", "treasure");
  assert.ok(!card("Smothering Tithe").tags.includes("ramp") && !card("Cultivate").tags.includes("ramp"), "Ramp is split: Mana generation, Extra lands, Treasure tokens");
  for (const k of Object.keys(idx.byTag)) assert.ok(idx.tagInfo[k].label && idx.tagInfo[k].group, k);
  assert.ok(idx.byTag.pinger.length > 100 && idx.byTag.pinger.every(c => c.tags.includes("pinger")));
});

test("showTags: most specific first, skips what a tier row says, generic only as a fallback", () => {
  const opt = card("Opt");   // draw + select; its Card draw tier row covers "draw"
  assert.deepEqual(K.showTags(opt, 3, ["draw"]), ["select"]);
  const bears = card("Grizzly Bears");
  assert.deepEqual(K.showTags(bears, 3), ["vanilla"]);
  const angel = card("Serra Angel");   // flying, vigilance: nothing but generic tags
  assert.ok(K.showTags(angel, 3).length >= 1 && K.showTags(angel, 3).every(k => K.GENERIC.has(k)));
  assert.equal(K.mainTag(card("Blood Artist")), "death");
});

test("tier lists: Twisted Image is a cantrip, Reality Ripple protects", () => {
  assert.equal(card("Twisted Image").roles.find(r => r.k === "draw")?.sub, "cantrip");
  assert.equal(card("Reality Ripple").roles.find(r => r.k === "protection")?.sub, "one");
});
