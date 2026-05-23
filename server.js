const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const BABYLOVE_SECRET = process.env.BABYLOVE_SECRET;
const SHOPER_URL = process.env.SHOPER_URL;
const SHOPER_LOGIN = process.env.SHOPER_LOGIN;
const SHOPER_PASSWORD = process.env.SHOPER_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

// ---------- walidacja linków ----------

async function checkUrl(url) {
  // Pomijaj linki wewnętrzne (kotwice i ścieżki względne)
  if (!url.startsWith('http://') && !url.startsWith('https://')) return true;

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)'
      },
      redirect: 'follow'
    });

    const status = response.status;

    // OK: 200, 301, 302, inne 2xx i 3xx
    if (status < 400) return true;

    // Usuń: 403, 404, 410, 5xx
    console.log(`[LINKS] Usuwam link (HTTP ${status}): ${url}`);
    return false;

  } catch (err) {
    // Błąd połączenia - link martwy
    console.log(`[LINKS] Usuwam link (błąd połączenia): ${url} - ${err.message}`);
    return false;
  }
}

async function validateLinks(html) {
  // Znajdź wszystkie linki <a href="...">
  const linkRegex = /<a\s+([^>]*?)href="([^"#][^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;
  const links = [];
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[2];
    // Pomijaj linki wewnętrzne do magnificentcoffee.pl
    if (url.includes('magnificentcoffee.pl')) continue;
    links.push({ full: match[0], url, before: match[1], after: match[3], text: match[4] });
  }

  if (links.length === 0) {
    console.log('[LINKS] Brak zewnętrznych linków do sprawdzenia');
    return html;
  }

  console.log(`[LINKS] Sprawdzam ${links.length} zewnętrznych linków...`);

  // Sprawdź wszystkie linki równolegle (max 5 na raz)
  const batchSize = 5;
  const results = new Map();

  for (let i = 0; i < links.length; i += batchSize) {
    const batch = links.slice(i, i + batchSize);
    const checks = await Promise.all(
      batch.map(async link => ({
        url: link.url,
        ok: await checkUrl(link.url)
      }))
    );
    checks.forEach(r => results.set(r.url, r.ok));
  }

  // Usuń martwe linki - zostaw sam tekst
  let result = html;
  for (const link of links) {
    const ok = results.get(link.url);
    if (!ok) {
      // Zamień <a href="...">tekst</a> na sam tekst
      result = result.replace(link.full, link.text);
    }
  }

  const removed = [...results.values()].filter(v => !v).length;
  console.log(`[LINKS] Usunięto ${removed} martwych linków z ${links.length} sprawdzonych`);

  return result;
}

// ---------- korekta ortograficzna przez OpenAI ----------

async function correctWithOpenAI(html) {
  if (!OPENAI_API_KEY) {
    console.log('[OPENAI] Brak klucza API - pomijam korektę');
    return html;
  }

  try {
    console.log('[OPENAI] Rozpoczynam korektę ortograficzną...');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `Jesteś korektorem języka polskiego. Poprawiasz błędy ortograficzne i gramatyczne w tekście HTML.
Zasady:
- Poprawiaj TYLKO błędy ortograficzne i gramatyczne (literówki, błędna odmiana, brak polskich znaków itp.)
- NIE zmieniaj struktury HTML, tagów, atrybutów, linków, klas CSS
- NIE zmieniaj treści merytorycznej ani stylu pisania
- NIE dodawaj ani nie usuwaj żadnych zdań
- Zwróć TYLKO poprawiony HTML, bez żadnych komentarzy ani wyjaśnień`
          },
          {
            role: 'user',
            content: html
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.warn('[OPENAI] API error:', response.status, err, '- pomijam korektę');
      return html;
    }

    const data = await response.json();
    const corrected = data.choices?.[0]?.message?.content?.trim();

    if (!corrected) {
      console.warn('[OPENAI] Pusta odpowiedź - pomijam korektę');
      return html;
    }

    console.log('[OPENAI] ✓ Korekta zakończona');
    return corrected;

  } catch (err) {
    console.warn('[OPENAI] Błąd:', err.message, '- pomijam korektę');
    return html;
  }
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

  // Zamień TL;DR na "W skrócie" (wszystkie warianty)
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

  // 1. Wyczyść HTML
  let content = processContent(article.content_html || '');

  // 2. Sprawdź i usuń martwe linki
  content = await validateLinks(content);

  // 3. Korekta ortograficzna przez OpenAI
  content = await correctWithOpenAI(content);

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
