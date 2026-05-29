const express = require("express");
const serverless = require("serverless-http");
const fs = require("fs");
const path = require("path");
const swaggerUi = require("swagger-ui-express");

const app = express();
const DATA_FILE = path.join(__dirname, "../../data/apis.json");

app.use(express.json({ limit: "1mb" }));

function readMirrors() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8").replace(/^\uFEFF/, "").trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
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

function buildOpenApiSpec(req) {
  const grouped = new Map();
  for (const mirror of readMirrors().filter((item) => item.active)) {
    const key = `${mirror.method} ${mirror.path}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(...scenariosForOpenApi(mirror));
  }

  const paths = {};
  for (const scenarios of grouped.values()) {
    const first = scenarios[0];
    const method = String(first.method || "GET").toLowerCase();
    const examples = Object.fromEntries(scenarios.map((scenario) => [
      slugify(scenario.nome || scenario.id) || scenario.id,
      { summary: scenario.nome, value: scenario.responseBody }
    ]));
    const requestExamples = Object.fromEntries(scenarios
      .filter((scenario) => Object.keys(scenario.requestExample || {}).length)
      .map((scenario) => [
        slugify(scenario.nome || scenario.id) || scenario.id,
        { summary: scenario.nome, value: scenario.requestExample }
      ]));

    paths[first.path] = paths[first.path] || {};
    paths[first.path][method] = {
      tags: [first.tag],
      summary: first.tag,
      description: scenarios.map((scenario) => `- ${scenario.nome}: HTTP ${scenario.responseStatus}`).join("\n"),
      requestBody: ["post", "put", "patch"].includes(method) ? {
        required: scenarios.some((scenario) => scenario.validateRequest),
        content: {
          "application/json": {
            schema: schemaFromExample(first.requestExample || {}),
            examples: requestExamples
          }
        }
      } : undefined,
      responses: {
        [String(first.responseStatus || 200)]: {
          description: "Response espelhado conforme cenario cadastrado.",
          content: { "application/json": { schema: schemaFromExample(first.responseBody), examples } }
        },
        404: { description: "Nenhum cenario correspondeu ao request." }
      }
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "MockFlow URA",
      version: "1.0.0",
      description: "Documentacao interativa das APIs simuladas para testes de URA."
    },
    servers: [{ url: `${req.protocol}://${req.get("host")}`, description: "Servidor atual" }],
    paths
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "mockflow-ura" });
});

app.get("/api/mirrors", (_req, res) => {
  res.json(readMirrors());
});

app.get("/openapi.json", (req, res) => {
  res.json(buildOpenApiSpec(req));
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
  const mirror = readMirrors().find((item) =>
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
