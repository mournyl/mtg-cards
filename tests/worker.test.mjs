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

test("decks: create, save, list, limits, and only your own", async () => {
  const { call, setCookie, getCookie } = setup();
  assert.equal((await call("GET", "/api/decks")).status, 401);
  await call("POST", "/api/signup", { username: "tyler", password: "correct horse" });
  const mine = getCookie();
  const d = await call("POST", "/api/decks", { name: "Simic ramp", cards: [{ n: "Sol Ring", q: 1 }] });
  assert.equal(d.status, 200);
  const id = d.body.deck.id;
  const put = await call("PUT", `/api/decks/${id}`, { name: "Simic ramp", commander: "Tatyova, Benthic Druid",
    cards: [{ n: "Sol Ring", q: 1 }, { n: "Forest", q: 30 }, { n: "Forest", q: 2 }, { n: "Cultivate", q: 500, cat: "ramp" }, { n: "", q: 1 }, { n: "Bad", cat: "<x>" }] });
  assert.equal(put.status, 200);
  const list = await call("GET", "/api/decks");
  const deck = list.body.decks[0];
  assert.equal(deck.commander, "Tatyova, Benthic Druid");
  assert.deepEqual(deck.cards, [{ n: "Sol Ring", q: 1 }, { n: "Forest", q: 30 }, { n: "Cultivate", q: 99, cat: "ramp" }, { n: "Bad", q: 1 }]);
  assert.equal((await call("POST", "/api/decks", { name: "" })).status, 400);
  assert.equal((await call("PUT", `/api/decks/${id}`, { name: "x", cards: Array.from({ length: 251 }, (_, i) => ({ n: "c" + i })) })).status, 400);
  await call("POST", "/api/signup", { username: "someone", password: "password one" });
  assert.equal((await call("PUT", `/api/decks/${id}`, { name: "mine now" })).status, 404);
  assert.equal((await call("DELETE", `/api/decks/${id}`)).status, 404);
  assert.equal((await call("GET", "/api/decks")).body.decks.length, 0);
  setCookie(mine);
  assert.equal((await call("DELETE", `/api/decks/${id}`)).status, 200);
  assert.equal((await call("GET", "/api/decks")).body.decks.length, 0);
});

test("feedback routes are gone", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/feedback", { role: "ramp", card: "Cultivate", suggested: "B" })).status, 401);
});

test("state-changing requests must be same-origin JSON", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/decks", { name: "x" }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("POST", "/api/decks", "name=x", { headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
});
