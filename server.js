const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BABYLOVE_SECRET = process.env.BABYLOVE_SECRET;
const SHOPER_URL = process.env.SHOPER_URL;
const SHOPER_LOGIN = process.env.SHOPER_LOGIN;
const SHOPER_PASSWORD = process.env.SHOPER_PASSWORD;

// ---------- Shoper auth ----------

async function getShoperToken() {
  const credentials = Buffer.from(`${SHOPER_LOGIN}:${SHOPER_PASSWORD}`).toString('base64');
  const response = await fetch(`https://${SHOPER_URL}/webapi/rest/auth`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Shoper auth failed: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

// ---------- slugify ----------

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, c => ({ ą:'a',ć:'c',ę:'e',ł:'l',ń:'n',ó:'o',ś:'s',ź:'z',ż:'z' })[c] || c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------- create blog post ----------

async function createBlogPost(token, article) {
  const slug = article.slug || slugify(article.title || 'artykul');

  const payload = {
    active: '0',        // szkic - zmień na '1' dla auto-publikacji
    lang_id: '1',       // 1 = polski
    name: article.title || 'Bez tytułu',
    content: article.content_html || '',
    short_content: article.metaDescription ? `<p>${article.metaDescription}</p>` : '',
    seo_title: article.title || '',
    seo_description: article.metaDescription || '',
    seo_url: slug
  };

  const response = await fetch(`https://${SHOPER_URL}/webapi/rest/news`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();
  console.log(`[SHOPER] Response ${response.status}:`, responseText);

  if (!response.ok) {
    throw new Error(`Shoper news failed: ${response.status} - ${responseText}`);
  }

  return responseText; // Shoper zwraca samo ID (liczba)
}

// ---------- webhook endpoint ----------

app.post('/webhook', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const expectedAuth = `Bearer ${BABYLOVE_SECRET}`;

  if (!authHeader || authHeader !== expectedAuth) {
    console.log('[WEBHOOK] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const article = req.body;
  console.log(`[WEBHOOK] Received article: "${article.title}" (id: ${article.id})`);

  try {
    const token = await getShoperToken();
    console.log('[SHOPER] Token obtained');
    const newsId = await createBlogPost(token, article);
    console.log('[SHOPER] Article created, news ID:', newsId);
    return res.status(200).json({ success: true, shoper_news_id: newsId });
  } catch (error) {
    console.error('[ERROR]', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ---------- health check ----------

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BabyLoveGrowth → Shoper webhook running' });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});
