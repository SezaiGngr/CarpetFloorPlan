import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 900

// ─── AI PROMPT ────────────────────────────────────────────────────────────────
// AI is ONLY used for reading text labels and dimensions — NOT for wall positions.
// Wall detection is done by actual image processing of dark pixels.

const LABEL_PROMPT = `Look at this floor plan image. List every text label and dimension annotation you can see.

Return JSON:
{
  "labels": [
    { "text": "3.7 x 3.7M", "type": "dimension" },
    { "text": "BATH", "type": "room_name" },
    { "text": "VOID", "type": "room_name" },
    { "text": "FP", "type": "feature" }
  ]
}

Include ALL text visible in the image. For dimension labels like "3.7 x 3.7M", type is "dimension".
For room names like "BATH", "VOID", type is "room_name".
For other features like "FP" (fireplace), type is "feature".

Return ONLY valid JSON.`


// ─── IMAGE PROCESSING: Detect walls from dark pixels ─────────────────────────

function detectWalls(imageData, width, height) {
  var data = imageData.data
  var DARK_THRESHOLD = 80  // pixels darker than this are "wall"
  var MIN_LINE_LENGTH = 15  // minimum pixels for a wall line
  var MIN_THICKNESS = 2     // minimum thickness to be considered a wall
  var MAX_GAP = 3           // max gap to bridge in a line

  // Step 1: Build binary mask of dark pixels
  var mask = new Uint8Array(width * height)
  for (var i = 0; i < width * height; i++) {
    var r = data[i * 4]
    var g = data[i * 4 + 1]
    var b = data[i * 4 + 2]
    var a = data[i * 4 + 3]
    // Dark pixel = wall candidate
    if (a > 128 && r < DARK_THRESHOLD && g < DARK_THRESHOLD && b < DARK_THRESHOLD) {
      mask[i] = 1
    }
  }

  // Step 2: Detect horizontal wall segments
  // For each row, find runs of dark pixels that are thick enough
  var hSegments = []
  for (var y = 1; y < height - 1; y++) {
    var runStart = -1
    var gapCount = 0

    for (var x = 0; x < width; x++) {
      var idx = y * width + x
      var isDark = mask[idx] === 1

      // Check thickness: at least MIN_THICKNESS rows of dark pixels
      if (isDark) {
        var thick = 0
        for (var dy = -2; dy <= 2; dy++) {
          var ny = y + dy
          if (ny >= 0 && ny < height && mask[ny * width + x] === 1) thick++
        }
        isDark = thick >= MIN_THICKNESS
      }

      if (isDark) {
        if (runStart === -1) runStart = x
        gapCount = 0
      } else {
        if (runStart !== -1) {
          gapCount++
          if (gapCount > MAX_GAP) {
            var runEnd = x - gapCount
            if (runEnd - runStart >= MIN_LINE_LENGTH) {
              hSegments.push({ x1: runStart, y1: y, x2: runEnd, y2: y })
            }
            runStart = -1
            gapCount = 0
          }
        }
      }
    }
    if (runStart !== -1) {
      var endX = width - 1 - gapCount
      if (endX - runStart >= MIN_LINE_LENGTH) {
        hSegments.push({ x1: runStart, y1: y, x2: endX, y2: y })
      }
    }
  }

  // Step 3: Detect vertical wall segments
  var vSegments = []
  for (var x2 = 1; x2 < width - 1; x2++) {
    var runStartV = -1
    var gapCountV = 0

    for (var y2 = 0; y2 < height; y2++) {
      var idx2 = y2 * width + x2
      var isDark2 = mask[idx2] === 1

      if (isDark2) {
        var thick2 = 0
        for (var dx = -2; dx <= 2; dx++) {
          var nx = x2 + dx
          if (nx >= 0 && nx < width && mask[y2 * width + nx] === 1) thick2++
        }
        isDark2 = thick2 >= MIN_THICKNESS
      }

      if (isDark2) {
        if (runStartV === -1) runStartV = y2
        gapCountV = 0
      } else {
        if (runStartV !== -1) {
          gapCountV++
          if (gapCountV > MAX_GAP) {
            var runEndV = y2 - gapCountV
            if (runEndV - runStartV >= MIN_LINE_LENGTH) {
              vSegments.push({ x1: x2, y1: runStartV, x2: x2, y2: runEndV })
            }
            runStartV = -1
            gapCountV = 0
          }
        }
      }
    }
    if (runStartV !== -1) {
      var endY = height - 1 - gapCountV
      if (endY - runStartV >= MIN_LINE_LENGTH) {
        vSegments.push({ x1: x2, y1: runStartV, x2: x2, y2: endY })
      }
    }
  }

  // Step 4: Merge nearby parallel segments
  // Horizontal: merge segments at similar y with overlapping x ranges
  var mergedH = mergeSegments(hSegments, 'h', 4)
  var mergedV = mergeSegments(vSegments, 'v', 4)

  return { horizontal: mergedH, vertical: mergedV, mask: mask }
}

function mergeSegments(segments, axis, tolerance) {
  if (segments.length === 0) return []

  // Sort by position (y for horizontal, x for vertical)
  var sorted = segments.slice().sort(function(a, b) {
    if (axis === 'h') return a.y1 - b.y1 || a.x1 - b.x1
    return a.x1 - b.x1 || a.y1 - b.y1
  })

  var merged = []
  var cur = Object.assign({}, sorted[0])

  for (var i = 1; i < sorted.length; i++) {
    var seg = sorted[i]
    var samePos = axis === 'h'
      ? Math.abs(seg.y1 - cur.y1) <= tolerance
      : Math.abs(seg.x1 - cur.x1) <= tolerance

    var overlaps = axis === 'h'
      ? seg.x1 <= cur.x2 + tolerance
      : seg.y1 <= cur.y2 + tolerance

    if (samePos && overlaps) {
      // Merge
      if (axis === 'h') {
        cur.x2 = Math.max(cur.x2, seg.x2)
        cur.y1 = Math.round((cur.y1 + seg.y1) / 2)
        cur.y2 = cur.y1
      } else {
        cur.y2 = Math.max(cur.y2, seg.y2)
        cur.x1 = Math.round((cur.x1 + seg.x1) / 2)
        cur.x2 = cur.x1
      }
    } else {
      merged.push(cur)
      cur = Object.assign({}, seg)
    }
  }
  merged.push(cur)

  return merged
}


// ─── DOOR DETECTION from the dark pixel mask ─────────────────────────────────
// Doors are gaps in walls where there's an arc (curved line).
// We detect them by finding gaps in wall lines and checking for curved pixels nearby.

function detectDoorGaps(hWalls, vWalls, mask, width, height) {
  var doors = []

  // For each horizontal wall, check if there are gaps
  // A gap in a horizontal wall at row y means: there's a range of x where no wall exists
  // but walls exist on both sides
  // We look for arcs near those gaps

  // Actually, the door arcs are already detected as short curved dark pixel regions
  // For now, we just identify wall gaps as potential door locations
  // The actual arc drawing will come from the pixel data

  return doors
}


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
  const imgElRef = useRef(null)

  var handleFile = useCallback(function(file) {
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
        var dataUrl = c.toDataURL('image/png')
        setImage(dataUrl)
        setImgSize({ w: c.width, h: c.height })
        imgElRef.current = { canvas: c, width: c.width, height: c.height }
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
    if (!imgElRef.current) return
    setLoading(true)
    setError(null)
    setAnalysis(null)

    try {
      var imgCanvas = imgElRef.current.canvas
      var w = imgElRef.current.width
      var h = imgElRef.current.height

      // STEP 1: Image processing — detect walls from dark pixels
      var ctx = imgCanvas.getContext('2d')
      var pixelData = ctx.getImageData(0, 0, w, h)

      var wallData = detectWalls(pixelData, w, h)
      var allWalls = wallData.horizontal.concat(wallData.vertical)

      // STEP 2: (Optional) Call AI for text labels only
      var labels = []
      try {
        var apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
        if (apiKey) {
          var dataUrl = imgCanvas.toDataURL('image/jpeg', 0.85)
          var base64 = dataUrl.split(',')[1]

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
              max_tokens: 2048,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
                  { type: 'text', text: LABEL_PROMPT }
                ]
              }]
            })
          })

          if (resp.ok) {
            var data = await resp.json()
            var text = ''
            data.content.forEach(function(b) { text += (b.text || '') })
            var clean = text.replace(/```json/g, '').replace(/```/g, '').trim()
            var parsed = JSON.parse(clean)
            labels = parsed.labels || []
          }
        }
      } catch (labelErr) {
        console.warn('Label detection failed:', labelErr)
      }

      setAnalysis({
        walls: allWalls,
        hWalls: wallData.horizontal.length,
        vWalls: wallData.vertical.length,
        labels: labels,
        imgWidth: w,
        imgHeight: h
      })

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
    if (walls.length === 0) return

    var srcW = analysis.imgWidth
    var srcH = analysis.imgHeight

    // Scale to fit display
    var PAD = 60
    var scale = Math.min((850 - PAD * 2) / srcW, (750 - PAD * 2) / srcH, 1)

    var cw = srcW * scale + PAD * 2
    var ch = srcH * scale + PAD * 2

    canvas.width = cw
    canvas.height = ch

    var ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cw, ch)

    var X = function(px) { return PAD + px * scale }
    var Y = function(py) { return PAD + py * scale }

    // Draw walls
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = Math.max(2, 4 * scale)
    ctx.lineCap = 'square'

    walls.forEach(function(w) {
      ctx.beginPath()
      ctx.moveTo(X(w.x1), Y(w.y1))
      ctx.lineTo(X(w.x2), Y(w.y2))
      ctx.stroke()
    })

    // Draw labels from AI (positioned roughly in room centers)
    // Since AI doesn't know pixel positions, we skip label placement for now
    // The wall structure itself tells the story

    // North arrow
    ctx.fillStyle = '#9ca3af'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText('N \u2191', cw - 8, 8)

    // Stats
    ctx.fillStyle = '#6b7280'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText(analysis.hWalls + ' horizontal + ' + analysis.vWalls + ' vertical walls detected', PAD, ch - 8)
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
              {loading ? 'Processing\u2026' : 'Detect Walls'}
            </button>
            <button onClick={function() { setImage(null); setImageData(null); setImgSize(null); setAnalysis(null); setError(null); imgElRef.current = null }}
              className="fpa-btn fpa-btn-secondary">Clear</button>
          </div>
        </div>
      )}

      {error && <div className="fpa-error">{error}</div>}

      {loading && (
        <div className="fpa-loading">
          <div className="fpa-spinner" />
          <p>Processing floor plan&hellip;</p>
          <p className="fpa-loading-sub">Scanning pixels for wall lines</p>
        </div>
      )}

      {analysis && (
        <div className="fpa-result">
          <div className="fpa-result-header">
            <h2>Detected Floor Plan</h2>
            <div className="fpa-result-stats">
              {analysis.hWalls} horizontal walls &middot; {analysis.vWalls} vertical walls
            </div>
          </div>
          <div className="fpa-canvas-wrap">
            <canvas ref={canvasRef} className="fpa-canvas" />
          </div>
          <details className="fpa-details">
            <summary>Detection Data ({analysis.walls.length} segments)</summary>
            <pre className="fpa-json">{JSON.stringify(analysis, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  )
}
