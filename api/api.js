const express = require("express");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ========== DADOS EM MEMÓRIA ==========
// Como o Vercel tem sistema de arquivos read-only, usamos memória
// Para persistência real, você precisaria de um banco de dados (Turso, Neon, etc)

let inMemoryMirrors = [];
let inMemoryMassas = [];

// Funções de persistência (memória)
async function readMirrors() { return inMemoryMirrors; }
async function writeMirrors(mirrors) { inMemoryMirrors = mirrors; return true; }
async function readMassas() { return inMemoryMassas; }
async function writeMassas(massas) { inMemoryMassas = massas; return true; }

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

function toMirror(payload, existing = {}) {
  const now = new Date().toISOString();
  const pathValue = String(payload.path || "/").trim();
  return {
    id: existing.id || randomUUID(),
    nome: String(payload.nome || "").trim(),
    method: String(payload.method || "GET").trim().toUpperCase(),
    path: pathValue.startsWith("/") ? pathValue : `/${pathValue}`,
    active: payload.active !== false,
    chaos: payload.chaos || null,
    scenarios: Array.isArray(payload.scenarios) ? payload.scenarios : [],
    criadoEm: existing.criadoEm || now,
    atualizadoEm: now
  };
}

function validateMirrorPayload(payload) {
  const errors = [];
  if (!String(payload.nome || "").trim()) errors.push("Campo obrigatorio: nome");
  if (!String(payload.path || "").trim()) errors.push("Campo obrigatorio: path");
  if (!String(payload.method || "").trim()) errors.push("Campo obrigatorio: method");
  return errors;
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

function validateMassa(payload) {
  const errors = [];
  const required = ["nome", "cenario", "telefone", "cpf", "status"];
  for (const field of required) {
    if (!String(payload[field] || "").trim()) {
      errors.push(`Campo obrigatorio: ${field}`);
    }
  }
  return errors;
}

function filterMassas(massas, query) {
  const q = normalize(query.q);
  const cenario = normalize(query.cenario);
  const status = normalize(query.status);
  return massas.filter((massa) => {
    const matchesScenario = !cenario || normalize(massa.cenario) === cenario;
    const matchesStatus = !status || normalize(massa.status) === status;
    const searchable = [massa.nome, massa.cenario, massa.telefone, massa.cpf, massa.contrato, massa.status, massa.fila, massa.observacao].join(" ");
    const matchesQuery = !q || normalize(searchable).includes(q);
    return matchesScenario && matchesStatus && matchesQuery;
  });
}

function filterMirrors(mirrors, query) {
  const q = normalize(query.q);
  return mirrors.filter((mirror) => {
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
  const errors = validateMassa(req.body);
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

// Mirrors (APIs Espelhadas)
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
app.all("*", async (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "Endpoint nao encontrado" });
  }
  if (req.path.startsWith("/docs") || req.path === "/openapi.json") {
    return next();
  }
  
  const mirrors = await readMirrors();
  const mirror = mirrors.find(m => m.active && normalize(m.method) === normalize(req.method) && normalize(m.path) === normalize(req.path));
  
  if (!mirror) {
    return res.status(404).json({ error: "API espelhada nao encontrada", path: req.path, method: req.method });
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