import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 900

const LABEL_PROMPT = `Look at this floor plan image. List every text label and dimension annotation visible.

Return JSON:
{
  "labels": [
    { "text": "3.7 x 3.7M", "type": "dimension" },
    { "text": "BATH", "type": "room_name" }
  ],
  "calibration": {
    "room_text": "3.7 x 3.7M",
    "width_m": 3.7,
    "height_m": 3.7
  }
}

For calibration, pick the clearest labeled room where you can read both dimensions confidently.
Return ONLY valid JSON.`


// ─── IMAGE PROCESSING ────────────────────────────────────────────────────────

function detectWalls(imageData, width, height) {
  var data = imageData.data
  var DARK = 100
  var MIN_LEN = 15
  var MIN_THICK = 3
  var MAX_GAP = 4

  // Build dark pixel mask
  var mask = new Uint8Array(width * height)
  for (var i = 0; i < width * height; i++) {
    var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3]
    if (a > 100 && r < DARK && g < DARK && b < DARK) mask[i] = 1
  }

  // ── Horizontal: scan rows, but SKIP rows too close to already-found walls ──
  var hSegs = []
  var lastHWallY = -999  // track last wall y to skip duplicates

  for (var y = 0; y < height; y++) {
    // Skip if too close to a wall we already found
    if (y - lastHWallY < 8) continue

    var runStart = -1, gap = 0
    var foundAny = false

    for (var x = 0; x < width; x++) {
      // Check vertical thickness at this point
      var thick = 0
      for (var dy = -4; dy <= 4; dy++) {
        var ny = y + dy
        if (ny >= 0 && ny < height && mask[ny * width + x]) thick++
      }
      var isWall = thick >= MIN_THICK

      if (isWall) {
        if (runStart === -1) runStart = x
        gap = 0
      } else if (runStart !== -1) {
        gap++
        if (gap > MAX_GAP) {
          var end = x - gap
          if (end - runStart >= MIN_LEN) {
            hSegs.push({ x1: runStart, y1: y, x2: end, y2: y })
            foundAny = true
          }
          runStart = -1; gap = 0
        }
      }
    }
    if (runStart !== -1) {
      var endX = width - 1 - gap
      if (endX - runStart >= MIN_LEN) {
        hSegs.push({ x1: runStart, y1: y, x2: endX, y2: y })
        foundAny = true
      }
    }

    if (foundAny) lastHWallY = y
  }

  // ── Vertical: scan columns, skip columns too close to already-found walls ──
  var vSegs = []
  var lastVWallX = -999

  for (var x2 = 0; x2 < width; x2++) {
    if (x2 - lastVWallX < 8) continue

    var runStart2 = -1, gap2 = 0
    var foundAny2 = false

    for (var y2 = 0; y2 < height; y2++) {
      var thick2 = 0
      for (var dx = -4; dx <= 4; dx++) {
        var nx = x2 + dx
        if (nx >= 0 && nx < width && mask[y2 * width + nx]) thick2++
      }
      var isWall2 = thick2 >= MIN_THICK

      if (isWall2) {
        if (runStart2 === -1) runStart2 = y2
        gap2 = 0
      } else if (runStart2 !== -1) {
        gap2++
        if (gap2 > MAX_GAP) {
          var end2 = y2 - gap2
          if (end2 - runStart2 >= MIN_LEN) {
            vSegs.push({ x1: x2, y1: runStart2, x2: x2, y2: end2 })
            foundAny2 = true
          }
          runStart2 = -1; gap2 = 0
        }
      }
    }
    if (runStart2 !== -1) {
      var endY = height - 1 - gap2
      if (endY - runStart2 >= MIN_LEN) {
        vSegs.push({ x1: x2, y1: runStart2, x2: x2, y2: endY })
        foundAny2 = true
      }
    }

    if (foundAny2) lastVWallX = x2
  }

  // Merge remaining nearby duplicates
  var mergedH = mergeSegments(hSegs, 'h', 10)
  var mergedV = mergeSegments(vSegs, 'v', 10)

  return { horizontal: mergedH, vertical: mergedV }
}

function mergeSegments(segments, axis, tol) {
  if (segments.length === 0) return []

  var sorted = segments.slice().sort(function(a, b) {
    if (axis === 'h') return a.y1 - b.y1 || a.x1 - b.x1
    return a.x1 - b.x1 || a.y1 - b.y1
  })

  var merged = []
  var cur = { x1: sorted[0].x1, y1: sorted[0].y1, x2: sorted[0].x2, y2: sorted[0].y2 }

  for (var i = 1; i < sorted.length; i++) {
    var s = sorted[i]
    var samePos = axis === 'h'
      ? Math.abs(s.y1 - cur.y1) <= tol
      : Math.abs(s.x1 - cur.x1) <= tol
    var overlaps = axis === 'h'
      ? s.x1 <= cur.x2 + tol * 2
      : s.y1 <= cur.y2 + tol * 2

    if (samePos && overlaps) {
      if (axis === 'h') {
        cur.x1 = Math.min(cur.x1, s.x1)
        cur.x2 = Math.max(cur.x2, s.x2)
        cur.y1 = Math.round((cur.y1 + s.y1) / 2)
        cur.y2 = cur.y1
      } else {
        cur.y1 = Math.min(cur.y1, s.y1)
        cur.y2 = Math.max(cur.y2, s.y2)
        cur.x1 = Math.round((cur.x1 + s.x1) / 2)
        cur.x2 = cur.x1
      }
    } else {
      merged.push(cur)
      cur = { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }
    }
  }
  merged.push(cur)
  return merged
}


// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function FloorPlanAnalyzer() {
  const [image, setImage] = useState(null)
  const [imgSize, setImgSize] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)
  const fileRef = useRef(null)
  const imgElRef = useRef(null)

  var handleFile = useCallback(function(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return
    setError(null); setAnalysis(null)

    var reader = new FileReader()
    reader.onload = function(e) {
      var img = new Image()
      img.onload = function() {
        var scale = img.width > MAX_IMG_WIDTH ? MAX_IMG_WIDTH / img.width : 1
        var c = document.createElement('canvas')
        c.width = img.width * scale
        c.height = img.height * scale
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
        setImage(c.toDataURL('image/png'))
        setImgSize({ w: c.width, h: c.height })
        imgElRef.current = { canvas: c, width: c.width, height: c.height }
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  }, [])

  var onDrop = useCallback(function(e) {
    e.preventDefault(); e.currentTarget.classList.remove('drag')
    handleFile(e.dataTransfer.files[0])
  }, [handleFile])

  var analyze = async function() {
    if (!imgElRef.current) return
    setLoading(true); setError(null); setAnalysis(null)

    try {
      var imgCanvas = imgElRef.current.canvas
      var w = imgElRef.current.width, h = imgElRef.current.height

      var ctx = imgCanvas.getContext('2d')
      var pixelData = ctx.getImageData(0, 0, w, h)
      var wallData = detectWalls(pixelData, w, h)

      // AI for labels + calibration
      var labels = [], ppm = null, calibration = null
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
              model: MODEL, max_tokens: 2048,
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
            var text = ''; data.content.forEach(function(b) { text += (b.text || '') })
            var clean = text.replace(/```json/g, '').replace(/```/g, '').trim()
            var parsed = JSON.parse(clean)
            labels = parsed.labels || []
            calibration = parsed.calibration || null
            if (calibration) ppm = estimatePPM(wallData, calibration, w, h)
          }
        }
      } catch (e2) { console.warn('Label err:', e2) }

      if (!ppm) ppm = estimatePPMFallback(wallData)

      setAnalysis({
        walls: wallData.horizontal.concat(wallData.vertical),
        hWalls: wallData.horizontal,
        vWalls: wallData.vertical,
        hCount: wallData.horizontal.length,
        vCount: wallData.vertical.length,
        labels: labels,
        ppm: ppm,
        calibration: calibration,
        imgWidth: w, imgHeight: h
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function estimatePPM(wallData, cal, imgW, imgH) {
    if (!cal || !cal.width_m || !cal.height_m) return null
    var hWalls = wallData.horizontal.slice().sort(function(a, b) { return a.y1 - b.y1 || a.x1 - b.x1 })
    var vWalls = wallData.vertical.slice().sort(function(a, b) { return a.x1 - b.x1 || a.y1 - b.y1 })
    if (hWalls.length < 2 || vWalls.length < 2) return null

    var topWall = hWalls[0]
    var roomBottoms = hWalls.filter(function(w) { return w.y1 > topWall.y1 + 20 && w.x1 < imgW * 0.5 })
    if (roomBottoms.length === 0) return null
    var heightPx = roomBottoms[0].y1 - topWall.y1
    var ppmH = heightPx / cal.height_m

    var leftWall = vWalls[0]
    var roomRights = vWalls.filter(function(w) { return w.x1 > leftWall.x1 + 20 && w.y1 < imgH * 0.5 })
    if (roomRights.length > 0) {
      var widthPx = roomRights[0].x1 - leftWall.x1
      return (ppmH + widthPx / cal.width_m) / 2
    }
    return ppmH
  }

  function estimatePPMFallback(wallData) {
    var all = wallData.horizontal.concat(wallData.vertical)
    if (all.length === 0) return 80
    var minX = Infinity, maxX = -Infinity
    all.forEach(function(w) { minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2) })
    return (maxX - minX) / 10
  }

  useEffect(function() {
    if (analysis && analysis.walls && analysis.walls.length > 0) drawFloorPlan()
  }, [analysis])

  var drawFloorPlan = function() {
    var canvas = canvasRef.current
    if (!canvas || !analysis) return

    var hWalls = analysis.hWalls || []
    var vWalls = analysis.vWalls || []
    var allWalls = hWalls.concat(vWalls)
    if (allWalls.length === 0) return

    var srcW = analysis.imgWidth, srcH = analysis.imgHeight
    var ppm = analysis.ppm || 80

    var PAD = 70
    var scale = Math.min((900 - PAD * 2) / srcW, (800 - PAD * 2) / srcH, 1)
    var cw = srcW * scale + PAD * 2
    var ch = srcH * scale + PAD * 2
    canvas.width = cw; canvas.height = ch

    var ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cw, ch)

    var X = function(px) { return PAD + px * scale }
    var Y = function(py) { return PAD + py * scale }

    // Draw walls
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = Math.max(2.5, 4 * scale)
    ctx.lineCap = 'square'

    allWalls.forEach(function(w) {
      ctx.beginPath()
      ctx.moveTo(X(w.x1), Y(w.y1))
      ctx.lineTo(X(w.x2), Y(w.y2))
      ctx.stroke()
    })

    // Dimension labels on walls
    var MIN_LABEL_PX = 35
    ctx.fillStyle = '#2563eb'

    allWalls.forEach(function(w) {
      var dx = w.x2 - w.x1, dy = w.y2 - w.y1
      var lenPx = Math.sqrt(dx * dx + dy * dy)
      var lenM = lenPx / ppm
      var screenLen = lenPx * scale
      if (screenLen < MIN_LABEL_PX) return

      var label = lenM.toFixed(2) + 'm'
      var fontSize = Math.max(8, Math.min(11, screenLen / 8))
      ctx.font = fontSize + 'px "Segoe UI", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      var mx = X((w.x1 + w.x2) / 2)
      var my = Y((w.y1 + w.y2) / 2)

      if (Math.abs(dy) < 2) {
        ctx.fillText(label, mx, my - 10)
      } else {
        ctx.save()
        ctx.translate(mx - 10, my)
        ctx.rotate(-Math.PI / 2)
        ctx.fillText(label, 0, 0)
        ctx.restore()
      }
    })

    ctx.fillStyle = '#9ca3af'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText('N \u2191', cw - 8, 8)

    ctx.fillStyle = '#6b7280'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText(analysis.hCount + 'H + ' + analysis.vCount + 'V walls | ppm=' + (ppm || 0).toFixed(1), PAD, ch - 8)
  }

  return (
    <div className="fpa-root">
      <header className="fpa-header">
        <h1>CarpetPlan</h1>
        <p className="fpa-subtitle">Upload a floor plan &rarr; Detect walls &amp; measure dimensions</p>
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
            <button onClick={function() { setImage(null); setImgSize(null); setAnalysis(null); setError(null); imgElRef.current = null }}
              className="fpa-btn fpa-btn-secondary">Clear</button>
          </div>
        </div>
      )}

      {error && <div className="fpa-error">{error}</div>}

      {loading && (
        <div className="fpa-loading">
          <div className="fpa-spinner" />
          <p>Processing floor plan&hellip;</p>
          <p className="fpa-loading-sub">Scanning pixels for walls, reading labels</p>
        </div>
      )}

      {analysis && (
        <div className="fpa-result">
          <div className="fpa-result-header">
            <h2>Detected Floor Plan</h2>
            <div className="fpa-result-stats">
              {analysis.hCount} horizontal &middot; {analysis.vCount} vertical walls
              {analysis.ppm ? ' \u00b7 ' + analysis.ppm.toFixed(1) + ' px/m' : ''}
            </div>
          </div>
          <div className="fpa-canvas-wrap">
            <canvas ref={canvasRef} className="fpa-canvas" />
          </div>
          <details className="fpa-details">
            <summary>Detection Data</summary>
            <pre className="fpa-json">{JSON.stringify({
              calibration: analysis.calibration,
              ppm: analysis.ppm,
              labels: analysis.labels,
              wallCount: analysis.walls.length
            }, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  )
}
