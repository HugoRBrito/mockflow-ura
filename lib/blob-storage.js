const { put, list, del, head } = require('@vercel/blob');

const BLOB_PREFIX = 'mockflow/';

// Salvar dados
async function saveToBlob(key, data) {
  const blobKey = `${BLOB_PREFIX}${key}.json`;
  const result = await put(blobKey, JSON.stringify(data, null, 2), {
    access: 'public',
    addRandomSuffix: false,
  });
  return result;
}

// Ler dados
async function loadFromBlob(key, defaultValue = []) {
  const blobKey = `${BLOB_PREFIX}${key}.json`;
  try {
    const { url } = await head(blobKey);
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    // Arquivo não existe
    return defaultValue;
  }
}

// Listar todos os blobs
async function listBlobs() {
  const { blobs } = await list({ prefix: BLOB_PREFIX });
  return blobs;
}

// Deletar um blob
async function deleteFromBlob(key) {
  const blobKey = `${BLOB_PREFIX}${key}.json`;
  await del(blobKey);
}

module.exports = { saveToBlob, loadFromBlob, listBlobs, deleteFromBlob };