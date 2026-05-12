/**
 * BabyLoveGrowth → Shoper Blog Webhook
 * 
 * Odbiera artykuły z BabyLoveGrowth i tworzy wpisy blogowe w Shoperze.
 * 
 * Env vars:
 *   PORT                  - port serwera (domyślnie 3000)
 *   BABYLOVE_SECRET       - Bearer token z BabyLoveGrowth (do walidacji)
 *   SHOPER_URL            - np. kawiara-65185.shoparena.pl (bez https://)
 *   SHOPER_TOKEN          - token API Shopera z dostępem do news
 */

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const BABYLOVE_SECRET = process.env.BABYLOVE_SECRET;
const SHOPER_URL = process.env.SHOPER_URL;
const SHOPER_TOKEN = process.env.SHOPER_TOKEN;

// ---------- helpers ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function shoperRequest(path, method, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;

    const options = {
      hostname: SHOPER_URL,
      port: 443,
      path: '/webapi/rest/' + path,
      method,
      headers: {
        'Authorization': 'Bearer ' + SHOPER_TOKEN,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- mapping BabyLoveGrowth → Shoper news ----------

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, c => ({ ą:'a',ć:'c',ę:'e',ł:'l',ń:'n',ó:'o',ś:'s',ź:'z',ż:'z' })[c] || c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function mapArticleToShoperNews(article) {
  const slug = article.slug || slugify(article.title || 'artykul');
  return {
    active: '0',      // 0 = szkic do zatwierdzenia, zmień na '1' jeśli chcesz auto-publikację
    lang_id: '1',     // 1 = polski
    name: article.title || 'Bez tytułu',
    content: article.content_html || '',
    short_content: article.metaDescription ? `<p>${article.metaDescription}</p>` : '',
    seo_title: article.title || '',
    seo_description: article.metaDescription || '',
    seo_url: slug
  };
}

// ---------- request handler ----------

async function handleWebhook(req, res) {
  // Walidacja Bearer token
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (BABYLOVE_SECRET && token !== BABYLOVE_SECRET) {
    console.error('[WEBHOOK] Unauthorized - invalid token');
    res.writeHead(401);
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  let article;
  try {
    article = await readBody(req);
  } catch (e) {
    console.error('[WEBHOOK] Invalid JSON body:', e.message);
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }

  console.log(`[WEBHOOK] Received article: "${article.title}" (id: ${article.id})`);

  // Mapowanie i zapis do Shopera
  const newsPayload = mapArticleToShoperNews(article);

  let shoperResult;
  try {
    shoperResult = await shoperRequest('news', 'POST', newsPayload);
  } catch (e) {
    console.error('[SHOPER] Request failed:', e.message);
    res.writeHead(500);
    return res.end(JSON.stringify({ error: 'Shoper request failed', detail: e.message }));
  }

  if (shoperResult.status === 200 || shoperResult.status === 201) {
    const newsId = shoperResult.body;
    console.log(`[SHOPER] Article created, news ID: ${newsId}`);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, shoper_news_id: newsId }));
  } else {
    console.error(`[SHOPER] Error ${shoperResult.status}:`, JSON.stringify(shoperResult.body));
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Shoper error', status: shoperResult.status, detail: shoperResult.body }));
  }
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    return handleWebhook(req, res);
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[SERVER] BabyLoveGrowth→Shoper webhook running on port ${PORT}`);
  console.log(`[SERVER] Endpoint: POST /webhook`);
  console.log(`[SERVER] Health:   GET  /health`);
