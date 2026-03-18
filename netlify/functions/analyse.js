export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { imageB64 } = await req.json();

    const prompt = `You are an expert architectural floor plan analyst.

Carefully analyse this floor plan image. Your job is to map every room's EXACT position and size so I can redraw the floor plan accurately.

CRITICAL INSTRUCTIONS:
1. Look at the entire floor plan boundary first
2. For each room, measure its position relative to the TOTAL floor plan bounding box
3. position x,y = distance from TOP-LEFT of the entire floor plan as a fraction (0.0 to 1.0)
4. size w,h = room's width and height as a fraction of the TOTAL floor plan width/height
5. Rooms that share walls should have touching edges (e.g. if room A ends at x=0.5, room B starts at x=0.5)
6. Read ALL labelled dimensions from the plan text
7. For scale: find at least 2 labelled rooms, calculate pixels per metre

RESPOND WITH ONLY A JSON OBJECT. No text. No markdown. Start with { end with }.

{
  "scale": {
    "ratio": "128px/m",
    "pxPerM": 128,
    "references": ["Living/Dining 3.6m = 460px horizontal"]
  },
  "planBounds": {
    "description": "The outer boundary of the entire floor plan"
  },
  "rooms": [
    {
      "name": "Living/Dining",
      "widthM": 3.6,
      "lengthM": 5.2,
      "dimensionSource": "labelled",
      "position": { "x": 0.18, "y": 0.05 },
      "size": { "w": 0.42, "h": 0.45 },
      "wallTop": true,
      "wallRight": true,
      "wallBottom": true,
      "wallLeft": true,
      "doorWall": "south",
      "doorPos": 0.3,
      "notes": ""
    }
  ],
  "sanityFlags": [],
  "totalAreaM2": 18.72
}

RULES:
- Every room must be included — bedrooms, living, dining, kitchen, bathroom, hallway, laundry, balcony, robe, ensuite, everything visible
- Positions must reflect the ACTUAL layout — rooms next to each other should have matching edges
- wallTop/Right/Bottom/Left = true if that side has an exterior or shared wall
- doorWall: which wall has the door opening (north/south/east/west)
- doorPos: position of door along that wall as fraction 0-1
- dimensionSource: "labelled" if plan shows the number, "scaled" if you calculated it
- totalAreaM2: sum of all widthM x lengthM`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: imageB64 }
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
