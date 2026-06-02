const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const { createClient } = require("@libsql/client");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";

// ─── TURSO CLIENT ─────────────────────────────────────────────────────────────
// Variáveis de ambiente necessárias na Vercel:
//   TURSO_DATABASE_URL  → ex: libsql://seu-banco.turso.io
//   TURSO_AUTH_TOKEN    → token gerado no dashboard do Turso

let _db = null;
function getDb() {
  if (!_db) {
    _db = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _db;
}

async function dbRun(sql, args = []) {
  const result = await getDb().execute({ sql, args });
  // rowsAffected pode ser undefined em algumas versões do @libsql/client
  return { changes: result.rowsAffected ?? result.changes ?? 1 };
}

async function dbGet(sql, args = []) {
  const result = await getDb().execute({ sql, args });
  if (!result.rows.length) return undefined;
  const columns = result.columns.map(c => (typeof c === "object" ? c.name : c));
  return rowToObj(columns, result.rows[0]);
}

async function dbAll(sql, args = []) {
  const result = await getDb().execute({ sql, args });
  const columns = result.columns.map(c => (typeof c === "object" ? c.name : c));
  return result.rows.map(r => rowToObj(columns, r));
}

function rowToObj(columns, row) {
  // @libsql/client pode retornar row como array ou como objeto dependendo da versão
  if (!Array.isArray(row)) return row;
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

// ─── INIT DB ──────────────────────────────────────────────────────────────────

let _dbReady = null;
async function initDatabase() {
  // Na Vercel serverless cada invocação pode ser nova instância — mas dentro da mesma
  // invocação o cache evita re-criar as tabelas desnecessariamente
  if (_dbReady) return _dbReady;
  _dbReady = (async () => {
    await getDb().executeMultiple(`
      CREATE TABLE IF NOT EXISTS mirrors (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS massas (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  })();
  return _dbReady;
}

// ─── MIRRORS ──────────────────────────────────────────────────────────────────

async function readMirrors() {
  await initDatabase();
  const rows = await dbAll("SELECT payload_json FROM mirrors ORDER BY created_at DESC");
  return rows.map(r => JSON.parse(r.payload_json));
}

async function writeMirror(mirror) {
  await initDatabase();
  const now = new Date().toISOString();
  const existing = await dbGet("SELECT id FROM mirrors WHERE id = ?", [mirror.id]);
  if (existing) {
    await dbRun("UPDATE mirrors SET payload_json = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(mirror), now, mirror.id]);
  } else {
    await dbRun("INSERT INTO mirrors (id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [mirror.id, JSON.stringify(mirror), now, now]);
  }
}

async function deleteMirrorById(id) {
  await initDatabase();
  // Verifica se existe antes de deletar para dar 404 correto
  const exists = await dbGet("SELECT id FROM mirrors WHERE id = ?", [id]);
  if (!exists) return false;
  await dbRun("DELETE FROM mirrors WHERE id = ?", [id]);
  return true;
}

// ─── MASSAS ───────────────────────────────────────────────────────────────────

async function readMassas() {
  await initDatabase();
  const rows = await dbAll("SELECT payload_json FROM massas ORDER BY created_at DESC");
  return rows.map(r => JSON.parse(r.payload_json));
}

async function writeMassa(massa) {
  await initDatabase();
  const now = new Date().toISOString();
  const existing = await dbGet("SELECT id FROM massas WHERE id = ?", [massa.id]);
  if (existing) {
    await dbRun("UPDATE massas SET payload_json = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(massa), now, massa.id]);
  } else {
    await dbRun("INSERT INTO massas (id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [massa.id, JSON.stringify(massa), now, now]);
  }
}

async function deleteMassaById(id) {
  await initDatabase();
  const exists = await dbGet("SELECT id FROM massas WHERE id = ?", [id]);
  if (!exists) return false;
  await dbRun("DELETE FROM massas WHERE id = ?", [id]);
  return true;
}

// ─── LOGS ─────────────────────────────────────────────────────────────────────

const MAX_LOGS = 200;
let requestLogs = []; // cache em memória para a sessão atual

async function appendLog(entry) {
  requestLogs.unshift(entry);
  if (requestLogs.length > MAX_LOGS) requestLogs = requestLogs.slice(0, MAX_LOGS);
  try {
    await initDatabase();
    await dbRun("INSERT INTO logs (payload_json, created_at) VALUES (?, ?)",
      [JSON.stringify(entry), new Date().toISOString()]);
    // Manter apenas os últimos MAX_LOGS no banco
    await dbRun(`DELETE FROM logs WHERE id NOT IN (
      SELECT id FROM logs ORDER BY id DESC LIMIT ${MAX_LOGS}
    )`);
  } catch {}
}

async function loadLogsFromDb() {
  try {
    await initDatabase();
    const rows = await dbAll(`SELECT payload_json FROM logs ORDER BY id DESC LIMIT ${MAX_LOGS}`);
    requestLogs = rows.map(r => JSON.parse(r.payload_json));
  } catch {
    requestLogs = [];
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
    atualizadoEm: now,
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
      atualizadoEm: now,
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
    atualizadoEm: now,
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

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

function applyChaos(chaos) {
  if (!chaos) return null;
  const roll = Math.random() * 100;
  if (roll < (chaos.errorRate || 0)) {
    return {
      status: chaos.errorStatus || 500,
      body: chaos.errorBody || { codigo: "CHAOS_ERROR", mensagem: "Erro injetado pelo MockFlow Chaos Engine." },
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

    if (selectedScenario.validateRequest && selectedScenario.requiredFields) {
      const missing = selectedScenario.requiredFields.filter(f => !hasValue(req.body || {}, f));
      if (missing.length) {
        await appendLog({ id: randomUUID(), ts: new Date().toISOString(), method: req.method, path: requestedPath, status: 400, ms: Date.now() - startTime, scenario: selectedScenario.nome, chaos: false, error: "REQUEST_INVALIDO", missingFields: missing });
        return res.status(400).json({ codigo: "REQUEST_INVALIDO", mensagem: "Request nao possui campos obrigatorios", camposObrigatoriosAusentes: missing });
      }
    }

    const chaosResult = applyChaos(selectedMirror.chaos);
    await chaosDelay(selectedMirror.chaos);

    if (chaosResult) {
      await appendLog({ id: randomUUID(), ts: new Date().toISOString(), method: req.method, path: requestedPath, status: chaosResult.status, ms: Date.now() - startTime, scenario: selectedScenario.nome, chaos: true, mirrorId: selectedMirror.id });
      return res.status(chaosResult.status).json(chaosResult.body);
    }

    if (selectedScenario.delayMs) await new Promise(r => setTimeout(r, selectedScenario.delayMs));

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
      responses: { [String(first.responseStatus || 200)]: { description: "Response espelhado conforme cenario cadastrado.", content: { "application/json": { schema: schemaFromExample(first.responseBody), examples } } }, 404: { description: "Nenhuma API espelhada correspondeu." } },
    };
  }
  return { openapi: "3.0.3", info: { title: "MockFlow URA", version: "1.0.0", description: "Documentacao interativa das APIs simuladas para testes de URA." }, servers: [{ url: `${req.protocol}://${req.get("host")}`, description: "Servidor atual" }], paths };
}

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── ROUTES: SYSTEM ───────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "mockflow-ura", version: "2.0.0" }));

app.get("/openapi.json", async (req, res, next) => {
  try {
    res.set({ "Cache-Control": "no-store", "Pragma": "no-cache", "Expires": "0" });
    res.json(await buildOpenApiSpec(req));
  } catch (e) { next(e); }
});

// SSE não funciona na Vercel (funções serverless têm timeout).
// Substituído por polling: retorna os logs mais recentes como JSON.
app.get("/api/logs/stream", async (_req, res) => {
  await loadLogsFromDb();
  res.json(requestLogs);
});

app.get("/api/logs", (_req, res) => res.json(requestLogs));

app.delete("/api/logs", async (_req, res) => {
  requestLogs = [];
  try {
    await initDatabase();
    await dbRun("DELETE FROM logs");
  } catch {}
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
    const mirror = toMirror(req.body);
    await writeMirror(mirror);
    res.status(201).json(mirror);
  } catch (e) { next(e); }
});

app.put("/api/mirrors/:id", async (req, res, next) => {
  try {
    const mirrors = await readMirrors();
    const existing = mirrors.find(m => m.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Nao encontrado." });
    const errors = validateMirror(req.body);
    if (errors.length) return res.status(400).json({ errors });
    const updated = toMirror(req.body, existing);
    await writeMirror(updated);
    res.json(updated);
  } catch (e) { next(e); }
});

app.patch("/api/mirrors/:id", async (req, res, next) => {
  try {
    const mirrors = await readMirrors();
    const existing = mirrors.find(m => m.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Nao encontrado." });
    if (req.body.active !== undefined) existing.active = req.body.active;
    if (req.body.chaos !== undefined) existing.chaos = req.body.chaos;
    existing.atualizadoEm = new Date().toISOString();
    await writeMirror(existing);
    res.json(existing);
  } catch (e) { next(e); }
});

app.delete("/api/mirrors/:id", async (req, res, next) => {
  try {
    const deleted = await deleteMirrorById(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Nao encontrado." });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ─── ROUTES: MASSAS ───────────────────────────────────────────────────────────

app.get("/api/massas", async (req, res, next) => {
  try { res.json(filterMassas(await readMassas(), req.query)); } catch (e) { next(e); }
});

app.get("/api/massas/:id", async (req, res, next) => {
  try {
    const massas = await readMassas();
    const m = massas.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: "Massa nao encontrada." });
    res.json(m);
  } catch (e) { next(e); }
});

app.post("/api/massas", async (req, res, next) => {
  try {
    const errors = validateMassa(req.body);
    if (errors.length) return res.status(400).json({ errors });
    const massa = toMassa(req.body);
    await writeMassa(massa);
    res.status(201).json(massa);
  } catch (e) { next(e); }
});

app.put("/api/massas/:id", async (req, res, next) => {
  try {
    const massas = await readMassas();
    const existing = massas.find(m => m.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Massa nao encontrada." });
    const errors = validateMassa(req.body);
    if (errors.length) return res.status(400).json({ errors });
    const updated = toMassa(req.body, existing);
    await writeMassa(updated);
    res.json(updated);
  } catch (e) { next(e); }
});

app.delete("/api/massas/:id", async (req, res, next) => {
  try {
    const deleted = await deleteMassaById(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Massa nao encontrada." });
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
        colors: { primary: { main: '#818cf8' } },
        typography: { fontSize: '14px', fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif' },
        sidebar: { backgroundColor: '#1a1a1f', textColor: '#e4e4e7', activeTextColor: '#818cf8', width: '220px' }
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
  console.error("[MockFlow Error]", error?.message || error);
  res.status(500).json({ error: "Erro interno no servidor.", detalhe: error?.message });
});

// ─── EXPORT para Vercel (sem app.listen) ──────────────────────────────────────
module.exports = app;

// Inicialização local (ignorado na Vercel)
if (process.env.NODE_ENV !== "production" || process.env.LOCAL_DEV) {
  initDatabase().then(() => loadLogsFromDb()).then(() => {
    app.listen(PORT, () => console.log(`MockFlow URA v2.0 em http://localhost:${PORT}`));
  });
}