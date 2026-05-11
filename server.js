const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BABYLOVE_SECRET = process.env.BABYLOVE_SECRET;
const SHOPER_URL = process.env.SHOPER_URL; // np. magnificentcoffee.pl
const SHOPER_LOGIN = process.env.SHOPER_LOGIN;
const SHOPER_PASSWORD = process.env.SHOPER_PASSWORD;

// Pomocnicza funkcja: pobierz token z Shoper API
async function getShoperToken() {
  const credentials = Buffer.from(`${SHOPER_LOGIN}:${SHOPER_PASSWORD}`).toString('base64');
  const response = await fetch(`https://${SHOPER_URL}/webapi/rest/auth`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Shoper auth failed: ${response.status}`);
  }

  const data = await response.json();
  return data.token;
}

// Pomocnicza funkcja: stwórz wpis blogowy w Shoperze jako szkic
async function createBlogPost(token, article) {
  const response = await fetch(`https://${SHOPER_URL}/webapi/rest/blogposts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      active: '0', // szkic - nieaktywny
      translations: {
        pl: {
          name: article.title,
          body: article.content_html,
          meta_title: article.title,
          meta_description: article.metaDescription || '',
          friendly_url: article.slug || ''
        }
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Shoper blog post failed: ${response.status} - ${err}`);
  }

  return await response.json();
}

// Główny endpoint webhook
app.post('/webhook', async (req, res) => {
  // Sprawdź token autoryzacji
  const authHeader = req.headers['authorization'];
  const expectedAuth = `Bearer ${BABYLOVE_SECRET}`;

  if (!authHeader || authHeader !== expectedAuth) {
    console.log('Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const article = req.body;
  console.log('Received article:', article.title);

  try {
    const token = await getShoperToken();
    console.log('Shoper token obtained');

    const result = await createBlogPost(token, article);
    console.log('Blog post created in Shoper, ID:', result.blog_post_id);

    return res.status(200).json({
      success: true,
      blog_post_id: result.blog_post_id
    });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BabyLove webhook server running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
