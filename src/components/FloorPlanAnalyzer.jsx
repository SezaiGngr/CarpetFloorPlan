import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 1200

// ─── AI PROMPT ────────────────────────────────────────────────────────────────
// TWO-PHASE approach:
// Phase 1: AI describes layout column-by-column, top-to-bottom
// Phase 2: Code computes exact coordinates from description
//
// This is MUCH easier for the AI than absolute coordinates because
// it only needs to say "these rooms are stacked vertically in this column"
// and give dimensions. The code handles all positioning math.

const ANALYSIS_PROMPT = `You are an expert architectural floor plan analyzer.

Analyze this floor plan image. Describe the layout as VERTICAL COLUMNS of rooms, read from LEFT to RIGHT across the floor plan. Within each column, list rooms from TOP to BOTTOM.

Return this EXACT JSON format:

{
  "total_width": 9.2,
  "total_height": 12.9,
  "columns": [
    {
      "x": 0,
      "width": 3.7,
      "rooms": [
        { "name": "Bed 1", "height": 3.7 },
        { "name": "Bath", "height": 2.4 },
        { "name": "Void", "height": 2.5 },
        { "name": "Living", "height": 4.3 }
      ]
    },
    {
      "x": 3.7,
      "width": 5.5,
      "rooms": [
        { "name": "Bed 2", "height": 3.7 },
        { "name": "Room 3.8x3.9M", "height": 3.9 },
        { "name": "Room 3.8x3.8M", "height": 3.8 },
        { "name": "Room 5.1x2.4M", "height": 2.4 }
      ]
    }
  ],
  "doors": [
    {
      "room1": "Bed 1",
      "room2": "Bath",
      "wall": "bottom",
      "position": 0.7,
      "width": 0.82,
      "hinge": "left"
    }
  ]
}

RULES:

1. COLUMNS: Divide the floor plan into vertical columns. Each column contains rooms stacked top-to-bottom.
   - "x": The left edge x-position of this column in meters (first column starts at 0)
   - "width": The width of this column in meters
   - Adjacent columns must have x values that add up correctly: column[i].x + column[i].width = column[i+1].x
   - A room may span multiple columns. If so, include it ONLY in the leftmost column it occupies and set its width to the actual room width.

2. ROOMS within each column: Listed top-to-bottom.
   - "name": The label shown in the floor plan (e.g., "3.7 x 3.7M", "BATH", "VOID")
   - "height": The room's height (vertical extent) in meters
   - The sum of all room heights in a column should equal the total height used by rooms in that column
   - If a room is wider than its column, add "width": actualWidth to override
   - If a room doesn't start at the same x as its column, add "x_offset": offset in meters

3. Read dimension annotations from the image VERY carefully.
   - "3.7 x 3.7M" means width = 3.7m, height = 3.7m
   - "5.5 x 3.7M" means width = 5.5m, height = 3.7m
   - First number is ALWAYS width (horizontal), second is ALWAYS height (vertical)

4. Include ALL rooms, hallways, corridors, voids, stairs visible in the image.

5. DOORS:
   - "room1", "room2": Names of rooms the door connects
   - "wall": Which wall of room1: "top", "bottom", "left", "right"
   - "position": 0.0-1.0 fraction along that wall (0=start, 1=end)
   - "width": Door width in meters (typically 0.7-0.9)
   - "hinge": Which side the hinge is on when looking at the wall from room1: "left" or "right"

Return ONLY valid JSON. No markdown, no backticks, no explanation.`


// ─── CONVERT COLUMN LAYOUT TO ROOM RECTANGLES ───────────────────────────────
function columnsToRooms(data) {
  var rooms = []
  var columns = data.columns || []

  columns.forEach(function(col) {
    var curY = 0
    var colX = col.x || 0
    var colW = col.width || 3

    ;(col.rooms || []).forEach(function(room) {
      var rw = room.width || colW
      var rh = room.height || 3
      var rx = colX + (room.x_offset || 0)

      rooms.push({
        name: room.name,
        x: rx,
        y: curY,
        width: rw,
        height: rh,
        label: room.name
      })

      curY += rh
    })
  })

  return rooms
}


// ─── COORDINATE SNAPPING ─────────────────────────────────────────────────────
function snapRoomCoordinates(rooms, tolerance) {
  if (!rooms || rooms.length === 0) return rooms
  tolerance = tolerance || 0.15

  var xVals = []
  var yVals = []
  rooms.forEach(function(r) {
    xVals.push(r.x, r.x + r.width)
    yVals.push(r.y, r.y + r.height)
  })

  function clusterValues(vals, tol) {
    var sorted = []
    var seen = {}
    vals.forEach(function(v) {
      var key = v.toFixed(6)
      if (!seen[key]) { seen[key] = true; sorted.push(v) }
    })
    sorted.sort(function(a, b) { return a - b })

    var clusters = []
    sorted.forEach(function(v) {
      var found = false
      for (var ci = 0; ci < clusters.length; ci++) {
        if (Math.abs(v - clusters[ci].avg) < tol) {
          clusters[ci].vals.push(v)
          var sum = 0
          clusters[ci].vals.forEach(function(x) { sum += x })
          clusters[ci].avg = sum / clusters[ci].vals.length
          found = true
          break
        }
      }
      if (!found) {
        clusters.push({ vals: [v], avg: v })
      }
    })

    var mapping = {}
    clusters.forEach(function(c) {
      c.vals.forEach(function(v) {
        mapping[v.toFixed(6)] = c.avg
      })
    })
    return mapping
  }

  var xMap = clusterValues(xVals, tolerance)
  var yMap = clusterValues(yVals, tolerance)

  function snapVal(v, map) {
    var key = v.toFixed(6)
    if (map[key] !== undefined) return map[key]
    var best = v, bestDist = Infinity
    Object.keys(map).forEach(function(k) {
      var d = Math.abs(v - parseFloat(k))
      if (d < bestDist) { bestDist = d; best = map[k] }
    })
    return best
  }

  return rooms.map(function(r) {
    var sx = snapVal(r.x, xMap)
    var sy = snapVal(r.y, yMap)
    var sx2 = snapVal(r.x + r.width, xMap)
    var sy2 = snapVal(r.y + r.height, yMap)
    return Object.assign({}, r, {
      x: sx, y: sy,
      width: sx2 - sx,
      height: sy2 - sy
    })
  })
}


// ─── WALL COMPUTATION ────────────────────────────────────────────────────────
function computeWalls(rooms, doors) {
  var snap = 0.05
  var rawEdges = []

  rooms.forEach(function(r) {
    var x1 = r.x, y1 = r.y
    var x2 = r.x + r.width, y2 = r.y + r.height
    rawEdges.push({ a: x1, b: x2, pos: y1, axis: 'h' })
    rawEdges.push({ a: x1, b: x2, pos: y2, axis: 'h' })
    rawEdges.push({ a: y1, b: y2, pos: x1, axis: 'v' })
    rawEdges.push({ a: y1, b: y2, pos: x2, axis: 'v' })
  })

  // Group by axis + snapped position
  var groups = {}
  rawEdges.forEach(function(e) {
    var rp = Math.round(e.pos / snap) * snap
    var key = e.axis + '_' + rp.toFixed(4)
    if (!groups[key]) {
      groups[key] = { axis: e.axis, pos: e.pos, segments: [], count: 0 }
    }
    groups[key].count++
    groups[key].pos = groups[key].pos + (e.pos - groups[key].pos) / groups[key].count
    groups[key].segments.push({ a: Math.min(e.a, e.b), b: Math.max(e.a, e.b) })
  })

  // Merge overlapping segments
  var wallSegments = []
  Object.keys(groups).forEach(function(key) {
    var group = groups[key]
    var segs = group.segments.sort(function(a, b) { return a.a - b.a })
    var merged = []
    var cur = { a: segs[0].a, b: segs[0].b }
    for (var i = 1; i < segs.length; i++) {
      if (segs[i].a <= cur.b + snap) {
        cur.b = Math.max(cur.b, segs[i].b)
      } else {
        merged.push({ a: cur.a, b: cur.b })
        cur = { a: segs[i].a, b: segs[i].b }
      }
    }
    merged.push({ a: cur.a, b: cur.b })
    merged.forEach(function(seg) {
      wallSegments.push({ axis: group.axis, pos: group.pos, a: seg.a, b: seg.b })
    })
  })

  // Cut door gaps
  var finalWalls = []
  wallSegments.forEach(function(wall) {
    var segments = [{ a: wall.a, b: wall.b }]

    ;(doors || []).forEach(function(door) {
      var ds = getDoorSegment(door, rooms, snap)
      if (!ds) return
      if (wall.axis !== ds.axis) return
      if (Math.abs(wall.pos - ds.pos) > snap) return

      var newSegs = []
      segments.forEach(function(seg) {
        if (ds.b <= seg.a + snap || ds.a >= seg.b - snap) {
          newSegs.push(seg)
        } else {
          if (ds.a > seg.a + snap) newSegs.push({ a: seg.a, b: ds.a })
          if (ds.b < seg.b - snap) newSegs.push({ a: ds.b, b: seg.b })
        }
      })
      segments = newSegs
    })

    segments.forEach(function(seg) {
      if (seg.b - seg.a > snap) {
        finalWalls.push({ axis: wall.axis, pos: wall.pos, a: seg.a, b: seg.b })
      }
    })
  })

  return finalWalls
}

function getDoorSegment(door, rooms) {
  var room1 = rooms.find(function(r) { return r.name === door.room1 })
  if (!room1) return null
  var pos = door.position != null ? door.position : 0.5
  var dw = door.width || 0.82
  var wallPos, wallStart, wallEnd, axis

  if (door.wall === 'top') {
    axis = 'h'; wallPos = room1.y; wallStart = room1.x; wallEnd = room1.x + room1.width
  } else if (door.wall === 'bottom') {
    axis = 'h'; wallPos = room1.y + room1.height; wallStart = room1.x; wallEnd = room1.x + room1.width
  } else if (door.wall === 'left') {
    axis = 'v'; wallPos = room1.x; wallStart = room1.y; wallEnd = room1.y + room1.height
  } else if (door.wall === 'right') {
    axis = 'v'; wallPos = room1.x + room1.width; wallStart = room1.y; wallEnd = room1.y + room1.height
  } else { return null }

  var wallLen = wallEnd - wallStart
  var doorCenter = wallStart + wallLen * pos
  return { axis: axis, pos: wallPos, a: doorCenter - dw / 2, b: doorCenter + dw / 2 }
}


// ─── DOOR ARC ────────────────────────────────────────────────────────────────
function drawDoorArc(ctx, door, rooms, X, Y, S) {
  var room1 = rooms.find(function(r) { return r.name === door.room1 })
  if (!room1) return

  var pos = door.position != null ? door.position : 0.5
  var dw = door.width || 0.82
  var dwPx = S(dw)
  var hinge = door.hinge || 'left'

  var pivotX, pivotY, startAngle, endAngle

  if (door.wall === 'bottom') {
    var wy = room1.y + room1.height
    var dc = room1.x + room1.width * pos
    if (hinge === 'left') {
      pivotX = X(dc - dw/2); pivotY = Y(wy)
      startAngle = -Math.PI/2; endAngle = 0
    } else {
      pivotX = X(dc + dw/2); pivotY = Y(wy)
      startAngle = Math.PI; endAngle = Math.PI * 1.5
    }
  } else if (door.wall === 'top') {
    var wy2 = room1.y
    var dc2 = room1.x + room1.width * pos
    if (hinge === 'left') {
      pivotX = X(dc2 - dw/2); pivotY = Y(wy2)
      startAngle = 0; endAngle = Math.PI/2
    } else {
      pivotX = X(dc2 + dw/2); pivotY = Y(wy2)
      startAngle = Math.PI/2; endAngle = Math.PI
    }
  } else if (door.wall === 'right') {
    var wx = room1.x + room1.width
    var dc3 = room1.y + room1.height * pos
    if (hinge === 'left') {
      pivotX = X(wx); pivotY = Y(dc3 - dw/2)
      startAngle = Math.PI/2; endAngle = Math.PI
    } else {
      pivotX = X(wx); pivotY = Y(dc3 + dw/2)
      startAngle = Math.PI; endAngle = Math.PI * 1.5
    }
  } else if (door.wall === 'left') {
    var wx2 = room1.x
    var dc4 = room1.y + room1.height * pos
    if (hinge === 'left') {
      pivotX = X(wx2); pivotY = Y(dc4 - dw/2)
      startAngle = -Math.PI/2; endAngle = 0
    } else {
      pivotX = X(wx2); pivotY = Y(dc4 + dw/2)
      startAngle = 0; endAngle = Math.PI/2
    }
  } else { return }

  ctx.strokeStyle = '#4B5563'
  ctx.lineWidth = 1.2
  ctx.setLineDash([])

  ctx.beginPath()
  ctx.arc(pivotX, pivotY, dwPx, startAngle, endAngle, false)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(pivotX, pivotY)
  ctx.lineTo(pivotX + dwPx * Math.cos(endAngle), pivotY + dwPx * Math.sin(endAngle))
  ctx.stroke()
}


// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function FloorPlanAnalyzer() {
  const [image, setImage] = useState(null)
  const [imageData, setImageData] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)
  const fileRef = useRef(null)

  const handleFile = useCallback(function(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return
    setError(null)
    setAnalysis(null)

    var reader = new FileReader()
    reader.onload = function(e) {
      var img = new Image()
      img.onload = function() {
        var scale = img.width > MAX_IMG_WIDTH ? MAX_IMG_WIDTH / img.width : 1
        var c = document.createElement('canvas')
        c.width = img.width * scale
        c.height = img.height * scale
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
        var dataUrl = c.toDataURL('image/jpeg', 0.85)
        setImage(dataUrl)
        setImageData(dataUrl.split(',')[1])
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  }, [])

  const onDrop = useCallback(function(e) {
    e.preventDefault()
    e.currentTarget.classList.remove('drag')
    handleFile(e.dataTransfer.files[0])
  }, [handleFile])

  const analyze = async function() {
    if (!imageData) return
    setLoading(true)
    setError(null)
    setAnalysis(null)

    try {
      var apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('Set VITE_ANTHROPIC_API_KEY in environment')

      var resp = await fetch('https://api.anthropic.com/v1/messages', {
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
        var errData = await resp.json().catch(function() { return {} })
        throw new Error((errData.error && errData.error.message) || ('API error ' + resp.status))
      }

      var data = await resp.json()
      var text = ''
      if (data.content) {
        data.content.forEach(function(b) { text += (b.text || '') })
      }
      var clean = text.replace(/```json/g, '').replace(/```/g, '').trim()
      var parsed = JSON.parse(clean)

      // Convert column layout to room rectangles
      var rooms = []
      if (parsed.columns) {
        rooms = columnsToRooms(parsed)
      } else if (parsed.rooms) {
        rooms = parsed.rooms
      }

      if (rooms.length === 0) throw new Error('No rooms found')

      // Snap coordinates
      rooms = snapRoomCoordinates(rooms)

      setAnalysis({ rooms: rooms, doors: parsed.doors || [], raw: parsed })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(function() {
    if (analysis && analysis.rooms && analysis.rooms.length > 0) {
      drawFloorPlan()
    }
  }, [analysis])

  const drawFloorPlan = function() {
    var canvas = canvasRef.current
    if (!canvas || !analysis) return

    var rooms = analysis.rooms || []
    var doors = analysis.doors || []
    if (rooms.length === 0) return

    // Bounding box
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    rooms.forEach(function(r) {
      minX = Math.min(minX, r.x)
      minY = Math.min(minY, r.y)
      maxX = Math.max(maxX, r.x + r.width)
      maxY = Math.max(maxY, r.y + r.height)
    })

    var totalW = maxX - minX
    var totalH = maxY - minY

    var PAD = 70
    var PX_PER_M = Math.min((850 - PAD*2) / totalW, (750 - PAD*2) / totalH, 100)

    var cw = totalW * PX_PER_M + PAD * 2
    var ch = totalH * PX_PER_M + PAD * 2

    canvas.width = cw
    canvas.height = ch

    var ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cw, ch)

    var Xfn = function(m) { return PAD + (m - minX) * PX_PER_M }
    var Yfn = function(m) { return PAD + (m - minY) * PX_PER_M }
    var Sfn = function(m) { return m * PX_PER_M }

    // Room fills
    var COLORS = [
      '#E8F0FE', '#FFF3E0', '#E8F5E9', '#FCE4EC', '#FFF8E1',
      '#F3E5F5', '#E0F2F1', '#FFEBEE', '#E3F2FD', '#FBE9E7'
    ]
    rooms.forEach(function(r, i) {
      ctx.fillStyle = COLORS[i % COLORS.length]
      ctx.fillRect(Xfn(r.x), Yfn(r.y), Sfn(r.width), Sfn(r.height))
    })

    // Walls — ALL thick
    var walls = computeWalls(rooms, doors)
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = 4
    ctx.lineCap = 'square'

    walls.forEach(function(w) {
      ctx.beginPath()
      if (w.axis === 'h') {
        ctx.moveTo(Xfn(w.a), Yfn(w.pos))
        ctx.lineTo(Xfn(w.b), Yfn(w.pos))
      } else {
        ctx.moveTo(Xfn(w.pos), Yfn(w.a))
        ctx.lineTo(Xfn(w.pos), Yfn(w.b))
      }
      ctx.stroke()
    })

    // Door arcs
    doors.forEach(function(door) {
      drawDoorArc(ctx, door, rooms, Xfn, Yfn, Sfn)
    })

    // Room labels
    rooms.forEach(function(r) {
      var cx = Xfn(r.x + r.width / 2)
      var cy = Yfn(r.y + r.height / 2)
      var fs = Math.max(9, Math.min(14, Sfn(Math.min(r.width, r.height)) / 6))

      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#1f2937'
      ctx.font = '600 ' + fs + 'px "Segoe UI", system-ui, sans-serif'
      ctx.fillText(r.name, cx, cy - fs * 0.7)

      ctx.fillStyle = '#6b7280'
      ctx.font = '400 ' + (fs * 0.85) + 'px "Segoe UI", system-ui, sans-serif'
      var dimText = r.width.toFixed(1) + ' x ' + r.height.toFixed(1)
      ctx.fillText(dimText, cx, cy + fs * 0.5)
    })

    // Dimension lines
    drawDimensions(ctx, rooms, Xfn, Yfn, Sfn, PAD, minX, minY, maxX, maxY)

    ctx.fillStyle = '#9ca3af'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText('N \u2191', cw - 8, 8)
  }

  const drawDimensions = function(ctx, rooms, X, Y, S, PAD, minX, minY, maxX, maxY) {
    var TICK = 6, OFFSET = 25
    ctx.strokeStyle = '#6b7280'
    ctx.fillStyle = '#4b5563'
    ctx.lineWidth = 0.8
    ctx.font = '11px "Segoe UI", system-ui, sans-serif'

    var dimH = function(x1, x2, y, label, above) {
      var ly = above ? y - OFFSET : y + OFFSET
      ctx.beginPath()
      ctx.moveTo(x1, y); ctx.lineTo(x1, ly)
      ctx.moveTo(x2, y); ctx.lineTo(x2, ly)
      ctx.moveTo(x1, ly); ctx.lineTo(x2, ly)
      ctx.moveTo(x1, ly - TICK); ctx.lineTo(x1, ly + TICK)
      ctx.moveTo(x2, ly - TICK); ctx.lineTo(x2, ly + TICK)
      ctx.stroke()
      ctx.textAlign = 'center'
      ctx.textBaseline = above ? 'bottom' : 'top'
      ctx.fillText(label, (x1 + x2) / 2, ly + (above ? -3 : 3))
    }

    var dimV = function(y1, y2, x, label, left) {
      var lx = left ? x - OFFSET : x + OFFSET
      ctx.beginPath()
      ctx.moveTo(x, y1); ctx.lineTo(lx, y1)
      ctx.moveTo(x, y2); ctx.lineTo(lx, y2)
      ctx.moveTo(lx, y1); ctx.lineTo(lx, y2)
      ctx.moveTo(lx - TICK, y1); ctx.lineTo(lx + TICK, y1)
      ctx.moveTo(lx - TICK, y2); ctx.lineTo(lx + TICK, y2)
      ctx.stroke()
      ctx.save()
      ctx.translate(lx + (left ? -4 : 4), (y1 + y2) / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'center'
      ctx.textBaseline = left ? 'bottom' : 'top'
      ctx.fillText(label, 0, 0)
      ctx.restore()
    }

    dimH(X(minX), X(maxX), Y(minY), (maxX - minX).toFixed(2) + 'm', true)
    dimV(Y(minY), Y(maxY), X(minX), (maxY - minY).toFixed(2) + 'm', true)

    var rightRooms = rooms.filter(function(r) { return Math.abs((r.x + r.width) - maxX) < 0.15 }).sort(function(a, b) { return a.y - b.y })
    if (rightRooms.length > 1) {
      rightRooms.forEach(function(r) {
        dimV(Y(r.y), Y(r.y + r.height), X(maxX), r.height.toFixed(1) + 'm', false)
      })
    }

    var bottomRooms = rooms.filter(function(r) { return Math.abs((r.y + r.height) - maxY) < 0.15 }).sort(function(a, b) { return a.x - b.x })
    if (bottomRooms.length > 1) {
      bottomRooms.forEach(function(r) {
        dimH(X(r.x), X(r.x + r.width), Y(maxY), r.width.toFixed(1) + 'm', false)
      })
    }
  }


  return (
    <div className="fpa-root">
      <header className="fpa-header">
        <h1>CarpetPlan</h1>
        <p className="fpa-subtitle">Upload a floor plan &rarr; Get accurate architectural drawings</p>
      </header>

      {!image && (
        <div className="fpa-upload"
          onClick={function() { fileRef.current && fileRef.current.click() }}
          onDrop={onDrop}
          onDragOver={function(e) { e.preventDefault(); e.currentTarget.classList.add('drag') }}
          onDragLeave={function(e) { e.currentTarget.classList.remove('drag') }}>
          <input ref={fileRef} type="file" accept="image/*"
            onChange={function(e) { handleFile(e.target.files[0]) }} />
          <span className="fpa-upload-icon">&#x1F4D0;</span>
          <span className="fpa-upload-text">Drop floor plan image or click to browse</span>
        </div>
      )}

      {image && (
        <div className="fpa-controls">
          <img src={image} alt="Floor plan" className="fpa-preview" />
          <div className="fpa-buttons">
            <button onClick={analyze} disabled={loading} className="fpa-btn fpa-btn-primary">
              {loading ? 'Analyzing\u2026' : 'Analyze Floor Plan'}
            </button>
            <button onClick={function() { setImage(null); setImageData(null); setAnalysis(null); setError(null) }}
              className="fpa-btn fpa-btn-secondary">Clear</button>
          </div>
        </div>
      )}

      {error && <div className="fpa-error">{error}</div>}

      {loading && (
        <div className="fpa-loading">
          <div className="fpa-spinner" />
          <p>Analyzing floor plan with AI&hellip;</p>
          <p className="fpa-loading-sub">Identifying rooms, walls, and doors</p>
        </div>
      )}

      {analysis && (
        <div className="fpa-result">
          <div className="fpa-result-header">
            <h2>Floor Plan Drawing</h2>
            <div className="fpa-result-stats">
              {(analysis.rooms && analysis.rooms.length) || 0} rooms &middot; {(analysis.doors && analysis.doors.length) || 0} doors
            </div>
          </div>
          <div className="fpa-canvas-wrap">
            <canvas ref={canvasRef} className="fpa-canvas" />
          </div>
          <details className="fpa-details">
            <summary>Room Details</summary>
            <table className="fpa-table">
              <thead><tr><th>Room</th><th>Position</th><th>Size</th></tr></thead>
              <tbody>
                {analysis.rooms.map(function(r, i) {
                  return <tr key={i}><td>{r.name}</td><td>{r.x.toFixed(2)}, {r.y.toFixed(2)}</td><td>{r.width.toFixed(2)} &times; {r.height.toFixed(2)}m</td></tr>
                })}
              </tbody>
            </table>
          </details>
          <details className="fpa-details">
            <summary>Raw AI Response</summary>
            <pre className="fpa-json">{JSON.stringify(analysis.raw || analysis, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  )
}
