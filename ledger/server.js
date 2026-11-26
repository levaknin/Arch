"use strict";

// Partner Ledger server: login for three fixed users, SQLite storage,
// role checks enforced here (not in the browser). No external dependencies.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const USERS = {
  eli: { name: "Eli", level: "full" },   // add, edit, delete everything
  moshe: { name: "Moshe", level: "own" }, // add; edit/delete only own entries
  igor: { name: "Igor", level: "view" }   // view only
};
const PARTNERS = ["Eli", "Moshe", "Igor"];
const METHODS = ["Bank transfer", "DuitNow", "Cash", "Cheque", "Card"];
const CATEGORIES = [
  "Rent", "Stock purchase", "Staff salaries", "EPF / SOCSO / EIS", "Utilities (TNB, water, internet)",
  "Renovation & fit-out", "Licences & permits", "Marketing", "Equipment & POS",
  "Transport & logistics", "Bank & payment fees", "Professional fees", "Other"
];
const KINDS = { deposits: "deposit", expenses: "expense" };
const MAX_SEN = 100000000000; // RM 1,000,000,000.00
const SESSION_DAYS = 30;
const MAX_BODY = 16 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const MIN_PASSWORD_LEN = 12;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- validation ----------
function parseAmount(v) {
  const s = String(v == null ? "" : v).replace(/[,\s]/g, "").replace(/^RM/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const sen = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(sen) || sen <= 0 || sen > MAX_SEN) return null;
  return sen;
}
function validDate(d) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + "T00:00:00Z");
  return !isNaN(t) && t.toISOString().slice(0, 10) === d;
}
function text(v, max) {
  if (v == null) return "";
  if (typeof v !== "string") throw new HttpError(400, "Text fields must be strings.");
  // strip control characters, trim, cap length
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function validateEntry(kind, b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Send the entry as a JSON object.");
  if (!validDate(b.date)) throw new HttpError(400, "Enter a valid date (YYYY-MM-DD).");
  const amount = parseAmount(b.amount);
  if (amount == null) throw new HttpError(400, "Enter an amount above 0 with at most 2 decimals.");
  const method = text(b.method, 40);
  if (!METHODS.includes(method)) throw new HttpError(400, "Choose a payment method from the list.");
  const out = { date: b.date, amount, method, ref: text(b.ref, 80), note: text(b.note, 300), partner: null, category: null, payee: null };
  if (kind === "deposit") {
    out.partner = text(b.partner, 60);
    if (!out.partner) throw new HttpError(400, "Enter the partner's name.");
  } else {
    out.category = text(b.category, 60);
    if (!CATEGORIES.includes(out.category)) throw new HttpError(400, "Choose a category from the list.");
    out.payee = text(b.payee, 80);
  }
  return out;
}

// ---------- auth ----------
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest();
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function makeAuth(passwords, secret) {
  // Per-user signing key includes the password hash, so changing a
  // password invalidates that user's existing sessions.
  const keys = {};
  for (const u of Object.keys(USERS)) {
    keys[u] = crypto.createHmac("sha256", secret).update("session:" + u + ":").update(sha256(passwords[u])).digest();
  }
  function sign(u, exp) { return b64url(crypto.createHmac("sha256", keys[u]).update(u + "." + exp).digest()); }
  return {
    checkPassword(u, pw) {
      if (!USERS[u] || typeof pw !== "string") {
        crypto.timingSafeEqual(sha256("x"), sha256("y")); // keep timing similar
        return false;
      }
      return crypto.timingSafeEqual(sha256(pw), sha256(passwords[u]));
    },
    issue(u) {
      const exp = Date.now() + SESSION_DAYS * 86400000;
      return u + "." + exp + "." + sign(u, exp);
    },
    verify(token) {
      if (typeof token !== "string") return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [u, expStr, sig] = parts;
      if (!USERS[u] || !/^\d+$/.test(expStr)) return null;
      const exp = Number(expStr);
      if (exp < Date.now()) return null;
      const want = Buffer.from(sign(u, exp));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      return u;
    }
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- database ----------
function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "ledger.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('deposit','expense')),
      date TEXT NOT NULL,
      amount_sen INTEGER NOT NULL CHECK (amount_sen > 0),
      partner TEXT, category TEXT, payee TEXT,
      method TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_kind_date ON entries (kind, date);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL,
      entry_id TEXT NOT NULL, before TEXT, after TEXT
    );
  `);
  return db;
}
function rowOut(r) {
  return {
    id: r.id, date: r.date, amount: r.amount_sen, partner: r.partner || "", category: r.category || "",
    payee: r.payee || "", method: r.method, ref: r.ref, note: r.note,
    createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at
  };
}

// ---------- app ----------
function createApp(opts) {
  const { passwords, secret, dataDir, publicDir = path.join(__dirname, "public"), secureCookies = true } = opts;
  for (const u of Object.keys(USERS)) {
    if (typeof passwords[u] !== "string" || passwords[u].length < MIN_PASSWORD_LEN) {
      throw new Error(`Password for ${u} is missing or shorter than ${MIN_PASSWORD_LEN} characters.`);
    }
  }
  if (typeof secret !== "string" || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");

  const auth = makeAuth(passwords, secret);
  const db = openDb(dataDir);
  const q = {
    list: db.prepare("SELECT * FROM entries WHERE kind = ? ORDER BY date DESC, created_at DESC"),
    get: db.prepare("SELECT * FROM entries WHERE id = ? AND kind = ?"),
    insert: db.prepare(`INSERT INTO entries (id, kind, date, amount_sen, partner, category, payee, method, ref, note, created_by, created_at, updated_by, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE entries SET date = ?, amount_sen = ?, partner = ?, category = ?, payee = ?, method = ?, ref = ?, note = ?, updated_by = ?, updated_at = ?
                        WHERE id = ? AND kind = ?`),
    del: db.prepare("DELETE FROM entries WHERE id = ? AND kind = ?"),
    audit: db.prepare("INSERT INTO audit (at, user, action, entry_id, before, after) VALUES (?, ?, ?, ?, ?, ?)")
  };
  function inTx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
  }

  const statics = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"]
  };
  const staticCache = {};
  for (const [route, [file, type]] of Object.entries(statics)) {
    staticCache[route] = { body: fs.readFileSync(path.join(publicDir, file)), type };
  }

  const fails = new Map(); // ip -> {count, reset}
  function tooManyFails(ip) {
    const f = fails.get(ip);
    if (!f) return false;
    if (f.reset < Date.now()) { fails.delete(ip); return false; }
    return f.count >= LOGIN_MAX_FAILS;
  }
  function recordFail(ip) {
    const now = Date.now();
    const f = fails.get(ip);
    if (!f || f.reset < now) fails.set(ip, { count: 1, reset: now + LOGIN_WINDOW_MS });
    else f.count++;
    if (fails.size > 10000) for (const [k, v] of fails) if (v.reset < now) fails.delete(k);
  }

  function baseHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  function sendJson(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extraHeaders || {}));
    res.end(body);
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const type = (req.headers["content-type"] || "").split(";")[0].trim();
      if (type !== "application/json") return reject(new HttpError(415, "Send JSON."));
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, "Request too large.")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
        catch (_) { reject(new HttpError(400, "Invalid JSON.")); }
      });
      req.on("error", reject);
    });
  }
  function cookie(value, maxAgeSec) {
    return `sid=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}` + (secureCookies ? "; Secure" : "");
  }
  function clientIp(req) {
    return String(req.headers["fly-client-ip"] || req.socket.remoteAddress || "unknown");
  }
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients; SameSite=Strict covers browsers
    try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
  }

  function canModify(user, row) {
    const level = USERS[user].level;
    return level === "full" || (level === "own" && row.created_by === user);
  }

  async function handleApi(req, res, url) {
    const method = req.method;
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) throw new HttpError(403, "Cross-site request refused.");

    if (url.pathname === "/api/login" && method === "POST") {
      const ip = clientIp(req);
      if (tooManyFails(ip)) throw new HttpError(429, "Too many failed sign-ins. Wait 15 minutes and try again.");
      const b = await readJson(req);
      const u = typeof b.user === "string" ? b.user.toLowerCase() : "";
      if (!auth.checkPassword(u, b.password)) { recordFail(ip); throw new HttpError(401, "Wrong name or password."); }
      fails.delete(ip);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie(auth.issue(u), SESSION_DAYS * 86400) });
    }
    if (url.pathname === "/api/logout" && method === "POST") {
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });
    }

    const user = auth.verify(parseCookies(req.headers.cookie).sid);
    if (!user) throw new HttpError(401, "Please sign in.");

    if (url.pathname === "/api/me" && method === "GET") {
      const users = {}; for (const [k, v] of Object.entries(USERS)) users[k] = v.name;
      return sendJson(res, 200, {
        user: { id: user, name: USERS[user].name, level: USERS[user].level },
        users, options: { partners: PARTNERS, methods: METHODS, categories: CATEGORIES }
      });
    }
    if (url.pathname === "/api/entries" && method === "GET") {
      return sendJson(res, 200, {
        deposits: q.list.all("deposit").map(rowOut),
        expenses: q.list.all("expense").map(rowOut)
      });
    }

    const m = url.pathname.match(/^\/api\/(deposits|expenses)(?:\/([A-Za-z0-9_-]{1,64}))?$/);
    if (!m) throw new HttpError(404, "Not found.");
    const kind = KINDS[m[1]];
    const id = m[2];
    const level = USERS[user].level;

    if (!id && method === "POST") {
      if (level === "view") throw new HttpError(403, "You have view-only access.");
      const e = validateEntry(kind, await readJson(req));
      const now = new Date().toISOString();
      const newId = crypto.randomUUID();
      const row = inTx(() => {
        q.insert.run(newId, kind, e.date, e.amount, e.partner, e.category, e.payee, e.method, e.ref, e.note, user, now, user, now);
        const r = q.get.get(newId, kind);
        q.audit.run(now, user, "create", newId, null, JSON.stringify(rowOut(r)));
        return r;
      });
      return sendJson(res, 201, rowOut(row));
    }
    if (id && method === "PUT") {
      if (level === "view") throw new HttpError(403, "You have view-only access.");
      const e = validateEntry(kind, await readJson(req));
      const now = new Date().toISOString();
      const row = inTx(() => {
        const before = q.get.get(id, kind);
        if (!before) throw new HttpError(404, "This entry no longer exists.");
        if (!canModify(user, before)) throw new HttpError(403, "You can only edit entries you added.");
        q.update.run(e.date, e.amount, e.partner, e.category, e.payee, e.method, e.ref, e.note, user, now, id, kind);
        const after = q.get.get(id, kind);
        q.audit.run(now, user, "update", id, JSON.stringify(rowOut(before)), JSON.stringify(rowOut(after)));
        return after;
      });
      return sendJson(res, 200, rowOut(row));
    }
    if (id && method === "DELETE") {
      if (level === "view") throw new HttpError(403, "You have view-only access.");
      const now = new Date().toISOString();
      inTx(() => {
        const before = q.get.get(id, kind);
        if (!before) throw new HttpError(404, "This entry no longer exists.");
        if (!canModify(user, before)) throw new HttpError(403, "You can only delete entries you added.");
        q.del.run(id, kind);
        q.audit.run(now, user, "delete", id, JSON.stringify(rowOut(before)), null);
      });
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, "Method not allowed.");
  }

  const server = http.createServer(async (req, res) => {
    baseHeaders(res);
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch (_) { res.writeHead(400); return res.end(); }
    try {
      if (url.pathname === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      const s = staticCache[url.pathname];
      if (s && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(200, { "Content-Type": s.type, "Cache-Control": "no-cache" });
        return res.end(req.method === "HEAD" ? undefined : s.body);
      }
      res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(new Date().toISOString(), req.method, url.pathname, err);
      if (!res.headersSent) sendJson(res, 500, { error: "Server error. Try again." });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  return { server, close() { return new Promise((r) => server.close(() => { try { db.close(); } catch (_) {} r(); })); } };
}

module.exports = { createApp, parseAmount, validDate, USERS };

if (require.main === module) {
  let app;
  try {
    app = createApp({
      passwords: { eli: process.env.ELI_PASSWORD, moshe: process.env.MOSHE_PASSWORD, igor: process.env.IGOR_PASSWORD },
      secret: process.env.SESSION_SECRET,
      dataDir: process.env.DATA_DIR || path.join(__dirname, "data"),
      secureCookies: process.env.INSECURE_COOKIES !== "1"
    });
  } catch (e) {
    console.error("Startup failed:", e.message);
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8080;
  app.server.listen(port, "0.0.0.0", () => console.log(`Partner Ledger listening on :${port}`));
  const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
