const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10mb' }));

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

// ---------- helpers ----------

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, c => ({ ą:'a',ć:'c',ę:'e',ł:'l',ń:'n',ó:'o',ś:'s',ź:'z',ż:'z' })[c] || c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------- processContent ----------

function processContent(html) {
  if (!html) return '';

  // Usuń <script type="application/ld+json">
  html = html.replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, '');

  // Usuń pierwsze <img> (hero image - dodawane ręcznie przez panel)
  html = html.replace(/<img[^>]*>/i, '');

  // Wyczyść szkielet HTML - zostaw tylko treść
  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');
  html = html.replace(/<html[^>]*>/gi, '');
  html = html.replace(/<\/html>/gi, '');
  html = html.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  html = html.replace(/<body[^>]*>/gi, '');
  html = html.replace(/<\/body>/gi, '');
  html = html.replace(/<article[^>]*>/gi, '');
  html = html.replace(/<\/article>/gi, '');

  // Zamień TL;DR na "W skrócie" (wszystkie warianty: TL;DR, TL:DR, tl;dr itp.)
  html = html.replace(/\bTL[;:]\s*DR\b/gi, 'W skrócie');

  // Dekoduj URL-encoded linki wewnętrzne (#spis-tresci, #rozdzial itp.)
  html = html.replace(/href="#([^"]+)"/gi, (match, anchor) => {
    try {
      return `href="#${decodeURIComponent(anchor)}"`;
    } catch (e) {
      return match;
    }
  });

  // Styluj tabelki
  html = html.replace(/<table(?:[^>]*)>/gi,
    '<table style="width:100%; border-collapse:collapse; border:1px solid #ddd;">');
  html = html.replace(/(<thead>[\s\S]*?<\/thead>)/gi, (block) =>
    block.replace(/<tr(?:[^>]*)>/gi, '<tr style="background-color:#f8f8f8;">')
  );
  html = html.replace(/<th(?:[^>]*)>/gi,
    '<th style="padding:12px; text-align:left; border:1px solid #ddd;">');
  html = html.replace(/<td(?:[^>]*)>/gi,
    '<td style="padding:12px; border:1px solid #ddd; vertical-align:top;">');

  // Usuń nadmiarowe białe znaki
  html = html.replace(/\n{3,}/g, '\n\n').trim();

  return html;
}

// ---------- tworzenie wpisu blogowego ----------

async function createBlogPost(token, article) {
  const slug = article.slug
    ? `blog/wpis/${article.slug}`
    : `blog/wpis/${slugify(article.title || 'artykul')}`;

  const content = processContent(article.content_html || '');

  const payload = {
    active: '0',
    lang_id: '1',
    news_categories: [4],
    author: 'Magnificent Coffee',
    name: article.title || 'Bez tytułu',
    content: content,
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

  return responseText.trim();
}

// ---------- webhook ----------

app.post('/webhook', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const expectedAuth = `Bearer ${BABYLOVE_SECRET}`;

  if (!authHeader || authHeader !== expectedAuth) {
    console.log('[WEBHOOK] Unauthorized');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const article = req.body;
  console.log(`[WEBHOOK] Received: "${article.title}" (id: ${article.id})`);

  try {
    const token = await getShoperToken();
    console.log('[SHOPER] Token obtained');

    const newsId = await createBlogPost(token, article);
    console.log('[SHOPER] Article created, ID:', newsId);

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
