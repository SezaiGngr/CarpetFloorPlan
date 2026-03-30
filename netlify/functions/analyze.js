const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) }
  }

  var apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY env var is not set on the server. Add it in Netlify Site Configuration > Environment Variables.' } })
    }
  }

  // Trim whitespace that may have been pasted with the key
  apiKey = apiKey.trim()

  try {
    var body = JSON.parse(event.body)

    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body)
    })

    var data = await response.json()

    if (response.status === 401) {
      data.error = data.error || {}
      data.error.message = (data.error.message || 'invalid key') +
        ' | Key starts with: ' + apiKey.slice(0, 10) +
        '... | Length: ' + apiKey.length +
        ' | Had extra whitespace: ' + (apiKey !== process.env.ANTHROPIC_API_KEY)
    }

    return {
      statusCode: response.status,
      headers: CORS_HEADERS,
      body: JSON.stringify(data)
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: { message: err.message } })
    }
  }
}
