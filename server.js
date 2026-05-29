const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const swaggerUi = require("swagger-ui-express");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "massas.json");
const MIRRORS_FILE = path.join(DATA_DIR, "apis.json");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

// FUNÇÃO CORRIGIDA PARA REMOVER BOM CHARACTER
async function readJsonFile(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    // Remove BOM character (ï»¿) e outros caracteres invisíveis no início
    const cleanJson = raw.replace(/^\uFEFF/, "").replace(/^ï»¿/, "").trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error(`Erro ao ler ${file}:`, error.message);
    return fallback;
  }
}

async function ensureJsonFile(file, fallback) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  }
}

async function ensureDataFile() {
  await ensureJsonFile(DATA_FILE, []);
}

async function readMassas() {
  await ensureDataFile();
  return await readJsonFile(DATA_FILE, []);
}

async function writeMassas(massas) {
  await ensureDataFile();
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(massas, null, 2)}\n`, "utf8");
  await fs.rename(tmp, DATA_FILE);
}

async function readMirrors() {
  await ensureJsonFile(MIRRORS_FILE, []);
  return await readJsonFile(MIRRORS_FILE, []);
}

async function writeMirrors(mirrors) {
  await ensureJsonFile(MIRRORS_FILE, []);
  const tmp = `${MIRRORS_FILE}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(mirrors, null, 2)}\n`, "utf8");
  await fs.rename(tmp, MIRRORS_FILE);
}

function requireUraKey(req, res, next) {
  if (!API_KEY) {
    next();
    return;
  }

  const receivedKey = req.get("x-api-key") || req.query.apiKey;
  if (receivedKey !== API_KEY) {
    res.status(401).json({
      encontrado: false,
      codigo: "NAO_AUTORIZADO",
      mensagem: "API key invalida ou ausente."
    });
    return;
  }

  next();
}

function validateMassa(payload) {
  const errors = [];
  const required = ["nome", "cenario", "telefone", "cpf", "status"];

  for (const field of required) {
    if (!String(payload[field] || "").trim()) {
      errors.push(`Campo obrigatorio: ${field}`);
    }
  }

  if (payload.telefone && !/^[0-9+()\-\s]{8,20}$/.test(String(payload.telefone))) {
    errors.push("Telefone deve conter apenas numeros, espacos ou simbolos +()-.");
  }

  return errors;
}

function toMassa(payload, existing = {}) {
  const now = new Date().toISOString();
  const extra = payload.extra && typeof payload.extra === "object" ? payload.extra : {};

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
    extra,
    criadoEm: existing.criadoEm || now,
    atualizadoEm: now
  };
}

function publicUraResponse(massa) {
  if (!massa) {
    return {
      encontrado: false,
      codigo: "MASSA_NAO_ENCONTRADA",
      mensagem: "Nenhuma massa ativa encontrada para os parametros informados."
    };
  }

  return {
    encontrado: true,
    codigo: "OK",
    id: massa.id,
    nome: massa.nome,
    cenario: massa.cenario,
    telefone: massa.telefone,
    cpf: massa.cpf,
    contrato: massa.contrato,
    status: massa.status,
    fila: massa.fila,
    observacao: massa.observacao,
    extra: massa.extra || {}
  };
}

function filterMassas(massas, query) {
  const q = normalize(query.q);
  const cenario = normalize(query.cenario);
  const status = normalize(query.status);

  return massas.filter((massa) => {
    const matchesScenario = !cenario || normalize(massa.cenario) === cenario;
    const matchesStatus = !status || normalize(massa.status) === status;
    const searchable = [
      massa.nome,
      massa.cenario,
      massa.telefone,
      massa.cpf,
      massa.contrato,
      massa.status,
      massa.fila,
      massa.observacao
    ].join(" ");
    const matchesQuery = !q || normalize(searchable).includes(q);

    return matchesScenario && matchesStatus && matchesQuery;
  });
}

function slugify(value) {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function validateMirror(payload) {
  const errors = [];
  
  // Se veio com scenarios (formato novo)
  if (payload.scenarios) {
    if (!String(payload.nome || "").trim()) errors.push("Campo obrigatorio: nome");
    if (!String(payload.path || "").trim()) errors.push("Campo obrigatorio: path");
    if (!String(payload.method || "").trim()) errors.push("Campo obrigatorio: method");
    if (!Array.isArray(payload.scenarios)) errors.push("Scenarios deve ser um array");
    return errors;
  }
  
  // Formato antigo
  if (!String(payload.nome || "").trim()) errors.push("Campo obrigatorio: nome");
  if (!String(payload.path || "").trim()) errors.push("Campo obrigatorio: path");
  if (!String(payload.method || "").trim()) errors.push("Campo obrigatorio: method");
  if (!Number.isInteger(Number(payload.responseStatus))) errors.push("Status HTTP deve ser numerico.");
  if (payload.responseBody === undefined) errors.push("Campo obrigatorio: responseBody");
  
  return errors;
}

function toMirror(payload, existing = {}) {
  const now = new Date().toISOString();
  
  // Se veio com scenarios (formato novo)
  if (payload.scenarios && Array.isArray(payload.scenarios)) {
    return {
      id: existing.id || randomUUID(),
      nome: String(payload.nome || "").trim(),
      method: String(payload.method || "GET").trim().toUpperCase(),
      path: String(payload.path || "/").trim(),
      active: payload.active !== false,
      scenarios: payload.scenarios,
      criadoEm: existing.criadoEm || now,
      atualizadoEm: now
    };
  }
  
  // Formato antigo (compatibilidade)
  return {
    id: existing.id || randomUUID(),
    nome: String(payload.nome || "").trim(),
    cenario: String(payload.cenario || "").trim(),
    slug: String(payload.slug || "").trim(),
    method: String(payload.method || "GET").trim().toUpperCase(),
    path: String(payload.path || "/").trim(),
    active: payload.active !== false,
    match: payload.match || {},
    responseStatus: Number(payload.responseStatus || 200),
    responseBody: payload.responseBody || {},
    delayMs: Number(payload.delayMs || 0),
    validateRequest: payload.validateRequest === true,
    requiredFields: payload.requiredFields || [],
    requestExample: payload.requestExample || {},
    criadoEm: existing.criadoEm || now,
    atualizadoEm: now
  };
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

// VALIDAÇÃO AVANÇADA DE REQUEST
function validateRequestStructure(mirror, requestBody) {
    const errors = [];
    
    // 1. Valida campos obrigatórios
    if (mirror.validateRequest && mirror.requiredFields) {
        for (const field of mirror.requiredFields) {
            if (!hasValue(requestBody, field)) {
                errors.push(`Campo obrigatório ausente: ${field}`);
            }
        }
    }
    
    // 2. Valida tipos dos campos (baseado no requestExample)
    if (mirror.validateRequest && mirror.requestExample) {
        function validateType(value, expected, path) {
            if (expected === undefined) return;
            
            const expectedType = typeof expected;
            const actualType = typeof value;
            
            if (expectedType === 'object' && expected !== null) {
                if (actualType !== 'object' || value === null) {
                    errors.push(`Campo ${path} deve ser um objeto, recebeu ${actualType}`);
                    return;
                }
                // Valida recursivamente objetos aninhados
                for (const [key, expectedValue] of Object.entries(expected)) {
                    validateType(value[key], expectedValue, path ? `${path}.${key}` : key);
                }
            } else if (expectedType !== actualType) {
                // Tipos primitivos
                if (expectedType === 'number' && !isNaN(Number(value))) {
                    // Conversão numérica é aceita
                    return;
                }
                errors.push(`Campo ${path} deve ser do tipo ${expectedType}, recebeu ${actualType}`);
            }
        }
        
        validateType(requestBody, mirror.requestExample, 'body');
    }
    
    // 3. Valida se não há campos extras (opcional - descomente se quiser)
    // function hasExtraFields(body, expected, path = '') {
    //     for (const key of Object.keys(body)) {
    //         if (!expected || !expected.hasOwnProperty(key)) {
    //             errors.push(`Campo não permitido: ${path}${key}`);
    //         } else if (typeof body[key] === 'object' && body[key] !== null) {
    //             hasExtraFields(body[key], expected[key], `${path}${key}.`);
    //         }
    //     }
    // }
    // if (mirror.blockExtraFields) {
    //     hasExtraFields(requestBody, mirror.requestExample);
    // }
    
    return errors;
}

// SUBSTITUIR a função validateRequestBody existente por esta:
function validateRequestBody(mirror, body) {
    if (!mirror.validateRequest) return [];
    return validateRequestStructure(mirror, body);
}

function validateRequestBody(mirror, body) {
  if (!mirror.validateRequest) return [];
  return (mirror.requiredFields || []).filter((field) => !hasValue(body || {}, field));
}

function matchesMirror(mirror, req, requestedPath) {
  if (!mirror.active) return false;
  if (normalize(mirror.method) !== normalize(req.method)) return false;
  if (normalize(mirror.path) !== normalize(requestedPath)) return false;

  const match = mirror.match || {};
  for (const [key, expected] of Object.entries(match)) {
    const actual = key.startsWith("body.")
      ? getByPath(req.body || {}, key.replace(/^body\./, ""))
      : getByPath(req.query || {}, key.replace(/^query\./, ""));
    if (normalize(actual) !== normalize(expected)) return false;
  }

  return true;
}

async function handleMirrorRequest(req, res, next, requestedPath, slug) {
  try {
    const mirrors = await readMirrors();
    
    // Filtra APIs que correspondem ao path e método
    const matchingMirrors = mirrors.filter((item) => {
      const slugMatches = !slug || normalize(item.slug) === normalize(slug);
      return slugMatches && normalize(item.method) === normalize(req.method) && normalize(item.path) === normalize(requestedPath) && item.active;
    });
    
    if (matchingMirrors.length === 0) {
      res.status(404).json({
        encontrado: false,
        codigo: "API_ESPELHADA_NAO_ENCONTRADA",
        mensagem: "Nenhuma API espelhada ativa corresponde ao metodo e path informados."
      });
      return;
    }
    
    // Procura o cenário correto
    let selectedScenario = null;
    let selectedMirror = null;
    
    for (const mirror of matchingMirrors) {
      // Verifica se tem scenarios (formato novo) ou é formato antigo
      const scenarios = mirror.scenarios || [{
        nome: mirror.nome || 'Cenário Padrão',
        match: mirror.match || {},
        responseStatus: mirror.responseStatus || 200,
        responseBody: mirror.responseBody || {},
        delayMs: mirror.delayMs || 0,
        validateRequest: mirror.validateRequest || false,
        requiredFields: mirror.requiredFields || [],
        requestExample: mirror.requestExample || {}
      }];
      
      // Ordena por especificidade (quem tem mais match conditions primeiro)
      const sortedScenarios = [...scenarios].sort((a, b) => 
        Object.keys(b.match || {}).length - Object.keys(a.match || {}).length
      );
      
      for (const scenario of sortedScenarios) {
        // Verifica se o match corresponde
        let matches = true;
        const matchConditions = scenario.match || {};
        
        for (const [key, expected] of Object.entries(matchConditions)) {
          let actual;
          if (key.startsWith("body.")) {
            actual = getByPath(req.body || {}, key.replace(/^body\./, ""));
          } else if (key.startsWith("query.")) {
            actual = getByPath(req.query || {}, key.replace(/^query\./, ""));
          } else if (key.startsWith("header.")) {
            actual = req.get(key.replace(/^header\./, ""));
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
          selectedMirror = mirror;
          break;
        }
      }
      
      if (selectedScenario) break;
    }
    
    if (!selectedScenario) {
      res.status(404).json({
        encontrado: false,
        codigo: "CENARIO_NAO_ENCONTRADO",
        mensagem: "Nenhum cenário ativo corresponde aos parametros informados."
      });
      return;
    }
    
    // Valida campos obrigatórios se necessário
    if (selectedScenario.validateRequest && selectedScenario.requiredFields) {
      const missingFields = [];
      for (const field of selectedScenario.requiredFields) {
        if (!hasValue(req.body || {}, field)) {
          missingFields.push(field);
        }
      }
      if (missingFields.length) {
        res.status(400).json({
          codigo: "REQUEST_INVALIDO",
          mensagem: "Request não possui campos obrigatorios",
          camposObrigatoriosAusentes: missingFields
        });
        return;
      }
    }
    
    // Delay
    if (selectedScenario.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, selectedScenario.delayMs));
    }
    
    // Headers
    if (selectedScenario.responseHeaders) {
      for (const [key, value] of Object.entries(selectedScenario.responseHeaders)) {
        res.set(key, String(value));
      }
    }
    
    // Resposta com template
    res.status(selectedScenario.responseStatus).json(applyTemplate(selectedScenario.responseBody, req));
    
  } catch (error) {
    console.error('Erro no handleMirrorRequest:', error);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
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

function filterMirrors(mirrors, query) {
  const q = normalize(query.q);
  return mirrors.filter((mirror) => {
    const searchable = [mirror.nome, mirror.cenario, mirror.slug, mirror.method, mirror.path].join(" ");
    return !q || normalize(searchable).includes(q);
  });
}

function matchSpecificity(mirror) {
  return Object.keys(mirror.match || {}).length;
}

function schemaFromExample(example) {
  if (Array.isArray(example)) {
    return {
      type: "array",
      items: schemaFromExample(example[0] ?? {})
    };
  }

  if (example === null) return { nullable: true };

  if (typeof example === "object") {
    return {
      type: "object",
      additionalProperties: true,
      properties: Object.fromEntries(
        Object.entries(example || {}).map(([key, value]) => [key, schemaFromExample(value)])
      )
    };
  }

  if (typeof example === "number") return { type: Number.isInteger(example) ? "integer" : "number" };
  if (typeof example === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function sampleRequestFromMatch(match) {
  return Object.fromEntries(
    Object.entries(match || {})
      .filter(([key]) => key.startsWith("body."))
      .map(([key, value]) => [key.replace(/^body\./, ""), value])
  );
}

function schemaWithRequired(example, requiredFields = []) {
  const schema = schemaFromExample(example || {});
  if (schema.type !== "object") return schema;

  const topLevelRequired = requiredFields.filter((field) => !field.includes("."));
  if (topLevelRequired.length) {
    schema.required = topLevelRequired;
  }

  return schema;
}

function queryParametersFromScenarios(scenarios) {
  const params = new Map();

  for (const scenario of scenarios) {
    for (const [key, value] of Object.entries(scenario.match || {})) {
      if (key.startsWith("body.")) continue;
      const name = key.replace(/^query\./, "");
      if (!params.has(name)) {
        params.set(name, {
          name,
          in: "query",
          required: false,
          schema: { type: "string" },
          example: value
        });
      }
    }
  }

  return [...params.values()];
}

function scenarioDescription(scenarios) {
  return scenarios
    .map((scenario) => {
      const match = JSON.stringify(scenario.match || {});
      const required = (scenario.requiredFields || []).length ? `, obrigatorios: ${scenario.requiredFields.join(", ")}` : "";
      const validation = scenario.validateRequest ? `, request validado${required}` : ", request livre";
      return `- ${scenario.nome}: match ${match || "{}"}, HTTP ${scenario.responseStatus}${validation}`;
    })
    .join("\n");
}

function scenariosForOpenApi(mirror) {
  if (Array.isArray(mirror.scenarios) && mirror.scenarios.length) {
    return mirror.scenarios.map((scenario, index) => ({
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

  return [{
    id: mirror.id,
    nome: mirror.nome,
    match: mirror.match || {},
    requestExample: mirror.requestExample || {},
    requiredFields: mirror.requiredFields || [],
    validateRequest: mirror.validateRequest === true,
    responseStatus: Number(mirror.responseStatus || 200),
    responseBody: mirror.responseBody || {},
    method: mirror.method,
    path: mirror.path,
    tag: mirror.nome || mirror.slug || "APIs"
  }];
}

async function buildOpenApiSpec(req) {
  const mirrors = await readMirrors();
  const activeMirrors = mirrors.filter((mirror) => mirror.active);
  const grouped = new Map();

  for (const mirror of activeMirrors) {
    const key = `${mirror.method} ${mirror.path}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(...scenariosForOpenApi(mirror));
  }

  const paths = {};

  for (const scenarios of grouped.values()) {
    const [first] = scenarios;
    const openApiPath = first.path;
    const method = first.method.toLowerCase();
    const examples = Object.fromEntries(
      scenarios.map((scenario) => [
        slugify(scenario.nome || scenario.id) || scenario.id,
        {
          summary: scenario.nome,
          value: scenario.responseBody
        }
      ])
    );
    const requestExamples = Object.fromEntries(
      scenarios
        .map((scenario) => [scenario, Object.keys(scenario.requestExample || {}).length ? scenario.requestExample : sampleRequestFromMatch(scenario.match)])
        .filter(([, body]) => Object.keys(body).length > 0)
        .map(([scenario, body]) => [
          slugify(scenario.nome || scenario.id) || scenario.id,
          {
            summary: scenario.nome,
            value: body
          }
        ])
    );

    paths[openApiPath] = paths[openApiPath] || {};
    paths[openApiPath][method] = {
      tags: [first.tag],
      summary: first.nome,
      description: scenarioDescription(scenarios),
      parameters: queryParametersFromScenarios(scenarios),
      requestBody: ["post", "put", "patch"].includes(method)
        ? {
            required: first.validateRequest || (first.requiredFields || []).length > 0,
            content: {
              "application/json": {
                schema: schemaWithRequired(first.requestExample || {}, first.requiredFields || []),
                examples: requestExamples
              }
            }
          }
        : undefined,
      responses: {
        [String(first.responseStatus || 200)]: {
          description: "Response espelhado conforme cenario cadastrado.",
          content: {
            "application/json": {
              schema: schemaFromExample(first.responseBody),
              examples
            }
          }
        },
        404: {
          description: "Nenhuma API espelhada correspondeu ao metodo, path e match."
        }
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
    servers: [
      {
        url: `${req.protocol}://${req.get("host")}`,
        description: "Servidor local"
      }
    ],
    paths
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "cxone-massas-web" });
});

app.get("/openapi.json", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json(await buildOpenApiSpec(req));
  } catch (error) {
    next(error);
  }
});

app.get("/docs", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "docs.html"));
});

app.get("/api/massas", async (req, res, next) => {
  try {
    const massas = await readMassas();
    res.json(filterMassas(massas, req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/massas/:id", async (req, res, next) => {
  try {
    const massas = await readMassas();
    const massa = massas.find((item) => item.id === req.params.id);
    if (!massa) {
      res.status(404).json({ error: "Massa nao encontrada." });
      return;
    }
    res.json(massa);
  } catch (error) {
    next(error);
  }
});

app.post("/api/massas", async (req, res, next) => {
  try {
    const errors = validateMassa(req.body);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    const massas = await readMassas();
    const massa = toMassa(req.body);
    massas.unshift(massa);
    await writeMassas(massas);
    res.status(201).json(massa);
  } catch (error) {
    next(error);
  }
});

app.put("/api/massas/:id", async (req, res, next) => {
  try {
    const massas = await readMassas();
    const index = massas.findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: "Massa nao encontrada." });
      return;
    }

    const errors = validateMassa(req.body);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    massas[index] = toMassa(req.body, massas[index]);
    await writeMassas(massas);
    res.json(massas[index]);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/massas/:id", async (req, res, next) => {
  try {
    const massas = await readMassas();
    const nextMassas = massas.filter((item) => item.id !== req.params.id);
    if (nextMassas.length === massas.length) {
      res.status(404).json({ error: "Massa nao encontrada." });
      return;
    }

    await writeMassas(nextMassas);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/mirrors", async (req, res, next) => {
  try {
    const mirrors = await readMirrors();
    res.json(filterMirrors(mirrors, req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/mirrors", async (req, res, next) => {
  try {
    const errors = validateMirror(req.body);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    const mirrors = await readMirrors();
    const mirror = toMirror(req.body);
    mirrors.unshift(mirror);
    await writeMirrors(mirrors);
    res.status(201).json(mirror);
  } catch (error) {
    next(error);
  }
});

app.put("/api/mirrors/:id", async (req, res, next) => {
  try {
    const mirrors = await readMirrors();
    const index = mirrors.findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: "API espelhada nao encontrada." });
      return;
    }

    const errors = validateMirror(req.body);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    mirrors[index] = toMirror(req.body, mirrors[index]);
    await writeMirrors(mirrors);
    res.json(mirrors[index]);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/mirrors/:id", async (req, res, next) => {
  try {
    const mirrors = await readMirrors();
    const nextMirrors = mirrors.filter((item) => item.id !== req.params.id);
    if (nextMirrors.length === mirrors.length) {
      res.status(404).json({ error: "API espelhada nao encontrada." });
      return;
    }

    await writeMirrors(nextMirrors);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/ura/consulta", requireUraKey, async (req, res, next) => {
  try {
    const campo = normalize(req.query.campo || "telefone");
    const valor = normalize(req.query.valor);
    const onlyActive = normalize(req.query.apenasAtiva || "true") !== "false";

    if (!valor) {
      res.status(400).json({
        encontrado: false,
        codigo: "PARAMETRO_INVALIDO",
        mensagem: "Informe valor para consulta."
      });
      return;
    }

    const allowedFields = new Set(["telefone", "cpf", "contrato", "cenario", "id"]);
    if (!allowedFields.has(campo)) {
      res.status(400).json({
        encontrado: false,
        codigo: "CAMPO_INVALIDO",
        mensagem: "Campo permitido: telefone, cpf, contrato, cenario ou id."
      });
      return;
    }

    const massas = await readMassas();
    const massa = massas.find((item) => {
      const sameField = normalize(item[campo]) === valor;
      const isActive = !onlyActive || normalize(item.status) === "ativa";
      return sameField && isActive;
    });

    res.json(publicUraResponse(massa));
  } catch (error) {
    next(error);
  }
});

app.get("/api/ura/telefone/:telefone", requireUraKey, async (req, res, next) => {
  try {
    const massas = await readMassas();
    const telefone = normalize(req.params.telefone);
    const massa = massas.find((item) => normalize(item.telefone) === telefone && normalize(item.status) === "ativa");
    res.json(publicUraResponse(massa));
  } catch (error) {
    next(error);
  }
});

app.all(["/mock/:slug", "/mock/:slug/*"], requireUraKey, async (req, res, next) => {
  const requestedPath = `/${req.params[0] || ""}`;
  await handleMirrorRequest(req, res, next, requestedPath, req.params.slug);
});

app.all("*", requireUraKey, async (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/docs") || req.path === "/openapi.json") {
    next();
    return;
  }

  await handleMirrorRequest(req, res, next, req.path);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Erro interno no servidor." });
});

ensureDataFile().then(() => {
  app.listen(PORT, () => {
    console.log(`Sistema de massas CXone em http://localhost:${PORT}`);
  });
});
