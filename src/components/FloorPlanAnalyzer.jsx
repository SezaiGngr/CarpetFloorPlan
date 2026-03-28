import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 1200

// ─── AI PROMPT ────────────────────────────────────────────────────────────────
// COMPLETELY NEW APPROACH: Don't try to understand rooms/layout.
// Instead, trace every wall line and door arc as pixel coordinates.
// The AI scans the image systematically and reports exact positions.

const ANALYSIS_PROMPT = `You are analyzing a floor plan image. Your job is to trace EVERY wall line and door arc visible in the image, reporting their EXACT pixel coordinates.

STEP 1: Report the image dimensions (width x height in pixels).

STEP 2: Find calibration. Look for dimension annotations like "3.7 x 3.7M". Find that room in the image, measure its pixel dimensions, and calculate pixels_per_meter.

STEP 3: Scan the ENTIRE image systematically. Trace every single wall line. Walls appear as thick dark/black lines. Report each wall as a straight line segment with start and end pixel coordinates.

STEP 4: Trace every door. Doors appear as gaps in walls with quarter-circle arc lines. Report the arc center, radius, start angle, and end angle.

STEP 5: Report room labels with their center position in pixels and the text shown.

Return this EXACT JSON format:

{
  "image_width": 800,
  "image_height": 1000,
  "pixels_per_meter": 80.5,
  "walls": [
    { "x1": 50, "y1": 50, "x2": 350, "y2": 50 },
    { "x1": 50, "y1": 50, "x2": 50, "y2": 400 }
  ],
  "doors": [
    { "cx": 200, "cy": 300, "radius": 60, "start_deg": 0, "end_deg": 90, "line_to_deg": 90 }
  ],
  "labels": [
    { "text": "3.7 x 3.7M", "cx": 180, "cy": 150 },
    { "text": "BATH", "cx": 150, "cy": 350 }
  ]
}

CRITICAL RULES:

1. WALLS: Every thick dark line in the floor plan is a wall. Include ALL of them:
   - All exterior walls (the outer boundary)
   - All interior walls (dividing rooms)
   - Even SHORT wall segments (10-20 pixels long) — include them ALL
   - Walls are STRAIGHT lines, either horizontal or vertical
   - Where a door gap exists, the wall is split into TWO segments with a gap between them
   - Report EXACT pixel coordinates for start (x1,y1) and end (x2,y2)

2. SCAN METHOD: Go through the image systematically:
   - First, trace the entire outer boundary (all exterior walls)
   - Then scan left-to-right, top-to-bottom for interior walls
   - For each horizontal wall: report its y-coordinate and the x-range it spans
   - For each vertical wall: report its x-coordinate and the y-range it spans
   - Do NOT skip any wall segment, no matter how small

3. DOORS: Quarter-circle arcs that show door swing direction:
   - "cx", "cy": Center of the arc (the hinge point) in pixels
   - "radius": The arc radius in pixels (= door width)
   - "start_deg": Start angle in degrees (0=right, 90=down, 180=left, 270=up)
   - "end_deg": End angle in degrees
   - "line_to_deg": Angle for the straight door panel line from center

4. LABELS: Room name labels with center position in pixels.

5. PRECISION: Be as precise as possible with pixel coordinates. Measure from the CENTER of wall lines, not their edges.

6. DO NOT MISS ANY WALLS. Every line you can see in the image must be in your output.

Return ONLY valid JSON. No markdown, no backticks, no explanation.`


// ─── COMPONENT ───────────────────────────────────────────────────────────────
export default function FloorPlanAnalyzer() {
  const [image, setImage] = useState(null)
  const [imageData, setImageData] = useState(null)
  const [imgSize, setImgSize] = useState(null)
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
        setImgSize({ w: c.width, h: c.height })
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  }, [])

  var onDrop = useCallback(function(e) {
    e.preventDefault()
    e.currentTarget.classList.remove('drag')
    handleFile(e.dataTransfer.files[0])
  }, [handleFile])

  var analyze = async function() {
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
          max_tokens: 8192,
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

      if (!parsed.walls || parsed.walls.length === 0) throw new Error('No walls found')

      setAnalysis(parsed)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(function() {
    if (analysis && analysis.walls && analysis.walls.length > 0) {
      drawFloorPlan()
    }
  }, [analysis])

  var drawFloorPlan = function() {
    var canvas = canvasRef.current
    if (!canvas || !analysis) return

    var walls = analysis.walls || []
    var doors = analysis.doors || []
    var labels = analysis.labels || []
    var ppm = analysis.pixels_per_meter || 80

    // Use the AI-reported image size, or fall back to our measured size
    var aiW = analysis.image_width || (imgSize && imgSize.w) || 800
    var aiH = analysis.image_height || (imgSize && imgSize.h) || 1000

    // We know our actual sent image size
    var actualW = (imgSize && imgSize.w) || aiW
    var actualH = (imgSize && imgSize.h) || aiH

    // Scale factor: AI pixel coords -> our actual image coords
    var scaleX = actualW / aiW
    var scaleY = actualH / aiH

    // Canvas padding for dimension labels
    var PAD = 70

    // Scale to fit canvas nicely (target ~800px wide)
    var drawScale = Math.min((850 - PAD * 2) / actualW, (750 - PAD * 2) / actualH, 1)

    var cw = actualW * drawScale + PAD * 2
    var ch = actualH * drawScale + PAD * 2

    canvas.width = cw
    canvas.height = ch

    var ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cw, ch)

    // Transform AI pixel coordinates to canvas coordinates
    var X = function(px) { return PAD + px * scaleX * drawScale }
    var Y = function(py) { return PAD + py * scaleY * drawScale }
    var S = function(px) { return px * scaleX * drawScale }

    // ── Draw walls ─────────────────────────────────────────────────────
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = 4
    ctx.lineCap = 'square'

    walls.forEach(function(w) {
      ctx.beginPath()
      ctx.moveTo(X(w.x1), Y(w.y1))
      ctx.lineTo(X(w.x2), Y(w.y2))
      ctx.stroke()
    })

    // ── Draw doors ─────────────────────────────────────────────────────
    ctx.strokeStyle = '#4B5563'
    ctx.lineWidth = 1.5
    ctx.lineCap = 'round'

    doors.forEach(function(d) {
      var cx = X(d.cx)
      var cy = Y(d.cy)
      var r = S(d.radius)
      var sa = (d.start_deg || 0) * Math.PI / 180
      var ea = (d.end_deg || 90) * Math.PI / 180

      // Draw arc
      ctx.beginPath()
      ctx.arc(cx, cy, r, sa, ea, false)
      ctx.stroke()

      // Draw door panel line
      var la = (d.line_to_deg != null ? d.line_to_deg : d.end_deg) * Math.PI / 180
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + r * Math.cos(la), cy + r * Math.sin(la))
      ctx.stroke()
    })

    // ── Draw labels ────────────────────────────────────────────────────
    labels.forEach(function(lb) {
      var lx = X(lb.cx)
      var ly = Y(lb.cy)

      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#1f2937'
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'
      ctx.fillText(lb.text, lx, ly)
    })

    // ── Dimension labels using pixels_per_meter ────────────────────────
    // Find bounding box of all walls
    var minPx = Infinity, minPy = Infinity, maxPx = -Infinity, maxPy = -Infinity
    walls.forEach(function(w) {
      minPx = Math.min(minPx, w.x1, w.x2)
      minPy = Math.min(minPy, w.y1, w.y2)
      maxPx = Math.max(maxPx, w.x1, w.x2)
      maxPy = Math.max(maxPy, w.y1, w.y2)
    })

    var totalWidthM = (maxPx - minPx) / ppm
    var totalHeightM = (maxPy - minPy) / ppm

    var TICK = 6, OFFSET = 25
    ctx.strokeStyle = '#6b7280'
    ctx.fillStyle = '#4b5563'
    ctx.lineWidth = 0.8
    ctx.font = '11px "Segoe UI", system-ui, sans-serif'

    // Top dimension
    var tx1 = X(minPx), tx2 = X(maxPx), ty = Y(minPy)
    var tly = ty - OFFSET
    ctx.beginPath()
    ctx.moveTo(tx1, ty); ctx.lineTo(tx1, tly)
    ctx.moveTo(tx2, ty); ctx.lineTo(tx2, tly)
    ctx.moveTo(tx1, tly); ctx.lineTo(tx2, tly)
    ctx.moveTo(tx1, tly - TICK); ctx.lineTo(tx1, tly + TICK)
    ctx.moveTo(tx2, tly - TICK); ctx.lineTo(tx2, tly + TICK)
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(totalWidthM.toFixed(2) + 'm', (tx1 + tx2) / 2, tly - 3)

    // Left dimension
    var ly1 = Y(minPy), ly2 = Y(maxPy), lx = X(minPx)
    var llx = lx - OFFSET
    ctx.beginPath()
    ctx.moveTo(lx, ly1); ctx.lineTo(llx, ly1)
    ctx.moveTo(lx, ly2); ctx.lineTo(llx, ly2)
    ctx.moveTo(llx, ly1); ctx.lineTo(llx, ly2)
    ctx.moveTo(llx - TICK, ly1); ctx.lineTo(llx + TICK, ly1)
    ctx.moveTo(llx - TICK, ly2); ctx.lineTo(llx + TICK, ly2)
    ctx.stroke()
    ctx.save()
    ctx.translate(llx - 4, (ly1 + ly2) / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(totalHeightM.toFixed(2) + 'm', 0, 0)
    ctx.restore()

    // North arrow
    ctx.fillStyle = '#9ca3af'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText('N \u2191', cw - 8, 8)
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
          <p className="fpa-loading-sub">Tracing every wall line and door arc</p>
        </div>
      )}

      {analysis && (
        <div className="fpa-result">
          <div className="fpa-result-header">
            <h2>Floor Plan Drawing</h2>
            <div className="fpa-result-stats">
              {(analysis.walls && analysis.walls.length) || 0} wall segments &middot; {(analysis.doors && analysis.doors.length) || 0} doors &middot; {(analysis.labels && analysis.labels.length) || 0} labels
            </div>
          </div>
          <div className="fpa-canvas-wrap">
            <canvas ref={canvasRef} className="fpa-canvas" />
          </div>
          <details className="fpa-details">
            <summary>Raw AI Response</summary>
            <pre className="fpa-json">{JSON.stringify(analysis, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  )
}
