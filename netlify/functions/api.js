const express = require("express");
const serverless = require("serverless-http");
const fs = require("fs");
const path = require("path");
const swaggerUi = require("swagger-ui-express");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Caminho dos arquivos
const DATA_DIR = "/tmp/data";
const MIRRORS_FILE = path.join(DATA_DIR, "apis.json");

// Garantir que a pasta existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Funções auxiliares
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

// Leitura e escrita dos arquivos
function readMirrors() {
  try {
    if (!fs.existsSync(MIRRORS_FILE)) {
      fs.writeFileSync(MIRRORS_FILE, JSON.stringify([], null, 2));
      return [];
    }
    const raw = fs.readFileSync(MIRRORS_FILE, "utf8");
    const cleanJson = raw.replace(/^\uFEFF/, "").replace(/^ï»¿/, "").trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error("Erro ao ler mirrors:", error);
    return [];
  }
}

function writeMirrors(mirrors) {
  fs.writeFileSync(MIRRORS_FILE, JSON.stringify(mirrors, null, 2));
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
  return errors;
}

// ========== ROTAS ==========

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "mockflow-ura" });
});

app.get("/api/mirrors", (_req, res) => {
  res.json(readMirrors());
});

app.post("/api/mirrors", (req, res) => {
  const errors = validateMirrorPayload(req.body);
  if (errors.length) {
    res.status(400).json({ errors });
    return;
  }
  const mirrors = readMirrors();
  const mirror = toMirror(req.body);
  mirrors.unshift(mirror);
  writeMirrors(mirrors);
  res.status(201).json(mirror);
});

app.put("/api/mirrors/:id", (req, res) => {
  const mirrors = readMirrors();
  const index = mirrors.findIndex(item => item.id === req.params.id);
  if (index === -1) {
    res.status(404).json({ error: "API espelhada nao encontrada" });
    return;
  }
  mirrors[index] = toMirror(req.body, mirrors[index]);
  writeMirrors(mirrors);
  res.json(mirrors[index]);
});

app.delete("/api/mirrors/:id", (req, res) => {
  const mirrors = readMirrors();
  const filtered = mirrors.filter(item => item.id !== req.params.id);
  if (filtered.length === mirrors.length) {
    res.status(404).json({ error: "API espelhada nao encontrada" });
    return;
  }
  writeMirrors(filtered);
  res.status(204).end();
});

// ========== REDOC (SWAGGER MODERNIZADO) ==========

// HTML do Redoc
const redocHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>MockFlow URA - Documentação da API</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        }
        .redoc-wrap {
            height: 100vh;
        }
    </style>
</head>
<body>
    <redoc spec-url='/openapi.json' 
           expand-responses="200,201"
           expand-single-schema-field="true"
           hide-download-button="false"
           hide-hostname="false"
           native-scrollbars="true"
           no-auto-auth="false"
           path-in-middle-panel="true"
           required-props-first="true"
           scroll-y-offset="70"
           show-curl="true"
           show-request-body="true"
           show-request-headers="true"
           show-responses-in-middle-panel="true"
           theme='{"colors":{"primary":{"main":"#6366f1"}},"typography":{"fontSize":"14px","fontFamily":"-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"},"sidebar":{"backgroundColor":"#1a1a1f","textColor":"#e4e4e7","activeTextColor":"#6366f1","groupTextColor":"#a1a1aa"}}'>
    </redoc>
    <script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
</body>
</html>
`;

function generateSwaggerDoc(req) {
  const mirrors = readMirrors();
  const paths = {};
  
  mirrors.forEach(api => {
    if (!api.active) return;
    
    const path = api.path;
    const method = api.method.toLowerCase();
    
    if (!paths[path]) paths[path] = {};
    
    const scenarios = api.scenarios && api.scenarios.length > 0 ? api.scenarios : [];
    
    // Cria exemplos
    const examples = {};
    const requestExamples = {};
    
    scenarios.forEach((scenario, idx) => {
      const name = scenario.nome || `Cenário ${idx + 1}`;
      
      if (scenario.responseBody && Object.keys(scenario.responseBody).length > 0) {
        examples[name] = {
          summary: name,
          value: scenario.responseBody
        };
      }
      
      if (scenario.requestExample && Object.keys(scenario.requestExample).length > 0) {
        requestExamples[name] = {
          summary: name,
          value: scenario.requestExample
        };
      }
    });
    
    // Se não tem exemplos, adiciona um padrão
    if (Object.keys(examples).length === 0) {
      examples["Resposta padrão"] = {
        summary: "Resposta padrão",
        value: { mensagem: "sucesso" }
      };
    }
    
    // Configuração do endpoint
    const endpointConfig = {
      summary: api.nome,
      description: scenarios.map(s => `- ${s.nome || 'Cenário'}: ${s.match && Object.keys(s.match).length ? JSON.stringify(s.match) : 'fallback'}`).join('\n'),
      responses: {
        200: {
          description: "Sucesso",
          content: {
            "application/json": {
              examples: examples
            }
          }
        },
        400: {
          description: "Requisição inválida - campos obrigatórios ausentes"
        },
        404: {
          description: "API ou cenário não encontrado"
        }
      }
    };
    
    // Adiciona request body para POST/PUT/PATCH
    if (method === 'post' || method === 'put' || method === 'patch') {
      endpointConfig.requestBody = {
        required: true,
        content: {
          "application/json": {
            examples: requestExamples
          }
        }
      };
    }
    
    paths[path][method] = endpointConfig;
  });
  
  // Adiciona rota de health check
  if (!paths["/api/health"]) {
    paths["/api/health"] = {
      get: {
        summary: "Health Check",
        responses: {
          200: {
            description: "Servidor online",
            content: {
              "application/json": {
                example: { ok: true, service: "mockflow-ura" }
              }
            }
          }
        }
      }
    };
  }
  
  return {
    openapi: "3.0.0",
    info: {
      title: "MockFlow URA",
      version: "1.0.0",
      description: "Sistema de simulação de API para NICE CXone",
      contact: {
        name: "MockFlow URA"
      }
    },
    servers: [
      {
        url: `https://${req.get("host")}`,
        description: "Servidor atual"
      }
    ],
    paths: paths
  };
}

// Rota para o Redoc
app.get("/docs", (req, res) => {
    res.send(redocHTML);
});

app.get("/openapi.json", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.json(generateSwaggerDoc(req));
});

// Swagger UI
app.use("/docs", swaggerUi.serve, swaggerUi.setup(null, {
  swaggerOptions: {
    url: "/openapi.json",
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: "list",
    filter: true,
    showExtensions: true,
    showCommonExtensions: true,
    tryItOutEnabled: true
  },
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "MockFlow URA - API Documentation"
}));

app.get("/openapi.json", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.json(generateSwaggerDoc(req));
});

// ========== MOCK ENDPOINTS ==========

app.all("*", (req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/docs") || req.path === "/openapi.json" || req.path.startsWith("/swagger")) {
    return;
  }
  
  const mirrors = readMirrors();
  const mirror = mirrors.find(m => 
    m.active && 
    normalize(m.method) === normalize(req.method) && 
    normalize(m.path) === normalize(req.path)
  );
  
  if (!mirror) {
    res.status(404).json({ 
      error: "API espelhada nao encontrada",
      path: req.path,
      method: req.method
    });
    return;
  }
  
  const scenarios = mirror.scenarios || [];
  let selectedScenario = null;
  
  // Procura cenário por match
  for (const scenario of scenarios) {
    let matches = true;
    for (const [key, expected] of Object.entries(scenario.match || {})) {
      let actual;
      if (key.startsWith("body.")) {
        actual = getByPath(req.body || {}, key.slice(5));
      } else if (key.startsWith("query.")) {
        actual = getByPath(req.query || {}, key.slice(6));
      } else {
        actual = getByPath(req.query || {}, key) ?? getByPath(req.body || {}, key);
      }
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
  
  // Se não achou, pega o primeiro cenário (fallback)
  if (!selectedScenario && scenarios.length > 0) {
    selectedScenario = scenarios[0];
  }
  
  if (!selectedScenario) {
    res.status(404).json({ error: "Nenhum cenário configurado" });
    return;
  }
  
  // Valida campos obrigatórios
  if (selectedScenario.validateRequest && selectedScenario.requiredFields) {
    const missing = selectedScenario.requiredFields.filter(field => !hasValue(req.body || {}, field));
    if (missing.length) {
      res.status(400).json({
        error: "Campos obrigatórios ausentes",
        missing_fields: missing
      });
      return;
    }
  }
  
  // Delay
  if (selectedScenario.delayMs) {
    setTimeout(() => {
      res.status(selectedScenario.responseStatus || 200).json(applyTemplate(selectedScenario.responseBody || {}, req));
    }, selectedScenario.delayMs);
  } else {
    res.status(selectedScenario.responseStatus || 200).json(applyTemplate(selectedScenario.responseBody || {}, req));
  }
});

exports.handler = serverless(app);