export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const MAX_RETRIES = 5;
  let waitMs = 8000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    // On rate limit, read retry-after header and wait server-side
    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        return res.status(429).json({ error: 'Rate limit exceeded after retries' });
      }

      // Anthropic sends retry-after header with seconds to wait
      const retryAfter = response.headers.get('retry-after');
      const waitSeconds = retryAfter ? parseInt(retryAfter) * 1000 : waitMs;

      console.log(`429 rate limit — waiting ${waitSeconds/1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, waitSeconds));
      waitMs = Math.min(waitMs * 2, 60000); // exponential backoff fallback
      continue;
    }

    const data = await response.json();
    return res.status(response.status).json(data);
  }
}
