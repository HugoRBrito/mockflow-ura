const express = require("express");
const serverless = require("serverless-http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

// Caminhos dos arquivos
const DATA_DIR = path.resolve(__dirname, "../../data");
const MIRRORS_FILE = path.join(DATA_DIR, "apis.json");
const MASSAS_FILE = path.join(DATA_DIR, "massas.json");

// Garantir que a pasta existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Funções auxiliares
function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function getByPath(source, dottedPath) {
  return String(dottedPath)
    .split(".")
    .filter(Boolean)
    .reduce((current, part) => (current && current[part] !== undefined ? current[part] : undefined), source);
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

function readMassas() {
  try {
    if (!fs.existsSync(MASSAS_FILE)) {
      fs.writeFileSync(MASSAS_FILE, JSON.stringify([], null, 2));
      return [];
    }
    const raw = fs.readFileSync(MASSAS_FILE, "utf8");
    const cleanJson = raw.replace(/^\uFEFF/, "").replace(/^ï»¿/, "").trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error("Erro ao ler massas:", error);
    return [];
  }
}

function writeMassas(massas) {
  fs.writeFileSync(MASSAS_FILE, JSON.stringify(massas, null, 2));
}

// ========== ROTAS ==========

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "mockflow-ura" });
});

// Massas CRUD
app.get("/api/massas", (_req, res) => {
  res.json(readMassas());
});

app.get("/api/massas/:id", (req, res) => {
  const massas = readMassas();
  const massa = massas.find(m => m.id === req.params.id);
  if (!massa) return res.status(404).json({ error: "Massa nao encontrada" });
  res.json(massa);
});

app.post("/api/massas", (req, res) => {
  const massas = readMassas();
  const newMassa = {
    id: randomUUID(),
    ...req.body,
    criadoEm: new Date().toISOString()
  };
  massas.unshift(newMassa);
  writeMassas(massas);
  res.status(201).json(newMassa);
});

app.put("/api/massas/:id", (req, res) => {
  const massas = readMassas();
  const index = massas.findIndex(m => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Massa nao encontrada" });
  massas[index] = { ...massas[index], ...req.body, atualizadoEm: new Date().toISOString() };
  writeMassas(massas);
  res.json(massas[index]);
});

app.delete("/api/massas/:id", (req, res) => {
  const massas = readMassas();
  const filtered = massas.filter(m => m.id !== req.params.id);
  if (filtered.length === massas.length) return res.status(404).json({ error: "Massa nao encontrada" });
  writeMassas(filtered);
  res.status(204).end();
});

// APIs Mirrors CRUD
app.get("/api/mirrors", (_req, res) => {
  res.json(readMirrors());
});

app.get("/api/mirrors/:id", (req, res) => {
  const mirrors = readMirrors();
  const mirror = mirrors.find(m => m.id === req.params.id);
  if (!mirror) return res.status(404).json({ error: "API nao encontrada" });
  res.json(mirror);
});

app.post("/api/mirrors", (req, res) => {
  const mirrors = readMirrors();
  const newMirror = {
    id: randomUUID(),
    ...req.body,
    criadoEm: new Date().toISOString()
  };
  mirrors.unshift(newMirror);
  writeMirrors(mirrors);
  res.status(201).json(newMirror);
});

app.put("/api/mirrors/:id", (req, res) => {
  const mirrors = readMirrors();
  const index = mirrors.findIndex(m => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "API nao encontrada" });
  mirrors[index] = { ...mirrors[index], ...req.body, atualizadoEm: new Date().toISOString() };
  writeMirrors(mirrors);
  res.json(mirrors[index]);
});

app.delete("/api/mirrors/:id", (req, res) => {
  const mirrors = readMirrors();
  const filtered = mirrors.filter(m => m.id !== req.params.id);
  if (filtered.length === mirrors.length) return res.status(404).json({ error: "API nao encontrada" });
  writeMirrors(filtered);
  res.status(204).end();
});

// URA Consulta
app.get("/api/ura/consulta", (req, res) => {
  const campo = normalize(req.query.campo || "telefone");
  const valor = normalize(req.query.valor);
  const onlyActive = normalize(req.query.apenasAtiva || "true") !== "false";
  
  if (!valor) {
    return res.status(400).json({ 
      encontrado: false, 
      codigo: "PARAMETRO_INVALIDO" 
    });
  }
  
  const massas = readMassas();
  const massa = massas.find(item => {
    const sameField = normalize(item[campo]) === valor;
    const isActive = !onlyActive || normalize(item.status) === "ativa";
    return sameField && isActive;
  });
  
  if (!massa) {
    return res.json({ 
      encontrado: false, 
      codigo: "MASSA_NAO_ENCONTRADA" 
    });
  }
  
  res.json({ encontrado: true, ...massa });
});

// Mock endpoints (apis espelhadas)
app.all("*", (req, res) => {
  // Pula rotas da API
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "Rota nao encontrada" });
  }
  
  const mirrors = readMirrors();
  
  // Procura a API que corresponde
  const mirror = mirrors.find(m => 
    m.active && 
    normalize(m.method) === normalize(req.method) && 
    normalize(m.path) === normalize(req.path)
  );
  
  if (!mirror) {
    return res.status(404).json({ 
      error: "API espelhada nao encontrada",
      path: req.path,
      method: req.method
    });
  }
  
  // Verifica se tem cenários
  let responseBody = mirror.responseBody;
  let responseStatus = mirror.responseStatus || 200;
  let delayMs = mirror.delayMs || 0;
  
  // Se tem cenários, procura o que match
  if (mirror.scenarios && mirror.scenarios.length > 0) {
    for (const scenario of mirror.scenarios) {
      let matches = true;
      const matchConditions = scenario.match || {};
      
      for (const [key, expected] of Object.entries(matchConditions)) {
        let actual;
        if (key.startsWith("body.")) {
          actual = getByPath(req.body || {}, key.replace(/^body\./, ""));
        } else if (key.startsWith("query.")) {
          actual = getByPath(req.query || {}, key.replace(/^query\./, ""));
        } else {
          actual = getByPath(req.query || {}, key) ?? getByPath(req.body || {}, key);
        }
        
        if (normalize(actual) !== normalize(expected)) {
          matches = false;
          break;
        }
      }
      
      if (matches) {
        responseBody = scenario.responseBody;
        responseStatus = scenario.responseStatus || 200;
        delayMs = scenario.delayMs || 0;
        break;
      }
    }
  }
  
  // Delay
  if (delayMs > 0) {
    setTimeout(() => {
      res.status(responseStatus).json(applyTemplate(responseBody, req));
    }, delayMs);
  } else {
    res.status(responseStatus).json(applyTemplate(responseBody, req));
  }
});

// Exportar para o Netlify
exports.handler = serverless(app);