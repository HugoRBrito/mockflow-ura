const state = {
  mirrors: [],
  editingMirrorId: ""
};

const elements = {
  filters: document.querySelector("#filters"),
  search: document.querySelector("#search"),
  total: document.querySelector("#total"),
  apiStatus: document.querySelector("#apiStatus"),
  mirrorEndpointExample: document.querySelector("#mirrorEndpointExample"),
  newButton: document.querySelector("#newButton"),
  mirrorForm: document.querySelector("#mirrorForm"),
  mirrorId: document.querySelector("#mirrorId"),
  mirrorNome: document.querySelector("#mirrorNome"),
  mirrorMethod: document.querySelector("#mirrorMethod"),
  mirrorPath: document.querySelector("#mirrorPath"),
  mirrorStatus: document.querySelector("#mirrorStatus"),
  mirrorDelay: document.querySelector("#mirrorDelay"),
  mirrorActive: document.querySelector("#mirrorActive"),
  mirrorValidateRequest: document.querySelector("#mirrorValidateRequest"),
  mirrorHeaders: document.querySelector("#mirrorHeaders"),
  mirrorRequest: document.querySelector("#mirrorRequest"),
  mirrorRequired: document.querySelector("#mirrorRequired"),
  mirrorMatch: document.querySelector("#mirrorMatch"),
  mirrorBody: document.querySelector("#mirrorBody"),
  clearMirrorButton: document.querySelector("#clearMirrorButton"),
  mirrorsList: document.querySelector("#mirrorsList"),
  mirrorTemplate: document.querySelector("#mirrorTemplate")
};

function setStatus(message) {
  elements.apiStatus.textContent = message;
}

function parseJsonField(value, fallback) {
  const text = String(value || "").trim();
  return text ? JSON.parse(text) : fallback;
}

function buildQuery() {
  const params = new URLSearchParams();
  if (elements.search.value.trim()) params.set("q", elements.search.value.trim());
  return params.toString();
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.errors ? body.errors.join("\n") : body.error || body.mensagem || "Falha na requisicao.";
    throw new Error(message);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function loadMirrors() {
  setStatus("Carregando APIs...");
  const query = buildQuery();
  state.mirrors = await request(`/api/mirrors${query ? `?${query}` : ""}`);
  renderMirrors();
  elements.total.textContent = `${state.mirrors.length} ${state.mirrors.length === 1 ? "API" : "APIs"}`;
  setStatus("API pronta");
}

function renderMirrors() {
  elements.mirrorsList.innerHTML = "";

  if (!state.mirrors.length) {
    elements.mirrorsList.innerHTML = '<article class="massa-card">Nenhuma API espelhada cadastrada.</article>';
    return;
  }

  for (const mirror of state.mirrors) {
    const node = elements.mirrorTemplate.content.firstElementChild.cloneNode(true);
    const endpoint = mirror.path;
    node.dataset.id = mirror.id;

    for (const field of ["nome", "method", "path", "responseStatus"]) {
      node.querySelector(`[data-field="${field}"]`).textContent = mirror[field] || "-";
    }

    node.querySelector('[data-field="endpoint"]').textContent = endpoint;
    node.querySelector('[data-field="validateRequest"]').textContent = mirror.validateRequest ? "validado" : "livre";

    const active = node.querySelector('[data-field="active"]');
    active.textContent = mirror.active ? "ativa" : "inativa";
    active.classList.toggle("inativa", !mirror.active);

    node.querySelector('[data-action="edit"]').addEventListener("click", () => editMirror(mirror));
    node.querySelector('[data-action="delete"]').addEventListener("click", () => deleteMirror(mirror));
    node.querySelector('[data-action="copy"]').addEventListener("click", () => copyMirrorUrl(mirror));

    elements.mirrorsList.appendChild(node);
  }
}

function readMirrorForm() {
  return {
    nome: elements.mirrorNome.value,
    method: elements.mirrorMethod.value,
    path: elements.mirrorPath.value,
    active: elements.mirrorActive.value === "true",
    validateRequest: elements.mirrorValidateRequest.value === "true",
    responseStatus: Number(elements.mirrorStatus.value || 200),
    delayMs: Number(elements.mirrorDelay.value || 0),
    responseHeaders: parseJsonField(elements.mirrorHeaders.value, {}),
    requestExample: parseJsonField(elements.mirrorRequest.value, {}),
    requiredFields: parseJsonField(elements.mirrorRequired.value, []),
    match: parseJsonField(elements.mirrorMatch.value, {}),
    responseBody: parseJsonField(elements.mirrorBody.value, {})
  };
}

function resetMirrorForm() {
  state.editingMirrorId = "";
  elements.mirrorForm.reset();
  elements.mirrorMethod.value = "GET";
  elements.mirrorStatus.value = "200";
  elements.mirrorDelay.value = "0";
  elements.mirrorActive.value = "true";
  elements.mirrorValidateRequest.value = "false";
  elements.mirrorHeaders.value = "";
  elements.mirrorRequest.value = "";
  elements.mirrorRequired.value = "";
  elements.mirrorMatch.value = "{}";
  elements.mirrorBody.value = "";
  elements.mirrorId.value = "";
  elements.mirrorNome.focus();
}

function editMirror(mirror) {
  state.editingMirrorId = mirror.id;
  elements.mirrorId.value = mirror.id;
  elements.mirrorNome.value = mirror.nome || "";
  elements.mirrorMethod.value = mirror.method || "GET";
  elements.mirrorPath.value = mirror.path || "/";
  elements.mirrorStatus.value = mirror.responseStatus || 200;
  elements.mirrorDelay.value = mirror.delayMs || 0;
  elements.mirrorActive.value = mirror.active ? "true" : "false";
  elements.mirrorValidateRequest.value = mirror.validateRequest ? "true" : "false";
  elements.mirrorHeaders.value = JSON.stringify(mirror.responseHeaders || {}, null, 2);
  elements.mirrorRequest.value = JSON.stringify(mirror.requestExample || {}, null, 2);
  elements.mirrorRequired.value = JSON.stringify(mirror.requiredFields || [], null, 2);
  elements.mirrorMatch.value = JSON.stringify(mirror.match || {}, null, 2);
  elements.mirrorBody.value = JSON.stringify(mirror.responseBody || {}, null, 2);
  elements.mirrorNome.focus();
}

async function saveMirror(event) {
  event.preventDefault();

  try {
    const payload = readMirrorForm();
    const url = state.editingMirrorId ? `/api/mirrors/${state.editingMirrorId}` : "/api/mirrors";
    const method = state.editingMirrorId ? "PUT" : "POST";
    await request(url, { method, body: JSON.stringify(payload) });
    resetMirrorForm();
    await loadMirrors();
    setStatus("API espelhada salva");
  } catch (error) {
    setStatus(error.message);
  }
}

async function deleteMirror(mirror) {
  const confirmed = window.confirm(`Excluir a API espelhada "${mirror.nome}"?`);
  if (!confirmed) return;

  try {
    await request(`/api/mirrors/${mirror.id}`, { method: "DELETE" });
    await loadMirrors();
    setStatus("API espelhada excluida");
  } catch (error) {
    setStatus(error.message);
  }
}

async function copyMirrorUrl(mirror) {
  const url = `${location.origin}${mirror.path}`;
  await navigator.clipboard.writeText(url);
  elements.mirrorEndpointExample.textContent = url.replace(location.origin, "");
  setStatus("URL da API espelhada copiada");
}

let filterTimer;
function scheduleLoad() {
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    loadMirrors().catch((error) => setStatus(error.message));
  }, 250);
}

elements.mirrorForm.addEventListener("submit", saveMirror);
elements.clearMirrorButton.addEventListener("click", resetMirrorForm);
elements.newButton.addEventListener("click", resetMirrorForm);
elements.filters.addEventListener("input", scheduleLoad);

loadMirrors().catch((error) => setStatus(error.message));
