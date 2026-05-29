# MockFlow URA

Aplicacao web para cadastrar APIs espelhadas, documentar requests no estilo Swagger e devolver responses configurados para fluxos de URA.

## Rodar localmente

```powershell
npm.cmd install
npm.cmd start
```

Acesse:

```text
http://localhost:3000
```

Documentacao interativa estilo Swagger:

```text
http://localhost:3000/docs
```

## Espelhar APIs do cliente

Cadastre na aba **APIs espelhadas** a rota que quer simular. A URA chama o sistema local usando:

```http
GET /clientes?cpf=12345678901
```

Tambem funciona manter o path original inteiro do cliente e trocar apenas o dominio.

URL original:

```text
https://hml.portoseguro.com.br/AgendaAtendimentoSocorristaIntegrationService/AgendaAtendimentoSocorristaIntegrationServiceRestV1_0/RegularAgenda
```

URL local:

```text
http://localhost:3000/AgendaAtendimentoSocorristaIntegrationService/AgendaAtendimentoSocorristaIntegrationServiceRestV1_0/RegularAgenda
```

Exemplo de cadastro:

```json
{
  "nome": "Consulta cadastro cliente",
  "slug": "cliente",
  "method": "GET",
  "path": "/clientes",
  "active": true,
  "match": {
    "cpf": "12345678901"
  },
  "responseStatus": 200,
  "responseHeaders": {
    "x-simulador": "cxone-massas"
  },
  "responseBody": {
    "cpf": "{{query.cpf}}",
    "nome": "Cliente Teste",
    "elegivel": true
  },
  "delayMs": 0
}
```

O campo `match` diferencia cenarios usando query string ou body:

```json
{
  "cpf": "12345678901",
  "body.contrato": "CTR-1001"
}
```

Templates aceitos dentro da resposta:

- `{{query.cpf}}`
- `{{body.cpf}}`
- `{{method}}`
- `{{path}}`

### Como manipular responses por cenario

Para uma mesma API, cadastre mais de uma resposta com o mesmo `slug`, `method` e `path`, mudando apenas:

- `cenario`: nome amigavel do caso de teste
- `match`: regra que escolhe quando aquele response sera usado
- `responseBody`: JSON que a API espelhada deve devolver

Exemplo de uma API de produtos do cliente:

```http
GET /produtos?cpf=00000000000
```

Response para cliente sem produtos:

```json
{
  "cpf": "00000000000",
  "quantidadeProdutos": 0,
  "produtos": []
}
```

Outro cenario da mesma API:

```http
GET /produtos?cpf=55555555555
```

Response para cliente com 5 produtos:

```json
{
  "cpf": "55555555555",
  "quantidadeProdutos": 5,
  "produtos": [
    { "codigo": "AUTO", "nome": "Seguro Auto", "status": "ativo" },
    { "codigo": "RES", "nome": "Assistencia Residencial", "status": "ativo" },
    { "codigo": "VIDA", "nome": "Seguro Vida", "status": "ativo" },
    { "codigo": "PET", "nome": "Assistencia Pet", "status": "ativo" },
    { "codigo": "BIKE", "nome": "Assistencia Bike", "status": "ativo" }
  ]
}
```

O sistema escolhe primeiro a resposta com `match` mais especifico. Assim, uma resposta sem `match` pode servir como fallback geral, e respostas com `cpf`, `body.idTipoServico`, `body.contrato` etc. servem para casos especificos.

Depois de cadastrar ou editar uma API espelhada, abra `/docs` para ver e testar no estilo Swagger. A documentacao e gerada automaticamente a partir do arquivo `data/apis.json`.

### Request igual a documentacao do cliente

No cadastro da API, use:

- `Request esperado JSON`: cole o exemplo de request da documentacao do cliente.
- `Campos obrigatorios por presenca JSON`: liste os campos prioritarios/obrigatorios.
- `Validar campos obrigatorios do request`: marque `Sim` quando quiser bloquear chamadas incompletas.

Exemplo:

```json
[
  "idTipoServico",
  "idProduto",
  "quantidade",
  "solicitante.nome",
  "solicitante.numeroDocumento"
]
```

Se a validacao estiver ligada e a URA nao enviar algum campo obrigatorio, o mock retorna:

```json
{
  "codigo": "REQUEST_INVALIDO",
  "mensagem": "Request nao possui campos obrigatorios conforme documentacao cadastrada.",
  "camposObrigatoriosAusentes": ["quantidade"]
}
```

Se a validacao estiver desligada, qualquer request para aquele endpoint recebe o response configurado.

A validacao dos campos obrigatorios confere apenas se o campo existe e veio preenchido. O valor pode ser qualquer um. Para restringir um response a um valor especifico, use o campo opcional `match`.

API administrativa das rotas espelhadas:

```http
GET /api/mirrors
POST /api/mirrors
PUT /api/mirrors/:id
DELETE /api/mirrors/:id
```

### Exemplo: abertura de ordem de servico

Baseado no documento `abertura-os.docx.pdf`, a API do cliente fica espelhada assim:

```http
POST /ordem-servico
Content-Type: application/json
```

Body minimo para teste:

```json
{
  "tipoOperacao": "ABERTURA",
  "idTipoServico": 25,
  "idProduto": 3160,
  "idParceiro": 140,
  "dataAgendamento": "16/08/2024",
  "horaAgendamento": "08:00",
  "horaFinalAgendamento": "10:00",
  "chaveAgendamento": "16082024080000160777",
  "quantidade": 1,
  "solicitante": {
    "nome": "DIEGO SARZI",
    "numeroDocumento": "34168748898",
    "email": "diego@gmail.com",
    "tipoSolicitante": "3"
  }
}
```

Resposta simulada:

```json
{
  "codigo": 200,
  "mensagem": "Ordem de servico aberta com sucesso.",
  "numeroServico": 1085187,
  "anoServico": 24
}
```

## Proteger endpoint da URA

Defina `API_KEY` antes de iniciar o servidor:

```powershell
$env:API_KEY="minha-chave"
npm.cmd start
```

Depois envie a chave no header:

```http
x-api-key: minha-chave
```

Tambem funciona com query string `apiKey` quando a ferramenta de chamada da URA nao permite headers.
