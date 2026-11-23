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

test("state-changing requests must be same-origin JSON", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/feedback", { role: "ramp", card: "Cultivate", suggested: "B" }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("POST", "/api/feedback", "role=ramp", { headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
});
