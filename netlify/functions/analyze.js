export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const body = await req.json()

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body)
    })

    const data = await response.json()

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: err.message } }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    })
  }
}

export const config = { path: '/api/analyze' }
```

---

**After pasting and committing, also make sure:**

1. `FloorPlanAnalyzer.jsx` calls `/api/analyze` — open it on GitHub, press Ctrl+F, search for `fetch(` — it must say `fetch('/api/analyze'` not `fetch('https://api.anthropic`

2. `ANTHROPIC_API_KEY` is set in Netlify environment variables (you already have this ✅)

3. `netlify.toml` has this redirect (you already have this ✅):
```
[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200
