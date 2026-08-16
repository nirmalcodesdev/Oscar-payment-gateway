/* Oscar Gateway Dev Console — dependency-free API exerciser. */
const $ = (sel, el = document) => el.querySelector(sel);
const state = {
  apiBase: localStorage.getItem("apiBase") ?? "http://127.0.0.1:3000",
  adminToken: localStorage.getItem("adminToken") ?? "",
  merchantKey: localStorage.getItem("merchantKey") ?? "",
  stepUp: "",
};
const save = () => {
  localStorage.setItem("apiBase", state.apiBase);
  localStorage.setItem("adminToken", state.adminToken);
  localStorage.setItem("merchantKey", state.merchantKey);
};
$("#api-base").value = state.apiBase;
$("#api-base").onchange = (e) => {
  state.apiBase = e.target.value.replace(/\/$/, "");
  save();
  checkConn();
};

/* ---------- console + fetch ---------- */
let consoleEntries = 0;
$("#console-toggle").onclick = () => {
  $("#console").hidden = !$("#console").hidden;
};
$("#console-clear").onclick = () => {
  $("#console").innerHTML = "";
  consoleEntries = 0;
  $("#console-count").textContent = "";
};
function logCall(method, path, status, ms) {
  consoleEntries += 1;
  $("#console-count").textContent = `${consoleEntries} calls`;
  const div = document.createElement("div");
  div.className = "entry";
  const cls = status >= 400 ? "s4" : status === 0 ? "s5" : "s2";
  div.innerHTML = `<span class="m">${method}</span> ${path} <span class="${cls}">${status}</span><span class="t">${ms}ms</span>`;
  $("#console").prepend(div);
}
async function api(
  method,
  path,
  { body, headers = {}, auth = "none", raw = false } = {},
) {
  const h = { ...headers };
  if (auth === "admin" && state.adminToken)
    h.authorization = `Bearer ${state.adminToken}`;
  if (auth === "merchant" && state.merchantKey)
    h["x-oscar-merchant-api-key"] = state.merchantKey;
  if (body !== undefined && !raw) h["content-type"] = "application/json";
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${state.apiBase}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
  } catch (e) {
    logCall(method, path, 0, Math.round(performance.now() - started));
    throw e;
  }
  logCall(method, path, res.status, Math.round(performance.now() - started));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, json, text };
}

/* ---------- helpers ---------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children)
    node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}
const out = (text) => el("pre", { class: "out" + (text ? "" : " empty") }, text ?? "");
const jsonPretty = (r) => (r.json === null ? r.text : JSON.stringify(r.json, null, 2));
const field = (labelText, inputAttrs = {}) => {
  const input = el("input", inputAttrs);
  if (inputAttrs.value !== undefined) input.value = inputAttrs.value;
  return { root: el("label", { class: "f" }, labelText, input), input };
};
const area = (labelText, value = "", rows = 4) => {
  const t = el("textarea", { rows: String(rows) });
  t.value = value;
  return { root: el("label", { class: "f" }, labelText, t), input: t };
};
const select = (labelText, options, value) => {
  const s = el("select");
  for (const o of options) s.append(el("option", { value: o }, o));
  s.value = value;
  return { root: el("label", { class: "f" }, labelText, s), input: s };
};
const btn = (text, onclick, cls = "") =>
  el("button", { class: "act " + cls, onclick }, text);
const fieldset = (legend, ...kids) => {
  const f = el("fieldset", {}, el("legend", {}, legend));
  f.append(...kids);
  return f;
};
const randomHex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
async function hmacSha256(secretStr, prefix, bytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretStr),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefixBytes = new TextEncoder().encode(prefix);
  const combined = new Uint8Array(prefixBytes.length + bytes.length);
  combined.set(prefixBytes);
  combined.set(bytes, prefixBytes.length);
  const sig = await crypto.subtle.sign("HMAC", key, combined);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function checkConn() {
  const pill = $("#conn-state");
  try {
    const r = await fetch(`${state.apiBase}/health`);
    pill.textContent = r.ok ? "connected" : `http ${r.status}`;
    pill.className = "pill " + (r.ok ? "ok" : "err");
  } catch {
    pill.textContent = "offline";
    pill.className = "pill err";
  }
}

/* ---------- section registry ---------- */
const sections = {};
const register = (name, build) => {
  sections[name] = build;
};
const main = $("#main");
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-section]");
  if (!b) return;
  document.querySelectorAll("#nav button").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  render(b.dataset.section);
});
function render(name) {
  main.innerHTML = "";
  const view = el("section", { class: "view" });
  main.append(view);
  (sections[name] ?? ((v) => v.append(el("p", {}, "unknown section"))))(view);
}

/* ================= DASHBOARD ================= */
register("dashboard", (view) => {
  view.append(el("h2", {}, "Service dashboard"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Liveness is process-only; readiness reports every dependency and enabled-chain check without provider identity.",
    ),
  );
  const healthOut = out();
  const readyOut = out();
  const metricsOut = out();
  view.append(
    fieldset(
      "Probes",
      btn("GET /health", async () => {
        const r = await api("GET", "/health");
        healthOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("GET /ready", async () => {
        const r = await api("GET", "/ready");
        readyOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("GET /metrics", async () => {
        const r = await api("GET", "/metrics");
        metricsOut.textContent = r.text;
      }),
      healthOut,
      readyOut,
      metricsOut,
    ),
  );
  checkConn();
});

/* ================= ADMIN SESSION ================= */
register("admin", (view) => {
  view.append(el("h2", {}, "Admin session"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Short-lived HS256 access tokens with rotating refresh; the token is stored only in this browser (localStorage).",
    ),
  );
  const email = field("Email", { value: "admin@example.com" });
  const password = field("Password", { type: "password", value: "" });
  const result = out();
  const result2 = out();
  view.append(
    fieldset(
      "Login",
      email.root,
      password.root,
      btn("POST /admin/auth/login", async () => {
        const r = await api("POST", "/api/v1/admin/auth/login", {
          body: { email: email.input.value, password: password.input.value },
        });
        if (r.status === 200 && r.json?.accessToken) {
          state.adminToken = r.json.accessToken;
          save();
        }
        result.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      result,
    ),
  );
  const status = out(
    state.adminToken ? `token: ${state.adminToken.slice(0, 24)}…` : "no token",
  );
  view.append(
    fieldset(
      "Session",
      btn("POST /admin/auth/refresh", async () => {
        const r = await api("POST", "/api/v1/admin/auth/refresh", { auth: "admin" });
        if (r.json?.accessToken) {
          state.adminToken = r.json.accessToken;
          save();
        }
        result2.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("POST /admin/auth/logout", async () => {
        const r = await api("POST", "/api/v1/admin/auth/logout", { auth: "admin" });
        if (r.status < 300) {
          state.adminToken = "";
          save();
        }
        result2.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("Forget token", () => {
        state.adminToken = "";
        save();
        status.textContent = "no token";
      }),
      status,
      result2,
    ),
  );
});

/* ================= MERCHANTS (admin) ================= */
register("merchants", (view) => {
  view.append(el("h2", {}, "Merchants (admin)"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Onboarding: register returns a one-time API key (full scope set); approval activates the merchant. The key is copied into the Merchant session automatically — it is never shown again.",
    ),
  );
  const email = field("Email", { value: `dev-${Date.now()}@example.com` });
  const regOut = out();
  view.append(
    fieldset(
      "POST /api/v1/merchants",
      email.root,
      btn("Register merchant", async () => {
        const r = await api("POST", "/api/v1/merchants", {
          body: { email: email.input.value },
        });
        regOut.textContent = `${r.status}\n${jsonPretty(r)}`;
        if (r.json?.apiKey) {
          state.merchantKey = r.json.apiKey;
          save();
          regOut.textContent +=
            "\n\nAPI key stored into the Merchant session section (shown this once only).";
        }
      }),
      regOut,
    ),
  );
  const mid = field("merchantId", { value: "" });
  const ver = field("expectedVersion", { type: "number", value: "0" });
  const statusSel = select("status", ["active", "suspended", "rejected"], "suspended");
  const admOut = out();
  view.append(
    fieldset(
      "Admin actions",
      mid.root,
      ver.root,
      btn("POST …/email-verification", async () => {
        const r = await api(
          "POST",
          `/api/v1/admin/merchants/${mid.input.value}/email-verification`,
          {
            auth: "admin",
            body: { expectedVersion: Number(ver.input.value) },
          },
        );
        admOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("POST …/approval", async () => {
        const r = await api(
          "POST",
          `/api/v1/admin/merchants/${mid.input.value}/approval`,
          {
            auth: "admin",
            body: { expectedVersion: Number(ver.input.value) },
          },
        );
        admOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      statusSel.root,
      btn("PATCH …/status", async () => {
        const r = await api(
          "PATCH",
          `/api/v1/admin/merchants/${mid.input.value}/status`,
          {
            auth: "admin",
            body: { version: Number(ver.input.value), status: statusSel.input.value },
          },
        );
        admOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      admOut,
    ),
  );
});

/* ================= CHAINS (admin) ================= */
register("chains", (view) => {
  view.append(el("h2", {}, "Chain registry (admin)"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Chains are created disabled and activated separately after independent-provider verification. Disabling with open payments fails closed unless forced with a reason and confirmation literal.",
    ),
  );
  const id = field("chainId (registry id)", { value: "dev-chain" });
  const nid = field("networkChainId (EVM)", { type: "number", value: "11155111" });
  const name = field("name", { value: "Dev Chain" });
  const p1 = field("providerId 1 (catalog)", { value: "local-rpc-a" });
  const p2 = field("providerId 2 (catalog)", { value: "local-rpc-b" });
  const cur = field("native symbol", { value: "ETH" });
  const conf = field("requiredConfirmations", { type: "number", value: "2" });
  const out1 = out();
  view.append(
    fieldset(
      "POST /admin/chains",
      id.root,
      el("div", { class: "row" }, nid.root, name.root),
      el("div", { class: "row" }, p1.root, p2.root),
      el("div", { class: "row" }, cur.root, conf.root),
      btn("Create chain", async () => {
        const body = {
          chainId: id.input.value,
          networkChainId: Number(nid.input.value),
          name: name.input.value,
          providerIds: [p1.input.value, p2.input.value],
          nativeCurrency: {
            name: `${cur.input.value} unit`,
            symbol: cur.input.value,
            decimals: 18,
          },
          requiredConfirmations: Number(conf.input.value),
        };
        const r = await api("POST", "/api/v1/admin/chains", { auth: "admin", body });
        out1.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      out1,
    ),
  );
  const cid = field("chainId", { value: "dev-chain" });
  const ver = field("expectedVersion", { type: "number", value: "0" });
  const nname = field("new name (optional)", { value: "" });
  const nconf = field("new requiredConfirmations", { type: "number", value: "" });
  const forceReason = area(
    "force deactivation reason (≥10 chars; empty = normal)",
    "",
    2,
  );
  const confirmLit = field("confirmation literal (force)", { value: "" });
  const out2 = out();
  view.append(
    fieldset(
      "Update / lifecycle",
      cid.root,
      ver.root,
      el("div", { class: "row" }, nname.root, nconf.root),
      btn("PATCH /admin/chains/:id", async () => {
        const body = { expectedVersion: Number(ver.input.value) };
        if (nname.input.value) body.name = nname.input.value;
        if (nconf.input.value) body.requiredConfirmations = Number(nconf.input.value);
        const r = await api("PATCH", `/api/v1/admin/chains/${cid.input.value}`, {
          auth: "admin",
          body,
        });
        out2.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("POST …/activation", async () => {
        const r = await api(
          "POST",
          `/api/v1/admin/chains/${cid.input.value}/activation`,
          {
            auth: "admin",
            body: { expectedVersion: Number(ver.input.value) },
          },
        );
        out2.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("POST …/deactivation", async () => {
        const force = forceReason.input.value.trim().length > 0;
        const body = force
          ? {
              expectedVersion: Number(ver.input.value),
              force: true,
              confirmation: confirmLit.input.value,
              reason: forceReason.input.value,
            }
          : { expectedVersion: Number(ver.input.value), force: false };
        const r = await api(
          "POST",
          `/api/v1/admin/chains/${cid.input.value}/deactivation`,
          {
            auth: "admin",
            body,
          },
        );
        out2.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      forceReason.root,
      confirmLit.root,
      out2,
    ),
  );
});

/* ================= TOKENS (admin) ================= */
register("tokens", (view) => {
  view.append(el("h2", {}, "Token registry (admin)"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Activation verifies live decimals through independent providers; non-standard contracts require an acknowledged manual review. Force-disable exists for tokens with open payments.",
    ),
  );
  const tid = field("tokenId", { value: "dev-usdc" });
  const chn = field("chain", { value: "dev-chain" });
  const sym = field("symbol", { value: "USDC" });
  const caddr = field("contractAddress (0x…40)", { value: "" });
  const dec = field("decimals", { type: "number", value: "6" });
  const mn = field("minAmount (base units)", { value: "1" });
  const mx = field("maxAmount (base units)", { value: "1000000000" });
  const pol = select(
    "verificationPolicy",
    ["event_only", "balance_delta_required"],
    "event_only",
  );
  const out1 = out();
  view.append(
    fieldset(
      "POST /admin/tokens",
      tid.root,
      chn.root,
      el("div", { class: "row" }, sym.root, caddr.root),
      el("div", { class: "row" }, dec.root, pol.root),
      el("div", { class: "row" }, mn.root, mx.root),
      btn("Create token", async () => {
        const body = {
          tokenId: tid.input.value,
          chain: chn.input.value,
          symbol: sym.input.value,
          contractAddress: caddr.input.value,
          decimals: Number(dec.input.value),
          minAmount: mn.input.value,
          maxAmount: mx.input.value,
          verificationPolicy: pol.input.value,
        };
        const r = await api("POST", "/api/v1/admin/tokens", { auth: "admin", body });
        out1.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      out1,
    ),
  );
  const tid2 = field("tokenId", { value: "dev-usdc" });
  const ver = field("expectedVersion", { type: "number", value: "0" });
  const nmn = field("new minAmount", { value: "" });
  const nmx = field("new maxAmount", { value: "" });
  const reason = area("manual-review reason (non-standard activation)", "", 2);
  const ack = field("acknowledged (manual review)", { type: "checkbox" });
  const forceReason = area(
    "force deactivation reason (≥10 chars; empty = normal)",
    "",
    2,
  );
  const out2 = out();
  view.append(
    fieldset(
      "Lifecycle",
      tid2.root,
      ver.root,
      el("div", { class: "row" }, nmn.root, nmx.root),
      btn("PATCH /admin/tokens/:id", async () => {
        const body = { expectedVersion: Number(ver.input.value) };
        if (nmn.input.value) body.minAmount = nmn.input.value;
        if (nmx.input.value) body.maxAmount = nmx.input.value;
        const r = await api("PATCH", `/api/v1/admin/tokens/${tid2.input.value}`, {
          auth: "admin",
          body,
        });
        out2.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("POST …/activation", async () => {
        const body = { expectedVersion: Number(ver.input.value) };
        if (ack.input.checked)
          body.manualReview = { acknowledged: true, reason: reason.input.value };
        const r = await api(
          "POST",
          `/api/v1/admin/tokens/${tid2.input.value}/activation`,
          { auth: "admin", body },
        );
        out2.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("POST …/deactivation", async () => {
        const force = forceReason.input.value.trim().length > 0;
        const body = force
          ? {
              expectedVersion: Number(ver.input.value),
              force: true,
              reason: forceReason.input.value,
            }
          : { expectedVersion: Number(ver.input.value), force: false };
        const r = await api(
          "POST",
          `/api/v1/admin/tokens/${tid2.input.value}/deactivation`,
          { auth: "admin", body },
        );
        out2.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      reason.root,
      ack.root,
      forceReason.root,
      out2,
    ),
  );
});

/* ================= COMPLIANCE ================= */
register("compliance", (view) => {
  view.append(el("h2", {}, "Compliance (admin)"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Sanctions lists are integrity-checked: the server recomputes the canonical SHA-256 over the sorted unique lowercase addresses. This console computes the identical digest before submitting.",
    ),
  );
  const ver = field("listVersion", { value: `dev-${Date.now()}` });
  const src = field("source", { value: "dev-console" });
  const addrs = area("addresses (one per line, 0x…40)", "", 6);
  const hashOut = out();
  const ingestOut = out();
  async function canonicalHash(list) {
    const uniq = [
      ...new Set(list.map((a) => a.trim().toLowerCase()).filter(Boolean)),
    ].sort();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(uniq)),
    );
    return {
      hex: [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
      uniq,
    };
  }
  view.append(
    fieldset(
      "PUT /admin/compliance/sanctions-list",
      ver.root,
      src.root,
      addrs.root,
      btn("Compute content hash", async () => {
        const { hex, uniq } = await canonicalHash(addrs.input.value.split("\n"));
        hashOut.textContent = `entries: ${uniq.length}\ncontentSha256: ${hex}`;
      }),
      btn("Ingest list", async () => {
        const { hex } = await canonicalHash(addrs.input.value.split("\n"));
        const list = addrs.input.value
          .split("\n")
          .map((a) => a.trim())
          .filter(Boolean);
        const r = await api("PUT", "/api/v1/admin/compliance/sanctions-list", {
          auth: "admin",
          body: {
            listVersion: ver.input.value,
            source: src.input.value,
            addresses: list,
            contentSha256: hex,
          },
        });
        ingestOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      hashOut,
      ingestOut,
    ),
  );
  const holdsOut = out();
  view.append(
    fieldset(
      "GET /admin/compliance/holds",
      btn("Load holds", async () => {
        const r = await api("GET", "/api/v1/admin/compliance/holds", { auth: "admin" });
        holdsOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      holdsOut,
    ),
  );
  const pid = field("paymentId", { value: "" });
  const decision = select("decision", ["release", "block"], "release");
  const reason = area(
    "reason (≥10 chars)",
    "Reviewed from the dev console with documented evidence.",
    2,
  );
  const evidence = field("evidence (optional)", { value: "dev-console" });
  const decOut = out();
  view.append(
    fieldset(
      "POST …/holds/:paymentId/decision",
      pid.root,
      decision.root,
      reason.root,
      evidence.root,
      btn("Record decision", async () => {
        const body = { decision: decision.input.value, reason: reason.input.value };
        if (evidence.input.value) body.evidence = evidence.input.value;
        const r = await api(
          "POST",
          `/api/v1/admin/compliance/holds/${pid.input.value}/decision`,
          {
            auth: "admin",
            body,
          },
        );
        decOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      decOut,
    ),
  );
});

/* ================= RECONCILIATION ================= */
register("reconciliation", (view) => {
  view.append(el("h2", {}, "Reconciliation (admin)"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Surfaces — never hides — discrepancies: orphan events, open annotations, stale payments, compliance holds, reorg effects, and webhook dead letters.",
    ),
  );
  const ovOut = out();
  view.append(
    fieldset(
      "GET /admin/reconciliation",
      btn("Load overview", async () => {
        const r = await api("GET", "/api/v1/admin/reconciliation", { auth: "admin" });
        ovOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      ovOut,
    ),
  );
  const ann = field("annotationId", { value: "" });
  const note = area(
    "resolution note (≥10 chars)",
    "Resolved from the dev console after review.",
    2,
  );
  const resOut = out();
  view.append(
    fieldset(
      "POST …/annotations/:id/resolve",
      ann.root,
      note.root,
      btn("Resolve annotation", async () => {
        const r = await api(
          "POST",
          `/api/v1/admin/reconciliation/annotations/${ann.input.value}/resolve`,
          {
            auth: "admin",
            body: { note: note.input.value },
          },
        );
        resOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      resOut,
    ),
  );
  const did = field("deliveryId", { value: "" });
  const repOut = out();
  view.append(
    fieldset(
      "POST /admin/webhooks/:id/replay",
      did.root,
      btn("Replay dead-lettered webhook", async () => {
        const r = await api(
          "POST",
          `/api/v1/admin/webhooks/${did.input.value}/replay`,
          { auth: "admin" },
        );
        repOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      repOut,
    ),
  );
});

/* ================= MERCHANT SESSION ================= */
register("merchant", (view) => {
  view.append(el("h2", {}, "Merchant session"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Requests authenticate with the one-time API key (x-oscar-merchant-api-key). The key is kept in this browser's localStorage and attached automatically.",
    ),
  );
  const key = field("API key", { value: state.merchantKey });
  key.input.onchange = () => {
    state.merchantKey = key.input.value.trim();
    save();
  };
  view.append(
    fieldset(
      "Credential",
      key.root,
      btn("Use this key", () => {
        state.merchantKey = key.input.value.trim();
        save();
      }),
    ),
  );
  const stepOut = out();
  view.append(
    fieldset(
      "Step-up (single-use token for wallet rotation)",
      btn("POST /merchant/auth/step-up (merchant:wallets)", async () => {
        const r = await api("POST", "/api/v1/merchant/auth/step-up", {
          auth: "merchant",
        });
        if (r.json?.token) state.stepUp = r.json.token;
        stepOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      el(
        "p",
        { class: "muted" },
        state.stepUp
          ? `step-up token held (${state.stepUp.slice(0, 16)}…, single use)`
          : "no step-up token yet",
      ),
      stepOut,
    ),
  );
  const rotOut = out();
  view.append(
    fieldset(
      "Credential rotation & revocation",
      btn("POST /merchant/credentials/rotate", async () => {
        const r = await api("POST", "/api/v1/merchant/credentials/rotate", {
          auth: "merchant",
        });
        if (r.json?.apiKey) {
          key.input.value = r.json.apiKey;
          state.merchantKey = r.json.apiKey;
          save();
        }
        rotOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn("POST …/credentials/:id/revocation", async () => {
        const credId = prompt("credentialId to revoke");
        if (!credId) return;
        const r = await api(
          "POST",
          `/api/v1/merchant/credentials/${credId}/revocation`,
          { auth: "merchant" },
        );
        rotOut.textContent = `${r.status}\n${r.status === 204 ? "(no content)" : jsonPretty(r)}`;
      }),
      rotOut,
    ),
  );
  const wver = field("merchant version", { type: "number", value: "0" });
  const wurl = field("webhookUrl (public https URL; SSRF-guarded on delivery)", {
    value: "",
  });
  const wOut = out();
  view.append(
    fieldset(
      "PUT /merchant/webhook",
      wver.root,
      wurl.root,
      btn("Set webhook URL", async () => {
        const r = await api("PUT", "/api/v1/merchant/webhook", {
          auth: "merchant",
          body: { version: Number(wver.input.value), webhookUrl: wurl.input.value },
        });
        wOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      wOut,
    ),
  );
  const chn = field("chain", { value: "dev-chain" });
  const xpub = area(
    "publicExtendedKey (xpub/tpub only — private material is rejected)",
    "",
    3,
  );
  const regOut = out();
  view.append(
    fieldset(
      "POST /merchant/wallets",
      chn.root,
      xpub.root,
      btn("Register wallet", async () => {
        const r = await api("POST", "/api/v1/merchant/wallets", {
          auth: "merchant",
          body: { chain: chn.input.value, publicExtendedKey: xpub.input.value.trim() },
        });
        regOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      regOut,
    ),
  );
  const xid = field("xpubId", { value: "" });
  const rwver = field("merchant version", { type: "number", value: "0" });
  const rchn = field("chain", { value: "dev-chain" });
  const rotWOut = out();
  view.append(
    fieldset(
      "PUT /merchant/wallets/:xpubId (consumes the step-up token)",
      xid.root,
      rwver.root,
      rchn.root,
      btn("Rotate wallet", async () => {
        const headers = {};
        if (state.stepUp) headers["x-oscar-wallet-step-up"] = state.stepUp;
        const r = await api("PUT", `/api/v1/merchant/wallets/${xid.input.value}`, {
          auth: "merchant",
          headers,
          body: {
            version: Number(rwver.input.value),
            chain: rchn.input.value,
            publicExtendedKey: xpub.input.value.trim(),
          },
        });
        if (r.status < 300) state.stepUp = "";
        rotWOut.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      rotWOut,
    ),
  );
});

/* ================= PAYMENTS ================= */
register("payments", (view) => {
  view.append(el("h2", {}, "Payments"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Creation derives a unique deposit address per payment (Option A), clamps expiry server-side, and returns an EIP-681 URI. An optional Idempotency-Key replays the stored response for identical requests and conflicts on different ones.",
    ),
  );
  const chn = field("chain", { value: "dev-chain" });
  const tok = field("token", { value: "dev-usdc" });
  const amt = field("amount (base-unit integer string)", { value: "1000000" });
  const exp = field("expiresInSec (optional, clamped)", { type: "number", value: "" });
  const idem = field("Idempotency-Key (optional, 16–255 chars)", { value: "" });
  const cout = out();
  const pid = field("paymentId", { value: "" });
  view.append(
    fieldset(
      "POST /api/v1/payments",
      el("div", { class: "row" }, chn.root, tok.root),
      el("div", { class: "row" }, amt.root, exp.root),
      idem.root,
      btn("Create payment", async () => {
        const body = {
          chain: chn.input.value,
          token: tok.input.value,
          amount: amt.input.value,
        };
        if (exp.input.value) body.expiresInSec = Number(exp.input.value);
        const headers = {};
        if (idem.input.value) headers["idempotency-key"] = idem.input.value;
        const r = await api("POST", "/api/v1/payments", {
          auth: "merchant",
          headers,
          body,
        });
        cout.textContent = `${r.status}\n${jsonPretty(r)}`;
        if (r.json?.paymentId) pid.input.value = r.json.paymentId;
      }),
      cout,
    ),
  );
  const gout = out();
  let pollTimer = null;
  view.append(
    fieldset(
      "GET /api/v1/payments/:id",
      pid.root,
      btn("Fetch payment", async () => {
        const r = await api("GET", `/api/v1/payments/${pid.input.value}`, {
          auth: "merchant",
        });
        gout.textContent = `${r.status}\n${jsonPretty(r)}`;
      }),
      btn(
        "Poll every 3s",
        (e) => {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
            e.target.textContent = "Poll every 3s";
            return;
          }
          e.target.textContent = "Stop polling";
          pollTimer = setInterval(async () => {
            const r = await api("GET", `/api/v1/payments/${pid.input.value}`, {
              auth: "merchant",
            });
            gout.textContent = `${new Date().toLocaleTimeString()} ${r.status}\n${jsonPretty(r)}`;
          }, 3000);
        },
        "secondary",
      ),
      gout,
    ),
  );
});

/* ================= INGESTION TESTER ================= */
register("ingestion", (view) => {
  view.append(el("h2", {}, "Internal ingestion tester"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Signs an on-chain event exactly like the watcher: HMAC-SHA256 over `${timestamp}\\n${nonce}\\n` + the exact body bytes, with per-request nonce replay protection. Defaults match the local dev compose secrets.",
    ),
  );
  const secret = field("INGESTION_HMAC_CURRENT_SECRET", {
    value: "local-ingestion-hmac-secret-change-me-32",
  });
  const keyId = field("key id", { value: "local-v1" });
  const chn = field("chain", { value: "dev-chain" });
  const contract = field("contractAddress (0x…40)", { value: "" });
  const to = field("toAddress (the payment's deposit address)", { value: "" });
  const from = field("fromAddress", {
    value: "0x1111111111111111111111111111111111111111",
  });
  const amt = field("amount (base units)", { value: "1000000" });
  const block = field("blockNumber", { type: "number", value: "100" });
  const txh = field("transactionHash (0x…64)", { value: "" });
  const logi = field("logIndex", { type: "number", value: "0" });
  const iout = out();
  view.append(
    fieldset(
      "POST /api/v1/internal/on-chain-events",
      secret.root,
      keyId.root,
      el("div", { class: "row" }, chn.root, contract.root),
      el("div", { class: "row" }, to.root, from.root),
      el("div", { class: "row" }, amt.root, block.root),
      el("div", { class: "row" }, txh.root, logi.root),
      btn(
        "Auto-fill hashes",
        () => {
          if (!contract.input.value) contract.input.value = `0x${randomHex(20)}`;
          if (!txh.input.value) txh.input.value = `0x${randomHex(32)}`;
        },
        "secondary",
      ),
      btn("Sign & submit", async () => {
        const topic = (a) =>
          `0x000000000000000000000000${a.replace(/^0x/, "").toLowerCase()}`;
        const body = {
          chain: chn.input.value,
          transactionHash: txh.input.value,
          logIndex: Number(logi.input.value),
          blockNumber: Number(block.input.value),
          blockHash: `0x${randomHex(32)}`,
          contractAddress: contract.input.value,
          fromAddress: from.input.value,
          toAddress: to.input.value,
          amount: amt.input.value,
          rawEvent: {
            topics: [
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
              topic(from.input.value),
              topic(to.input.value),
            ],
            data:
              "0x" +
              BigInt(amt.input.value || "0")
                .toString(16)
                .padStart(64, "0"),
          },
        };
        const bytes = new TextEncoder().encode(JSON.stringify(body));
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = randomHex(16);
        const signature = await hmacSha256(
          secret.input.value,
          `${timestamp}\n${nonce}\n`,
          bytes,
        );
        const r = await api("POST", "/api/v1/internal/on-chain-events", {
          headers: {
            "content-type": "application/json",
            "x-oscar-event-key-id": keyId.input.value,
            "x-oscar-event-timestamp": timestamp,
            "x-oscar-event-nonce": nonce,
            "x-oscar-event-signature": signature,
          },
          body: bytes,
          raw: true,
        });
        iout.textContent = `${r.status}\n${jsonPretty(r)}\n\nsent body:\n${JSON.stringify(body, null, 2)}`;
      }),
      iout,
    ),
  );
});

/* ================= WEBHOOK VERIFIER ================= */
register("webhook", (view) => {
  view.append(el("h2", {}, "Webhook signature verifier"));
  view.append(
    el(
      "p",
      { class: "hint" },
      "Reproduces what a merchant receiver must do: verify HMAC-SHA256 over `${timestamp}\\n${deliveryId}\\n` + the exact received body bytes.",
    ),
  );
  const secret = field("WEBHOOK_HMAC_CURRENT_SECRET", {
    value: "local-webhook-hmac-secret-change-me-32",
  });
  const ts = field("x-oscar-webhook-timestamp", { value: "" });
  const did = field("x-oscar-delivery-id", { value: "" });
  const sig = field("x-oscar-webhook-signature", { value: "" });
  const body = area("raw body bytes (exactly as received)", "{}", 6);
  const vout = out();
  view.append(
    fieldset(
      "Verify",
      secret.root,
      ts.root,
      did.root,
      sig.root,
      body.root,
      btn("Verify signature", async () => {
        const hex = await hmacSha256(
          secret.input.value,
          `${ts.input.value}\n${did.input.value}\n`,
          new TextEncoder().encode(body.input.value),
        );
        const ok = hex === sig.input.value.trim().toLowerCase();
        vout.textContent = `computed: ${hex}\nsupplied: ${sig.input.value}\nmatch: ${ok ? "VALID ✓" : "INVALID ✗"}`;
      }),
      vout,
    ),
  );
});

render("dashboard");
checkConn();
