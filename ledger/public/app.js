(function () {
  "use strict";

  const LEVELS = {
    full: "Add, edit and delete all entries",
    own: "Add; edit and delete your own entries",
    view: "View only"
  };
  const POLL_MS = 20000;

  const S = {
    me: null, users: {}, options: { partners: [], methods: [], categories: [] },
    deposits: [], expenses: [], loaded: false,
    tab: "deposits", editing: { deposits: null, expenses: null }, pollTimer: null
  };

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "class") n.className = props[k];
      else if (k === "text") n.textContent = props[k];
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    for (const c of kids) if (c != null) n.append(c);
    return n;
  }
  const fmtRM = new Intl.NumberFormat("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function rm(sen) {
    const v = Number.isFinite(sen) ? sen : 0;
    return (v < 0 ? "−RM " : "RM ") + fmtRM.format(Math.abs(v) / 100);
  }
  const senToInput = (sen) => (sen / 100).toFixed(2);
  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function monthLabel(ym) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-MY", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  function setStatus(msg) { const s = $("status"); s.textContent = msg || ""; s.hidden = !msg; }
  const personName = (id) => (id === (S.me && S.me.id) ? "You" : S.users[id] || id || "Unknown");

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method, credentials: "same-origin",
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (_) {
      const e = new Error("Can't reach the server. Check your connection."); e.status = 0; throw e;
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || "Request failed (" + res.status + ")."); e.status = res.status;
      if (res.status === 401 && url !== "/api/login") showLogin();
      throw e;
    }
    return data;
  }

  // ---------- permissions (server enforces the same rules) ----------
  const level = () => (S.me ? S.me.level : "view");
  const canAdd = () => level() === "full" || level() === "own";
  const canModify = (row) => level() === "full" || (level() === "own" && row.createdBy === S.me.id);

  // ---------- login ----------
  function showLogin() {
    stopPolling();
    S.me = null; S.loaded = false; S.deposits = []; S.expenses = [];
    $("app").hidden = true; $("who").hidden = true; $("login").hidden = false;
    setStatus("");
    $("login-pass").value = "";
    $("login-pass").focus();
  }
  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("login-btn"), msg = $("login-msg");
    msg.textContent = "";
    if (!$("login-pass").value) { msg.textContent = "Enter your password."; return; }
    btn.disabled = true;
    try {
      await api("POST", "/api/login", { user: $("login-user").value, password: $("login-pass").value });
      $("login-pass").value = "";
      await boot();
    } catch (e) { msg.textContent = e.message; }
    finally { btn.disabled = false; }
  });
  $("logout").addEventListener("click", async () => {
    try { await api("POST", "/api/logout", {}); } catch (_) { /* ignore */ }
    showLogin();
  });

  // ---------- rendering ----------
  function renderWho() {
    $("who").hidden = false;
    $("who-name").textContent = S.me.name;
    $("who-role").textContent = LEVELS[S.me.level] || "";
  }
  function monthsOf(rows) {
    return [...new Set(rows.map((r) => (r.date || "").slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))].sort().reverse();
  }
  function renderFilter(kind) {
    const sel = $("filter-" + kind);
    const cur = sel.value || "all";
    sel.replaceChildren(el("option", { value: "all", text: "All months" }));
    for (const m of monthsOf(S[kind])) sel.append(el("option", { value: m, text: monthLabel(m) }));
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "all";
  }

  function actionCell(kind, row) {
    const td = el("td", { class: "act" });
    if (!canModify(row)) return td;
    td.append(el("button", { class: "btn sm", type: "button", text: "Edit", onclick: () => openForm(kind, row) }));
    const del = el("button", { class: "btn sm danger", type: "button", text: "Delete" });
    let timer = null;
    del.addEventListener("click", async () => {
      if (!del.classList.contains("armed")) {
        del.classList.add("armed"); del.textContent = "Confirm delete";
        timer = setTimeout(() => { del.classList.remove("armed"); del.textContent = "Delete"; }, 4000);
        return;
      }
      clearTimeout(timer);
      del.disabled = true;
      try {
        await api("DELETE", "/api/" + kind + "/" + encodeURIComponent(row.id));
        await refresh();
      } catch (e) { del.disabled = false; setStatus(e.message); }
    });
    td.append(del);
    return td;
  }

  function renderList(kind) {
    renderFilter(kind);
    const f = $("filter-" + kind).value;
    const rows = S[kind].filter((r) => f === "all" || (r.date || "").startsWith(f));
    const body = $("rows-" + kind), foot = $("foot-" + kind);
    body.replaceChildren(); foot.replaceChildren();
    $("cnt-" + kind).textContent = S.loaded ? String(S[kind].length) : "";
    const cols = kind === "deposits" ? 8 : 9;
    if (!rows.length) {
      const noun = kind === "deposits" ? "deposit" : "expense";
      const msg = !S.loaded ? "Loading…" :
        (S[kind].length ? "No entries in this month." :
          (canAdd() ? "No " + kind + " yet. Use “Add " + noun + "” to record the first one." : "No " + kind + " recorded yet."));
      body.append(el("tr", null, el("td", { class: "empty", colspan: String(cols), text: msg })));
      return;
    }
    let total = 0;
    for (const r of rows) {
      total += r.amount || 0;
      const by = el("td", { class: "by", text: personName(r.createdBy) });
      if (r.updatedAt && r.updatedAt !== r.createdAt) by.title = "Last edited by " + personName(r.updatedBy) + " on " + r.updatedAt.slice(0, 10);
      const cells = kind === "deposits"
        ? [el("td", { class: "date", text: r.date }), el("td", { text: r.partner }), el("td", { class: "amt in", text: rm(r.amount) }),
           el("td", { text: r.method }), el("td", { text: r.ref }), el("td", { class: "note", text: r.note })]
        : [el("td", { class: "date", text: r.date }), el("td", { text: r.category }), el("td", { text: r.payee }),
           el("td", { class: "amt out", text: rm(r.amount) }), el("td", { text: r.method }), el("td", { text: r.ref }), el("td", { class: "note", text: r.note })];
      body.append(el("tr", null, ...cells, by, actionCell(kind, r)));
    }
    const label = el("td", { colspan: kind === "deposits" ? "2" : "3", text: "Total" + (f === "all" ? "" : " · " + monthLabel(f)) + " (" + rows.length + ")" });
    foot.append(el("tr", null, label, el("td", { class: "amt", text: rm(total) }), el("td", { colspan: "5" })));
  }

  function shareRows(tbodyId, map, total, isOut) {
    const body = $(tbodyId);
    body.replaceChildren();
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { body.append(el("tr", null, el("td", { class: "empty", colspan: "4", text: "Nothing recorded yet." }))); return; }
    for (const [k, v] of entries) {
      const pct = total > 0 ? (v / total) * 100 : 0;
      const fill = el("span");
      fill.style.width = pct.toFixed(1) + "%";
      const meter = el("div", { class: "meter" + (isOut ? " out" : "") }, fill);
      body.append(el("tr", null, el("td", { text: k }), el("td", { class: "amt", text: rm(v) }), el("td", { class: "amt", text: pct.toFixed(1) + "%" }), el("td", null, meter)));
    }
  }

  function renderSummary() {
    const dep = S.deposits.reduce((s, r) => s + (r.amount || 0), 0);
    const exp = S.expenses.reduce((s, r) => s + (r.amount || 0), 0);
    $("k-dep").textContent = rm(dep);
    $("k-exp").textContent = rm(exp);
    const bal = $("k-bal"); bal.textContent = rm(dep - exp); bal.className = "v " + (dep - exp < 0 ? "out" : "in");

    const byPartner = {}; for (const r of S.deposits) { const k = r.partner || "Unknown"; byPartner[k] = (byPartner[k] || 0) + (r.amount || 0); }
    const byCat = {}; for (const r of S.expenses) { const k = r.category || "Other"; byCat[k] = (byCat[k] || 0) + (r.amount || 0); }
    shareRows("sum-partners", byPartner, dep, false);
    shareRows("sum-categories", byCat, exp, true);

    const months = {};
    for (const r of S.deposits) { const m = (r.date || "").slice(0, 7); if (m) (months[m] = months[m] || { d: 0, e: 0 }).d += r.amount || 0; }
    for (const r of S.expenses) { const m = (r.date || "").slice(0, 7); if (m) (months[m] = months[m] || { d: 0, e: 0 }).e += r.amount || 0; }
    const keys = Object.keys(months).sort();
    const body = $("sum-months"); body.replaceChildren();
    if (!keys.length) { body.append(el("tr", null, el("td", { class: "empty", colspan: "5", text: "Nothing recorded yet." }))); return; }
    let run = 0; const out = [];
    for (const k of keys) {
      const { d, e } = months[k]; run += d - e;
      out.push(el("tr", null, el("td", { text: monthLabel(k) }), el("td", { class: "amt in", text: rm(d) }), el("td", { class: "amt out", text: rm(e) }),
        el("td", { class: "amt " + (d - e < 0 ? "out" : "in"), text: rm(d - e) }), el("td", { class: "amt", text: rm(run) })));
    }
    body.append(...out.reverse());
  }

  function renderAll() {
    if (!S.me) return;
    renderWho();
    for (const kind of ["deposits", "expenses"]) {
      $("add-" + kind).hidden = !canAdd() || !$("form-" + kind).hidden;
      renderList(kind);
    }
    renderSummary();
  }

  // ---------- tabs ----------
  function showTab(t) {
    if (!["deposits", "expenses", "summary"].includes(t)) t = "deposits";
    S.tab = t;
    for (const b of document.querySelectorAll("nav.tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    for (const k of ["deposits", "expenses", "summary"]) $("view-" + k).hidden = k !== t;
    try { localStorage.setItem("ledger-tab", t); } catch (_) { /* storage unavailable */ }
  }
  for (const b of document.querySelectorAll("nav.tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
  let savedTab = "deposits";
  try { savedTab = localStorage.getItem("ledger-tab") || "deposits"; } catch (_) { /* storage unavailable */ }
  showTab(savedTab);

  // ---------- forms ----------
  function fillSelect(id, items) { $(id).replaceChildren(...items.map((v) => el("option", { value: v, text: v }))); }
  $("dep-partner").addEventListener("change", () => { $("dep-other-wrap").hidden = $("dep-partner").value !== "Other"; });
  for (const k of ["deposits", "expenses"]) {
    $("filter-" + k).addEventListener("change", () => renderList(k));
    $("add-" + k).addEventListener("click", () => openForm(k, null));
  }
  $("dep-cancel").addEventListener("click", () => closeForm("deposits"));
  $("exp-cancel").addEventListener("click", () => closeForm("expenses"));

  function openForm(kind, row) {
    if (row ? !canModify(row) : !canAdd()) return;
    const o = S.options;
    S.editing[kind] = row ? row.id : null;
    const p = kind === "deposits" ? "dep" : "exp";
    $(p + "-msg").textContent = ""; $(p + "-msg").className = "";
    $(p + "-date").value = row ? row.date : today();
    $(p + "-amount").value = row ? senToInput(row.amount) : "";
    $(p + "-method").value = row && o.methods.includes(row.method) ? row.method : o.methods[0];
    $(p + "-ref").value = row ? row.ref || "" : "";
    $(p + "-note").value = row ? row.note || "" : "";
    if (kind === "deposits") {
      const known = row && o.partners.includes(row.partner);
      $("dep-partner").value = row ? (known ? row.partner : "Other") : o.partners[0];
      $("dep-other").value = row && !known ? row.partner || "" : "";
      $("dep-other-wrap").hidden = $("dep-partner").value !== "Other";
      $("dep-save").textContent = row ? "Save changes" : "Save deposit";
    } else {
      $("exp-category").value = row && o.categories.includes(row.category) ? row.category : o.categories[0];
      $("exp-payee").value = row ? row.payee || "" : "";
      $("exp-save").textContent = row ? "Save changes" : "Save expense";
    }
    $("form-" + kind).hidden = false;
    $("add-" + kind).hidden = true;
    showTab(kind);
    $(p + "-amount").focus();
  }
  function closeForm(kind) {
    S.editing[kind] = null;
    $("form-" + kind).hidden = true;
    $("add-" + kind).hidden = !canAdd();
  }

  async function submit(kind, ev) {
    ev.preventDefault();
    const p = kind === "deposits" ? "dep" : "exp";
    const msg = $(p + "-msg");
    const body = {
      date: $(p + "-date").value,
      amount: $(p + "-amount").value,
      method: $(p + "-method").value,
      ref: $(p + "-ref").value,
      note: $(p + "-note").value
    };
    if (kind === "deposits") {
      body.partner = $("dep-partner").value === "Other" ? $("dep-other").value : $("dep-partner").value;
    } else {
      body.category = $("exp-category").value;
      body.payee = $("exp-payee").value;
    }
    const id = S.editing[kind];
    const btn = $(p + "-save");
    btn.disabled = true; msg.className = ""; msg.textContent = "Saving…";
    try {
      if (id) await api("PUT", "/api/" + kind + "/" + encodeURIComponent(id), body);
      else await api("POST", "/api/" + kind, body);
      closeForm(kind);
      await refresh();
    } catch (e) {
      msg.className = "err"; msg.textContent = e.message;
    } finally { btn.disabled = false; }
  }
  $("form-deposits").addEventListener("submit", (e) => submit("deposits", e));
  $("form-expenses").addEventListener("submit", (e) => submit("expenses", e));

  // ---------- data ----------
  async function refresh() {
    const data = await api("GET", "/api/entries");
    S.deposits = data.deposits; S.expenses = data.expenses; S.loaded = true;
    setStatus("");
    renderAll();
  }
  function stopPolling() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }
  function startPolling() {
    stopPolling();
    S.pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible" || !S.me) return;
      // Don't redraw under someone mid-edit; their save triggers a refresh anyway.
      if (!$("form-deposits").hidden || !$("form-expenses").hidden) return;
      refresh().catch((e) => { if (e.status !== 401) setStatus("Couldn't update: " + e.message); });
    }, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.me && $("form-deposits").hidden && $("form-expenses").hidden) refresh().catch(() => {});
  });

  async function boot() {
    let me;
    try { me = await api("GET", "/api/me"); }
    catch (e) { if (e.status !== 401) { showLogin(); setStatus(e.message); } return; }
    S.me = me.user; S.users = me.users; S.options = me.options;
    fillSelect("dep-partner", [...S.options.partners, "Other"]);
    fillSelect("dep-method", S.options.methods);
    fillSelect("exp-category", S.options.categories);
    fillSelect("exp-method", S.options.methods);
    closeForm("deposits"); closeForm("expenses");
    $("login").hidden = true; $("app").hidden = false;
    renderAll();
    try { await refresh(); } catch (e) { if (e.status !== 401) setStatus(e.message); }
    startPolling();
  }

  boot();
})();
