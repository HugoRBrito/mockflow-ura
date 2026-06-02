const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MIRRORS_FILE = path.join(DATA_DIR, 'apis.json');

// Mock das funções do banco usando JSON
async function dbRun(sql, params = []) {
  // Para CREATE TABLE, apenas ignore
  if (sql.includes('CREATE TABLE')) {
    return { changes: 0, lastID: 0 };
  }
  // Para INSERT/UPDATE/DELETE, manipular o JSON
  if (sql.includes('INSERT OR REPLACE')) {
    const mirrors = await readJsonFile(MIRRORS_FILE, []);
    const payload = JSON.parse(params[5]);
    
    const existingIndex = mirrors.findIndex(m => m.id === params[0]);
    if (existingIndex >= 0) {
      mirrors[existingIndex] = payload;
    } else {
      mirrors.push(payload);
    }
    
    await writeJsonFile(MIRRORS_FILE, mirrors);
    return { changes: 1, lastID: mirrors.length };
  }
  
  if (sql.includes('DELETE')) {
    const mirrors = await readJsonFile(MIRRORS_FILE, []);
    const filtered = mirrors.filter(m => m.id !== params[0]);
    await writeJsonFile(MIRRORS_FILE, filtered);
    return { changes: mirrors.length !== filtered.length ? 1 : 0 };
  }
  
  return { changes: 0, lastID: 0 };
}

async function dbGet(sql, params = []) {
  const mirrors = await readJsonFile(MIRRORS_FILE, []);
  
  if (sql.includes('SELECT COUNT(*)')) {
    return { total: mirrors.length };
  }
  
  if (sql.includes('SELECT * FROM api_mirrors WHERE id =')) {
    const mirror = mirrors.find(m => m.id === params[0]);
    if (mirror) {
      return {
        id: mirror.id,
        nome: mirror.nome,
        method: mirror.method,
        path: mirror.path,
        active: mirror.active ? 1 : 0,
        payload_json: JSON.stringify(mirror),
        created_at: mirror.criadoEm,
        updated_at: mirror.atualizadoEm
      };
    }
    return null;
  }
  
  if (sql.includes('SELECT name FROM sqlite_master')) {
    return { name: 'api_mirrors' };
  }
  
  return null;
}

async function dbAll(sql, params = []) {
  const mirrors = await readJsonFile(MIRRORS_FILE, []);
  
  return mirrors.map(mirror => ({
    id: mirror.id,
    nome: mirror.nome,
    method: mirror.method,
    path: mirror.path,
    active: mirror.active ? 1 : 0,
    payload_json: JSON.stringify(mirror),
    created_at: mirror.criadoEm,
    updated_at: mirror.atualizadoEm
  }));
}

async function readJsonFile(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

module.exports = { dbRun, dbGet, dbAll };