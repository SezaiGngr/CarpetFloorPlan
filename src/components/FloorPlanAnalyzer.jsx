import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'

const ANALYSIS_PROMPT = `You are an expert floor plan analyzer with perfect spatial reasoning.

CRITICAL FIRST STEP — FIND THE ACTUAL FLOOR PLAN AREA:
The image may have large black borders/padding. Identify where the actual floor plan drawing starts and ends.
ALL pixel coordinates must be relative to the TOP-LEFT of the FULL image (0,0 = top-left pixel).

STEP 1 — CALIBRATION:
- Find ALL rooms/spaces that have written dimensions inside them (e.g. "5 x 6m", "2.8 x 3.6m", "6 x 3m")
- Use the Living room (5 x 6m) or largest labeled room for calibration
- Measure that room's SHORT wall carefully in pixels
- pixels_per_meter = short_side_pixels / short_side_meters
- Verify: long_side_pixels should equal long_side_meters × pixels_per_meter

STEP 2 — MAP EVERY SINGLE ROOM (critical — do not skip any):
List EVERY space visible: bedrooms, bathroom, kitchen, laundry, living, dining, robe/wardrobe, linen, balcony, garage, entry, corridor — ALL of them.
For each room provide:
- Exact bounding_box in full-image pixels (x, y, w, h)
- ALL 4 walls (north/south/east/west) with pixel length and meter length
- Walls that are shared between rooms still get measured individually per room

STEP 3 — DOOR DETECTION:
A. SWING DOOR: gap in wall + quarter-circle arc drawn from one end
   - arc_center_x/y = hinge point (full image coords)
   - arc_radius_px = door width in pixels
   - arc_start_deg/arc_end_deg = sweep angle
   - wall_orientation: "horizontal" or "vertical"
B. OPEN PASSAGE: gap with NO arc (wardrobe entries, open archways)
C. WINDOW: gap in exterior wall with double sill line

STEP 4 — DIMENSION LINES (important for drawing):
For each wall, also provide the actual start and end pixel coordinates of that wall edge so dimension lines can be drawn precisely:
- wall_x1, wall_y1 = start point of wall in full image pixels
- wall_x2, wall_y2 = end point of wall in full image pixels

Return ONLY valid JSON, nothing else:

{
  "calibration": {
    "reference_room": "Living",
    "label_text": "5 x 6m",
    "short_side_label_m": 5,
    "long_side_label_m": 6,
    "short_side_pixels": 280,
    "long_side_pixels": 336,
    "pixels_per_meter": 56.0,
    "confidence": "high"
  },
  "floorplan_bounds": { "x": 60, "y": 420, "w": 550, "h": 650 },
  "rooms": [
    {
      "name": "Living",
      "label": "5 x 6m",
      "bounding_box": { "x": 190, "y": 580, "w": 280, "h": 336 },
      "walls": [
        { "side": "north", "length_px": 280, "length_m": 5.0, "has_door": true,  "has_window": false, "wall_x1": 190, "wall_y1": 580, "wall_x2": 470, "wall_y2": 580 },
        { "side": "east",  "length_px": 336, "length_m": 6.0, "has_door": false, "has_window": false, "wall_x1": 470, "wall_y1": 580, "wall_x2": 470, "wall_y2": 916 },
        { "side": "south", "length_px": 280, "length_m": 5.0, "has_door": false, "has_window": false, "wall_x1": 190, "wall_y1": 916, "wall_x2": 470, "wall_y2": 916 },
        { "side": "west",  "length_px": 336, "length_m": 6.0, "has_door": false, "has_window": true,  "wall_x1": 190, "wall_y1": 580, "wall_x2": 190, "wall_y2": 916 }
      ]
    }
  ],
  "doors": [
    {
      "id": "D1",
      "type": "swing",
      "wall_orientation": "horizontal",
      "location": "Bed 2 south wall into corridor",
      "gap_x": 120, "gap_y": 490,
      "gap_width_px": 52, "gap_width_m": 0.93,
      "arc_center_x": 120, "arc_center_y": 490,
      "arc_radius_px": 52, "arc_start_deg": 0, "arc_end_deg": 90,
      "connects": ["Bed 2", "Corridor"]
    }
  ],
  "passages": [
    {
      "id": "P1", "wall_orientation": "horizontal",
      "location": "Robe entry", "gap_x": 90, "gap_y": 520,
      "gap_width_px": 40, "gap_width_m": 0.71,
      "connects": ["Bed 2", "Robe"]
    }
  ],
  "windows": [
    {
      "id": "W1", "location": "North wall Bed 1",
      "wall_orientation": "horizontal",
      "center_x": 395, "center_y": 418,
      "width_px": 60, "width_m": 1.07
    }
  ],
  "summary": "Found all rooms. Calibrated via Living 5x6m."
}`

export default function FloorPlanAnalyzer() {
  const [image, setImage] = useState(null)
  const [imageNaturalSize, setImageNaturalSize] = useState({ w: 1, h: 1 })
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState('')
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('doors')
  const [hoveredId, setHoveredId] = useState(null)
  const [showDimensions, setShowDimensions] = useState(true)
  const [showDoors, setShowDoors] = useState(true)
  const [showWindows, setShowWindows] = useState(true)
  const [showPassages, setShowPassages] = useState(true)
  const [imgReady, setImgReady] = useState(false)

  const fileInputRef = useRef(null)
  const canvasRef = useRef(null)
  const imgRef = useRef(null)

  const handleFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const src = e.target.result
      const img = new Image()
      img.onload = () => {
        setImageNaturalSize({ w: img.width, h: img.height })
        setImage(src)
        setAnalysis(null)
        setError(null)
        setImgReady(false)
      }
      img.src = src
    }
    reader.readAsDataURL(file)
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    handleFile(e.dataTransfer.files[0])
  }, [handleFile])

  const analyze = async () => {
    if (!image) return
    setLoading(true)
    setError(null)
    setAnalysis(null)

    try {
      setLoadingStep('Sending image to AI…')
      const base64 = image.split(',')[1]
      const mediaType = image.split(';')[0].split(':')[1]

      const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: ANALYSIS_PROMPT }
            ]
          }]
        })
      })

      setLoadingStep('Parsing results…')
      const data = await response.json()
      if (!response.ok) throw new Error(data.error?.message || 'API error')

      const raw = data.content.map(b => b.text || '').join('')
      const clean = raw.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      // Bug 6 fix: validate calibration before accepting
      if (!parsed.calibration?.pixels_per_meter || parsed.calibration.pixels_per_meter <= 0) {
        throw new Error(
          'AI could not determine a valid pixel-to-meter calibration. ' +
          'Try a higher-resolution image or ensure the floor plan has labeled room dimensions (e.g. "5 x 6m").'
        )
      }

      setAnalysis(parsed)
      setActiveTab('doors')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setLoadingStep('')
    }
  }

  // Bug 7 fix: only draw after image is confirmed painted in DOM
  useEffect(() => {
    if (!analysis || !imgReady) return
    drawOverlay()
  }, [analysis, showDimensions, showDoors, showWindows, showPassages, hoveredId, imgReady])

  // Bug 7 fix: mark image ready after load event fires
  const onImgLoad = () => {
    setImgReady(true)
  }

  const drawOverlay = () => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return

    const dW = img.offsetWidth
    const dH = img.offsetHeight
    if (!dW || !dH) return  // image not yet painted

    canvas.width = dW
    canvas.height = dH

    const natW = imageNaturalSize.w
    const natH = imageNaturalSize.h
    const scX = dW / natW
    const scY = dH / natH

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, dW, dH)

    const px = x => x * scX
    const py = y => y * scY

    const { doors = [], passages = [], windows = [], rooms = [] } = analysis

    // ── Dimension overlays — precise architectural style ────────────────────
    if (showDimensions && rooms.length > 0) {
      const OFFSET = 22
      const TICK = 7

      rooms.forEach(room => {
        const bb = room.bounding_box
        if (!bb) return
        const isHov = hoveredId === room.name
        const lineColor = isHov ? '#185FA5' : '#2563eb'
        const textColor = isHov ? '#0C447C' : '#1e3a5f'

        room.walls?.forEach(wall => {
          if (!wall.length_m || isNaN(wall.length_m)) return
          const lbl = wall.length_m.toFixed(2) + 'm'
          const side = wall.side

          // Use precise wall coords if available, fallback to bounding box
          let wx1, wy1, wx2, wy2
          if (wall.wall_x1 != null) {
            wx1 = px(wall.wall_x1); wy1 = py(wall.wall_y1)
            wx2 = px(wall.wall_x2); wy2 = py(wall.wall_y2)
          } else {
            if (side === 'north')      { wx1 = px(bb.x); wy1 = py(bb.y);        wx2 = px(bb.x+bb.w); wy2 = py(bb.y) }
            else if (side === 'south') { wx1 = px(bb.x); wy1 = py(bb.y+bb.h);   wx2 = px(bb.x+bb.w); wy2 = py(bb.y+bb.h) }
            else if (side === 'west')  { wx1 = px(bb.x); wy1 = py(bb.y);        wx2 = px(bb.x);       wy2 = py(bb.y+bb.h) }
            else                       { wx1 = px(bb.x+bb.w); wy1 = py(bb.y);   wx2 = px(bb.x+bb.w); wy2 = py(bb.y+bb.h) }
          }

          // Dimension line offset direction
          let dx1, dy1, dx2, dy2, angle
          const isHoriz = (side === 'north' || side === 'south')
          if (side === 'north') {
            dx1 = wx1; dy1 = wy1 - OFFSET; dx2 = wx2; dy2 = wy2 - OFFSET; angle = 0
          } else if (side === 'south') {
            dx1 = wx1; dy1 = wy1 + OFFSET; dx2 = wx2; dy2 = wy2 + OFFSET; angle = 0
          } else if (side === 'west') {
            dx1 = wx1 - OFFSET; dy1 = wy1; dx2 = wx2 - OFFSET; dy2 = wy2; angle = -Math.PI/2
          } else {
            dx1 = wx1 + OFFSET; dy1 = wy1; dx2 = wx2 + OFFSET; dy2 = wy2; angle = -Math.PI/2
          }

          const midX = (dx1 + dx2) / 2
          const midY = (dy1 + dy2) / 2

          // Extension lines
          ctx.strokeStyle = lineColor + '88'
          ctx.lineWidth = 1
          ctx.setLineDash([4, 3])
          ctx.beginPath()
          ctx.moveTo(wx1, wy1); ctx.lineTo(dx1, dy1)
          ctx.moveTo(wx2, wy2); ctx.lineTo(dx2, dy2)
          ctx.stroke()
          ctx.setLineDash([])

          // Dimension line
          ctx.strokeStyle = lineColor
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(dx1, dy1); ctx.lineTo(dx2, dy2)
          ctx.stroke()

          // Tick marks (45-degree slash style)
          ctx.lineWidth = 1.5
          ctx.beginPath()
          if (isHoriz) {
            ctx.moveTo(dx1 - 4, dy1 - TICK); ctx.lineTo(dx1 + 4, dy1 + TICK)
            ctx.moveTo(dx2 - 4, dy2 - TICK); ctx.lineTo(dx2 + 4, dy2 + TICK)
          } else {
            ctx.moveTo(dx1 - TICK, dy1 - 4); ctx.lineTo(dx1 + TICK, dy1 + 4)
            ctx.moveTo(dx2 - TICK, dy2 - 4); ctx.lineTo(dx2 + TICK, dy2 + 4)
          }
          ctx.stroke()

          // Label — rotated for vertical walls
          ctx.save()
          ctx.translate(midX, midY)
          ctx.rotate(angle)
          ctx.font = '500 11px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          const tw = ctx.measureText(lbl).width + 10
          ctx.fillStyle = 'rgba(255,255,255,0.95)'
          ctx.beginPath()
          ctx.roundRect(-tw/2, -9, tw, 18, 3)
          ctx.fill()
          ctx.strokeStyle = lineColor + '66'
          ctx.lineWidth = 0.5
          ctx.stroke()
          ctx.fillStyle = textColor
          ctx.fillText(lbl, 0, 0)
          ctx.restore()
        })
      })
    }

    // ── Doors ────────────────────────────────────────────────────────────
    if (showDoors) {
      doors.forEach(door => {
        const isHov = hoveredId === door.id
        const isVert = door.wall_orientation === 'vertical'

        // Bug 2 fix: use average scale so arc stays circular
        const avgScale = (scX + scY) / 2
        const arcCx = px(door.arc_center_x)
        const arcCy = py(door.arc_center_y)
        const arcR  = door.arc_radius_px * avgScale
        const startRad = (door.arc_start_deg ?? 0)  * Math.PI / 180
        const endRad   = (door.arc_end_deg   ?? 90) * Math.PI / 180

        ctx.strokeStyle = isHov ? '#E24B4A' : '#E24B4Acc'
        ctx.lineWidth = isHov ? 3 : 2.5
        ctx.setLineDash([5, 3])
        ctx.beginPath()
        ctx.arc(arcCx, arcCy, arcR, startRad, endRad)
        ctx.stroke()
        ctx.setLineDash([])

        // Bug 4 fix: gap bracket direction respects wall_orientation
        ctx.strokeStyle = isHov ? '#E24B4A' : '#E24B4Acc'
        ctx.lineWidth = isHov ? 4 : 3
        const gx1 = px(door.gap_x)
        const gy1 = py(door.gap_y)
        const gx2 = isVert ? px(door.gap_x)                    : px(door.gap_x + door.gap_width_px)
        const gy2 = isVert ? py(door.gap_y + door.gap_width_px): py(door.gap_y)

        ctx.beginPath()
        if (isVert) {
          ctx.moveTo(gx1 - 4, gy1); ctx.lineTo(gx1 + 4, gy1)
          ctx.moveTo(gx2 - 4, gy2); ctx.lineTo(gx2 + 4, gy2)
        } else {
          ctx.moveTo(gx1, gy1 - 4); ctx.lineTo(gx1, gy1 + 4)
          ctx.moveTo(gx2, gy2 - 4); ctx.lineTo(gx2, gy2 + 4)
        }
        ctx.stroke()

        const lx = (gx1 + gx2) / 2
        const ly = (gy1 + gy2) / 2 - 14
        const lbl = door.id
        const tw = lbl.length * 7 + 10
        ctx.fillStyle = isHov ? '#A32D2D' : '#E24B4A'
        ctx.beginPath()
        ctx.roundRect(lx - tw / 2, ly - 9, tw, 18, 4)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(lbl, lx, ly)
      })
    }

    // ── Passages ─────────────────────────────────────────────────────────
    if (showPassages) {
      passages.forEach(p => {
        const isHov = hoveredId === p.id
        const isVert = p.wall_orientation === 'vertical'

        ctx.strokeStyle = isHov ? '#1D9E75' : '#1D9E7599'
        ctx.lineWidth = isHov ? 3 : 2
        ctx.setLineDash([4, 3])
        const gx1 = px(p.gap_x)
        const gy1 = py(p.gap_y)
        const gx2 = isVert ? px(p.gap_x)                   : px(p.gap_x + p.gap_width_px)
        const gy2 = isVert ? py(p.gap_y + p.gap_width_px)  : py(p.gap_y)

        ctx.beginPath()
        ctx.moveTo(gx1, gy1)
        ctx.lineTo(gx2, gy2)
        ctx.stroke()
        ctx.setLineDash([])

        const lx = (gx1 + gx2) / 2
        const ly = (gy1 + gy2) / 2 - 14
        const lbl = p.id
        const tw = lbl.length * 7 + 10
        ctx.fillStyle = isHov ? '#0F6E56' : '#1D9E75'
        ctx.beginPath()
        ctx.roundRect(lx - tw / 2, ly - 9, tw, 18, 4)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(lbl, lx, ly)
      })
    }

    // ── Windows ───────────────────────────────────────────────────────────
    if (showWindows) {
      windows.forEach(w => {
        const isHov = hoveredId === w.id
        const isVert = w.wall_orientation === 'vertical'
        const cx = px(w.center_x)
        const cy = py(w.center_y)
        const halfW = px(w.width_px) / 2

        ctx.strokeStyle = isHov ? '#BA7517' : '#BA751799'
        ctx.lineWidth = isHov ? 4 : 3
        ctx.beginPath()
        if (isVert) {
          ctx.moveTo(cx, cy - halfW); ctx.lineTo(cx, cy + halfW)
          ctx.moveTo(cx - 5, cy - halfW); ctx.lineTo(cx + 5, cy - halfW)
          ctx.moveTo(cx - 5, cy + halfW); ctx.lineTo(cx + 5, cy + halfW)
        } else {
          ctx.moveTo(cx - halfW, cy); ctx.lineTo(cx + halfW, cy)
          ctx.moveTo(cx - halfW, cy - 5); ctx.lineTo(cx - halfW, cy + 5)
          ctx.moveTo(cx + halfW, cy - 5); ctx.lineTo(cx + halfW, cy + 5)
        }
        ctx.stroke()

        const lbl = w.id
        const tw = lbl.length * 7 + 10
        const labelY = isVert ? cy : cy - 16
        ctx.fillStyle = isHov ? '#854F0B' : '#BA7517'
        ctx.beginPath()
        ctx.roundRect(cx - tw / 2, labelY - 9, tw, 16, 3)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 10px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(lbl, cx, labelY)
      })
    }
  }

  const cal      = analysis?.calibration
  const doors    = analysis?.doors    || []
  const passages = analysis?.passages || []
  const windows  = analysis?.windows  || []
  const rooms    = analysis?.rooms    || []

  return (
    <div className="fpa-root">
      <header className="fpa-header">
        <div className="fpa-logo">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect x="1"  y="1"  width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <rect x="11" y="1"  width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <rect x="1"  y="11" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <rect x="11" y="11" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          </svg>
          CarpetPlan
        </div>
        <span className="fpa-badge">Floor Plan Analyzer</span>
      </header>

      <main className="fpa-main">
        <div className="fpa-left">
          {!image ? (
            <div
              className="fpa-dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
            >
              <input ref={fileInputRef} type="file" accept="image/*" onChange={e => handleFile(e.target.files[0])} />
              <div className="fpa-drop-icon">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <rect x="4" y="6" width="24" height="20" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                  <path d="M4 12h24" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M10 9h.01M13 9h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <path d="M16 20v-6M13 17l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <p className="fpa-drop-title">Drop your floor plan here</p>
              <p className="fpa-drop-sub">or click to browse · PNG, JPG, WEBP</p>
            </div>
          ) : (
            <div className="fpa-canvas-area">
              <div className="fpa-toggles">
                <button className={`fpa-toggle ${showDimensions ? 'on blue' : ''}`}  onClick={() => setShowDimensions(v => !v)}>
                  <span className="tog-dot"></span> Dimensions
                </button>
                <button className={`fpa-toggle ${showDoors    ? 'on red'  : ''}`}  onClick={() => setShowDoors(v => !v)}>
                  <span className="tog-dot"></span> Doors
                </button>
                <button className={`fpa-toggle ${showPassages ? 'on green': ''}`}  onClick={() => setShowPassages(v => !v)}>
                  <span className="tog-dot"></span> Passages
                </button>
                <button className={`fpa-toggle ${showWindows  ? 'on amber': ''}`}  onClick={() => setShowWindows(v => !v)}>
                  <span className="tog-dot"></span> Windows
                </button>
                <button className="fpa-toggle reset" onClick={() => {
                  setImage(null); setAnalysis(null); setError(null); setImgReady(false)
                }}>
                  Clear
                </button>
              </div>

              <div className="fpa-img-wrap">
                <img
                  ref={imgRef}
                  src={image}
                  alt="Floor plan"
                  className="fpa-img"
                  onLoad={onImgLoad}
                />
                <canvas ref={canvasRef} className="fpa-overlay" />
              </div>
            </div>
          )}

          {/* Bug 3 fix: always show when image loaded, label changes to Re-analyze */}
          {image && (
            <button className="fpa-analyze-btn" onClick={analyze} disabled={loading}>
              {loading ? (
                <><span className="spin"></span>{loadingStep}</>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  {analysis ? 'Re-analyze' : 'Analyze Floor Plan'}
                </>
              )}
            </button>
          )}

          {error && (
            <div className="fpa-error">
              <strong>Analysis failed:</strong> {error}
            </div>
          )}
        </div>

        {analysis && (
          <div className="fpa-right">
            {cal && (
              <div className="fpa-cal-card">
                <div className="fpa-cal-label">Calibration</div>
                <div className="fpa-cal-row">
                  <span className="cal-room">{cal.reference_room}</span>
                  <span className="cal-eq">{cal.label_text}</span>
                  <span className="cal-px">{cal.pixels_per_meter?.toFixed(1)} px/m</span>
                </div>
                <div className={`fpa-cal-conf ${cal.confidence}`}>{cal.confidence} confidence</div>
              </div>
            )}

            <div className="fpa-tabs">
              {[
                { id: 'doors',    label: `Doors (${doors.length})`,       color: 'red'   },
                { id: 'passages', label: `Passages (${passages.length})`, color: 'green' },
                { id: 'windows',  label: `Windows (${windows.length})`,   color: 'amber' },
                { id: 'rooms',    label: `Rooms (${rooms.length})`,       color: 'blue'  },
              ].map(t => (
                <button
                  key={t.id}
                  className={`fpa-tab ${activeTab === t.id ? 'active ' + t.color : ''}`}
                  onClick={() => setActiveTab(t.id)}
                >{t.label}</button>
              ))}
            </div>

            <div className="fpa-panel">
              {activeTab === 'doors' && (
                <div className="fpa-list">
                  {doors.length === 0 && <p className="fpa-empty">No swing doors detected</p>}
                  {doors.map(d => (
                    <div
                      key={d.id}
                      className={`fpa-item door ${hoveredId === d.id ? 'hov' : ''}`}
                      onMouseEnter={() => setHoveredId(d.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    >
                      <div className="fpa-item-head">
                        <span className="fpa-item-id red">{d.id}</span>
                        <span className="fpa-item-type">{d.type === 'swing' ? 'Swing door' : d.type}</span>
                        <span className="fpa-item-dim">{d.gap_width_m?.toFixed(2)}m</span>
                      </div>
                      <div className="fpa-item-loc">{d.location}</div>
                      <div className="fpa-item-meta">
                        {d.connects?.join(' → ')}
                        {d.wall_orientation && <span className="fpa-chip">{d.wall_orientation}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'passages' && (
                <div className="fpa-list">
                  {passages.length === 0 && <p className="fpa-empty">No open passages detected</p>}
                  {passages.map(p => (
                    <div
                      key={p.id}
                      className={`fpa-item passage ${hoveredId === p.id ? 'hov' : ''}`}
                      onMouseEnter={() => setHoveredId(p.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    >
                      <div className="fpa-item-head">
                        <span className="fpa-item-id green">{p.id}</span>
                        <span className="fpa-item-type">Open passage</span>
                        <span className="fpa-item-dim">{p.gap_width_m?.toFixed(2)}m</span>
                      </div>
                      <div className="fpa-item-loc">{p.location}</div>
                      <div className="fpa-item-meta">
                        {p.connects?.join(' → ')}
                        {p.wall_orientation && <span className="fpa-chip">{p.wall_orientation}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'windows' && (
                <div className="fpa-list">
                  {windows.length === 0 && <p className="fpa-empty">No windows detected</p>}
                  {windows.map(w => (
                    <div
                      key={w.id}
                      className={`fpa-item window ${hoveredId === w.id ? 'hov' : ''}`}
                      onMouseEnter={() => setHoveredId(w.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    >
                      <div className="fpa-item-head">
                        <span className="fpa-item-id amber">{w.id}</span>
                        <span className="fpa-item-type">Window</span>
                        <span className="fpa-item-dim">{w.width_m?.toFixed(2)}m</span>
                      </div>
                      <div className="fpa-item-loc">{w.location}</div>
                      <div className="fpa-item-meta">{w.wall_orientation} wall</div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'rooms' && (
                <div className="fpa-list">
                  {rooms.length === 0 && <p className="fpa-empty">No rooms detected</p>}
                  {rooms.map((r, i) => (
                    <div
                      key={i}
                      className={`fpa-item room ${hoveredId === r.name ? 'hov' : ''}`}
                      onMouseEnter={() => setHoveredId(r.name)}
                      onMouseLeave={() => setHoveredId(null)}
                    >
                      <div className="fpa-item-head">
                        <span className="fpa-item-id blue">{r.label || '—'}</span>
                        <span className="fpa-item-type">{r.name}</span>
                      </div>
                      <table className="fpa-wall-table">
                        <thead>
                          <tr><th>Wall</th><th>Length</th><th>Flags</th></tr>
                        </thead>
                        <tbody>
                          {r.walls?.map(w => (
                            <tr key={w.side}>
                              <td>{w.side}</td>
                              <td>
                                <strong>{isNaN(w.length_m) ? '?' : w.length_m?.toFixed(2)}m</strong>
                                <span className="fpa-px"> ({Math.round(w.length_px || 0)}px)</span>
                              </td>
                              <td>
                                {w.has_door   && <span className="fpa-flag red">door</span>}
                                {w.has_window && <span className="fpa-flag amber">window</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {analysis.summary && (
              <div className="fpa-summary">{analysis.summary}</div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
