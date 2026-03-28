import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 1200

// ─── AI PROMPT ────────────────────────────────────────────────────────────────
// The key insight: we ask the AI to return ABSOLUTE coordinates for every room.
// No adjacency, no grid rows, no BFS. The AI looks at the image and tells us
// exactly where each room sits in a meter-based coordinate system.
// The renderer just draws what the AI says — no layout engine needed.

const ANALYSIS_PROMPT = `You are an expert architectural floor plan analyzer.

COORDINATE SYSTEM:
- Origin (0, 0) is the TOP-LEFT corner of the entire floor plan
- X axis goes RIGHT (increasing x = further right)  
- Y axis goes DOWN (increasing y = further down)
- All measurements are in METERS

TASK: Analyze this floor plan image and return a JSON object with this EXACT structure:

{
  "rooms": [
    {
      "name": "Bed 1",
      "x": 0,
      "y": 0,
      "width": 3.7,
      "height": 3.0,
      "label": "3.7 x 3.0"
    }
  ],
  "walls": [
    {
      "x1": 0, "y1": 0, "x2": 3.7, "y2": 0,
      "type": "exterior"
    }
  ],
  "doors": [
    {
      "x": 2.0,
      "y": 3.0,
      "width": 0.82,
      "orientation": "horizontal",
      "swing": "down-right",
      "connects": ["Bed 1", "Hallway"]
    }
  ]
}

CRITICAL RULES:

1. ROOMS: Return EVERY room visible in the floor plan. For each room, provide:
   - "name": The room label as shown (e.g., "Bed 1", "Living", "Kitchen")
   - "x", "y": Top-left corner position in meters from the floor plan's top-left
   - "width": Horizontal extent (left to right) in meters
   - "height": Vertical extent (top to bottom) in meters
   - "label": Dimension text like "3.7 x 3.0"
   
   IMPORTANT: Rooms that share a wall MUST have EXACTLY matching coordinates at that wall.
   Example: If Bed 1 goes from x=0 to x=3.7, and Bed 2 starts at Bed 1's right edge,
   then Bed 2 must have x=3.7 (not 3.71 or 3.69).

2. WALLS: Return EVERY wall segment as a line. Include:
   - ALL exterior walls (type: "exterior")
   - ALL interior walls between rooms (type: "interior")  
   - Walls are straight lines. A wall along the top of a room at y=0 from x=0 to x=3.7
     would be: {"x1": 0, "y1": 0, "x2": 3.7, "y2": 0, "type": "exterior"}
   - Where a door exists, SPLIT the wall into two segments with a gap for the door.
     Do NOT include the door gap as a wall segment.
   - Interior walls shared by two rooms should appear ONCE, not twice.

3. DOORS: Return every door with:
   - "x", "y": The starting position of the door opening (top-left of the gap)
   - "width": Door width in meters (typically 0.7-0.9m)
   - "orientation": "horizontal" if the door gap is along a horizontal wall (top/bottom of room),
                     "vertical" if along a vertical wall (left/right of room)
   - "swing": Direction the door swings. One of:
     "down-right", "down-left", "up-right", "up-left" (for horizontal orientation)
     "right-down", "right-up", "left-down", "left-up" (for vertical orientation)
   - "connects": Array of two room names the door connects

4. Read dimension annotations from the image carefully. Numbers like "3.7 x 3.0" or 
   "3700 x 3000" tell you exact room dimensions. Use these to calibrate all coordinates.

5. Rooms must tile together with NO gaps and NO overlaps. Adjacent rooms share exact edges.

Return ONLY valid JSON. No markdown, no explanation, no backticks.`


export default function FloorPlanAnalyzer() {
  const [image, setImage] = useState(null)
  const [imageData, setImageData] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const canvasRef = useRef(null)
  const fileRef = useRef(null)
  const imgRef = useRef(null)

  // ─── Image Upload ──────────────────────────────────────────────────────
  const handleFile = useCallback((file) => {
    if (!file?.type?.startsWith('image/')) return
    setError(null)
    setAnalysis(null)

    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        // Resize if needed
        const scale = img.width > MAX_IMG_WIDTH ? MAX_IMG_WIDTH / img.width : 1
        const c = document.createElement('canvas')
        c.width = img.width * scale
        c.height = img.height * scale
        const cx = c.getContext('2d')
        cx.drawImage(img, 0, 0, c.width, c.height)
        const dataUrl = c.toDataURL('image/jpeg', 0.85)
        const base64 = dataUrl.split(',')[1]
        setImage(dataUrl)
        setImageData(base64)
        imgRef.current = img
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  }, [])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    e.currentTarget.classList.remove('drag')
    handleFile(e.dataTransfer.files[0])
  }, [handleFile])

  // ─── API Call ──────────────────────────────────────────────────────────
  const analyze = async () => {
    if (!imageData) return
    setLoading(true)
    setError(null)
    setAnalysis(null)

    try {
      const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('Set VITE_ANTHROPIC_API_KEY in environment')

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
              { type: 'text', text: ANALYSIS_PROMPT }
            ]
          }]
        })
      })

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        throw new Error(errData?.error?.message || `API error ${resp.status}`)
      }

      const data = await resp.json()
      const text = data.content?.map(b => b.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      if (!parsed.rooms?.length) throw new Error('No rooms found in analysis')
      setAnalysis(parsed)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ─── Draw Floor Plan ──────────────────────────────────────────────────
  useEffect(() => {
    if (!analysis?.rooms?.length) return
    drawFloorPlan()
  }, [analysis, showOriginal])

  const drawFloorPlan = () => {
    const canvas = canvasRef.current
    if (!canvas || !analysis) return

    const rooms = analysis.rooms || []
    const walls = analysis.walls || []
    const doors = analysis.doors || []

    if (rooms.length === 0) return

    // ── Scale calculation ──────────────────────────────────────────────
    // Find bounding box of all rooms
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    rooms.forEach(r => {
      minX = Math.min(minX, r.x)
      minY = Math.min(minY, r.y)
      maxX = Math.max(maxX, r.x + r.width)
      maxY = Math.max(maxY, r.y + r.height)
    })

    const totalW = maxX - minX
    const totalH = maxY - minY

    // Canvas sizing
    const PAD = 70  // padding for dimension labels
    const PX_PER_M = Math.min(
      (800 - PAD * 2) / totalW,
      (700 - PAD * 2) / totalH,
      100  // max zoom
    )

    const cw = totalW * PX_PER_M + PAD * 2
    const ch = totalH * PX_PER_M + PAD * 2

    canvas.width = cw
    canvas.height = ch

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, cw, ch)

    // White background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cw, ch)

    // Coordinate transforms (meters → canvas pixels)
    const X = (m) => PAD + (m - minX) * PX_PER_M
    const Y = (m) => PAD + (m - minY) * PX_PER_M
    const S = (m) => m * PX_PER_M

    // ── Room fills ─────────────────────────────────────────────────────
    const ROOM_COLORS = [
      '#F0F7FF', '#FFF7ED', '#F0FDF4', '#FDF2F8', '#FFFBEB',
      '#F5F3FF', '#ECFDF5', '#FEF2F2', '#EFF6FF', '#FFF1F2'
    ]

    rooms.forEach((r, i) => {
      ctx.fillStyle = ROOM_COLORS[i % ROOM_COLORS.length]
      ctx.fillRect(X(r.x), Y(r.y), S(r.width), S(r.height))
    })

    // ── Draw ALL walls ─────────────────────────────────────────────────
    // If AI provided explicit walls, use them.
    // Otherwise, compute walls from room edges.

    const WALL_W_EXT = 4    // exterior wall thickness
    const WALL_W_INT = 2.5  // interior wall thickness

    if (walls.length > 0) {
      // Draw AI-provided walls
      walls.forEach(w => {
        ctx.beginPath()
        ctx.moveTo(X(w.x1), Y(w.y1))
        ctx.lineTo(X(w.x2), Y(w.y2))
        ctx.strokeStyle = '#1a1a1a'
        ctx.lineWidth = w.type === 'exterior' ? WALL_W_EXT : WALL_W_INT
        ctx.lineCap = 'round'
        ctx.stroke()
      })
    } else {
      // Fallback: compute walls from room edges
      drawWallsFromRooms(ctx, rooms, doors, X, Y, S, WALL_W_EXT, WALL_W_INT)
    }

    // ── Draw doors ─────────────────────────────────────────────────────
    doors.forEach(door => {
      drawDoor(ctx, door, X, Y, S)
    })

    // ── Room labels ────────────────────────────────────────────────────
    rooms.forEach(r => {
      const cx = X(r.x + r.width / 2)
      const cy = Y(r.y + r.height / 2)
      const fontSize = Math.max(10, Math.min(14, S(Math.min(r.width, r.height)) / 6))

      // Room name
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#1f2937'
      ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`
      ctx.fillText(r.name, cx, cy - fontSize * 0.7)

      // Dimensions
      ctx.fillStyle = '#6b7280'
      ctx.font = `400 ${fontSize * 0.85}px "Segoe UI", system-ui, sans-serif`
      const dimText = r.label || `${r.width.toFixed(1)} × ${r.height.toFixed(1)}`
      ctx.fillText(dimText, cx, cy + fontSize * 0.5)
    })

    // ── Dimension lines (outside the floor plan) ───────────────────────
    drawDimensionLines(ctx, rooms, X, Y, S, PAD, minX, minY, maxX, maxY)

    // ── North arrow ────────────────────────────────────────────────────
    ctx.fillStyle = '#9ca3af'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText('N ↑', cw - 8, 8)
  }

  // ─── Compute walls from room edges (fallback) ─────────────────────────
  const drawWallsFromRooms = (ctx, rooms, doors, X, Y, S, wallExt, wallInt) => {
    // Collect all edges from all rooms
    // An edge is: {x1, y1, x2, y2, roomIndex}
    // We'll detect shared edges = interior walls, unshared = exterior walls

    const SNAP = 0.05  // 5cm tolerance for matching edges

    const edges = []
    rooms.forEach((r, idx) => {
      // Top edge (left to right)
      edges.push({ x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y, ri: idx })
      // Bottom edge
      edges.push({ x1: r.x, y1: r.y + r.height, x2: r.x + r.width, y2: r.y + r.height, ri: idx })
      // Left edge (top to bottom)
      edges.push({ x1: r.x, y1: r.y, x2: r.x, y2: r.y + r.height, ri: idx })
      // Right edge
      edges.push({ x1: r.x + r.width, y1: r.y, x2: r.x + r.width, y2: r.y + r.height, ri: idx })
    })

    // Normalize edges so x1<=x2 and y1<=y2 for comparison
    const norm = (e) => ({
      ...e,
      x1: Math.min(e.x1, e.x2),
      y1: Math.min(e.y1, e.y2),
      x2: Math.max(e.x1, e.x2),
      y2: Math.max(e.y1, e.y2)
    })

    const normed = edges.map(norm)

    // Check if two edges overlap (share a segment)
    const isHorizontal = (e) => Math.abs(e.y1 - e.y2) < SNAP
    const isVertical = (e) => Math.abs(e.x1 - e.x2) < SNAP

    // Find which edges are shared (interior) vs unique (exterior)
    const edgeType = new Array(edges.length).fill('exterior')

    for (let i = 0; i < normed.length; i++) {
      for (let j = i + 1; j < normed.length; j++) {
        if (normed[i].ri === normed[j].ri) continue // same room

        const a = normed[i], b = normed[j]

        if (isHorizontal(a) && isHorizontal(b)) {
          // Both horizontal — check if same y and overlapping x range
          if (Math.abs(a.y1 - b.y1) < SNAP) {
            const overlapStart = Math.max(a.x1, b.x1)
            const overlapEnd = Math.min(a.x2, b.x2)
            if (overlapEnd - overlapStart > SNAP) {
              edgeType[i] = 'interior'
              edgeType[j] = 'interior'
            }
          }
        } else if (isVertical(a) && isVertical(b)) {
          // Both vertical — check if same x and overlapping y range
          if (Math.abs(a.x1 - b.x1) < SNAP) {
            const overlapStart = Math.max(a.y1, b.y1)
            const overlapEnd = Math.min(a.y2, b.y2)
            if (overlapEnd - overlapStart > SNAP) {
              edgeType[i] = 'interior'
              edgeType[j] = 'interior'
            }
          }
        }
      }
    }

    // Build wall segments, splitting for doors
    const doorSegments = doors.map(d => {
      if (d.orientation === 'horizontal') {
        return { x1: d.x, y1: d.y, x2: d.x + d.width, y2: d.y, horiz: true }
      } else {
        return { x1: d.x, y1: d.y, x2: d.x, y2: d.y + d.width, horiz: false }
      }
    })

    // Draw each edge, splitting around doors
    normed.forEach((edge, idx) => {
      const type = edgeType[idx]
      const lw = type === 'exterior' ? wallExt : wallInt

      // Check if any door intersects this edge
      const isH = isHorizontal(edge)
      const isV = isVertical(edge)

      // Find doors on this edge
      const doorsOnEdge = doorSegments.filter(ds => {
        if (isH && ds.horiz) {
          return Math.abs(ds.y1 - edge.y1) < SNAP &&
                 ds.x1 >= edge.x1 - SNAP && ds.x2 <= edge.x2 + SNAP
        }
        if (isV && !ds.horiz) {
          return Math.abs(ds.x1 - edge.x1) < SNAP &&
                 ds.y1 >= edge.y1 - SNAP && ds.y2 <= edge.y2 + SNAP
        }
        return false
      })

      if (doorsOnEdge.length === 0) {
        // Draw full edge
        ctx.beginPath()
        ctx.moveTo(X(edge.x1), Y(edge.y1))
        ctx.lineTo(X(edge.x2), Y(edge.y2))
        ctx.strokeStyle = '#1a1a1a'
        ctx.lineWidth = lw
        ctx.lineCap = 'round'
        ctx.stroke()
      } else {
        // Split edge around door gaps
        if (isH) {
          // Sort doors by x position
          const sorted = doorsOnEdge.sort((a, b) => a.x1 - b.x1)
          let curX = edge.x1
          sorted.forEach(ds => {
            if (ds.x1 > curX + SNAP) {
              ctx.beginPath()
              ctx.moveTo(X(curX), Y(edge.y1))
              ctx.lineTo(X(ds.x1), Y(edge.y1))
              ctx.strokeStyle = '#1a1a1a'
              ctx.lineWidth = lw
              ctx.lineCap = 'round'
              ctx.stroke()
            }
            curX = ds.x2
          })
          if (curX < edge.x2 - SNAP) {
            ctx.beginPath()
            ctx.moveTo(X(curX), Y(edge.y1))
            ctx.lineTo(X(edge.x2), Y(edge.y1))
            ctx.strokeStyle = '#1a1a1a'
            ctx.lineWidth = lw
            ctx.lineCap = 'round'
            ctx.stroke()
          }
        } else {
          // Vertical — sort doors by y
          const sorted = doorsOnEdge.sort((a, b) => a.y1 - b.y1)
          let curY = edge.y1
          sorted.forEach(ds => {
            if (ds.y1 > curY + SNAP) {
              ctx.beginPath()
              ctx.moveTo(X(edge.x1), Y(curY))
              ctx.lineTo(X(edge.x1), Y(ds.y1))
              ctx.strokeStyle = '#1a1a1a'
              ctx.lineWidth = lw
              ctx.lineCap = 'round'
              ctx.stroke()
            }
            curY = ds.y2
          })
          if (curY < edge.y2 - SNAP) {
            ctx.beginPath()
            ctx.moveTo(X(edge.x1), Y(curY))
            ctx.lineTo(X(edge.x1), Y(edge.y2))
            ctx.strokeStyle = '#1a1a1a'
            ctx.lineWidth = lw
            ctx.lineCap = 'round'
            ctx.stroke()
          }
        }
      }
    })
  }

  // ─── Draw a single door ───────────────────────────────────────────────
  const drawDoor = (ctx, door, X, Y, S) => {
    const dw = S(door.width)
    const dx = X(door.x)
    const dy = Y(door.y)
    const sw = door.swing || 'down-right'

    ctx.strokeStyle = '#4B5563'
    ctx.lineWidth = 1.5

    if (door.orientation === 'horizontal') {
      // Door gap is along a horizontal wall
      // Draw the swing arc
      let startAngle, endAngle, pivotX, pivotY

      if (sw.includes('down') && sw.includes('right')) {
        pivotX = dx; pivotY = dy
        startAngle = 0; endAngle = Math.PI / 2
      } else if (sw.includes('down') && sw.includes('left')) {
        pivotX = dx + dw; pivotY = dy
        startAngle = Math.PI / 2; endAngle = Math.PI
      } else if (sw.includes('up') && sw.includes('right')) {
        pivotX = dx; pivotY = dy
        startAngle = -Math.PI / 2; endAngle = 0
      } else if (sw.includes('up') && sw.includes('left')) {
        pivotX = dx + dw; pivotY = dy
        startAngle = Math.PI; endAngle = Math.PI * 1.5
      } else {
        pivotX = dx; pivotY = dy
        startAngle = 0; endAngle = Math.PI / 2
      }

      // Draw door panel line
      ctx.beginPath()
      const panelEndX = pivotX + dw * Math.cos(startAngle)
      const panelEndY = pivotY + dw * Math.sin(startAngle)
      // For a closed door, the panel sits in the opening
      // Draw the arc
      ctx.beginPath()
      ctx.arc(pivotX, pivotY, dw, startAngle, endAngle, false)
      ctx.stroke()

      // Door panel (line from pivot to arc start)
      ctx.beginPath()
      ctx.moveTo(pivotX, pivotY)
      ctx.lineTo(pivotX + dw * Math.cos(endAngle), pivotY + dw * Math.sin(endAngle))
      ctx.stroke()

    } else {
      // Door gap along a vertical wall
      let startAngle, endAngle, pivotX, pivotY

      if (sw.includes('right') && sw.includes('down')) {
        pivotX = dx; pivotY = dy
        startAngle = 0; endAngle = Math.PI / 2
      } else if (sw.includes('right') && sw.includes('up')) {
        pivotX = dx; pivotY = dy + dw
        startAngle = -Math.PI / 2; endAngle = 0
      } else if (sw.includes('left') && sw.includes('down')) {
        pivotX = dx; pivotY = dy
        startAngle = Math.PI / 2; endAngle = Math.PI
      } else if (sw.includes('left') && sw.includes('up')) {
        pivotX = dx; pivotY = dy + dw
        startAngle = Math.PI; endAngle = Math.PI * 1.5
      } else {
        pivotX = dx; pivotY = dy
        startAngle = 0; endAngle = Math.PI / 2
      }

      ctx.beginPath()
      ctx.arc(pivotX, pivotY, dw, startAngle, endAngle, false)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(pivotX, pivotY)
      ctx.lineTo(pivotX + dw * Math.cos(endAngle), pivotY + dw * Math.sin(endAngle))
      ctx.stroke()
    }
  }

  // ─── Dimension lines ──────────────────────────────────────────────────
  const drawDimensionLines = (ctx, rooms, X, Y, S, PAD, minX, minY, maxX, maxY) => {
    // Draw dimension lines for overall width/height and individual rooms along edges

    const TICK = 6
    const OFFSET = 25
    const FONT = '11px "Segoe UI", system-ui, sans-serif'

    ctx.strokeStyle = '#6b7280'
    ctx.fillStyle = '#4b5563'
    ctx.lineWidth = 1
    ctx.font = FONT

    // Helper: draw a dimension line with ticks and label
    const dimLine = (ax, ay, bx, by, label, side) => {
      ctx.beginPath()

      if (side === 'top' || side === 'bottom') {
        const ly = side === 'top' ? ay - OFFSET : ay + OFFSET
        // Extension lines
        ctx.moveTo(ax, ay); ctx.lineTo(ax, ly)
        ctx.moveTo(bx, by); ctx.lineTo(bx, ly)
        // Main line
        ctx.moveTo(ax, ly); ctx.lineTo(bx, ly)
        // Ticks
        ctx.moveTo(ax, ly - TICK); ctx.lineTo(ax, ly + TICK)
        ctx.moveTo(bx, ly - TICK); ctx.lineTo(bx, ly + TICK)
        ctx.stroke()
        // Label
        ctx.textAlign = 'center'
        ctx.textBaseline = side === 'top' ? 'bottom' : 'top'
        ctx.fillText(label, (ax + bx) / 2, ly + (side === 'top' ? -4 : 4))
      } else {
        const lx = side === 'left' ? ax - OFFSET : ax + OFFSET
        ctx.moveTo(ax, ay); ctx.lineTo(lx, ay)
        ctx.moveTo(bx, by); ctx.lineTo(lx, by)
        ctx.moveTo(lx, ay); ctx.lineTo(lx, by)
        ctx.moveTo(lx - TICK, ay); ctx.lineTo(lx + TICK, ay)
        ctx.moveTo(lx - TICK, by); ctx.lineTo(lx + TICK, by)
        ctx.stroke()

        ctx.save()
        ctx.translate(lx + (side === 'left' ? -4 : 4), (ay + by) / 2)
        ctx.rotate(-Math.PI / 2)
        ctx.textAlign = 'center'
        ctx.textBaseline = side === 'left' ? 'bottom' : 'top'
        ctx.fillText(label, 0, 0)
        ctx.restore()
      }
    }

    // Overall dimensions
    dimLine(X(minX), Y(minY), X(maxX), Y(minY),
      `${(maxX - minX).toFixed(2)}m`, 'top')
    dimLine(X(minX), Y(minY), X(minX), Y(maxY),
      `${(maxY - minY).toFixed(2)}m`, 'left')

    // Individual room dimensions along bottom and right edges
    // Find rooms along bottom edge
    const bottomRooms = rooms.filter(r =>
      Math.abs((r.y + r.height) - maxY) < 0.1
    ).sort((a, b) => a.x - b.x)

    if (bottomRooms.length > 1) {
      bottomRooms.forEach(r => {
        dimLine(X(r.x), Y(maxY), X(r.x + r.width), Y(maxY),
          `${r.width.toFixed(1)}m`, 'bottom')
      })
    }

    // Find rooms along right edge
    const rightRooms = rooms.filter(r =>
      Math.abs((r.x + r.width) - maxX) < 0.1
    ).sort((a, b) => a.y - b.y)

    if (rightRooms.length > 1) {
      rightRooms.forEach(r => {
        dimLine(X(maxX), Y(r.y), X(maxX), Y(r.y + r.height),
          `${r.height.toFixed(1)}m`, 'right')
      })
    }
  }


  // ─── UI ────────────────────────────────────────────────────────────────
  return (
    <div className="fpa-root">
      <header className="fpa-header">
        <h1>CarpetPlan</h1>
        <p className="fpa-subtitle">Upload a floor plan → Get accurate architectural drawings</p>
      </header>

      {/* Upload zone */}
      {!image && (
        <div
          className="fpa-upload"
          onClick={() => fileRef.current?.click()}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag') }}
          onDragLeave={(e) => e.currentTarget.classList.remove('drag')}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={(e) => handleFile(e.target.files[0])}
          />
          <span className="fpa-upload-icon">📐</span>
          <span className="fpa-upload-text">Drop floor plan image or click to browse</span>
        </div>
      )}

      {/* Image preview + controls */}
      {image && (
        <div className="fpa-controls">
          <img src={image} alt="Floor plan" className="fpa-preview" />
          <div className="fpa-buttons">
            <button
              onClick={analyze}
              disabled={loading}
              className="fpa-btn fpa-btn-primary"
            >
              {loading ? 'Analyzing…' : 'Analyze Floor Plan'}
            </button>
            <button
              onClick={() => { setImage(null); setImageData(null); setAnalysis(null); setError(null) }}
              className="fpa-btn fpa-btn-secondary"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && <div className="fpa-error">{error}</div>}

      {/* Loading */}
      {loading && (
        <div className="fpa-loading">
          <div className="fpa-spinner" />
          <p>Analyzing floor plan with AI…</p>
          <p className="fpa-loading-sub">Identifying rooms, walls, doors, and dimensions</p>
        </div>
      )}

      {/* Result */}
      {analysis && (
        <div className="fpa-result">
          <div className="fpa-result-header">
            <h2>Floor Plan Drawing</h2>
            <div className="fpa-result-stats">
              {analysis.rooms?.length || 0} rooms · {analysis.doors?.length || 0} doors · {analysis.walls?.length || 0} wall segments
            </div>
          </div>
          <div className="fpa-canvas-wrap">
            <canvas ref={canvasRef} className="fpa-canvas" />
          </div>

          {/* Room list */}
          <details className="fpa-details">
            <summary>Room Details</summary>
            <table className="fpa-table">
              <thead>
                <tr><th>Room</th><th>Position (x, y)</th><th>Size (w × h)</th></tr>
              </thead>
              <tbody>
                {analysis.rooms.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td>{r.x.toFixed(2)}, {r.y.toFixed(2)}</td>
                    <td>{r.width.toFixed(2)} × {r.height.toFixed(2)} m</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          {/* Debug JSON */}
          <details className="fpa-details">
            <summary>Raw AI Response</summary>
            <pre className="fpa-json">{JSON.stringify(analysis, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  )
}
