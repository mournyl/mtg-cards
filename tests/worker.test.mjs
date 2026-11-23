// Worker API tests against an in-memory SQLite database that stands in for D1.
// Run: node --test tests/worker.test.mjs   (Node 22.13+ for node:sqlite; no packages)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";

// ---- a small D1 lookalike: prepare/bind/first/all/run and batch ----
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const plain = r => (r == null ? r : { ...r });
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async col => { const r = plain(db.prepare(sql).get(...args)); return r === undefined ? null : col ? r[col] : r; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain), success: true }),
    run: async () => { const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; },
  });
  return {
    db,
    prepare: sql => stmt(sql),
    batch: async list => {
      db.exec("BEGIN");
      try { const out = []; for (const s of list) out.push(await s.all()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

const ORIGIN = "https://mournyl.test";
function setup(extraEnv = {}) {
  const env = { DB: makeD1(), ASSETS: { fetch: async req => new Response("asset:" + new URL(req.url).pathname) }, ...extraEnv };
  let cookie = "";
  async function call(method, path, body, opt = {}) {
    const headers = { ...(opt.headers || {}) };
    if (body !== undefined) headers["content-type"] = headers["content-type"] || "application/json";
    if (cookie && !opt.noCookie) headers.cookie = cookie;
    const req = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const res = await worker.fetch(req, env);
    const set = res.headers.get("set-cookie");
    if (set && !opt.noCookie) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : await res.text(), headers: res.headers };
  }
  return { env, call, setCookie: c => { cookie = c; }, getCookie: () => cookie };
}

test("static pages go to the assets binding", async () => {
  const { call } = setup();
  const r = await call("GET", "/tiers/");
  assert.equal(r.body, "asset:/tiers/");
});

test("existing account, favorites and list routes still work", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/signup", { username: "tyler", password: "correct horse" })).status, 200);
  assert.equal((await call("GET", "/api/me")).body.user.username, "tyler");
  const card = { id: "0afa0e33-4804-4b00-b625-c2d6b61090fc", name: "Counterspell", image: "https://cards.scryfall.io/x.jpg", type_line: "Instant", mana_cost: "{U}{U}", set: "dmr" };
  assert.equal((await call("POST", "/api/favorites", { card })).status, 200);
  const l = await call("POST", "/api/lists", { name: "Blue staples" });
  assert.equal((await call("POST", `/api/lists/${l.body.list.id}/cards`, { card })).status, 200);
  const saved = await call("GET", "/api/saved");
  assert.equal(saved.body.favorites[0].name, "Counterspell");
  assert.equal(saved.body.lists[0].cards.length, 1);
  assert.equal((await call("POST", "/api/logout", {})).status, 200);
  assert.equal((await call("GET", "/api/me")).body.user, null);
});

test("decks: create, list, open, update, check history, delete", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/decks", { name: "x", list: "1 Sol Ring" })).status, 401);
  await call("POST", "/api/signup", { username: "tyler", password: "correct horse" });
  const made = await call("POST", "/api/decks", { name: "Niv", commander: "Niv-Mizzet, Parun", list: "1 Sol Ring\n1 Island", settings: { rules: { preset: "pod" } } });
  assert.equal(made.status, 200);
  const id = made.body.deck.id;
  let list = await call("GET", "/api/decks");
  assert.equal(list.body.decks.length, 1);
  assert.equal(list.body.decks[0].last, null);
  for (let i = 0; i < 25; i++) assert.equal((await call("POST", `/api/decks/${id}/checks`, { summary: { total: 100, weak: i } })).status, 200);
  const open = await call("GET", `/api/decks/${id}`);
  assert.equal(open.body.deck.checks.length, 20);                 // history keeps the last 20
  assert.equal(open.body.deck.checks[0].summary.weak, 24);        // newest first
  assert.equal(open.body.deck.settings.rules.preset, "pod");
  list = await call("GET", "/api/decks");
  assert.equal(list.body.decks[0].last.weak, 24);
  assert.equal((await call("PATCH", `/api/decks/${id}`, { name: "Niv 2", commander: "Niv-Mizzet, Parun", list: "1 Sol Ring" })).status, 200);
  assert.equal((await call("GET", `/api/decks/${id}`)).body.deck.name, "Niv 2");
  assert.equal((await call("POST", "/api/decks", { name: "empty", list: "  " })).status, 400);
  assert.equal((await call("POST", "/api/decks", { name: "huge", list: "x".repeat(20001) })).status, 400);
  assert.equal((await call("DELETE", `/api/decks/${id}`)).status, 200);
  assert.equal((await call("GET", `/api/decks/${id}`)).status, 404);
});

test("decks are private to their owner", async () => {
  const a = setup();
  await a.call("POST", "/api/signup", { username: "alice", password: "password one" });
  const id = (await a.call("POST", "/api/decks", { name: "Mine", list: "1 Sol Ring" })).body.deck.id;
  const aliceCookie = a.getCookie();
  await a.call("POST", "/api/signup", { username: "bob", password: "password two" });
  assert.notEqual(a.getCookie(), aliceCookie);
  assert.equal((await a.call("GET", `/api/decks/${id}`)).status, 404);
  assert.equal((await a.call("DELETE", `/api/decks/${id}`)).status, 404);
  assert.equal((await a.call("GET", "/api/decks")).body.decks.length, 0);
});

test("tier feedback: anyone can send, it's validated and rate-limited, admins can read it", async () => {
  const { call, env } = setup({ ADMINS: "tyler" });
  const fb = { role: "ramp", card: "Cultivate", tier: "A", suggested: "B", note: "Slower than a Signet" };
  assert.equal((await call("POST", "/api/feedback", fb)).status, 200);
  assert.equal((await call("POST", "/api/feedback", { ...fb, suggested: "Z" })).status, 400);
  assert.equal((await call("POST", "/api/feedback", { ...fb, role: "<script>" })).status, 400);
  for (let i = 0; i < 19; i++) await call("POST", "/api/feedback", fb);
  assert.equal((await call("POST", "/api/feedback", fb)).status, 429);
  const row = env.DB.db.prepare("SELECT role, card, suggested, note, status, user_id FROM tier_feedback LIMIT 1").get();
  assert.deepEqual({ ...row }, { role: "ramp", card: "Cultivate", suggested: "B", note: "Slower than a Signet", status: "open", user_id: null });
  await call("POST", "/api/signup", { username: "someone", password: "password one" });
  assert.equal((await call("GET", "/api/feedback")).status, 403);
  await call("POST", "/api/signup", { username: "tyler", password: "password two" });
  const q = await call("GET", "/api/feedback");
  assert.equal(q.status, 200);
  assert.equal(q.body.feedback.length, 20);
  assert.equal((await call("PATCH", `/api/feedback/${q.body.feedback[0].id}`, { status: "done" })).status, 200);
  assert.equal((await call("GET", "/api/feedback?status=done")).body.feedback.length, 1);
});

test("Spellbook proxy: trims the answer, flags two-card combos, caches per card list", async () => {
  const { call } = setup();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    calls.push({ url: String(url), body: JSON.parse(opt.body) });
    if (String(url).includes("find-my-combos")) return Response.json({ count: 1, next: null, previous: null, results: {
      identity: "UR",
      included: [{ id: "123-456", uses: [{ card: { name: "Niv-Mizzet, Parun" } }, { card: { name: "Curiosity" } }], requires: [],
        produces: [{ feature: { name: "Infinite card draw" } }, { feature: { name: "Infinite damage" } }], bracketTag: "S" }],
      almostIncluded: [{ id: "9" }] } });
    if (String(url).includes("estimate-bracket")) return Response.json({ bracketTag: "S", cards: [], templates: [],
      combos: [{ combo: { id: "123-456" }, definitelyTwoCard: true, arguablyTwoCard: true }] });
    return new Response("no", { status: 404 });
  };
  try {
    const deck = { commanders: ["Niv-Mizzet, Parun"], main: ["Curiosity", "Sol Ring", "Island"] };
    const r = await call("POST", "/api/spellbook", deck);
    assert.equal(r.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.commanders, [{ card: "Niv-Mizzet, Parun", quantity: 1 }]);
    assert.equal(calls[0].body.main.length, 3);
    assert.ok(calls[0].url.startsWith("https://backend.commanderspellbook.com/find-my-combos"));
    assert.deepEqual(r.body.combos, [{ id: "123-456", cards: ["Niv-Mizzet, Parun", "Curiosity"], produces: ["Infinite card draw", "Infinite damage"], tag: "S", twoCard: true }]);
    assert.equal(r.body.bracketTag, "S");
    assert.equal(r.body.cached, false);
    const again = await call("POST", "/api/spellbook", { commanders: ["Niv-Mizzet, Parun"], main: ["Island", "Sol Ring", "Curiosity"] });
    assert.equal(again.body.cached, true);                   // same cards in another order: cache hit
    assert.equal(calls.length, 2);
    globalThis.fetch = async () => new Response("down", { status: 503 });
    const down = await call("POST", "/api/spellbook", { commanders: ["Kenrith, the Returned King"], main: ["Sol Ring"] });
    assert.equal(down.status, 502);
    assert.equal((await call("POST", "/api/spellbook", { commanders: [], main: [] })).status, 400);
  } finally { globalThis.fetch = realFetch; }
});

test("state-changing requests must be same-origin JSON", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/feedback", { role: "ramp", card: "Cultivate", suggested: "B" }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("POST", "/api/feedback", "role=ramp", { headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
});
