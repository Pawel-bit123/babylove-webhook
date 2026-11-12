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

const NEWS_CATEGORY_ID = 4;   // kategoria bloga "Blog o kawie"

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

// Link usuwamy tylko wtedy, gdy strona wyraźnie mówi, że adres nie istnieje
// (404/410 albo nieistniejąca domena). Blokada automatycznych zapytań (403, 405, 429),
// błąd serwera albo przekroczony czas to nie dowód, że link jest martwy -
// serwisy naukowe i urzędowe często odrzucają automaty, a w przeglądarce działają.
const DEAD_STATUSES = [404, 410];

async function fetchStatus(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' },
      redirect: 'follow'
    });
    return response.status;
  } finally {
    clearTimeout(timeout);
    if (method === 'GET') controller.abort();   // status już mamy - nie pobieramy treści strony
  }
}

async function checkUrl(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return true;

  try {
    let status = await fetchStatus(url, 'HEAD');
    // część serwerów źle odpowiada na HEAD - 404/410 potwierdzamy zwykłym GET
    if (DEAD_STATUSES.includes(status)) status = await fetchStatus(url, 'GET');

    if (DEAD_STATUSES.includes(status)) {
      console.log(`[LINKS] Usuwam link (HTTP ${status}): ${url}`);
      return false;
    }
    if (status >= 400) console.log(`[LINKS] Zostawiam link mimo HTTP ${status}: ${url}`);
    return true;

  } catch (err) {
    if (err.code === 'ENOTFOUND') {
      console.log(`[LINKS] Usuwam link (domena nie istnieje): ${url}`);
      return false;
    }
    console.log(`[LINKS] Zostawiam link mimo błędu sprawdzania: ${url} - ${err.message}`);
    return true;
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

// ---------- znaczniki bloku kodu ----------

// Model czasem otacza odpowiedź blokiem kodu Markdown (```html na początku, ``` na końcu).
// Bez zdjęcia tych znaczników trafiają one do treści wpisu i są widoczne na blogu.
function stripCodeFences(html) {
  if (!html) return html;
  return html
    .replace(/^\s*(?:<p>\s*)?```[a-z]*\s*(?:<\/p>)?\s*/i, '')
    .replace(/\s*(?:<p>\s*)?```\s*(?:<\/p>)?\s*$/i, '')
    .trim();
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
- Zwróć TYLKO poprawiony HTML, bez żadnych komentarzy ani wyjaśnień
- Nie otaczaj odpowiedzi znacznikami bloku kodu Markdown ani słowem html na początku`
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
    const corrected = stripCodeFences(data.choices?.[0]?.message?.content?.trim());
    if (!corrected) return html;

    console.log('[OPENAI] ✓ Korekta zakończona');
    return corrected;

  } catch (err) {
    console.warn('[OPENAI] Błąd:', err.message, '- pomijam');
    return html;
  }
}

// ---------- zdjęcie wpisu ----------

// Pierwszy obrazek artykułu to zdjęcie główne. processContent() usuwa go z treści,
// a tutaj bierzemy jego adres, żeby ustawić go w Shoperze jako "zdjęcie wpisu".
function extractHeroImageUrl(html) {
  if (!html) return null;
  // ta sama kolejność co w processContent(): najpierw bez JSON-LD, potem pierwszy <img>
  const clean = html.replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, '');
  const tag = clean.match(/<img[^>]*>/i);
  if (!tag) return null;
  const src = tag[0].match(/\ssrc\s*=\s*["']([^"']+)["']/i);
  if (!src) return null;
  const url = src[1].replace(/&amp;/g, '&').trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

// Shoper ogranicza liczbę zapytań API (błąd 429, wspólny limit z innymi automatyzacjami).
// Zapytania po zapisie artykułu (kategoria, zdjęcie) ponawiamy z rosnącą przerwą, zamiast od razu się poddawać.
async function shoperFetch(url, options = {}) {
  const waits = [5, 10, 20, 30, 60];   // sekundy między próbami
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt >= waits.length) return res;
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    const wait = Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : waits[attempt];
    console.warn(`[SHOPER] Limit zapytań (429) - ponawiam za ${wait} s (próba ${attempt + 2}/${waits.length + 1})`);
    await new Promise(r => setTimeout(r, wait * 1000));
  }
}

// Shoper sam pobiera plik spod podanego adresu (pole image_url) i zapisuje go jako zdjęcie wpisu.
async function setNewsImage(token, newsId, imageUrl) {
  const url = `https://${SHOPER_URL}/webapi/rest/news/${newsId}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const put = await shoperFetch(url, { method: 'PUT', headers, body: JSON.stringify({ image_url: imageUrl }) });
  if (!put.ok) throw new Error(`PUT image_url: ${put.status} - ${await put.text()}`);

  const check = await shoperFetch(url, { headers });
  const news = await check.json();
  if (!news.image_file) throw new Error('Shoper nie zapisał zdjęcia (image_file puste)');
  return news.image_file;
}

// Przypisuje wpis do kategorii bloga. Shoper przyjmuje pole "categories"
// (pole "news_categories" jest po cichu ignorowane).
async function setNewsCategory(token, newsId, categoryId) {
  const put = await shoperFetch(`https://${SHOPER_URL}/webapi/rest/news/${newsId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ categories: [categoryId] })
  });
  if (!put.ok) throw new Error(`PUT categories: ${put.status} - ${await put.text()}`);
}

// Republikacja z BabyLove wysyła ten sam adres co przy pierwszej publikacji.
// Shoper nie filtruje wpisów po seo_url (404), więc przeglądamy listę stronami.
// Wywoływane tylko po konflikcie adresu, więc nie obciąża limitu API przy nowych wpisach.
async function findNewsBySeoUrl(token, seoUrl) {
  const headers = { 'Authorization': `Bearer ${token}` };
  for (let page = 1; page <= 50; page++) {
    const res = await shoperFetch(`https://${SHOPER_URL}/webapi/rest/news?limit=50&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GET news (strona ${page}): ${res.status}`);
    const data = await res.json();
    const hit = (data.list || []).find(n => n.seo_url === seoUrl);
    if (hit) return hit;
    if (page >= parseInt(data.pages || '1', 10)) return null;
  }
  return null;
}

// Aktualizacja istniejącego wpisu: tylko treść i pola SEO.
// Stan aktywny, adres, kategoria, data, autor i zdjęcie wpisu zostają bez zmian.
async function updateExistingNews(token, existing, payload) {
  const fields = ['name', 'content', 'short_content', 'seo_title', 'seo_description'];
  const body = Object.fromEntries(fields.map(f => [f, payload[f]]));
  console.log(`[UPDATE] Wpis ${existing.news_id} już istnieje ("${existing.name}") - aktualizuję treść i SEO`);
  const put = await shoperFetch(`https://${SHOPER_URL}/webapi/rest/news/${existing.news_id}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!put.ok) throw new Error(`PUT news/${existing.news_id}: ${put.status} - ${await put.text()}`);
  console.log(`[UPDATE] ✓ Wpis ${existing.news_id} zaktualizowany: "${payload.name}" (aktywny: ${existing.active}, zdjęcie bez zmian)`);
}

// ---------- processContent ----------

function processContent(html) {
  if (!html) return '';
  html = stripCodeFences(html);

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
  // Łap oba warianty: id="faq" i id="najczesciej-zadawane-pytania" (i podobne)
  html = html.replace(/(<h2\s[^>]*id="(?:faq|najczesciej[^"]*pytani[^"]*)")/i, ctaButton + '$1');
  // Fallback: jeśli żaden z powyższych - wstaw przed ostatnim <h2 (ale nie jeśli już wstawiono)
  if (!html.includes('Zamów teraz')) {
    const lastH2Match = html.match(/[\s\S]*(<h2\s)/i);
    if (lastH2Match) {
      const lastIdx = html.lastIndexOf('<h2 ');
      if (lastIdx !== -1) {
        html = html.slice(0, lastIdx) + ctaButton + html.slice(lastIdx);
        console.log('[CTA] Fallback: wstawiono przed ostatnim <h2>');
      }
    }
  }

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

    const heroUrl = extractHeroImageUrl(article.content_html || '');
    let content = processContent(article.content_html || '');
    content = await validateLinks(content);
    content = await correctWithOpenAI(content);

    const payload = {
      active: '0',
      box: '0',   // "Moduł" wyłączony - wpis jest widoczny na blogu przez kategorię
      lang_id: '1',
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

    // Konflikt adresu = republikacja poprawionego artykułu -> aktualizujemy istniejący wpis
    if (response.status === 400 && /seo_url/.test(responseText)) {
      // adres z komunikatu Shopera, np. "...konfliktujący adres URL do 'blog/wpis/x'"
      let conflictUrl = slug;
      try {
        const m = (JSON.parse(responseText).error_description || '').match(/'([^']+)'\s*$/);
        if (m) conflictUrl = m[1];
      } catch (e) { /* zostaje slug */ }
      const existing = await findNewsBySeoUrl(token, conflictUrl);
      if (!existing) throw new Error(`Konflikt adresu ${slug}, ale nie znaleziono wpisu: ${responseText}`);
      await updateExistingNews(token, existing, payload);
      return;
    }

    if (!response.ok) throw new Error(`Shoper news failed: ${response.status} - ${responseText}`);

    console.log(`[SHOPER] ✓ Artykuł zapisany, ID: ${responseText.trim()}`);

    // Zdjęcie wpisu - osobny try/catch, błąd tutaj nie cofa zapisanego artykułu
    const newsId = parseInt(responseText.replace(/[^0-9]/g, ''), 10);

    // Kategoria - osobnym zapisem, tak jak sprawdzono w API; błąd nie cofa artykułu
    if (Number.isInteger(newsId)) {
      try {
        await setNewsCategory(token, newsId, NEWS_CATEGORY_ID);
        console.log(`[CATEGORY] ✓ Wpis przypisany do kategorii ${NEWS_CATEGORY_ID}`);
      } catch (catErr) {
        console.warn(`[CATEGORY] Nie udało się przypisać kategorii: ${catErr.message}`);
      }
    }

    if (!heroUrl) {
      console.log('[IMAGE] Brak pierwszego obrazka w artykule - wpis bez zdjęcia');
    } else if (!Number.isInteger(newsId)) {
      console.warn('[IMAGE] Nie rozpoznano ID wpisu - zdjęcie nieustawione');
    } else {
      try {
        const file = await setNewsImage(token, newsId, heroUrl);
        console.log(`[IMAGE] ✓ Zdjęcie wpisu ustawione: ${file}`);
      } catch (imgErr) {
        console.warn(`[IMAGE] Nie udało się ustawić zdjęcia wpisu (${heroUrl}): ${imgErr.message}`);
      }
    }

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

