import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 900

const LABEL_PROMPT = `Look at this floor plan image carefully.

Find the TOTAL overall width and height of the ENTIRE floor plan building outline.

Also list all room dimension labels.

Return JSON:
{
  "overall_width_m": 9.2,
  "overall_height_m": 12.9,
  "labels": [
    { "text": "3.7 x 3.7M", "type": "dimension" },
    { "text": "BATH", "type": "room_name" }
  ]
}

- If multiple width dimensions exist at top, ADD them together.
- Same for height on left/right edges.
- If no overall dimension found, set to null.

Return ONLY valid JSON.`


function detectWalls(imageData, width, height) {
  var data = imageData.data
  var DARK = 105
  var MIN_LEN = 15
  var MIN_THICK = 3
  var MAX_GAP = 6

  var mask = new Uint8Array(width * height)
  for (var i = 0; i < width * height; i++) {
    var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3]
    if (a > 100 && r < DARK && g < DARK && b < DARK) mask[i] = 1
  }

  // Horizontal scan
  var hSegs = []
  var lastHY = -999
  for (var y = 0; y < height; y++) {
    if (y - lastHY < 7) continue
    var runStart = -1, gap = 0, foundAny = false
    for (var x = 0; x < width; x++) {
      var thick = 0
      for (var dy = -4; dy <= 4; dy++) {
        var ny = y + dy
        if (ny >= 0 && ny < height && mask[ny * width + x]) thick++
      }
      if (thick >= MIN_THICK) {
        if (runStart === -1) runStart = x
        gap = 0
      } else if (runStart !== -1) {
        gap++
        if (gap > MAX_GAP) {
          var end = x - gap
          if (end - runStart >= MIN_LEN) { hSegs.push({ x1: runStart, y1: y, x2: end, y2: y }); foundAny = true }
          runStart = -1; gap = 0
        }
      }
    }
    if (runStart !== -1) {
      var endX = width - 1 - gap
      if (endX - runStart >= MIN_LEN) { hSegs.push({ x1: runStart, y1: y, x2: endX, y2: y }); foundAny = true }
    }
    if (foundAny) lastHY = y
  }

  // Vertical scan
  var vSegs = []
  var lastVX = -999
  for (var x2 = 0; x2 < width; x2++) {
    if (x2 - lastVX < 7) continue
    var runStart2 = -1, gap2 = 0, foundAny2 = false
    for (var y2 = 0; y2 < height; y2++) {
      var thick2 = 0
      for (var dx = -4; dx <= 4; dx++) {
        var nx = x2 + dx
        if (nx >= 0 && nx < width && mask[y2 * width + nx]) thick2++
      }
      if (thick2 >= MIN_THICK) {
        if (runStart2 === -1) runStart2 = y2
        gap2 = 0
      } else if (runStart2 !== -1) {
        gap2++
        if (gap2 > MAX_GAP) {
          var end2 = y2 - gap2
          if (end2 - runStart2 >= MIN_LEN) { vSegs.push({ x1: x2, y1: runStart2, x2: x2, y2: end2 }); foundAny2 = true }
          runStart2 = -1; gap2 = 0
        }
      }
    }
    if (runStart2 !== -1) {
      var endY = height - 1 - gap2
      if (endY - runStart2 >= MIN_LEN) { vSegs.push({ x1: x2, y1: runStart2, x2: x2, y2: endY }); foundAny2 = true }
    }
    if (foundAny2) lastVX = x2
  }

  var mergedH = mergeSegments(hSegs, 'h', 10)
  var mergedV = mergeSegments(vSegs, 'v', 10)

  // Remove segments outside building envelope
  var envelope = findBuildingEnvelope(mergedH, mergedV)
  if (envelope) {
    mergedH = filterOutsideEnvelope(mergedH, envelope, 'h', 15)
    mergedV = filterOutsideEnvelope(mergedV, envelope, 'v', 15)
  }

  // Remove floating segments — must connect to perpendicular wall at least one end
  // Run multiple passes: first filter H using V, then filter V using filtered H
  mergedH = filterUnconnected(mergedH, mergedV, 'h', 20)
  mergedV = filterUnconnected(mergedV, mergedH, 'v', 20)

  return { horizontal: mergedH, vertical: mergedV }
}


// A wall is real if at least one of its ends connects to a perpendicular wall.
// No length exception — even long dark bars inside rooms get filtered if they
// don't connect to anything.
function filterUnconnected(walls, crossWalls, axis, tol) {
  return walls.filter(function(w) {
    // Check if start or end connects to any perpendicular wall
    var startConnected = false
    var endConnected = false

    crossWalls.forEach(function(cw) {
      if (startConnected && endConnected) return

      if (axis === 'h') {
        // w is horizontal: check if vertical wall cw touches near x1 or x2
        // cw must span the y position of w
        if (w.y1 >= cw.y1 - tol && w.y1 <= cw.y2 + tol) {
          if (Math.abs(cw.x1 - w.x1) < tol) startConnected = true
          if (Math.abs(cw.x1 - w.x2) < tol) endConnected = true
        }
      } else {
        // w is vertical: check if horizontal wall cw touches near y1 or y2
        if (w.x1 >= cw.x1 - tol && w.x1 <= cw.x2 + tol) {
          if (Math.abs(cw.y1 - w.y1) < tol) startConnected = true
          if (Math.abs(cw.y1 - w.y2) < tol) endConnected = true
        }
      }
    })

    return startConnected || endConnected
  })
}


function findBuildingEnvelope(hWalls, vWalls) {
  if (hWalls.length < 2 || vWalls.length < 2) return null
  var hSorted = hWalls.slice().sort(function(a, b) { return a.y1 - b.y1 })
  var vSorted = vWalls.slice().sort(function(a, b) { return a.x1 - b.x1 })
  return {
    top: hSorted[0].y1,
    bottom: hSorted[hSorted.length - 1].y1,
    left: vSorted[0].x1,
    right: vSorted[vSorted.length - 1].x1
  }
}

function filterOutsideEnvelope(walls, env, axis, margin) {
  return walls.filter(function(w) {
    if (axis === 'h') return w.y1 >= env.top - margin && w.y1 <= env.bottom + margin
    return w.x1 >= env.left - margin && w.x1 <= env.right + margin
  })
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
    var samePos = axis === 'h' ? Math.abs(s.y1 - cur.y1) <= tol : Math.abs(s.x1 - cur.x1) <= tol
    var overlaps = axis === 'h' ? s.x1 <= cur.x2 + tol * 2 : s.y1 <= cur.y2 + tol * 2
    if (samePos && overlaps) {
      if (axis === 'h') {
        cur.x1 = Math.min(cur.x1, s.x1); cur.x2 = Math.max(cur.x2, s.x2)
        cur.y1 = Math.round((cur.y1 + s.y1) / 2); cur.y2 = cur.y1
      } else {
        cur.y1 = Math.min(cur.y1, s.y1); cur.y2 = Math.max(cur.y2, s.y2)
        cur.x1 = Math.round((cur.x1 + s.x1) / 2); cur.x2 = cur.x1
      }
    } else { merged.push(cur); cur = { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 } }
  }
  merged.push(cur)
  return merged
}


function calculatePPM(wallData, aiData, imgW, imgH) {
  var allWalls = wallData.horizontal.concat(wallData.vertical)
  if (allWalls.length === 0) return 80
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  allWalls.forEach(function(w) {
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2)
    minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2)
  })
  if (!aiData) return (maxX - minX) / 10
  var ppmW = null, ppmH = null
  if (aiData.overall_width_m > 0) ppmW = (maxX - minX) / aiData.overall_width_m
  if (aiData.overall_height_m > 0) ppmH = (maxY - minY) / aiData.overall_height_m
  if (ppmW && ppmH) return (ppmW + ppmH) / 2
  return ppmW || ppmH || (maxX - minX) / 10
}


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
        c.width = img.width * scale; c.height = img.height * scale
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
      var pixelData = imgCanvas.getContext('2d').getImageData(0, 0, w, h)
      var wallData = detectWalls(pixelData, w, h)

      var aiData = null, labels = [], ppm = null
      try {
        var apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
        if (apiKey) {
          var base64 = imgCanvas.toDataURL('image/jpeg', 0.85).split(',')[1]
          var resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
            body: JSON.stringify({ model: MODEL, max_tokens: 2048, messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
              { type: 'text', text: LABEL_PROMPT }
            ]}]})
          })
          if (resp.ok) {
            var data = await resp.json()
            var text = ''; data.content.forEach(function(b) { text += (b.text || '') })
            aiData = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim())
            labels = aiData.labels || []
          }
        }
      } catch (e2) { console.warn('Label err:', e2) }

      ppm = calculatePPM(wallData, aiData, w, h)
      setAnalysis({
        walls: wallData.horizontal.concat(wallData.vertical),
        hWalls: wallData.horizontal, vWalls: wallData.vertical,
        hCount: wallData.horizontal.length, vCount: wallData.vertical.length,
        labels: labels, ppm: ppm, aiData: aiData, imgWidth: w, imgHeight: h
      })
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  useEffect(function() {
    if (analysis && analysis.walls && analysis.walls.length > 0) drawFloorPlan()
  }, [analysis])

  var drawFloorPlan = function() {
    var canvas = canvasRef.current
    if (!canvas || !analysis) return
    var allWalls = (analysis.hWalls || []).concat(analysis.vWalls || [])
    if (allWalls.length === 0) return
    var srcW = analysis.imgWidth, srcH = analysis.imgHeight, ppm = analysis.ppm || 80
    var PAD = 70
    var scale = Math.min((900 - PAD * 2) / srcW, (800 - PAD * 2) / srcH, 1)
    var cw = srcW * scale + PAD * 2, ch = srcH * scale + PAD * 2
    canvas.width = cw; canvas.height = ch
    var ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch)
    var X = function(px) { return PAD + px * scale }
    var Y = function(py) { return PAD + py * scale }

    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = Math.max(2.5, 4 * scale); ctx.lineCap = 'square'
    allWalls.forEach(function(w) {
      ctx.beginPath(); ctx.moveTo(X(w.x1), Y(w.y1)); ctx.lineTo(X(w.x2), Y(w.y2)); ctx.stroke()
    })

    ctx.fillStyle = '#2563eb'
    allWalls.forEach(function(w) {
      var dx = w.x2 - w.x1, dy = w.y2 - w.y1
      var lenPx = Math.sqrt(dx * dx + dy * dy), screenLen = lenPx * scale
      if (screenLen < 35) return
      var label = (lenPx / ppm).toFixed(2) + 'm'
      var fs = Math.max(8, Math.min(11, screenLen / 8))
      ctx.font = fs + 'px "Segoe UI", system-ui, sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      var mx = X((w.x1 + w.x2) / 2), my = Y((w.y1 + w.y2) / 2)
      if (Math.abs(dy) < 2) { ctx.fillText(label, mx, my - 10) }
      else { ctx.save(); ctx.translate(mx - 10, my); ctx.rotate(-Math.PI / 2); ctx.fillText(label, 0, 0); ctx.restore() }
    })

    ctx.fillStyle = '#9ca3af'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'top'
    ctx.fillText('N \u2191', cw - 8, 8)
    ctx.fillStyle = '#6b7280'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
    ctx.fillText(analysis.hCount + 'H + ' + analysis.vCount + 'V | ppm=' + (ppm || 0).toFixed(1), PAD, ch - 8)
  }

  return (
    <div className="fpa-root">
      <header className="fpa-header">
        <h1>CarpetPlan</h1>
        <p className="fpa-subtitle">Upload a floor plan &rarr; Detect walls &amp; measure dimensions</p>
      </header>
      {!image && (
        <div className="fpa-upload" onClick={function() { fileRef.current && fileRef.current.click() }}
          onDrop={onDrop}
          onDragOver={function(e) { e.preventDefault(); e.currentTarget.classList.add('drag') }}
          onDragLeave={function(e) { e.currentTarget.classList.remove('drag') }}>
          <input ref={fileRef} type="file" accept="image/*" onChange={function(e) { handleFile(e.target.files[0]) }} />
          <span className="fpa-upload-icon">&#x1F4D0;</span>
          <span className="fpa-upload-text">Drop floor plan image or click to browse</span>
        </div>
      )}
      {image && (
        <div className="fpa-controls">
          <img src={image} alt="Floor plan" className="fpa-preview" />
          <div className="fpa-buttons">
            <button onClick={analyze} disabled={loading} className="fpa-btn fpa-btn-primary">{loading ? 'Processing\u2026' : 'Detect Walls'}</button>
            <button onClick={function() { setImage(null); setImgSize(null); setAnalysis(null); setError(null); imgElRef.current = null }} className="fpa-btn fpa-btn-secondary">Clear</button>
          </div>
        </div>
      )}
      {error && <div className="fpa-error">{error}</div>}
      {loading && (<div className="fpa-loading"><div className="fpa-spinner" /><p>Processing floor plan&hellip;</p><p className="fpa-loading-sub">Scanning pixels, calibrating dimensions</p></div>)}
      {analysis && (
        <div className="fpa-result">
          <div className="fpa-result-header">
            <h2>Detected Floor Plan</h2>
            <div className="fpa-result-stats">{analysis.hCount}H &middot; {analysis.vCount}V walls{analysis.ppm ? ' \u00b7 ' + analysis.ppm.toFixed(1) + ' px/m' : ''}</div>
          </div>
          <div className="fpa-canvas-wrap"><canvas ref={canvasRef} className="fpa-canvas" /></div>
          <details className="fpa-details"><summary>Detection Data</summary>
            <pre className="fpa-json">{JSON.stringify({ aiData: analysis.aiData, ppm: analysis.ppm, wallCount: analysis.walls.length }, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  )
}
