const express = require("express");
const serverless = require("serverless-http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

// ... configurações e funções auxiliares ...

// ========== ROTAS ==========
app.get("/api/health", (req, res) => { ... });
app.get("/api/mirrors", (req, res) => { ... });
app.post("/api/mirrors", (req, res) => { ... });
// ... todas as outras rotas ...

// ========== SWAGGER ==========
const swaggerUi = require("swagger-ui-express");

// Função para gerar documentação dinâmica baseada nas APIs cadastradas
function generateSwaggerDoc() {
    const mirrors = readMirrors();
    const paths = {};
    
    mirrors.forEach(api => {
        const path = api.path;
        const method = api.method.toLowerCase();
        
        if (!paths[path]) paths[path] = {};
        
        // Pega o primeiro cenário como exemplo
        const scenario = api.scenarios && api.scenarios.length > 0 ? api.scenarios[0] : null;
        
        paths[path][method] = {
            summary: api.nome,
            description: `API espelhada para ${api.nome}`,
            responses: {
                200: {
                    description: "Sucesso",
                    content: {
                        "application/json": {
                            example: scenario ? scenario.responseBody : (api.responseBody || {})
                        }
                    }
                }
            }
        };
        
        // Adiciona request body se for POST/PUT
        if (method === 'post' || method === 'put') {
            paths[path][method].requestBody = {
                required: true,
                content: {
                    "application/json": {
                        example: scenario ? scenario.requestExample : (api.requestExample || {})
                    }
                }
            };
        }
    });
    
    return {
        openapi: "3.0.0",
        info: {
            title: "MockFlow URA API",
            version: "1.0.0",
            description: "APIs simuladas para testes de URA NICE CXone",
            contact: {
                name: "MockFlow URA"
            }
        },
        servers: [
            {
                url: "https://mockflow-ura.netlify.app",
                description: "Produção"
            },
            {
                url: "http://localhost:3000",
                description: "Desenvolvimento local"
            }
        ],
        paths: paths
    };
}

// Rota para o Swagger UI
app.use("/docs", swaggerUi.serve, swaggerUi.setup(null, {
    swaggerOptions: {
        url: "/openapi.json",
        persistAuthorization: true
    }
}));

// Rota para o JSON do Swagger
app.get("/openapi.json", (req, res) => {
    res.json(generateSwaggerDoc());
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.get("/openapi.json", (req, res) => res.json(swaggerDocument));

// ========== EXPORTAR ==========
exports.handler = serverless(app);