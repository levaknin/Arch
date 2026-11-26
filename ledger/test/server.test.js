"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp, parseAmount, validDate } = require("../server.js");

const PW = { eli: "eli-password-123", moshe: "moshe-password-123", igor: "igor-password-123" };
let app, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
  app = createApp({ passwords: PW, secret: "x".repeat(40), dataDir, secureCookies: false });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + app.server.address().port;
});
after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function login(user, password = PW[user]) {
  const res = await fetch(base + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, password })
  });
  if (res.status !== 200) return { status: res.status };
  return { status: 200, cookie: res.headers.get("set-cookie").split(";")[0] };
}
function call(cookie, method, url, body) {
  return fetch(base + url, {
    method,
    headers: Object.assign({ Cookie: cookie || "" }, body !== undefined ? { "Content-Type": "application/json" } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}
const deposit = (extra) => Object.assign({ date: "2026-11-01", amount: "1500.50", method: "Bank transfer", partner: "Eli", ref: "", note: "" }, extra);
const expense = (extra) => Object.assign({ date: "2026-11-02", amount: "800", method: "Cash", category: "Rent", payee: "Landlord" }, extra);

test("amount and date parsing", () => {
  assert.equal(parseAmount("1,500.50"), 150050);
  assert.equal(parseAmount("RM 20"), 2000);
  assert.equal(parseAmount("0"), null);
  assert.equal(parseAmount("1.234"), null);
  assert.equal(parseAmount("-5"), null);
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2026-02-28"), true);
});

test("startup rejects weak config", () => {
  assert.throws(() => createApp({ passwords: { eli: "short", moshe: PW.moshe, igor: PW.igor }, secret: "x".repeat(40), dataDir }));
  assert.throws(() => createApp({ passwords: PW, secret: "short", dataDir }));
});

test("login: wrong password and unauthenticated access are refused", async () => {
  assert.equal((await login("eli", "nope")).status, 401);
  assert.equal((await login("nobody", "whatever-123456")).status, 401);
  assert.equal((await call("", "GET", "/api/entries")).status, 401);
  assert.equal((await call("sid=eli.99999999999999.forged", "GET", "/api/entries")).status, 401);
});

test("role enforcement", async () => {
  const eli = (await login("eli")).cookie;
  const moshe = (await login("moshe")).cookie;
  const igor = (await login("igor")).cookie;

  // Igor: view only
  assert.equal((await call(igor, "GET", "/api/entries")).status, 200);
  assert.equal((await call(igor, "POST", "/api/deposits", deposit())).status, 403);

  // Eli and Moshe each add one
  const eRes = await call(eli, "POST", "/api/deposits", deposit());
  assert.equal(eRes.status, 201);
  const eliRow = await eRes.json();
  assert.equal(eliRow.amount, 150050);
  assert.equal(eliRow.createdBy, "eli");

  const mRes = await call(moshe, "POST", "/api/expenses", expense());
  assert.equal(mRes.status, 201);
  const mosheRow = await mRes.json();

  // Moshe cannot touch Eli's entry
  assert.equal((await call(moshe, "PUT", "/api/deposits/" + eliRow.id, deposit({ amount: "1" }))).status, 403);
  assert.equal((await call(moshe, "DELETE", "/api/deposits/" + eliRow.id)).status, 403);

  // Moshe can edit his own
  const mEdit = await call(moshe, "PUT", "/api/expenses/" + mosheRow.id, expense({ amount: "900" }));
  assert.equal(mEdit.status, 200);
  assert.equal((await mEdit.json()).amount, 90000);

  // Igor cannot edit or delete anything
  assert.equal((await call(igor, "PUT", "/api/expenses/" + mosheRow.id, expense())).status, 403);
  assert.equal((await call(igor, "DELETE", "/api/expenses/" + mosheRow.id)).status, 403);

  // Eli can edit and delete Moshe's entry
  const eEdit = await call(eli, "PUT", "/api/expenses/" + mosheRow.id, expense({ amount: "950" }));
  assert.equal(eEdit.status, 200);
  const edited = await eEdit.json();
  assert.equal(edited.createdBy, "moshe");
  assert.equal(edited.updatedBy, "eli");
  assert.equal((await call(eli, "DELETE", "/api/expenses/" + mosheRow.id)).status, 200);
  assert.equal((await call(eli, "DELETE", "/api/expenses/" + mosheRow.id)).status, 404);

  const list = await (await call(igor, "GET", "/api/entries")).json();
  assert.equal(list.deposits.length, 1);
  assert.equal(list.expenses.length, 0);
});

test("validation and request hygiene", async () => {
  const eli = (await login("eli")).cookie;
  assert.equal((await call(eli, "POST", "/api/deposits", deposit({ amount: "abc" }))).status, 400);
  assert.equal((await call(eli, "POST", "/api/deposits", deposit({ date: "2026-13-01" }))).status, 400);
  assert.equal((await call(eli, "POST", "/api/expenses", expense({ category: "Made up" }))).status, 400);
  assert.equal((await call(eli, "POST", "/api/deposits", deposit({ partner: "  " }))).status, 400);
  assert.equal((await call(eli, "POST", "/api/deposits", deposit({ note: { x: 1 } }))).status, 400);

  const cross = await fetch(base + "/api/deposits", {
    method: "POST", headers: { Cookie: eli, "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify(deposit())
  });
  assert.equal(cross.status, 403);

  const wrongType = await fetch(base + "/api/deposits", { method: "POST", headers: { Cookie: eli, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(wrongType.status, 415);
});

test("audit log records changes", async () => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "ledger.db"));
  const actions = db.prepare("SELECT action FROM audit ORDER BY id").all().map((r) => r.action);
  db.close();
  assert.deepEqual(actions, ["create", "create", "update", "update", "delete"]);
});

test("static files and security headers", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await fetch(base + "/server.js")).status, 404);
  assert.equal((await fetch(base + "/healthz")).status, 200);
});
