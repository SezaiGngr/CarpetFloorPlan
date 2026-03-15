export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { imageB64, carpetedRooms } = await req.json();

    const prompt = `You are a professional carpet installation quantity surveyor.
Analyse this floor plan image carefully.
Carpeted areas for this job: ${carpetedRooms}

RESPOND WITH ONLY A JSON OBJECT. No text before or after. No markdown. No code fences.
Start with { and end with }.

{
  "scale": {
    "ratio": "128px/m",
    "references": ["Living/Dining 3.6m wide = 460px"]
  },
  "rooms": [
    {
      "name": "Bed 1",
      "widthM": 3.2,
      "lengthM": 3.0,
      "dimensionSource": "labelled",
      "position": { "x": 0.54, "y": 0.76 },
      "size": { "w": 0.28, "h": 0.22 },
      "doorWall": "west",
      "notes": ""
    }
  ],
  "sanityFlags": [],
  "totalAreaM2": 9.6
}

Rules:
- position x,y = top-left of room as fraction of full image (0.0–1.0)
- size w,h = room width/height as fraction of full image (0.0–1.0)
- dimensionSource: "labelled" if shown on plan, "scaled" if calculated
- doorWall: north / south / east / west
- totalAreaM2 = sum of all widthM × lengthM`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: imageB64
              }
            },
            { type: "text", text: prompt }
          ]
        }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const text = data.content?.find(b => b.type === "text")?.text || "";
    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

export const config = { path: "/api/analyse" };