// mournyl mtg — Cloudflare Worker
// Serves the static site from ./public (via [assets]) and a small JSON API under /api/*
// backed by D1 (binding: DB). Accounts are username + password; passwords are hashed
// with PBKDF2-SHA256, sessions are random tokens stored hashed, sent as an HttpOnly cookie.
// Also: "suggest a tier" feedback from the tier lists and card search.

const COOKIE = "mtg_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERS = 100000;        // Workers' WebCrypto maximum
const MAX_FAILS = 5, LOCK_MS = 10 * 60 * 1000;
const MAX_LISTS = 50, MAX_CARDS = 2000;
const LIMITS = { fb: [20, 3600e3] };               // per IP: feedback per hour

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
    }
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  },
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

// ---------- routing ----------
async function api(req, env, url) {
  const m = req.method, p = url.pathname.replace(/\/+$/, "");
  let r;

  // CSRF: state-changing requests must be JSON and same-origin
  if (m !== "GET" && m !== "HEAD") {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Bad origin");
    if (m !== "DELETE" && !(req.headers.get("content-type") || "").includes("application/json"))
      throw new HttpError(415, "Expected JSON");
  }

  if (p === "/api/signup" && m === "POST") return signup(req, env, url);
  if (p === "/api/login" && m === "POST") return login(req, env, url);
  if (p === "/api/logout" && m === "POST") return logout(req, env, url);
  if (p === "/api/me" && m === "GET") {
    const u = await currentUser(req, env);
    return u ? json({ user: { username: u.username } }) : json({ user: null });
  }
  // open to everyone (rate-limited per IP)
  if (p === "/api/feedback" && m === "POST") return feedback(req, env);

  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, "Log in first");

  if (p === "/api/saved" && m === "GET") return saved(env, user);

  // ---- feedback queue (admins only: usernames in the ADMINS variable, comma-separated) ----
  if (p === "/api/feedback" && m === "GET") {
    requireAdmin(env, user);
    const status = url.searchParams.get("status") || "open";
    const rows = await env.DB.prepare("SELECT id, role, card, tier, suggested, note, status, created_at FROM tier_feedback WHERE status = ? ORDER BY created_at DESC LIMIT 500").bind(status).all();
    return json({ feedback: rows.results });
  }
  if ((r = p.match(/^\/api\/feedback\/(\d+)$/)) && m === "PATCH") {
    requireAdmin(env, user);
    const st = String((await body(req)).status || "");
    if (!["open", "done", "rejected"].includes(st)) throw new HttpError(400, "Status must be open, done or rejected");
    await env.DB.prepare("UPDATE tier_feedback SET status = ? WHERE id = ?").bind(st, +r[1]).run();
    return json({ ok: true });
  }

  if (p === "/api/favorites" && m === "POST") {
    const card = cleanCard((await body(req)).card);
    await capCheck(env, user);
    await env.DB.prepare("INSERT OR REPLACE INTO favorites (user_id, card_id, data, added_at) VALUES (?, ?, ?, ?)")
      .bind(user.id, card.id, JSON.stringify(card), Date.now()).run();
    return json({ ok: true });
  }
  if ((r = p.match(/^\/api\/favorites\/([\w-]+)$/)) && m === "DELETE") {
    await env.DB.prepare("DELETE FROM favorites WHERE user_id = ? AND card_id = ?").bind(user.id, r[1]).run();
    return json({ ok: true });
  }

  if (p === "/api/lists" && m === "POST") {
    const name = cleanName((await body(req)).name);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM lists WHERE user_id = ?").bind(user.id).first();
    if (n >= MAX_LISTS) throw new HttpError(400, `Limit of ${MAX_LISTS} lists`);
    const row = await env.DB.prepare("INSERT INTO lists (user_id, name, created_at) VALUES (?, ?, ?) RETURNING id")
      .bind(user.id, name, Date.now()).first();
    return json({ list: { id: row.id, name, cards: [] } });
  }
  if ((r = p.match(/^\/api\/lists\/(\d+)$/))) {
    const list = await ownList(env, user, r[1]);
    if (m === "PATCH") {
      const name = cleanName((await body(req)).name);
      await env.DB.prepare("UPDATE lists SET name = ? WHERE id = ?").bind(name, list.id).run();
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM list_cards WHERE list_id = ?").bind(list.id),
        env.DB.prepare("DELETE FROM lists WHERE id = ?").bind(list.id),
      ]);
      return json({ ok: true });
    }
  }
  if ((r = p.match(/^\/api\/lists\/(\d+)\/cards$/)) && m === "POST") {
    const list = await ownList(env, user, r[1]);
    const card = cleanCard((await body(req)).card);
    await capCheck(env, user);
    await env.DB.prepare("INSERT OR REPLACE INTO list_cards (list_id, card_id, data, added_at) VALUES (?, ?, ?, ?)")
      .bind(list.id, card.id, JSON.stringify(card), Date.now()).run();
    return json({ ok: true });
  }
  if ((r = p.match(/^\/api\/lists\/(\d+)\/cards\/([\w-]+)$/)) && m === "DELETE") {
    const list = await ownList(env, user, r[1]);
    await env.DB.prepare("DELETE FROM list_cards WHERE list_id = ? AND card_id = ?").bind(list.id, r[2]).run();
    return json({ ok: true });
  }

  throw new HttpError(404, "Not found");
}

// ---------- tier feedback ----------
async function feedback(req, env) {
  const b = await body(req);
  const role = String(b.role || ""), card = String(b.card || "").trim().slice(0, 200);
  const tier = String(b.tier || ""), suggested = String(b.suggested || ""), note = String(b.note || "").trim().slice(0, 500);
  if (!/^[a-z]{3,20}$/.test(role) || !card || !/^[SABCDF]$/.test(suggested) || (tier && !/^[SABCDF]$/.test(tier)))
    throw new HttpError(400, "Pick a list and a tier");
  await rateLimit(env, req, "fb");
  const user = await currentUser(req, env);
  await env.DB.prepare("INSERT INTO tier_feedback (role, card, tier, suggested, note, user_id, ip_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)")
    .bind(role, card, tier, suggested, note, user ? user.id : null, await ipHash(req), Date.now()).run();
  return json({ ok: true });
}
function requireAdmin(env, user) {
  const admins = String(env.ADMINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!admins.includes(user.username.toLowerCase())) throw new HttpError(403, "Admins only");
}

// ---------- per-IP rate limits for the open endpoints ----------
async function ipHash(req) { return sha256("ip:" + (req.headers.get("cf-connecting-ip") || "local")); }
async function rateLimit(env, req, kind) {
  const [max, windowMs] = LIMITS[kind], key = kind + ":" + await ipHash(req), now = Date.now();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_hits WHERE key = ? AND at > ?").bind(key, now - windowMs).first();
  if (n >= max) throw new HttpError(429, "Too many requests — try again later");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO rate_hits (key, at) VALUES (?, ?)").bind(key, now),
    env.DB.prepare("DELETE FROM rate_hits WHERE at < ?").bind(now - 86400e3),
  ]);
}

// ---------- auth ----------
async function signup(req, env, url) {
  const { username, password } = await body(req);
  const u = String(username || "").trim();
  if (!/^[A-Za-z0-9_-]{3,24}$/.test(u)) throw new HttpError(400, "Username: 3–24 letters, numbers, _ or -");
  if (typeof password !== "string" || password.length < 8 || password.length > 200)
    throw new HttpError(400, "Password must be at least 8 characters");
  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(u).first();
  if (exists) throw new HttpError(409, "That username is taken");
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(password, salt);
  const row = await env.DB.prepare("INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(u, hash, salt, Date.now()).first();
  return startSession(env, url, row.id, u);
}

async function login(req, env, url) {
  const { username, password } = await body(req);
  const u = String(username || "").trim();
  const row = await env.DB.prepare("SELECT id, username, pass_hash, salt, failed, lock_until FROM users WHERE username = ?").bind(u).first();
  const now = Date.now();
  if (row && row.lock_until > now) throw new HttpError(429, "Too many attempts — try again in a few minutes");
  // hash even when the user doesn't exist so timing doesn't reveal valid usernames
  const hash = await pbkdf2(String(password || ""), row ? row.salt : "AAAAAAAAAAAAAAAAAAAAAA==");
  if (!row || !timingSafeEq(hash, row.pass_hash)) {
    if (row) {
      const failed = row.failed + 1;
      await env.DB.prepare("UPDATE users SET failed = ?, lock_until = ? WHERE id = ?")
        .bind(failed >= MAX_FAILS ? 0 : failed, failed >= MAX_FAILS ? now + LOCK_MS : 0, row.id).run();
    }
    throw new HttpError(401, "Wrong username or password");
  }
  await env.DB.prepare("UPDATE users SET failed = 0, lock_until = 0 WHERE id = ?").bind(row.id).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(row.id, now).run();
  return startSession(env, url, row.id, row.username);
}

async function logout(req, env, url) {
  const tok = getCookie(req, COOKIE);
  if (tok) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(tok)).run();
  return json({ ok: true }, 200, { "set-cookie": cookie(url, "", 0) });
}

async function startSession(env, url, userId, username) {
  const tok = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(tok), userId, Date.now() + maxAge * 1000).run();
  return json({ user: { username } }, 200, { "set-cookie": cookie(url, tok, maxAge) });
}

async function currentUser(req, env) {
  const tok = getCookie(req, COOKIE);
  if (!tok) return null;
  return env.DB.prepare(
    "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256(tok), Date.now()).first();
}

// ---------- saved data ----------
async function saved(env, user) {
  const [favs, lists, cards] = await env.DB.batch([
    env.DB.prepare("SELECT data FROM favorites WHERE user_id = ? ORDER BY added_at DESC").bind(user.id),
    env.DB.prepare("SELECT id, name FROM lists WHERE user_id = ? ORDER BY created_at").bind(user.id),
    env.DB.prepare("SELECT lc.list_id, lc.data FROM list_cards lc JOIN lists l ON l.id = lc.list_id WHERE l.user_id = ? ORDER BY lc.added_at DESC").bind(user.id),
  ]);
  const byList = new Map(lists.results.map(l => [l.id, { id: l.id, name: l.name, cards: [] }]));
  for (const c of cards.results) byList.get(c.list_id)?.cards.push(JSON.parse(c.data));
  return json({ favorites: favs.results.map(f => JSON.parse(f.data)), lists: [...byList.values()] });
}

async function ownList(env, user, id) {
  const l = await env.DB.prepare("SELECT id, name FROM lists WHERE id = ? AND user_id = ?").bind(+id, user.id).first();
  if (!l) throw new HttpError(404, "List not found");
  return l;
}

async function capCheck(env, user) {
  const { n } = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM favorites WHERE user_id = ?1) + (SELECT COUNT(*) FROM list_cards lc JOIN lists l ON l.id = lc.list_id WHERE l.user_id = ?1) AS n"
  ).bind(user.id).first();
  if (n >= MAX_CARDS) throw new HttpError(400, `Limit of ${MAX_CARDS} saved cards`);
}

// Only keep a small, known snapshot of the card (never trust arbitrary client JSON)
function cleanCard(c) {
  if (!c || typeof c !== "object" || !/^[0-9a-f-]{36}$/i.test(c.id || "")) throw new HttpError(400, "Bad card");
  const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const img = s(c.image, 300);
  return {
    id: c.id.toLowerCase(),
    name: s(c.name, 200),
    image: /^https:\/\/cards\.scryfall\.io\//.test(img) ? img : "",
    type_line: s(c.type_line, 200),
    mana_cost: s(c.mana_cost, 100),
    set: s(c.set, 10),
  };
}
function cleanName(n) {
  const v = String(n || "").trim().slice(0, 60);
  if (!v) throw new HttpError(400, "Name required");
  return v;
}
async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, "Bad JSON"); }
}

// ---------- crypto / cookie helpers ----------
const enc = new TextEncoder();
function b64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function b64url(bytes) { return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function pbkdf2(password, saltB64) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: PBKDF2_ITERS }, key, 256);
  return b64(new Uint8Array(bits));
}
async function sha256(s) { return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))); }
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function getCookie(req, name) {
  const h = req.headers.get("cookie") || "";
  for (const part of h.split(/;\s*/)) { const i = part.indexOf("="); if (part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
function cookie(url, value, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
