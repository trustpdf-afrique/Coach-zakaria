const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY;
const ROOT = __dirname;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const rate = new Map();

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Requête trop volumineuse.')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Format JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

function allowed(ip) {
  const now = Date.now();
  const entry = rate.get(ip);
  if (!entry || now - entry.start > 60_000) { rate.set(ip, { start: now, count: 1 }); return true; }
  entry.count++;
  return entry.count <= 20;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try { send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), 'text/html; charset=utf-8'); }
    catch { send(res, 500, 'Fichier index.html introuvable.', 'text/plain; charset=utf-8'); }
    return;
  }
  if (url.pathname !== '/api/ask' || req.method !== 'POST') {
    send(res, 404, { error: 'Adresse introuvable.' }); return;
  }
  const ip = req.socket.remoteAddress || 'unknown';
  if (!allowed(ip)) { send(res, 429, { error: 'Trop de demandes. Réessaie dans une minute.' }); return; }
  if (!API_KEY) { send(res, 503, { error: 'La clé Gemini n’est pas configurée sur le serveur.' }); return; }
  try {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
    if (!messages.length) { send(res, 400, { error: 'Écris une question avant d’envoyer.' }); return; }
    const history = messages.map(m => `${m.role === 'assistant' ? 'PROFESSEUR' : 'ÉLÈVE'} : ${String(m.text || '').slice(0, 5000)}`).join('\n\n');
    const prompt = `Tu es PROFESSEUR INTELLIGENT dans l’application scolaire IVOIRENOVA – ZAKARIATV. Réponds en français simple, avec patience, comme à un élève. Explique étape par étape, adapte-toi à la classe ${String(body.classe || 'non renseignée').slice(0, 80)}, donne des exemples simples si utile. Si tu ne sais pas, dis-le clairement. N’affirme pas avoir lu un PDF ou un document qui n’a pas été fourni.\n\nHistorique récent de la discussion :\n${history}\n\nRéponds au dernier message de l’élève.`;
    const apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 1200 } },)
    });
    const result = await apiRes.json().catch(() => ({}));
    if (!apiRes.ok) {
      console.error('Gemini API error:', apiRes.status, result?.error?.message || 'Erreur inconnue');
      send(res, 502, { error: 'Google Gemini n’a pas pu répondre. Vérifie la configuration de la clé et l’accès au modèle.' }); return;
    }
    const answer = (result.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n').trim();
    if (!answer) { send(res, 502, { error: 'Gemini a renvoyé une réponse vide. Réessaie.' }); return; }
    send(res, 200, { answer });
  } catch (err) {
    console.error('Request error:', err.message);
    send(res, 400, { error: 'La demande n’a pas pu être traitée. Vérifie le message et réessaie.' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`IVOIRENOVA backend prêt sur le port ${PORT}`));
