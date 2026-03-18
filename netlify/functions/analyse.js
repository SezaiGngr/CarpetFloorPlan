export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { imageB64, imgW, imgH } = await req.json();

    const prompt = `You are an expert architectural floor plan analyst.

Analyse this floor plan image (${imgW} x ${imgH} pixels).

YOUR TASK: For each room, find its exact pixel bounding box in the image.

PIXEL COORDINATE RULES:
- pixel_x increases going RIGHT (left edge of image = 0, right edge = ${imgW})
- pixel_y increases going DOWN (top edge of image = 0, bottom edge = ${imgH})
- pixel_left = x coordinate of the LEFT wall of this room
- pixel_top = y coordinate of the TOP wall of this room
- pixel_right = x coordinate of the RIGHT wall of this room
- pixel_bottom = y coordinate of the BOTTOM wall of this room

HOW TO MEASURE:
1. Find the floor plan boundary in the image
2. For each room, look at where its walls are in the image
3. Record the pixel coordinates of each wall precisely
4. Rooms sharing a wall will have matching pixel values (e.g. room A pixel_right = room B pixel_left)

STEP 1 - SCALE
Find labelled rooms, measure them in pixels, calculate px/metre.

STEP 2 - MAP EVERY ROOM
Measure pixel_left, pixel_top, pixel_right, pixel_bottom for each room.

STEP 3 - DETECT YELLOW MARKINGS
Yellow highlights on walls = doors or windows.
For each yellow marking record: wall (north/south/east/west), posStart (0-1 along that wall), posEnd (0-1), widthM, type (door or window).

RESPOND WITH ONLY RAW JSON. No text. No markdown. Start with { end with }.

{
  "imageWidth": ${imgW},
  "imageHeight": ${imgH},
  "scale": {
    "ratio": "2.5px/cm or 25px/m",
    "pxPerM": 25.0,
    "references": ["Lounge 3.8m wide = measured 95px wide in image"]
  },
  "rooms": [
    {
      "name": "Covered Entertaining Area",
      "widthM": 4.0,
      "lengthM": 11.7,
      "dimensionSource": "labelled",
      "pixel_left": 120,
      "pixel_top": 45,
      "pixel_right": 420,
      "pixel_bottom": 340,
      "openings": [],
      "notes": ""
    },
    {
      "name": "Bedroom 2",
      "widthM": 2.5,
      "lengthM": 3.6,
      "dimensionSource": "labelled",
      "pixel_left": 120,
      "pixel_top": 340,
      "pixel_right": 280,
      "pixel_bottom": 520,
      "openings": [
        { "type": "door", "wall": "east", "posStart": 0.5, "posEnd": 0.85, "widthM": 0.9 }
      ],
      "notes": ""
    }
  ],
  "totalAreaM2": 0
}

CRITICAL: pixel_left < pixel_right always. pixel_top < pixel_bottom always.
Rooms that share a wall must have matching pixel values.
Include ALL rooms visible on the plan.`;

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
