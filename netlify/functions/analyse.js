export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { imageB64 } = await req.json();

    const prompt = `You are an expert architectural floor plan analyst.

Analyse this floor plan image carefully. Your task is to map every room's position and size as a grid so they fit together like puzzle pieces — NO overlaps allowed.

CRITICAL RULE: Rooms must NOT overlap. If room A ends at x=0.5, room B that sits beside it starts at x=0.5. They share an edge but never overlap.

STEP 1 — ESTABLISH SCALE
Find labelled rooms and calculate pixels per metre.

STEP 2 — MAP THE GRID
Think of the entire floor plan as a rectangle from (0,0) to (1,1).
For EACH room, define:
- position.x, position.y = top-left corner of this room (fractions 0.0–1.0)
- size.w, size.h = width and height of this room (fractions 0.0–1.0)

RULES FOR NON-OVERLAPPING:
- Two rooms side by side: left.x + left.size.w = right.x (they share a wall edge)
- Two rooms top/bottom: top.y + top.size.h = bottom.y (they share a wall edge)  
- A room ABOVE another must have a SMALLER y value
- Room areas must match their labelled dimensions proportionally
- Check: for any two rooms A and B, they must NOT satisfy ALL of:
  A.x < B.x+B.w AND A.x+A.w > B.x AND A.y < B.y+B.h AND A.y+A.h > B.y

STEP 3 — DETECT YELLOW MARKINGS
Yellow highlights on walls = doors or windows.
Record wall (north/south/east/west), position along wall (posStart 0–1, posEnd 0–1), widthM, type (door/window).

RESPOND WITH ONLY A JSON OBJECT. No text. No markdown. Start with { end with }.

{
  "scale": {
    "ratio": "64px/m",
    "pxPerM": 64,
    "references": ["Living 5m wide = 320px"]
  },
  "rooms": [
    {
      "name": "Bed 2",
      "widthM": 2.8,
      "lengthM": 3.6,
      "dimensionSource": "labelled",
      "position": { "x": 0.00, "y": 0.00 },
      "size": { "w": 0.28, "h": 0.35 },
      "openings": [
        { "type": "door", "wall": "south", "posStart": 0.6, "posEnd": 0.9, "widthM": 0.9 }
      ],
      "notes": ""
    },
    {
      "name": "Bath",
      "widthM": 2.8,
      "lengthM": 2.5,
      "dimensionSource": "labelled",
      "position": { "x": 0.28, "y": 0.00 },
      "size": { "w": 0.18, "h": 0.28 },
      "openings": [],
      "notes": ""
    },
    {
      "name": "Bed 1",
      "widthM": 3.9,
      "lengthM": 3.6,
      "dimensionSource": "labelled",
      "position": { "x": 0.46, "y": 0.00 },
      "size": { "w": 0.36, "h": 0.35 },
      "openings": [],
      "notes": ""
    }
  ],
  "sanityFlags": [],
  "totalAreaM2": 45.0
}

IMPORTANT LAYOUT VERIFICATION — before outputting, mentally check each pair of rooms:
- Rooms in the SAME ROW: their y and y+h ranges must overlap, their x ranges must NOT overlap
- Rooms in DIFFERENT ROWS: their y ranges must NOT overlap
- No two rooms should have overlapping x AND y ranges at the same time`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } },
            { type: "text", text: prompt }
          ]
        }]
      })
    });

    const data = await response.json();
    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    const text = data.content?.find(b => b.type === "text")?.text || "";
    return new Response(JSON.stringify({ text }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
};

export const config = { path: "/api/analyse" };
