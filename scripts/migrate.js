const { createClient } = require('@libsql/client');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

// Carregar variáveis de ambiente do arquivo .env (se existir)
try {
  require('dotenv').config();
} catch(e) {
  console.log('dotenv não instalado, usando variáveis de ambiente existentes');
}

async function migrate() {
  console.log('🔄 Iniciando migração para Turso...');
  
  const url = process.env.TURSO_DB_URL;
  const token = process.env.TURSO_DB_AUTH_TOKEN;
  
  if (!url || !token) {
    console.error('❌ Erro: TURSO_DB_URL ou TURSO_DB_AUTH_TOKEN não definidos');
    console.log('Defina as variáveis de ambiente:');
    console.log('  TURSO_DB_URL=libsql://...');
    console.log('  TURSO_DB_AUTH_TOKEN=...');
    process.exit(1);
  }
  
  console.log(`📡 Conectando ao Turso: ${url}`);
  
  const turso = createClient({
    url: url,
    authToken: token,
  });
  
  try {
    // Testar conexão
    await turso.execute('SELECT 1 as test');
    console.log('✅ Conexão com Turso estabelecida!');
    
    // Criar tabela
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS api_mirrors (
        id TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    console.log('✅ Tabela criada/verificada');
    
    // Ler dados do JSON
    const MIRRORS_FILE = path.join(__dirname, '..', 'data', 'apis.json');
    const mirrorsFromJson = await fs.readFile(MIRRORS_FILE, 'utf8').catch(() => '[]');
    const mirrors = JSON.parse(mirrorsFromJson);
    
    console.log(`📦 Encontrados ${mirrors.length} mirrors para migrar`);
    
    for (const mirror of mirrors) {
      const now = new Date().toISOString();
      const item = {
        id: mirror.id || randomUUID(),
        nome: mirror.nome || '',
        method: mirror.method || 'GET',
        path: mirror.path || '/',
        active: mirror.active !== false,
        payload_json: JSON.stringify(mirror),
        created_at: mirror.criadoEm || now,
        updated_at: mirror.atualizadoEm || now
      };
      
      await turso.execute({
        sql: `INSERT OR REPLACE INTO api_mirrors 
              (id, nome, method, path, active, payload_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [item.id, item.nome, item.method, item.path, item.active ? 1 : 0, item.payload_json, item.created_at, item.updated_at]
      });
    }
    
    console.log('✅ Migração concluída!');
  } catch (error) {
    console.error('❌ Erro na migração:', error.message);
    process.exit(1);
  }
}

migrate().catch(console.error);