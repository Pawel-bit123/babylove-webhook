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
  if (!url.startsWith('http://') && !url.startsWith('https://')) return true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' },
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (response.status < 400) return true;
    console.log(`[LINKS] Usuwam link (HTTP ${response.status}): ${url}`);
    return false;

  } catch (err) {
    console.log(`[LINKS] Usuwam link (błąd): ${url} - ${err.message}`);
    return false;
  }
}

async function validateLinks(html) {
  const linkRegex = /<a\s+[^>]*?href="([^"#][^"]*)"[^>]*>[\s\S]*?<\/a>/gi;
  const links = [];
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    if (url.includes('magnificentcoffee.pl')) continue;
    if (!links.find(l => l.url === url)) {
      links.push({ url });
    }
  }

  if (links.length === 0) {
    console.log('[LINKS] Brak zewnętrznych linków');
    return html;
  }

  console.log(`[LINKS] Sprawdzam ${links.length} linków...`);

  // Sprawdź wszystkie równolegle
  const checks = await Promise.all(
    links.map(async l => ({ url: l.url, ok: await checkUrl(l.url) }))
  );
  const results = new Map(checks.map(c => [c.url, c.ok]));

  // Usuń martwe linki - zostaw sam tekst
  let result = html;
  for (const [url, ok] of results) {
    if (!ok) {
      const re = new RegExp(`<a\\s+[^>]*?href="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
      result = result.replace(re, '$1');
    }
  }

  const removed = [...results.values()].filter(v => !v).length;
  console.log(`[LINKS] Usunięto ${removed}/${links.length} martwych linków`);
  return result;
}

// ---------- korekta ortograficzna przez OpenAI ----------

async function correctWithOpenAI(html) {
  if (!OPENAI_API_KEY) {
    console.log('[OPENAI] Brak klucza - pomijam');
    return html;
  }

  try {
    console.log('[OPENAI] Korekta ortograficzna...');

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
          { role: 'user', content: html }
        ]
      })
    });

    if (!response.ok) {
      console.warn('[OPENAI] Error:', response.status, '- pomijam');
      return html;
    }

    const data = await response.json();
    const corrected = data.choices?.[0]?.message?.content?.trim();
    if (!corrected) return html;

    console.log('[OPENAI] ✓ Korekta zakończona');
    return corrected;

  } catch (err) {
    console.warn('[OPENAI] Błąd:', err.message, '- pomijam');
    return html;
  }
}

// ---------- processContent ----------

function processContent(html) {
  if (!html) return '';

  html = html.replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<img[^>]*>/i, '');
  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');
  html = html.replace(/<html[^>]*>/gi, '');
  html = html.replace(/<\/html>/gi, '');
  html = html.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  html = html.replace(/<body[^>]*>/gi, '');
  html = html.replace(/<\/body>/gi, '');
  html = html.replace(/<article[^>]*>/gi, '');
  html = html.replace(/<\/article>/gi, '');

  // TL;DR → W skrócie
  html = html.replace(/\bTL[;:]\s*DR\b/gi, 'W skrócie');

  // Owij grafikę MagnificentCoffee linkiem do strony głównej
  html = html.replace(
    /(<img\s[^>]*alt="https:\/\/magnificentcoffee\.pl"[^>]*>)/gi,
    '<a href="https://magnificentcoffee.pl" target="_blank" rel="noopener">$1</a>'
  );

  // Dodaj czarny przycisk CTA "Zamów teraz" przed sekcją FAQ
  const ctaButton = '<p style="text-align:center; margin:28px 0;">' +
    '<a href="https://magnificentcoffee.pl" target="_blank" rel="noopener" ' +
    'style="display:inline-block; background-color:#000000; color:#ffffff; ' +
    'padding:14px 36px; border-radius:4px; text-decoration:none; ' +
    'font-weight:bold; font-size:16px; letter-spacing:0.5px;">Zamów teraz \u2192</a>' +
    '</p>';
  html = html.replace(/(<h2\s[^>]*id="faq")/i, ctaButton + '$1');

  // Dekoduj kotwice
  html = html.replace(/href="#([^"]+)"/gi, (match, anchor) => {
    try { return `href="#${decodeURIComponent(anchor)}"`; }
    catch (e) { return match; }
  });

  // Styluj tabelki
  html = html.replace(/<table(?:[^>]*)>/gi, '<table style="width:100%; border-collapse:collapse; border:1px solid #ddd;">');
  html = html.replace(/(<thead>[\s\S]*?<\/thead>)/gi, block =>
    block.replace(/<tr(?:[^>]*)>/gi, '<tr style="background-color:#f8f8f8;">'));
  html = html.replace(/<th(?:[^>]*)>/gi, '<th style="padding:12px; text-align:left; border:1px solid #ddd;">');
  html = html.replace(/<td(?:[^>]*)>/gi, '<td style="padding:12px; border:1px solid #ddd; vertical-align:top;">');

  html = html.replace(/\n{3,}/g, '\n\n').trim();
  return html;
}

// ---------- przetwarzanie w tle ----------

async function processArticle(article) {
  try {
    const token = await getShoperToken();
    console.log('[SHOPER] Token obtained');

    const slug = article.slug
      ? `blog/wpis/${article.slug}`
      : `blog/wpis/${slugify(article.title || 'artykul')}`;

    let content = processContent(article.content_html || '');
    content = await validateLinks(content);
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
    if (!response.ok) throw new Error(`Shoper news failed: ${response.status} - ${responseText}`);

    console.log(`[SHOPER] ✓ Artykuł zapisany, ID: ${responseText.trim()}`);

  } catch (err) {
    console.error('[ERROR] Przetwarzanie nie powiodło się:', err.message);
  }
}

// ---------- webhook ----------

app.post('/webhook', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const expectedAuth = `Bearer ${BABYLOVE_SECRET}`;

  if (!authHeader || authHeader !== expectedAuth) {
    console.log('[WEBHOOK] Unauthorized');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const article = req.body;
  console.log(`[WEBHOOK] Received: "${article.title}" (id: ${article.id})`);

  // Odpowiedz od razu - przetwarzanie idzie w tle
  res.status(200).json({ success: true, message: 'Accepted, processing in background' });

  // Przetwarzaj asynchronicznie
  processArticle(article);
});

// ---------- health check ----------

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BabyLoveGrowth → Shoper webhook running' });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});
