const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "massas.json");
const MIRRORS_FILE = path.join(DATA_DIR, "apis.json");
const LOGS_FILE = path.join(DATA_DIR, "logs.json");

// SSE clients for real-time log streaming
const sseClients = new Set();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── UTILS ───────────────────────────────────────────────────────────────────

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

async function readJsonFile(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const cleanJson = raw.replace(/^\uFEFF/, "").replace(/^ï»¿/, "").trim();
    const jsonText = cleanJson.replace(/^[^\[{]+(?=[\[{])/, "");
    if (!jsonText) return fallback;
    const parsed = JSON.parse(jsonText);
    if (raw.charCodeAt(0) === 0xFEFF || raw.startsWith("ï»¿")) {
      await fs.writeFile(file, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    }
    return parsed;
  } catch {
    return fallback;
  }
}

async function ensureJsonFile(file, fallback) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(file); } catch {
    await fs.writeFile(file, JSON.stringify(fallback, null, 2) + "\n", "utf8");
  }
}

async function readMassas() { await ensureJsonFile(DATA_FILE, []); return readJsonFile(DATA_FILE, []); }
async function writeMassas(d) { const t = DATA_FILE + ".tmp"; await fs.writeFile(t, JSON.stringify(d, null, 2) + "\n", "utf8"); await fs.rename(t, DATA_FILE); }
async function readMirrors() { await ensureJsonFile(MIRRORS_FILE, []); return readJsonFile(MIRRORS_FILE, []); }
async function writeMirrors(d) { const t = MIRRORS_FILE + ".tmp"; await fs.writeFile(t, JSON.stringify(d, null, 2) + "\n", "utf8"); await fs.rename(t, MIRRORS_FILE); }

// ─── REQUEST LOG ─────────────────────────────────────────────────────────────

const MAX_LOGS = 200;
let requestLogs = [];

async function loadLogs() {
  await ensureJsonFile(LOGS_FILE, []);
  requestLogs = await readJsonFile(LOGS_FILE, []);
}

async function appendLog(entry) {
  requestLogs.unshift(entry);
  if (requestLogs.length > MAX_LOGS) requestLogs = requestLogs.slice(0, MAX_LOGS);
  try {
    await fs.writeFile(LOGS_FILE, JSON.stringify(requestLogs, null, 2) + "\n", "utf8");
  } catch {}
  // Push to SSE clients
  const data = JSON.stringify(entry);
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch { sseClients.delete(client); }
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function requireUraKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.get("x-api-key") || req.query.apiKey;
  if (key !== API_KEY) return res.status(401).json({ encontrado: false, codigo: "NAO_AUTORIZADO", mensagem: "API key invalida ou ausente." });
  next();
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────

function validateMassa(p) {
  const errors = [];
  for (const f of ["nome", "cenario", "telefone", "cpf", "status"]) {
    if (!String(p[f] || "").trim()) errors.push(`Campo obrigatorio: ${f}`);
  }
  if (p.telefone && !/^[0-9+()\-\s]{8,20}$/.test(String(p.telefone))) errors.push("Telefone invalido.");
  return errors;
}

function validateMirror(p) {
  const errors = [];
  if (!String(p.nome || "").trim()) errors.push("Campo obrigatorio: nome");
  if (!String(p.path || "").trim()) errors.push("Campo obrigatorio: path");
  if (!String(p.method || "").trim()) errors.push("Campo obrigatorio: method");
  if (p.scenarios && !Array.isArray(p.scenarios)) errors.push("Scenarios deve ser array");
  return errors;
}

function toMassa(p, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || randomUUID(),
    nome: String(p.nome || "").trim(),
    cenario: String(p.cenario || "").trim(),
    telefone: String(p.telefone || "").trim(),
    cpf: String(p.cpf || "").trim(),
    contrato: String(p.contrato || "").trim(),
    status: String(p.status || "").trim(),
    fila: String(p.fila || "").trim(),
    observacao: String(p.observacao || "").trim(),
    extra: (p.extra && typeof p.extra === "object") ? p.extra : {},
    criadoEm: existing.criadoEm || now,
    atualizadoEm: now
  };
}

function toMirror(p, existing = {}) {
  const now = new Date().toISOString();
  if (p.scenarios && Array.isArray(p.scenarios)) {
    return {
      id: existing.id || randomUUID(),
      nome: String(p.nome || "").trim(),
      method: String(p.method || "GET").trim().toUpperCase(),
      path: String(p.path || "/").trim(),
      active: p.active !== false,
      chaos: p.chaos || null,
      scenarios: p.scenarios,
      criadoEm: existing.criadoEm || now,
      atualizadoEm: now
    };
  }
  return {
    id: existing.id || randomUUID(),
    nome: String(p.nome || "").trim(),
    cenario: String(p.cenario || "").trim(),
    slug: String(p.slug || "").trim(),
    method: String(p.method || "GET").trim().toUpperCase(),
    path: String(p.path || "/").trim(),
    active: p.active !== false,
    chaos: p.chaos || null,
    match: p.match || {},
    responseStatus: Number(p.responseStatus || 200),
    responseBody: p.responseBody || {},
    responseHeaders: p.responseHeaders || {},
    delayMs: Number(p.delayMs || 0),
    validateRequest: p.validateRequest === true,
    requiredFields: p.requiredFields || [],
    requestExample: p.requestExample || {},
    criadoEm: existing.criadoEm || now,
    atualizadoEm: now
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getByPath(source, dottedPath) {
  return String(dottedPath).split(".").filter(Boolean)
    .reduce((cur, part) => (cur && cur[part] !== undefined ? cur[part] : undefined), source);
}

function hasValue(source, dottedPath) {
  const v = getByPath(source, dottedPath);
  return v !== undefined && v !== null && v !== "";
}

function slugify(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function normalize2(value) { return String(value || "").trim().toLowerCase(); }

function filterMassas(massas, query) {
  const q = normalize(query.q), cenario = normalize(query.cenario), status = normalize(query.status);
  return massas.filter(m => {
    const s = [m.nome, m.cenario, m.telefone, m.cpf, m.contrato, m.status, m.fila, m.observacao].join(" ");
    return (!cenario || normalize(m.cenario) === cenario) &&
           (!status || normalize(m.status) === status) &&
           (!q || normalize(s).includes(q));
  });
}

function filterMirrors(mirrors, query) {
  const q = normalize(query.q);
  return mirrors.filter(m => {
    const s = [m.nome, m.cenario, m.slug, m.method, m.path].join(" ");
    return !q || normalize(s).includes(q);
  });
}

function publicUraResponse(massa) {
  if (!massa) return { encontrado: false, codigo: "MASSA_NAO_ENCONTRADA", mensagem: "Nenhuma massa ativa encontrada." };
  return { encontrado: true, codigo: "OK", id: massa.id, nome: massa.nome, cenario: massa.cenario, telefone: massa.telefone, cpf: massa.cpf, contrato: massa.contrato, status: massa.status, fila: massa.fila, observacao: massa.observacao, extra: massa.extra || {} };
}

function applyTemplate(value, req) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, token) => {
      const t = String(token).trim();
      if (t.startsWith("query.")) return getByPath(req.query || {}, t.slice(6)) ?? "";
      if (t.startsWith("body.")) return getByPath(req.body || {}, t.slice(5)) ?? "";
      if (t === "method") return req.method;
      if (t === "path") return req.path;
      if (t === "timestamp") return Date.now().toString();
      if (t === "uuid") return randomUUID();
      return "";
    });
  }
  if (Array.isArray(value)) return value.map(i => applyTemplate(i, req));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyTemplate(v, req)]));
  return value;
}

// ─── CHAOS ENGINE ─────────────────────────────────────────────────────────────
// chaos: { errorRate: 0-100, errorStatus: 500, errorBody: {}, extraDelayMs: 0, jitterMs: 0 }

function applyChaos(chaos) {
  if (!chaos) return null;
  const roll = Math.random() * 100;
  if (roll < (chaos.errorRate || 0)) {
    return {
      status: chaos.errorStatus || 500,
      body: chaos.errorBody || { codigo: "CHAOS_ERROR", mensagem: "Erro injetado pelo MockFlow Chaos Engine." }
    };
  }
  return null;
}

async function chaosDelay(chaos) {
  if (!chaos) return;
  let extra = chaos.extraDelayMs || 0;
  if (chaos.jitterMs) extra += Math.floor(Math.random() * chaos.jitterMs);
  if (extra > 0) await new Promise(r => setTimeout(r, extra));
}

// ─── MIRROR REQUEST HANDLER ───────────────────────────────────────────────────

async function handleMirrorRequest(req, res, next, requestedPath, slug) {
  const startTime = Date.now();
  try {
    const mirrors = await readMirrors();
    const matching = mirrors.filter(item => {
      const slugOk = !slug || normalize(item.slug) === normalize(slug);
      return slugOk && normalize(item.method) === normalize(req.method) && normalize(item.path) === normalize(requestedPath) && item.active;
    });

    if (!matching.length) {
      await appendLog({ id: randomUUID(), ts: new Date().toISOString(), method: req.method, path: requestedPath, status: 404, ms: Date.now() - startTime, scenario: null, chaos: false, error: "API_NAO_ENCONTRADA" });
      return res.status(404).json({ encontrado: false, codigo: "API_ESPELHADA_NAO_ENCONTRADA", mensagem: "Nenhuma API espelhada ativa corresponde ao metodo e path." });
    }

    let selectedScenario = null, selectedMirror = null;

    for (const mirror of matching) {
      const scenarios = mirror.scenarios || [{ nome: mirror.nome || "Cenário Padrão", match: mirror.match || {}, responseStatus: mirror.responseStatus || 200, responseBody: mirror.responseBody || {}, responseHeaders: mirror.responseHeaders || {}, delayMs: mirror.delayMs || 0, validateRequest: mirror.validateRequest || false, requiredFields: mirror.requiredFields || [], requestExample: mirror.requestExample || {} }];
      const sorted = [...scenarios].sort((a, b) => Object.keys(b.match || {}).length - Object.keys(a.match || {}).length);

      for (const scenario of sorted) {
        let matches = true;
        for (const [key, expected] of Object.entries(scenario.match || {})) {
          let actual;
          if (key.startsWith("body.")) actual = getByPath(req.body || {}, key.replace(/^body\./, ""));
          else if (key.startsWith("query.")) actual = getByPath(req.query || {}, key.replace(/^query\./, ""));
          else if (key.startsWith("header.")) actual = req.get(key.replace(/^header\./, ""));
          else actual = getByPath(req.query || {}, key) ?? getByPath(req.body || {}, key);
          if (normalize(actual) !== normalize(expected)) { matches = false; break; }
        }
        if (matches) { selectedScenario = scenario; selectedMirror = mirror; break; }
      }
      if (selectedScenario) break;
    }

    if (!selectedScenario) {
      await appendLog({ id: randomUUID(), ts: new Date().toISOString(), method: req.method, path: requestedPath, status: 404, ms: Date.now() - startTime, scenario: null, chaos: false, error: "CENARIO_NAO_ENCONTRADO" });
      return res.status(404).json({ encontrado: false, codigo: "CENARIO_NAO_ENCONTRADO", mensagem: "Nenhum cenário ativo corresponde aos parametros." });
    }

    // Validação de campos obrigatórios
    if (selectedScenario.validateRequest && selectedScenario.requiredFields) {
      const missing = selectedScenario.requiredFields.filter(f => !hasValue(req.body || {}, f));
      if (missing.length) {
        await appendLog({ id: randomUUID(), ts: new Date().toISOString(), method: req.method, path: requestedPath, status: 400, ms: Date.now() - startTime, scenario: selectedScenario.nome, chaos: false, error: "REQUEST_INVALIDO", missingFields: missing });
        return res.status(400).json({ codigo: "REQUEST_INVALIDO", mensagem: "Request nao possui campos obrigatorios", camposObrigatoriosAusentes: missing });
      }
    }

    // Chaos engine
    const chaosResult = applyChaos(selectedMirror.chaos);
    await chaosDelay(selectedMirror.chaos);

    if (chaosResult) {
      await appendLog({ id: randomUUID(), ts: new Date().toISOString(), method: req.method, path: requestedPath, status: chaosResult.status, ms: Date.now() - startTime, scenario: selectedScenario.nome, chaos: true, mirrorId: selectedMirror.id });
      return res.status(chaosResult.status).json(chaosResult.body);
    }

    // Delay normal
    if (selectedScenario.delayMs) await new Promise(r => setTimeout(r, selectedScenario.delayMs));

    // Headers
    if (selectedScenario.responseHeaders) {
      for (const [k, v] of Object.entries(selectedScenario.responseHeaders)) res.set(k, String(v));
    }

    const ms = Date.now() - startTime;
    await appendLog({ id: randomUUID(), ts: new Date().toISOString(), method: req.method, path: requestedPath, status: selectedScenario.responseStatus, ms, scenario: selectedScenario.nome, chaos: false, mirrorId: selectedMirror.id, mirrorNome: selectedMirror.nome });

    res.status(selectedScenario.responseStatus).json(applyTemplate(selectedScenario.responseBody, req));
  } catch (error) {
    console.error("Erro handleMirrorRequest:", error);
    next(error);
  }
}

// ─── OPENAPI ──────────────────────────────────────────────────────────────────

function schemaFromExample(ex) {
  if (Array.isArray(ex)) return { type: "array", items: schemaFromExample(ex[0] ?? {}) };
  if (ex === null) return { nullable: true };
  if (typeof ex === "object") return { type: "object", additionalProperties: true, properties: Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, schemaFromExample(v)])) };
  if (typeof ex === "number") return { type: Number.isInteger(ex) ? "integer" : "number" };
  if (typeof ex === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function scenariosForOpenApi(mirror) {
  if (Array.isArray(mirror.scenarios) && mirror.scenarios.length) {
    return mirror.scenarios.map((s, i) => ({ id: `${mirror.id}-${i}`, nome: s.nome || mirror.nome, match: s.match || {}, requestExample: s.requestExample || {}, requiredFields: s.requiredFields || [], validateRequest: s.validateRequest === true, responseStatus: Number(s.responseStatus || 200), responseBody: s.responseBody || {}, method: mirror.method, path: mirror.path, tag: mirror.nome || "APIs" }));
  }
  return [{ id: mirror.id, nome: mirror.nome, match: mirror.match || {}, requestExample: mirror.requestExample || {}, requiredFields: mirror.requiredFields || [], validateRequest: mirror.validateRequest === true, responseStatus: Number(mirror.responseStatus || 200), responseBody: mirror.responseBody || {}, method: mirror.method, path: mirror.path, tag: mirror.nome || mirror.slug || "APIs" }];
}

async function buildOpenApiSpec(req) {
  const mirrors = await readMirrors();
  const grouped = new Map();
  for (const m of mirrors.filter(m => m.active)) {
    const key = `${m.method} ${m.path}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(...scenariosForOpenApi(m));
  }
  const paths = {};
  for (const scenarios of grouped.values()) {
    const [first] = scenarios;
    const method = first.method.toLowerCase();
    const examples = Object.fromEntries(scenarios.map(s => [slugify(s.nome || s.id) || s.id, { summary: s.nome, value: s.responseBody }]));
    paths[first.path] = paths[first.path] || {};
    paths[first.path][method] = {
      tags: [first.tag], summary: first.nome,
      description: scenarios.map(s => `- ${s.nome}: match ${JSON.stringify(s.match || {})}, HTTP ${s.responseStatus}`).join("\n"),
      parameters: [...new Map(scenarios.flatMap(s => Object.entries(s.match || {}).filter(([k]) => !k.startsWith("body.")).map(([k, v]) => [k.replace(/^query\./, ""), { name: k.replace(/^query\./, ""), in: "query", required: false, schema: { type: "string" }, example: v }])).map(([k, v]) => [k, v])).values()],
      requestBody: ["post", "put", "patch"].includes(method) ? { required: first.validateRequest, content: { "application/json": { schema: schemaFromExample(first.requestExample || {}), examples: Object.fromEntries(scenarios.filter(s => Object.keys(s.requestExample || {}).length).map(s => [slugify(s.nome), { summary: s.nome, value: s.requestExample }])) } } } : undefined,
      responses: { [String(first.responseStatus || 200)]: { description: "Response espelhado conforme cenario cadastrado.", content: { "application/json": { schema: schemaFromExample(first.responseBody), examples } } }, 404: { description: "Nenhuma API espelhada correspondeu." } }
    };
  }
  return { openapi: "3.0.3", info: { title: "MockFlow URA", version: "1.0.0", description: "Documentacao interativa das APIs simuladas para testes de URA." }, servers: [{ url: `${req.protocol}://${req.get("host")}`, description: "Servidor local" }], paths };
}

// ─── ROUTES: SYSTEM ───────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "mockflow-ura", version: "2.0.0" }));

app.get("/openapi.json", async (req, res, next) => {
  try {
    res.set({ "Cache-Control": "no-store", "Pragma": "no-cache", "Expires": "0" });
    res.json(await buildOpenApiSpec(req));
  } catch (e) { next(e); }
});

// SSE: real-time log stream
app.get("/api/logs/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", ts: new Date().toISOString() })}\n\n`);
  req.on("close", () => sseClients.delete(res));
});

app.get("/api/logs", (_req, res) => res.json(requestLogs));
app.delete("/api/logs", async (_req, res) => {
  requestLogs = [];
  try { await fs.writeFile(LOGS_FILE, "[]\n", "utf8"); } catch {}
  res.status(204).end();
});

// ─── ROUTES: MIRRORS ──────────────────────────────────────────────────────────

app.get("/api/mirrors", async (req, res, next) => {
  try { res.json(filterMirrors(await readMirrors(), req.query)); } catch (e) { next(e); }
});

app.post("/api/mirrors", async (req, res, next) => {
  try {
    const errors = validateMirror(req.body);
    if (errors.length) return res.status(400).json({ errors });
    const mirrors = await readMirrors();
    const mirror = toMirror(req.body);
    mirrors.unshift(mirror);
    await writeMirrors(mirrors);
    res.status(201).json(mirror);
  } catch (e) { next(e); }
});

app.put("/api/mirrors/:id", async (req, res, next) => {
  try {
    const mirrors = await readMirrors();
    const idx = mirrors.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Nao encontrado." });
    const errors = validateMirror(req.body);
    if (errors.length) return res.status(400).json({ errors });
    mirrors[idx] = toMirror(req.body, mirrors[idx]);
    await writeMirrors(mirrors);
    res.json(mirrors[idx]);
  } catch (e) { next(e); }
});

// PATCH: toggle ativo/inativo + chaos sem precisar mandar o mirror completo
app.patch("/api/mirrors/:id", async (req, res, next) => {
  try {
    const mirrors = await readMirrors();
    const idx = mirrors.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Nao encontrado." });
    if (req.body.active !== undefined) mirrors[idx].active = req.body.active;
    if (req.body.chaos !== undefined) mirrors[idx].chaos = req.body.chaos;
    mirrors[idx].atualizadoEm = new Date().toISOString();
    await writeMirrors(mirrors);
    res.json(mirrors[idx]);
  } catch (e) { next(e); }
});

app.delete("/api/mirrors/:id", async (req, res, next) => {
  try {
    const mirrors = await readMirrors();
    const next2 = mirrors.filter(m => m.id !== req.params.id);
    if (next2.length === mirrors.length) return res.status(404).json({ error: "Nao encontrado." });
    await writeMirrors(next2);
    res.status(204).end();
  } catch (e) { next(e); }
});

// ─── ROUTES: MASSAS ───────────────────────────────────────────────────────────

app.get("/api/massas", async (req, res, next) => {
  try { res.json(filterMassas(await readMassas(), req.query)); } catch (e) { next(e); }
});

app.get("/api/massas/:id", async (req, res, next) => {
  try {
    const m = (await readMassas()).find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: "Massa nao encontrada." });
    res.json(m);
  } catch (e) { next(e); }
});

app.post("/api/massas", async (req, res, next) => {
  try {
    const errors = validateMassa(req.body);
    if (errors.length) return res.status(400).json({ errors });
    const massas = await readMassas();
    const massa = toMassa(req.body);
    massas.unshift(massa);
    await writeMassas(massas);
    res.status(201).json(massa);
  } catch (e) { next(e); }
});

app.put("/api/massas/:id", async (req, res, next) => {
  try {
    const massas = await readMassas();
    const idx = massas.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Massa nao encontrada." });
    const errors = validateMassa(req.body);
    if (errors.length) return res.status(400).json({ errors });
    massas[idx] = toMassa(req.body, massas[idx]);
    await writeMassas(massas);
    res.json(massas[idx]);
  } catch (e) { next(e); }
});

app.delete("/api/massas/:id", async (req, res, next) => {
  try {
    const massas = await readMassas();
    const next2 = massas.filter(m => m.id !== req.params.id);
    if (next2.length === massas.length) return res.status(404).json({ error: "Massa nao encontrada." });
    await writeMassas(next2);
    res.status(204).end();
  } catch (e) { next(e); }
});

// ─── ROUTES: URA ──────────────────────────────────────────────────────────────

app.get("/api/ura/consulta", requireUraKey, async (req, res, next) => {
  try {
    const campo = normalize(req.query.campo || "telefone");
    const valor = normalize(req.query.valor);
    if (!valor) return res.status(400).json({ encontrado: false, codigo: "PARAMETRO_INVALIDO", mensagem: "Informe valor para consulta." });
    const allowed = new Set(["telefone", "cpf", "contrato", "cenario", "id"]);
    if (!allowed.has(campo)) return res.status(400).json({ encontrado: false, codigo: "CAMPO_INVALIDO", mensagem: "Campo permitido: telefone, cpf, contrato, cenario ou id." });
    const massas = await readMassas();
    const onlyActive = normalize(req.query.apenasAtiva || "true") !== "false";
    const massa = massas.find(m => normalize(m[campo]) === valor && (!onlyActive || normalize(m.status) === "ativa"));
    res.json(publicUraResponse(massa));
  } catch (e) { next(e); }
});

app.get("/api/ura/telefone/:telefone", requireUraKey, async (req, res, next) => {
  try {
    const massas = await readMassas();
    const massa = massas.find(m => normalize(m.telefone) === normalize(req.params.telefone) && normalize(m.status) === "ativa");
    res.json(publicUraResponse(massa));
  } catch (e) { next(e); }
});

// ─── ROUTES: DOCS ─────────────────────────────────────────────────────────────

app.get("/docs", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MockFlow URA - API Docs</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f0f12; }
    #loading { display: flex; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; color: #a1a1aa; gap: 12px; }
    .spinner { width: 22px; height: 22px; border: 3px solid #2e2e35; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    [role="tab"] { background: #25252b !important; color: #e4e4e7 !important; border-color: #2e2e35 !important; }
    [role="tab"][aria-selected="true"] { background: #6366f1 !important; color: #fff !important; }
    h5 { color: #a1a1aa !important; }
    a { color: #818cf8 !important; }
    code, pre { color: #c4b5fd !important; background: #25252b !important; }
  </style>
</head>
<body>
  <div id="loading"><div class="spinner"></div> Carregando documentação...</div>
  <div id="redoc-container"></div>
  <script src="https://cdn.jsdelivr.net/npm/redoc@2.1.3/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init('/openapi.json', {
      expandResponses: '200', hideDownloadButton: true,
      theme: {
        colors: { primary: { main: '#818cf8' }, text: { primary: '#e4e4e7', secondary: '#a1a1aa' }, http: { get: '#10b981', post: '#818cf8', put: '#f59e0b', delete: '#ef4444', patch: '#f59e0b' } },
        schema: { nestedBackground: '#1a1a1f', typeNameColor: '#c4b5fd', requireLabelColor: '#f87171' },
        typography: { fontSize: '14px', fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif', code: { fontSize: '13px', fontFamily: 'Consolas, Monaco, monospace', backgroundColor: '#25252b', color: '#c4b5fd', wrap: true }, links: { color: '#818cf8' } },
        sidebar: { backgroundColor: '#1a1a1f', textColor: '#e4e4e7', activeTextColor: '#818cf8', width: '220px' },
        rightPanel: { backgroundColor: '#1a1a1f', textColor: '#e4e4e7', width: '40%' },
        codeBlock: { backgroundColor: '#25252b' }
      }
    }, document.getElementById('redoc-container'), () => { document.getElementById('loading').style.display = 'none'; });
  </script>
</body>
</html>`);
});

// ─── MOCK CATCH-ALL ───────────────────────────────────────────────────────────

app.all(["/mock/:slug", "/mock/:slug/*"], requireUraKey, async (req, res, next) => {
  await handleMirrorRequest(req, res, next, `/${req.params[0] || ""}`, req.params.slug);
});

app.all("*", requireUraKey, async (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/docs") || req.path === "/openapi.json") return next();
  await handleMirrorRequest(req, res, next, req.path);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Erro interno no servidor." });
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────

loadLogs().then(() => {
  app.listen(PORT, () => console.log(`MockFlow URA v2.0 em http://localhost:${PORT}`));
});
