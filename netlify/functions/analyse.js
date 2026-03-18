export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { imageB64 } = await req.json();

    const prompt = `You are an expert architectural floor plan analyst.

Analyse this floor plan image. Map every room's position accurately.

═══════════════════════════════════════════════
COORDINATE SYSTEM — READ THIS CAREFULLY:
═══════════════════════════════════════════════
• The floor plan is a rectangle. Top-left corner = (x:0, y:0). Bottom-right corner = (x:1, y:1).
• x axis = HORIZONTAL. x increases going RIGHT across the image. LEFT rooms have SMALL x. RIGHT rooms have LARGE x.
• y axis = VERTICAL. y increases going DOWN the image. TOP rooms have SMALL y. BOTTOM rooms have LARGE y.
• position.x = how far from the LEFT edge (0=far left, 1=far right)
• position.y = how far from the TOP edge (0=very top, 1=very bottom)
• size.w = room width as fraction of total plan WIDTH (horizontal)
• size.h = room height as fraction of total plan HEIGHT (vertical)

EXAMPLE — a room in the TOP-LEFT corner:
  position: { x: 0.0, y: 0.0 }, size: { w: 0.3, h: 0.2 }

EXAMPLE — a room in the BOTTOM-RIGHT corner:
  position: { x: 0.7, y: 0.8 }, size: { w: 0.3, h: 0.2 }

EXAMPLE — a room directly to the RIGHT of the above top-left room:
  position: { x: 0.3, y: 0.0 }, size: { w: 0.3, h: 0.2 }

EXAMPLE — a room directly BELOW the top-left room:
  position: { x: 0.0, y: 0.2 }, size: { w: 0.3, h: 0.2 }
═══════════════════════════════════════════════

STEP 1 — ESTABLISH SCALE
Find at least 2 rooms with labelled dimensions. Calculate pixels per metre.

STEP 2 — IDENTIFY ROWS
Look at the floor plan and list which rooms are on the same horizontal level (same row).
For example:
  Row 1 (top): Bedroom 2, Bath, WC, Laundry
  Row 2 (middle): Dining, Kitchen
  Row 3 (bottom): Main Bedroom, Bedroom 3, Lounge

STEP 3 — ASSIGN COORDINATES
For each room:
- Rooms in the SAME ROW have the SAME or similar position.y value
- Rooms side by side have DIFFERENT position.x values
- A room to the RIGHT of another has a LARGER position.x
- A room BELOW another has a LARGER position.y
- NO TWO ROOMS should overlap (their rectangles must not intersect)

STEP 4 — DETECT YELLOW MARKINGS
Yellow highlights on walls = doors or windows.
Record: wall (north/south/east/west), posStart (0–1), posEnd (0–1), widthM, type (door or window).

RESPOND WITH ONLY A JSON OBJECT. No text before or after. No markdown. Start with { end with }.

{
  "scale": {
    "ratio": "64px/m",
    "pxPerM": 64,
    "references": ["Lounge 3.8m wide = 243px horizontal"]
  },
  "layoutRows": [
    "Row 1 (y≈0.0–0.25): Bedroom 2, WC, Bath, Laundry",
    "Row 2 (y≈0.25–0.55): Dining, Kitchen, Main Bedroom",
    "Row 3 (y≈0.55–0.85): Bedroom 3, Lounge"
  ],
  "rooms": [
    {
      "name": "Bedroom 2",
      "widthM": 2.5,
      "lengthM": 3.6,
      "dimensionSource": "labelled",
      "position": { "x": 0.00, "y": 0.22 },
      "size": { "w": 0.22, "h": 0.28 },
      "openings": [
        { "type": "door", "wall": "east", "posStart": 0.6, "posEnd": 0.9, "widthM": 0.9 }
      ],
      "notes": ""
    },
    {
      "name": "WC",
      "widthM": 1.2,
      "lengthM": 2.0,
      "dimensionSource": "scaled",
      "position": { "x": 0.22, "y": 0.22 },
      "size": { "w": 0.10, "h": 0.14 },
      "openings": [],
      "notes": "shares north wall with Bath"
    },
    {
      "name": "Bath",
      "widthM": 1.8,
      "lengthM": 2.2,
      "dimensionSource": "labelled",
      "position": { "x": 0.32, "y": 0.22 },
      "size": { "w": 0.16, "h": 0.18 },
      "openings": [],
      "notes": ""
    }
  ],
  "sanityFlags": [],
  "totalAreaM2": 0
}

FINAL CHECK before responding:
For every pair of rooms A and B, verify they do NOT both satisfy:
  A.x < B.x+B.w  AND  A.x+A.w > B.x  AND  A.y < B.y+B.h  AND  A.y+A.h > B.y
If any pair overlaps, fix by adjusting x or y so they share an edge but do not overlap.`;

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
