import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 900

// AI only reads text labels with approximate positions (as fractions 0-1)
const LABEL_PROMPT = `You are reading text from a floor plan image.

For EVERY dimension label visible in the image (like "3.7 x 3.7M", "5.5 x 3.7M", "BATH", "VOID"):

1. Read the text exactly
2. Estimate where it is in the image as a fraction: x_frac (0=left edge, 1=right edge), y_frac (0=top edge, 1=bottom edge)
3. If it's a dimension like "3.7 x 3.7M", parse width_m and height_m (first number = width, second = height)

Return JSON:
{
  "dimensions": [
    { "text": "3.7 x 3.7M", "x_frac": 0.2, "y_frac": 0.15, "width_m": 3.7, "height_m": 3.7 },
    { "text": "5.5 x 3.7M", "x_frac": 0.6, "y_frac": 0.15, "width_m": 5.5, "height_m": 3.7 },
    { "text": "BATH", "x_frac": 0.15, "y_frac": 0.35, "width_m": null, "height_m": null }
  ]
}

IMPORTANT:
- x_frac and y_frac are rough positions (0.0 to 1.0) of where the label CENTER appears in the image
- For dimensions like "3.8 x 3.9M": width_m=3.8, height_m=3.9
- For room names without dimensions (BATH, VOID, FP): width_m=null, height_m=null
- Include ALL visible text labels

Return ONLY valid JSON.`


// ─── WALL DETECTION ──────────────────────────────────────────────────────────

function detectWalls(imageData, width, height) {
  var data = imageData.data
  var DARK = 105, MIN_LEN = 15, MIN_THICK = 4, MAX_GAP = 6

  var mask = new Uint8Array(width * height)
  for (var i = 0; i < width * height; i++) {
    var r = data[i*4], g = data[i*4+1], b = data[i*4+2], a = data[i*4+3]
    if (a > 100 && r < DARK && g < DARK && b < DARK) mask[i] = 1
  }

  var hSegs = [], lastHY = -999
  for (var y = 0; y < height; y++) {
    if (y - lastHY < 7) continue
    var rs = -1, gap = 0, found = false
    for (var x = 0; x < width; x++) {
      var t = 0
      for (var dy = -5; dy <= 5; dy++) { var ny = y+dy; if (ny>=0&&ny<height&&mask[ny*width+x]) t++ }
      if (t >= MIN_THICK) { if (rs===-1) rs=x; gap=0 }
      else if (rs !== -1) { gap++; if (gap>MAX_GAP) { var e=x-gap; if(e-rs>=MIN_LEN){hSegs.push({x1:rs,y1:y,x2:e,y2:y});found=true} rs=-1;gap=0 } }
    }
    if (rs!==-1) { var ex=width-1-gap; if(ex-rs>=MIN_LEN){hSegs.push({x1:rs,y1:y,x2:ex,y2:y});found=true} }
    if (found) lastHY = y
  }

  var vSegs = [], lastVX = -999
  for (var x2 = 0; x2 < width; x2++) {
    if (x2 - lastVX < 7) continue
    var rs2 = -1, gap2 = 0, found2 = false
    for (var y2 = 0; y2 < height; y2++) {
      var t2 = 0
      for (var dx = -5; dx <= 5; dx++) { var nx = x2+dx; if (nx>=0&&nx<width&&mask[y2*width+nx]) t2++ }
      if (t2 >= MIN_THICK) { if (rs2===-1) rs2=y2; gap2=0 }
      else if (rs2 !== -1) { gap2++; if (gap2>MAX_GAP) { var e2=y2-gap2; if(e2-rs2>=MIN_LEN){vSegs.push({x1:x2,y1:rs2,x2:x2,y2:e2});found2=true} rs2=-1;gap2=0 } }
    }
    if (rs2!==-1) { var ey=height-1-gap2; if(ey-rs2>=MIN_LEN){vSegs.push({x1:x2,y1:rs2,x2:x2,y2:ey});found2=true} }
    if (found2) lastVX = x2
  }

  var mH = mergeSegments(hSegs, 'h', 10), mV = mergeSegments(vSegs, 'v', 10)

  var env = findEnvelope(mH, mV)
  if (env) {
    mH = mH.filter(function(w){return w.y1>=env.top-10&&w.y1<=env.bottom+10})
    mV = mV.filter(function(w){return w.x1>=env.left-10&&w.x1<=env.right+10})
  }

  mH = filterUnconnected(mH, mV, 'h', 20, env)
  mV = filterUnconnected(mV, mH, 'v', 20, env)

  return { horizontal: mH, vertical: mV }
}

function filterUnconnected(walls, cross, axis, tol, env) {
  return walls.filter(function(w) {
    var sOk=false, eOk=false
    if (env) {
      if (axis==='h') { if(Math.abs(w.x1-env.left)<tol)sOk=true; if(Math.abs(w.x2-env.right)<tol)eOk=true }
      else { if(Math.abs(w.y1-env.top)<tol)sOk=true; if(Math.abs(w.y2-env.bottom)<tol)eOk=true }
    }
    cross.forEach(function(cw) {
      if(sOk&&eOk)return
      if(axis==='h') {
        if(w.y1>=cw.y1-tol&&w.y1<=cw.y2+tol) { if(Math.abs(cw.x1-w.x1)<tol)sOk=true; if(Math.abs(cw.x1-w.x2)<tol)eOk=true }
      } else {
        if(w.x1>=cw.x1-tol&&w.x1<=cw.x2+tol) { if(Math.abs(cw.y1-w.y1)<tol)sOk=true; if(Math.abs(cw.y1-w.y2)<tol)eOk=true }
      }
    })
    return sOk && eOk
  })
}

function findEnvelope(h, v) {
  if(h.length<2||v.length<2)return null
  var hs=h.slice().sort(function(a,b){return a.y1-b.y1})
  var vs=v.slice().sort(function(a,b){return a.x1-b.x1})
  return {top:hs[0].y1,bottom:hs[hs.length-1].y1,left:vs[0].x1,right:vs[vs.length-1].x1}
}

function mergeSegments(segs, axis, tol) {
  if(!segs.length)return[]
  var s=segs.slice().sort(function(a,b){return axis==='h'?a.y1-b.y1||a.x1-b.x1:a.x1-b.x1||a.y1-b.y1})
  var m=[],c={x1:s[0].x1,y1:s[0].y1,x2:s[0].x2,y2:s[0].y2}
  for(var i=1;i<s.length;i++){
    var si=s[i]
    var sp=axis==='h'?Math.abs(si.y1-c.y1)<=tol:Math.abs(si.x1-c.x1)<=tol
    var ov=axis==='h'?si.x1<=c.x2+tol*2:si.y1<=c.y2+tol*2
    if(sp&&ov){
      if(axis==='h'){c.x1=Math.min(c.x1,si.x1);c.x2=Math.max(c.x2,si.x2);c.y1=Math.round((c.y1+si.y1)/2);c.y2=c.y1}
      else{c.y1=Math.min(c.y1,si.y1);c.y2=Math.max(c.y2,si.y2);c.x1=Math.round((c.x1+si.x1)/2);c.x2=c.x1}
    }else{m.push(c);c={x1:si.x1,y1:si.y1,x2:si.x2,y2:si.y2}}
  }
  m.push(c);return m
}


// ─── ROOM DETECTION: Find rectangular rooms from wall intersections ──────────

function detectRooms(hWalls, vWalls, tol) {
  tol = tol || 20
  // Get unique Y positions from horizontal walls and unique X positions from vertical walls
  var yPositions = [], xPositions = []

  hWalls.forEach(function(w) {
    var found = false
    for (var i = 0; i < yPositions.length; i++) { if (Math.abs(yPositions[i] - w.y1) < tol) { found = true; break } }
    if (!found) yPositions.push(w.y1)
  })

  vWalls.forEach(function(w) {
    var found = false
    for (var i = 0; i < xPositions.length; i++) { if (Math.abs(xPositions[i] - w.x1) < tol) { found = true; break } }
    if (!found) xPositions.push(w.x1)
  })

  yPositions.sort(function(a, b) { return a - b })
  xPositions.sort(function(a, b) { return a - b })

  // For each pair of consecutive Y and X positions, check if walls form a room
  var rooms = []

  for (var yi = 0; yi < yPositions.length - 1; yi++) {
    for (var xi = 0; xi < xPositions.length - 1; xi++) {
      var top = yPositions[yi], bottom = yPositions[yi + 1]
      var left = xPositions[xi], right = xPositions[xi + 1]

      var roomW = right - left
      var roomH = bottom - top

      // Skip tiny cells
      if (roomW < 30 || roomH < 30) continue

      // Check if walls exist on at least 3 sides
      var sides = 0
      // Top wall
      if (hasWallSegment(hWalls, top, left, right, tol)) sides++
      // Bottom wall
      if (hasWallSegment(hWalls, bottom, left, right, tol)) sides++
      // Left wall
      if (hasVWallSegment(vWalls, left, top, bottom, tol)) sides++
      // Right wall
      if (hasVWallSegment(vWalls, right, top, bottom, tol)) sides++

      if (sides >= 3) {
        rooms.push({
          left: left, top: top, right: right, bottom: bottom,
          widthPx: roomW, heightPx: roomH,
          cx: (left + right) / 2, cy: (top + bottom) / 2
        })
      }
    }
  }

  return rooms
}

function hasWallSegment(hWalls, y, x1, x2, tol) {
  for (var i = 0; i < hWalls.length; i++) {
    var w = hWalls[i]
    if (Math.abs(w.y1 - y) < tol) {
      // Wall must cover at least part of the x range
      var overlap = Math.min(w.x2, x2) - Math.max(w.x1, x1)
      if (overlap > (x2 - x1) * 0.3) return true
    }
  }
  return false
}

function hasVWallSegment(vWalls, x, y1, y2, tol) {
  for (var i = 0; i < vWalls.length; i++) {
    var w = vWalls[i]
    if (Math.abs(w.x1 - x) < tol) {
      var overlap = Math.min(w.y2, y2) - Math.max(w.y1, y1)
      if (overlap > (y2 - y1) * 0.3) return true
    }
  }
  return false
}


// ─── MATCH DIMENSIONS TO ROOMS ───────────────────────────────────────────────

function matchDimensionsToRooms(rooms, dimensions, imgW, imgH) {
  var ppmValues = []

  dimensions.forEach(function(dim) {
    if (!dim.width_m || !dim.height_m) return
    if (dim.x_frac == null || dim.y_frac == null) return

    // Convert fraction to pixel position
    var labelX = dim.x_frac * imgW
    var labelY = dim.y_frac * imgH

    // Find which room contains this label
    var bestRoom = null, bestDist = Infinity
    rooms.forEach(function(room) {
      // Check if label is inside the room
      if (labelX >= room.left - 20 && labelX <= room.right + 20 &&
          labelY >= room.top - 20 && labelY <= room.bottom + 20) {
        var dist = Math.sqrt(Math.pow(labelX - room.cx, 2) + Math.pow(labelY - room.cy, 2))
        if (dist < bestDist) { bestDist = dist; bestRoom = room }
      }
    })

    // If not inside any room, find nearest room
    if (!bestRoom) {
      rooms.forEach(function(room) {
        var dist = Math.sqrt(Math.pow(labelX - room.cx, 2) + Math.pow(labelY - room.cy, 2))
        if (dist < bestDist) { bestDist = dist; bestRoom = room }
      })
    }

    if (bestRoom && dim.width_m > 0 && dim.height_m > 0) {
      var ppmX = bestRoom.widthPx / dim.width_m
      var ppmY = bestRoom.heightPx / dim.height_m

      // Sanity check: both should be similar
      if (ppmX > 10 && ppmY > 10 && ppmX < 200 && ppmY < 200) {
        ppmValues.push(ppmX)
        ppmValues.push(ppmY)
        bestRoom.matchedDim = dim
        bestRoom.ppmX = ppmX
        bestRoom.ppmY = ppmY
      }
    }
  })

  // Calculate median PPM from all matched rooms
  if (ppmValues.length === 0) return null

  ppmValues.sort(function(a, b) { return a - b })
  var median = ppmValues[Math.floor(ppmValues.length / 2)]

  // Filter outliers and average
  var filtered = ppmValues.filter(function(v) { return Math.abs(v - median) / median < 0.25 })
  if (filtered.length === 0) filtered = [median]

  var sum = 0
  filtered.forEach(function(v) { sum += v })
  return sum / filtered.length
}


// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function FloorPlanAnalyzer() {
  const [image, setImage] = useState(null)
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

      // Detect rooms from wall intersections
      var rooms = detectRooms(wallData.horizontal, wallData.vertical)

      // AI reads dimension labels with approximate positions
      var aiData = null, ppm = null
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
          }
        }
      } catch (e2) { console.warn('Label err:', e2) }

      // Match AI dimensions to detected rooms to calculate PPM
      if (aiData && aiData.dimensions) {
        ppm = matchDimensionsToRooms(rooms, aiData.dimensions, w, h)
      }

      // Fallback PPM
      if (!ppm) {
        var allW = wallData.horizontal.concat(wallData.vertical)
        var minX=Infinity,maxX=-Infinity
        allW.forEach(function(wl){minX=Math.min(minX,wl.x1,wl.x2);maxX=Math.max(maxX,wl.x1,wl.x2)})
        ppm = (maxX - minX) / 10
      }

      setAnalysis({
        walls: wallData.horizontal.concat(wallData.vertical),
        hWalls: wallData.horizontal, vWalls: wallData.vertical,
        hCount: wallData.horizontal.length, vCount: wallData.vertical.length,
        rooms: rooms, ppm: ppm, aiData: aiData, imgWidth: w, imgHeight: h
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
    var allWalls = (analysis.hWalls||[]).concat(analysis.vWalls||[])
    if (allWalls.length === 0) return
    var srcW = analysis.imgWidth, srcH = analysis.imgHeight, ppm = analysis.ppm || 80
    var PAD = 70, scale = Math.min((900-PAD*2)/srcW,(800-PAD*2)/srcH,1)
    var cw = srcW*scale+PAD*2, ch = srcH*scale+PAD*2
    canvas.width = cw; canvas.height = ch
    var ctx = canvas.getContext('2d')
    ctx.clearRect(0,0,cw,ch); ctx.fillStyle='#fff'; ctx.fillRect(0,0,cw,ch)
    var X=function(p){return PAD+p*scale}, Y=function(p){return PAD+p*scale}

    // Walls
    ctx.strokeStyle='#1a1a1a'; ctx.lineWidth=Math.max(2.5,4*scale); ctx.lineCap='square'
    allWalls.forEach(function(w){ ctx.beginPath(); ctx.moveTo(X(w.x1),Y(w.y1)); ctx.lineTo(X(w.x2),Y(w.y2)); ctx.stroke() })

    // Dimensions on every wall
    ctx.fillStyle='#2563eb'
    allWalls.forEach(function(w){
      var dx=w.x2-w.x1,dy=w.y2-w.y1,lenPx=Math.sqrt(dx*dx+dy*dy),sLen=lenPx*scale
      if(sLen<35)return
      var label=(lenPx/ppm).toFixed(2)+'m'
      var fs=Math.max(8,Math.min(11,sLen/8))
      ctx.font=fs+'px "Segoe UI",system-ui,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'
      var mx=X((w.x1+w.x2)/2),my=Y((w.y1+w.y2)/2)
      if(Math.abs(dy)<2){ctx.fillText(label,mx,my-10)}
      else{ctx.save();ctx.translate(mx-10,my);ctx.rotate(-Math.PI/2);ctx.fillText(label,0,0);ctx.restore()}
    })

    // Stats
    ctx.fillStyle='#9ca3af';ctx.font='11px sans-serif';ctx.textAlign='right';ctx.textBaseline='top'
    ctx.fillText('N \u2191',cw-8,8)
    ctx.fillStyle='#6b7280';ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom'
    var matched = (analysis.rooms||[]).filter(function(r){return r.matchedDim}).length
    ctx.fillText(analysis.hCount+'H+'+analysis.vCount+'V | '+matched+' rooms matched | ppm='+(ppm||0).toFixed(1),PAD,ch-8)
  }

  return (
    <div className="fpa-root">
      <header className="fpa-header"><h1>CarpetPlan</h1>
        <p className="fpa-subtitle">Upload a floor plan &rarr; Detect walls &amp; measure dimensions</p></header>
      {!image&&(<div className="fpa-upload" onClick={function(){fileRef.current&&fileRef.current.click()}}
        onDrop={onDrop} onDragOver={function(e){e.preventDefault();e.currentTarget.classList.add('drag')}}
        onDragLeave={function(e){e.currentTarget.classList.remove('drag')}}>
        <input ref={fileRef} type="file" accept="image/*" onChange={function(e){handleFile(e.target.files[0])}}/>
        <span className="fpa-upload-icon">&#x1F4D0;</span>
        <span className="fpa-upload-text">Drop floor plan image or click to browse</span></div>)}
      {image&&(<div className="fpa-controls"><img src={image} alt="Floor plan" className="fpa-preview"/>
        <div className="fpa-buttons">
          <button onClick={analyze} disabled={loading} className="fpa-btn fpa-btn-primary">{loading?'Processing\u2026':'Detect Walls'}</button>
          <button onClick={function(){setImage(null);setAnalysis(null);setError(null);imgElRef.current=null}} className="fpa-btn fpa-btn-secondary">Clear</button>
        </div></div>)}
      {error&&<div className="fpa-error">{error}</div>}
      {loading&&(<div className="fpa-loading"><div className="fpa-spinner"/><p>Processing&hellip;</p><p className="fpa-loading-sub">Detecting walls, reading dimensions, matching rooms</p></div>)}
      {analysis&&(<div className="fpa-result">
        <div className="fpa-result-header"><h2>Detected Floor Plan</h2>
          <div className="fpa-result-stats">{analysis.hCount}H&middot;{analysis.vCount}V walls &middot; {(analysis.rooms||[]).length} rooms</div></div>
        <div className="fpa-canvas-wrap"><canvas ref={canvasRef} className="fpa-canvas"/></div>
        <details className="fpa-details"><summary>Detection Data</summary>
          <pre className="fpa-json">{JSON.stringify({ppm:analysis.ppm,roomsFound:(analysis.rooms||[]).length,
            matchedRooms:(analysis.rooms||[]).filter(function(r){return r.matchedDim}).map(function(r){return{dim:r.matchedDim.text,widthPx:r.widthPx,heightPx:r.heightPx,ppmX:r.ppmX,ppmY:r.ppmY}}),
            aiDimensions:analysis.aiData?analysis.aiData.dimensions:null},null,2)}</pre></details>
      </div>)}
    </div>
  )
}
