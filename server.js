const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const BABYLOVE_SECRET = process.env.BABYLOVE_SECRET;
const SHOPER_URL = process.env.SHOPER_URL;
const SHOPER_LOGIN = process.env.SHOPER_LOGIN;
const SHOPER_PASSWORD = process.env.SHOPER_PASSWORD;

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

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, c => ({ ą:'a',ć:'c',ę:'e',ł:'l',ń:'n',ó:'o',ś:'s',ź:'z',ż:'z' })[c] || c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function processContent(html) {
  // Usuń cały blok 
  html = html.replace(/]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, '');

  // Usuń pierwsze wystąpienie  (hero image które jest w treści)
  html = html.replace(/]*>/i, '');

  // Usuń znaczniki , , , 

,  itp.
  html = html.replace(/]*>/gi, '');
  html = html.replace(/]*>/gi, '');
  html = html.replace(/<\/html>/gi, '');
  html = html.replace(/]*>[\s\S]*?<\/head>/gi, '');
  html = html.replace(/]*>/gi, '');
  html = html.replace(/<\/body>/gi, '');
  html = html.replace(/]*>/gi, '');
  html = html.replace(/<\/article>/gi, '');

  // Styluj tabelki
  html = html.replace(/]*style)[^>]*>/g, '');
  html = html.replace(/([\s\S]*?)<\/thead>/g, (match, inner) => {
    const styledInner = inner.replace(/]*style)[^>]*>/g, '');
    return `${styledInner}`;
  });
  html = html.replace(/]*style)[^>]*>/g, '
');
  html = html.replace(/]*style)[^>]*>/g, '	');

  // Usuń nadmiarowe białe znaki
  html = html.replace(/\n{3,}/g, '\n\n').trim();

  return html;
}

async function uploadImageToShoper(token, newsId, imageUrl) {
  try {
    const imgResponse = await fetch(imageUrl);
    if (!imgResponse.ok) throw new Error(`Failed to fetch image: ${imgResponse.status}`);

    const imgBuffer = await imgResponse.buffer();
    const base64 = imgBuffer.toString('base64');
    const ext = imageUrl.split('.').pop().split('?')[0].toLowerCase() || 'jpg';
    const filename = `hero-${newsId}.${ext}`;

    const uploadResponse = await fetch(`https://${SHOPER_URL}/webapi/rest/news-images`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        news_id: String(newsId),
        image: base64,
        filename: filename
      })
    });

    const uploadText = await uploadResponse.text();
    console.log(`[SHOPER] Image upload ${uploadResponse.status}:`, uploadText);
  } catch (err) {
    console.error('[SHOPER] Image upload error:', err.message);
    // Nie rzucamy błędu — artykuł zostaje zapisany nawet bez zdjęcia
  }
}

async function createBlogPost(token, article) {
  const slug = article.slug
    ? `blog/wpis/${article.slug}`
    : `blog/wpis/${slugify(article.title || 'artykul')}`;

  const content = processContent(article.content_html || '');

  const payload = {
    active: '0',
    lang_id: '1',
    news_category_id: '4',
    author: 'Magnificent Coffee',
    name: article.title || 'Bez tytułu',
    content: content,
    short_content: article.metaDescription ? `
${article.metaDescription}

` : '',
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

    if (article.heroImageUrl) {
      console.log('[SHOPER] Uploading hero image:', article.heroImageUrl);
      await uploadImageToShoper(token, newsId, article.heroImageUrl);
    }

    return res.status(200).json({ success: true, shoper_news_id: newsId });
  } catch (error) {
    console.error('[ERROR]', error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BabyLoveGrowth → Shoper webhook running' });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});
