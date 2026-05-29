const express = require("express");
const serverless = require("serverless-http");
const fs = require("fs");
const path = require("path");
const swaggerUi = require("swagger-ui-express");
const { randomUUID } = require("crypto");
const { getStore } = require("@netlify/blobs");

const app = express();
const DATA_FILE = path.join(__dirname, "../../data/apis.json");
const RUNTIME_FILE = path.join("/tmp", "mockflow-apis.json");

app.use(express.json({ limit: "1mb" }));

function readSeedMirrors() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8").replace(/^\uFEFF/, "").trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function readRuntimeMirrors() {
  try {
    const file = fs.existsSync(RUNTIME_FILE) ? RUNTIME_FILE : DATA_FILE;
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return readSeedMirrors();
  }
}

function writeRuntimeMirrors(mirrors) {
  fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify(mirrors, null, 2)}\n`, "utf8");
}

async function readMirrors() {
  try {
    const store = getStore({ name: "mockflow-ura", consistency: "strong" });
    const mirrors = await store.get("apis", { type: "json", consistency: "strong" });
    return Array.isArray(mirrors) ? mirrors : readSeedMirrors();
  } catch {
    return readRuntimeMirrors();
  }
}

async function writeMirrors(mirrors) {
  try {
    const store = getStore({ name: "mockflow-ura", consistency: "strong" });
    await store.setJSON("apis", mirrors);
  } catch {
    writeRuntimeMirrors(mirrors);
  }
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
  if (payload.scenarios !== undefined && !Array.isArray(payload.scenarios)) {
    errors.push("Scenarios deve ser um array.");
  }
  return errors;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function slugify(value) {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
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
      return "";
    });
  }

  if (Array.isArray(value)) return value.map((item) => applyTemplate(item, req));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyTemplate(item, req)]));
  }

  return value;
}

function scenarioList(mirror) {
  if (Array.isArray(mirror.scenarios) && mirror.scenarios.length) return mirror.scenarios;
  return [{
    nome: mirror.nome,
    match: mirror.match || {},
    responseStatus: mirror.responseStatus || 200,
    responseBody: mirror.responseBody || {},
    delayMs: mirror.delayMs || 0,
    validateRequest: mirror.validateRequest === true,
    requiredFields: mirror.requiredFields || [],
    requestExample: mirror.requestExample || {}
  }];
}

function scenarioMatches(scenario, req) {
  for (const [key, expected] of Object.entries(scenario.match || {})) {
    let actual;
    if (key.startsWith("body.")) actual = getByPath(req.body || {}, key.slice(5));
    else if (key.startsWith("query.")) actual = getByPath(req.query || {}, key.slice(6));
    else if (key.startsWith("header.")) actual = req.get(key.slice(7));
    else actual = getByPath(req.query || {}, key) ?? getByPath(req.body || {}, key);
    if (normalize(actual) !== normalize(expected)) return false;
  }
  return true;
}

function selectScenario(mirror, req) {
  return [...scenarioList(mirror)]
    .sort((a, b) => Object.keys(b.match || {}).length - Object.keys(a.match || {}).length)
    .find((scenario) => scenarioMatches(scenario, req));
}

function schemaFromExample(example) {
  if (Array.isArray(example)) return { type: "array", items: schemaFromExample(example[0] ?? {}) };
  if (example === null) return { nullable: true };
  if (typeof example === "object") {
    return {
      type: "object",
      additionalProperties: true,
      properties: Object.fromEntries(Object.entries(example || {}).map(([key, value]) => [key, schemaFromExample(value)]))
    };
  }
  if (typeof example === "number") return { type: Number.isInteger(example) ? "integer" : "number" };
  if (typeof example === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function scenariosForOpenApi(mirror) {
  return scenarioList(mirror).map((scenario, index) => ({
    id: `${mirror.id || mirror.path}-${index}`,
    nome: scenario.nome || mirror.nome,
    match: scenario.match || {},
    requestExample: scenario.requestExample || {},
    requiredFields: scenario.requiredFields || [],
    validateRequest: scenario.validateRequest === true,
    responseStatus: Number(scenario.responseStatus || 200),
    responseBody: scenario.responseBody || {},
    method: mirror.method,
    path: mirror.path,
    tag: mirror.nome || "APIs"
  }));
}

async function buildOpenApiSpec(req) {
  const grouped = new Map();
  
  for (const mirror of (await readMirrors()).filter((item) => item.active)) {
    const key = `${mirror.method} ${mirror.path}`;
    if (!grouped.has(key)) grouped.set(key, []);
    
    const scenarios = scenarioList(mirror);
    scenarios.forEach((scenario, idx) => {
      grouped.get(key).push({
        id: `${mirror.id || mirror.path}-${idx}`,
        nome: scenario.nome || mirror.nome,
        match: scenario.match || {},
        requestExample: scenario.requestExample || {},
        requiredFields: scenario.requiredFields || [],
        validateRequest: scenario.validateRequest === true,
        responseStatus: Number(scenario.responseStatus || 200),
        responseBody: scenario.responseBody || {},
        method: mirror.method,
        path: mirror.path,
        tag: mirror.nome || "APIs"
      });
    });
  }

  const paths = {};
  for (const scenarios of grouped.values()) {
    const first = scenarios[0];
    const method = String(first.method || "GET").toLowerCase();
    
    // Cria exemplos de request para cada cenário
    const requestExamples = {};
    const responseExamples = {};
    
    scenarios.forEach(scenario => {
      const nome = scenario.nome || 'Cenário';
      
      if (scenario.requestExample && Object.keys(scenario.requestExample).length > 0) {
        requestExamples[slugify(nome)] = {
          summary: nome,
          value: scenario.requestExample
        };
      }
      
      if (scenario.responseBody && Object.keys(scenario.responseBody).length > 0) {
        responseExamples[slugify(nome)] = {
          summary: nome,
          value: scenario.responseBody
        };
      }
    });
    
    // Se não tem requestExample, tenta gerar do match
    if (Object.keys(requestExamples).length === 0 && scenarios[0].match) {
      const matchExample = {};
      for (const [key, value] of Object.entries(scenarios[0].match)) {
        if (key.startsWith("body.")) {
          matchExample[key.replace("body.", "")] = value;
        }
      }
      if (Object.keys(matchExample).length > 0) {
        requestExamples["exemplo_match"] = {
          summary: "Exemplo baseado no match",
          value: matchExample
        };
      }
    }
    
    // Monta o requestBody
    let requestBody = undefined;
    if (method === 'post' || method === 'put' || method === 'patch') {
      requestBody = {
        required: scenarios.some(s => s.validateRequest),
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {}
            }
          }
        }
      };
      
      if (Object.keys(requestExamples).length > 0) {
        requestBody.content["application/json"].examples = requestExamples;
      }
    }
    
    // Monta as responses
    const responses = {
      200: {
        description: "Sucesso",
        content: {
          "application/json": {
            schema: { type: "object" }
          }
        }
      },
      400: { description: "Request inválido - campos obrigatórios ausentes" },
      404: { description: "API ou cenário não encontrado" }
    };
    
    if (Object.keys(responseExamples).length > 0) {
      responses[200].content["application/json"].examples = responseExamples;
    }
    
    // Descrição dos cenários
    let description = `**API:** ${first.tag}\n\n`;
    description += `**Cenários disponíveis:**\n`;
    scenarios.forEach(scenario => {
      const matchStr = scenario.match && Object.keys(scenario.match).length > 0 
        ? JSON.stringify(scenario.match) 
        : "fallback (qualquer request)";
      description += `- **${scenario.nome}**: match ${matchStr} → HTTP ${scenario.responseStatus}\n`;
    });
    
    paths[first.path] = paths[first.path] || {};
    paths[first.path][method] = {
      tags: [first.tag],
      summary: first.tag,
      description: description,
      requestBody: requestBody,
      responses: responses
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "MockFlow URA",
      version: "1.0.0",
      description: "Documentacao interativa das APIs simuladas para testes de URA."
    },
    servers: [
      { 
        url: `${req.protocol}://${req.get("host")}`, 
        description: "Servidor atual" 
      }
    ],
    paths
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "mockflow-ura" });
});

app.get("/api/mirrors", async (_req, res) => {
  res.json(await readMirrors());
});

app.post("/api/mirrors", async (req, res) => {
  const errors = validateMirrorPayload(req.body || {});
  if (errors.length) {
    res.status(400).json({ errors });
    return;
  }

  const mirrors = await readMirrors();
  const mirror = toMirror(req.body);
  mirrors.unshift(mirror);
  await writeMirrors(mirrors);
  res.status(201).json(mirror);
});

app.put("/api/mirrors/:id", async (req, res) => {
  const errors = validateMirrorPayload(req.body || {});
  if (errors.length) {
    res.status(400).json({ errors });
    return;
  }

  const mirrors = await readMirrors();
  const index = mirrors.findIndex((item) => item.id === req.params.id);
  if (index === -1) {
    res.status(404).json({ error: "API espelhada nao encontrada." });
    return;
  }

  mirrors[index] = toMirror(req.body, mirrors[index]);
  await writeMirrors(mirrors);
  res.json(mirrors[index]);
});

app.delete("/api/mirrors/:id", async (_req, res) => {
  const mirrors = await readMirrors();
  const nextMirrors = mirrors.filter((item) => item.id !== _req.params.id);
  if (nextMirrors.length === mirrors.length) {
    res.status(404).json({ error: "API espelhada nao encontrada." });
    return;
  }

  await writeMirrors(nextMirrors);
  res.status(204).end();
});

app.get("/openapi.json", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.json(await buildOpenApiSpec(req));
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(null, {
  swaggerOptions: {
    url: "/openapi.json",
    persistAuthorization: true,
    displayRequestDuration: true
  },
  customSiteTitle: "MockFlow URA - Swagger"
}));

app.all("*", async (req, res) => {
  const mirror = (await readMirrors()).find((item) =>
    item.active && normalize(item.method) === normalize(req.method) && normalize(item.path) === normalize(req.path)
  );

  if (!mirror) {
    res.status(404).json({ codigo: "API_ESPELHADA_NAO_ENCONTRADA" });
    return;
  }

  const scenario = selectScenario(mirror, req);
  if (!scenario) {
    res.status(404).json({ codigo: "CENARIO_NAO_ENCONTRADO" });
    return;
  }

  const missing = scenario.validateRequest
    ? (scenario.requiredFields || []).filter((field) => !hasValue(req.body || {}, field))
    : [];
  if (missing.length) {
    res.status(400).json({
      codigo: "REQUEST_INVALIDO",
      mensagem: "Request nao possui campos obrigatorios",
      camposObrigatoriosAusentes: missing
    });
    return;
  }

  if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
  res.status(Number(scenario.responseStatus || 200)).json(applyTemplate(scenario.responseBody || {}, req));
});

exports.handler = serverless(app);
