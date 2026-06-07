require("dotenv").config();
const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const { createClient } = require("@libsql/client");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || process.env.TURSO_DB_URL || "";
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_DB_AUTH_TOKEN || "";

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  throw new Error(
    "Variáveis Turso ausentes. Configure TURSO_DATABASE_URL/TURSO_AUTH_TOKEN ou TURSO_DB_URL/TURSO_DB_AUTH_TOKEN."
  );
}

// ========== CONEXÃO COM TURSO ==========
const turso = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

let dbReady = false;
async function ensureDb() {
  if (dbReady) return;
  await turso.execute(`CREATE TABLE IF NOT EXISTS mirrors (
    id TEXT PRIMARY KEY,
    nome TEXT,
    method TEXT,
    path TEXT,
    active INTEGER,
    chaos TEXT,
    scenarios TEXT,
    criadoEm TEXT,
    atualizadoEm TEXT
  )`);
  await turso.execute(`CREATE TABLE IF NOT EXISTS massas (
    id TEXT PRIMARY KEY,
    nome TEXT,
    cenario TEXT,
    telefone TEXT,
    cpf TEXT,
    contrato TEXT,
    status TEXT,
    fila TEXT,
    observacao TEXT,
    extra TEXT,
    criadoEm TEXT,
    atualizadoEm TEXT
  )`);

  // Correção de migração para bancos existentes com schema antigo
  const mirrorColumns = [
    "nome TEXT",
    "method TEXT",
    "path TEXT",
    "active INTEGER",
    "chaos TEXT",
    "scenarios TEXT",
    "criadoEm TEXT",
    "atualizadoEm TEXT",
    "created_at TEXT",
    "updated_at TEXT"
  ];
  for (const column of mirrorColumns) {
    await turso.execute(`ALTER TABLE mirrors ADD COLUMN ${column}`).catch(() => {});
  }

  const massaColumns = [
    "nome TEXT",
    "cenario TEXT",
    "telefone TEXT",
    "cpf TEXT",
    "contrato TEXT",
    "status TEXT",
    "fila TEXT",
    "observacao TEXT",
    "extra TEXT",
    "criadoEm TEXT",
    "atualizadoEm TEXT",
    "created_at TEXT",
    "updated_at TEXT"
  ];
  for (const column of massaColumns) {
    await turso.execute(`ALTER TABLE massas ADD COLUMN ${column}`).catch(() => {});
  }

  dbReady = true;
}

// ========== FUNÇÕES AUXILIARES ==========

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function getByPath(source, dottedPath) {
  return String(dottedPath)
    .split(".")
    .filter(Boolean)
    .reduce((current, part) => (current && current[part] !== undefined ? current[part] : undefined), source);
}

function hasValue(source, dottedPath) {
  const value = getByPath(source, dottedPath);
  return value !== undefined && value !== null && value !== "";
}

function applyTemplate(value, req) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, token) => {
      const cleaned = String(token).trim();
      if (cleaned.startsWith("query.")) return getByPath(req.query || {}, cleaned.slice(6)) ?? "";
      if (cleaned.startsWith("body.")) return getByPath(req.body || {}, cleaned.slice(5)) ?? "";
      if (cleaned === "method") return req.method;
      if (cleaned === "path") return req.path;
      if (cleaned === "timestamp") return Date.now();
      if (cleaned === "random") return Math.floor(Math.random() * 10000);
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((item) => applyTemplate(item, req));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyTemplate(item, req)]));
  }
  return value;
}

function shouldApplyChaos(mirror) {
  if (!mirror || !mirror.chaos || !mirror.chaos.enabled) return false;
  const rate = Number(mirror.chaos.rate || 0);
  return rate > 0 && Math.random() * 100 < rate;
}

function getChaosDelay(mirror) {
  const jitter = Number(mirror.chaos?.jitter || 0);
  return jitter > 0 ? jitter : 0;
}

function sendChaosResponse(mirror, req, res) {
  if (!shouldApplyChaos(mirror)) return false;

  const status = Number(mirror.chaos.status) || 500;
  const body = mirror.chaos.body || {};
  const delay = getChaosDelay(mirror);

  const send = () => res.status(status).json(body);
  if (delay > 0) {
    setTimeout(send, delay);
  } else {
    send();
  }
  return true;
}

// ========== CRUD MIRRORS ==========

async function readMirrors() {
  await ensureDb();
  const result = await turso.execute("SELECT * FROM mirrors ORDER BY criadoEm DESC");
  return result.rows.map(row => {
    // suporte a schema antigo que armazena o objeto inteiro em `payload_json`
    if (row.payload_json) {
      try {
        const obj = JSON.parse(row.payload_json);
        return {
          id: obj.id || row.id,
          nome: obj.nome || "",
          method: obj.method || "GET",
          path: obj.path || "/",
          active: obj.active === 1 || obj.active === true,
          chaos: obj.chaos || null,
          scenarios: Array.isArray(obj.scenarios) ? obj.scenarios : JSON.parse(obj.scenarios || "[]"),
          criadoEm: obj.criadoEm || row.criadoEm,
          atualizadoEm: obj.atualizadoEm || row.atualizadoEm
        };
      } catch (e) {
        // fallback para row tradicional
      }
    }
    return {
      id: row.id,
      nome: row.nome,
      method: row.method,
      path: row.path,
      active: row.active === 1,
      chaos: row.chaos ? JSON.parse(row.chaos) : null,
      scenarios: JSON.parse(row.scenarios || "[]"),
      criadoEm: row.criadoEm,
      atualizadoEm: row.atualizadoEm
    };
  });
}

async function writeMirrors(mirrors) {
  await ensureDb();
  await turso.execute("DELETE FROM mirrors");
  for (const mirror of mirrors) {
    // Tenta inserção no schema novo; em caso de falha, grava em payload_json (schema antigo)
    try {
      await turso.execute({
        sql: `INSERT INTO mirrors (id, nome, method, path, active, chaos, scenarios, criadoEm, atualizadoEm) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [mirror.id, mirror.nome, mirror.method, mirror.path, mirror.active ? 1 : 0,
            JSON.stringify(mirror.chaos || null), JSON.stringify(mirror.scenarios), mirror.criadoEm, mirror.atualizadoEm]
      });
    } catch (err) {
      const now = new Date().toISOString();
      // fallback attempts: try simple payload_json, then include English timestamp columns
      try {
        await turso.execute({
          sql: `INSERT INTO mirrors (id, payload_json) VALUES (?, ?)` ,
          args: [mirror.id, JSON.stringify(mirror)]
        });
      } catch (e1) {
        try {
          await turso.execute({
            sql: `INSERT INTO mirrors (id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?)` ,
            args: [mirror.id, JSON.stringify(mirror), mirror.criadoEm || now, mirror.atualizadoEm || now]
          });
        } catch (e2) {
          try {
            await turso.execute({
              sql: `INSERT INTO mirrors (id, payload_json, criadoEm, atualizadoEm) VALUES (?, ?, ?, ?)` ,
              args: [mirror.id, JSON.stringify(mirror), mirror.criadoEm || now, mirror.atualizadoEm || now]
            });
          } catch (e3) {
            console.error('writeMirrors failed for mirror', mirror.id, e3);
            throw e3;
          }
        }
      }
    }
  }
}

// ========== CRUD MASSAS ==========

async function readMassas() {
  await ensureDb();
  const result = await turso.execute("SELECT * FROM massas ORDER BY criadoEm DESC");
  return result.rows.map(row => ({
    id: row.id,
    nome: row.nome,
    cenario: row.cenario,
    telefone: row.telefone,
    cpf: row.cpf,
    contrato: row.contrato,
    status: row.status,
    fila: row.fila,
    observacao: row.observacao,
    extra: JSON.parse(row.extra || "{}"),
    criadoEm: row.criadoEm,
    atualizadoEm: row.atualizadoEm
  }));
}

async function writeMassas(massas) {
  await ensureDb();
  await turso.execute("DELETE FROM massas");
  for (const massa of massas) {
    await turso.execute({
      sql: `INSERT INTO massas (id, nome, cenario, telefone, cpf, contrato, status, fila, observacao, extra, criadoEm, atualizadoEm) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [massa.id, massa.nome, massa.cenario, massa.telefone, massa.cpf, massa.contrato, 
              massa.status, massa.fila, massa.observacao, JSON.stringify(massa.extra || {}), 
              massa.criadoEm, massa.atualizadoEm]
    });
  }
}

// ========== VALIDAÇÕES ==========

function validateMirrorPayload(payload) {
  const errors = [];
  if (!String(payload.nome || "").trim()) errors.push("Campo obrigatorio: nome");
  if (!String(payload.path || "").trim()) errors.push("Campo obrigatorio: path");
  if (!String(payload.method || "").trim()) errors.push("Campo obrigatorio: method");
  return errors;
}

function validateMassaPayload(payload) {
  const errors = [];
  const required = ["nome", "cenario", "telefone", "cpf", "status"];
  for (const field of required) {
    if (!String(payload[field] || "").trim()) errors.push(`Campo obrigatorio: ${field}`);
  }
  return errors;
}

function toMirror(payload, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || randomUUID(),
    nome: String(payload.nome || "").trim(),
    method: String(payload.method || "GET").trim().toUpperCase(),
    path: String(payload.path || "/").trim(),
    active: payload.active !== false,
    chaos: payload.chaos || null,
    scenarios: Array.isArray(payload.scenarios) ? payload.scenarios : [],
    criadoEm: existing.criadoEm || now,
    atualizadoEm: now
  };
}

function toMassa(payload, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || randomUUID(),
    nome: String(payload.nome || "").trim(),
    cenario: String(payload.cenario || "").trim(),
    telefone: String(payload.telefone || "").trim(),
    cpf: String(payload.cpf || "").trim(),
    contrato: String(payload.contrato || "").trim(),
    status: String(payload.status || "").trim(),
    fila: String(payload.fila || "").trim(),
    observacao: String(payload.observacao || "").trim(),
    extra: payload.extra || {},
    criadoEm: existing.criadoEm || now,
    atualizadoEm: now
  };
}

function filterMassas(massas, query) {
  const q = normalize(query.q);
  const cenario = normalize(query.cenario);
  const status = normalize(query.status);
  return massas.filter(massa => {
    const matchesScenario = !cenario || normalize(massa.cenario) === cenario;
    const matchesStatus = !status || normalize(massa.status) === status;
    const searchable = [massa.nome, massa.cenario, massa.telefone, massa.cpf, massa.contrato, massa.status, massa.fila, massa.observacao].join(" ");
    const matchesQuery = !q || normalize(searchable).includes(q);
    return matchesScenario && matchesStatus && matchesQuery;
  });
}

function filterMirrors(mirrors, query) {
  const q = normalize(query.q);
  return mirrors.filter(mirror => {
    const searchable = [mirror.nome, mirror.method, mirror.path].join(" ");
    return !q || normalize(searchable).includes(q);
  });
}

function publicUraResponse(massa) {
  if (!massa) {
    return { encontrado: false, codigo: "MASSA_NAO_ENCONTRADA", mensagem: "Nenhuma massa ativa encontrada." };
  }
  return { encontrado: true, ...massa };
}

// ========== ROTAS ==========

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "mockflow-ura" });
});

// Massas
app.get("/api/massas", async (req, res) => {
  const massas = await readMassas();
  res.json(filterMassas(massas, req.query));
});

app.get("/api/massas/:id", async (req, res) => {
  const massas = await readMassas();
  const massa = massas.find(m => m.id === req.params.id);
  if (!massa) return res.status(404).json({ error: "Massa nao encontrada" });
  res.json(massa);
});

app.post("/api/massas", async (req, res) => {
  const errors = validateMassaPayload(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const massas = await readMassas();
  const massa = toMassa(req.body);
  massas.unshift(massa);
  await writeMassas(massas);
  res.status(201).json(massa);
});

app.put("/api/massas/:id", async (req, res) => {
  const massas = await readMassas();
  const index = massas.findIndex(m => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Massa nao encontrada" });
  massas[index] = toMassa(req.body, massas[index]);
  await writeMassas(massas);
  res.json(massas[index]);
});

app.delete("/api/massas/:id", async (req, res) => {
  const massas = await readMassas();
  const filtered = massas.filter(m => m.id !== req.params.id);
  if (filtered.length === massas.length) return res.status(404).json({ error: "Massa nao encontrada" });
  await writeMassas(filtered);
  res.status(204).end();
});

// Mirrors
app.get("/api/mirrors", async (req, res) => {
  const mirrors = await readMirrors();
  res.json(filterMirrors(mirrors, req.query));
});

app.post("/api/mirrors", async (req, res) => {
  const errors = validateMirrorPayload(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const mirrors = await readMirrors();
  const mirror = toMirror(req.body);
  mirrors.unshift(mirror);
  await writeMirrors(mirrors);
  res.status(201).json(mirror);
});

app.put("/api/mirrors/:id", async (req, res) => {
  const mirrors = await readMirrors();
  const index = mirrors.findIndex(item => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "API espelhada nao encontrada" });
  mirrors[index] = toMirror(req.body, mirrors[index]);
  await writeMirrors(mirrors);
  res.json(mirrors[index]);
});

app.delete("/api/mirrors/:id", async (req, res) => {
  const mirrors = await readMirrors();
  const filtered = mirrors.filter(item => item.id !== req.params.id);
  if (filtered.length === mirrors.length) return res.status(404).json({ error: "API espelhada nao encontrada" });
  await writeMirrors(filtered);
  res.status(204).end();
});

// URA Consulta
app.get("/api/ura/consulta", async (req, res) => {
  const campo = normalize(req.query.campo || "telefone");
  const valor = normalize(req.query.valor);
  if (!valor) return res.status(400).json({ encontrado: false, codigo: "PARAMETRO_INVALIDO" });
  const massas = await readMassas();
  const massa = massas.find(item => normalize(item[campo]) === valor && normalize(item.status) === "ativa");
  res.json(publicUraResponse(massa));
});

// Mock endpoints
app.all("*", async (req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/docs") || req.path === "/openapi.json") {
    return res.status(404).json({ error: "Endpoint nao encontrado" });
  }

  const mirrors = await readMirrors();
  const mirror = mirrors.find(m => m.active && normalize(m.method) === normalize(req.method) && normalize(m.path) === normalize(req.path));
  
  if (!mirror) {
    return res.status(404).json({ error: "API espelhada nao encontrada" });
  }
  
  const scenarios = mirror.scenarios || [];
  let selectedScenario = null;
  
  for (const scenario of scenarios) {
    let matches = true;
    for (const [key, expected] of Object.entries(scenario.match || {})) {
      let actual;
      if (key.startsWith("body.")) actual = getByPath(req.body || {}, key.slice(5));
      else if (key.startsWith("query.")) actual = getByPath(req.query || {}, key.slice(6));
      else actual = getByPath(req.query || {}, key) ?? getByPath(req.body || {}, key);
      if (normalize(actual) !== normalize(expected)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      selectedScenario = scenario;
      break;
    }
  }
  
  if (!selectedScenario && scenarios.length > 0) selectedScenario = scenarios[0];
  if (!selectedScenario) return res.status(404).json({ error: "Nenhum cenário configurado" });
  
  if (selectedScenario.validateRequest && selectedScenario.requiredFields) {
    const missing = selectedScenario.requiredFields.filter(field => !hasValue(req.body || {}, field));
    if (missing.length) {
      return res.status(400).json({ error: "Campos obrigatórios ausentes", missing_fields: missing });
    }
  }

  if (sendChaosResponse(mirror, req, res)) {
    return;
  }
  
  if (selectedScenario.delayMs) {
    setTimeout(() => {
      res.status(selectedScenario.responseStatus || 200).json(applyTemplate(selectedScenario.responseBody || {}, req));
    }, selectedScenario.delayMs);
  } else {
    res.status(selectedScenario.responseStatus || 200).json(applyTemplate(selectedScenario.responseBody || {}, req));
  }
});

// Swagger/Redoc
app.get("/docs", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>MockFlow URA - API Docs</title>
<style>body{margin:0;background:#0f0f12;}</style>
</head>
<body>
<div id="redoc-container"></div>
<script src="https://cdn.jsdelivr.net/npm/redoc@2.1.3/bundles/redoc.standalone.js"></script>
<script>
Redoc.init('/openapi.json', {theme:{colors:{primary:{main:'#6366f1'}}}}, document.getElementById('redoc-container'));
</script>
</body>
</html>`);
});

app.get("/openapi.json", async (req, res) => {
  const mirrors = await readMirrors();
  const paths = {};
  mirrors.forEach(api => {
    if (!api.active) return;
    const path = api.path;
    const method = api.method.toLowerCase();
    if (!paths[path]) paths[path] = {};
    paths[path][method] = { summary: api.nome, responses: { 200: { description: "Sucesso" } } };
  });
  res.json({ openapi: "3.0.0", info: { title: "MockFlow URA", version: "1.0.0" }, paths });
});

module.exports = app;