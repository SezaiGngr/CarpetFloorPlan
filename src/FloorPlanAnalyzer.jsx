import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 1000

const ANALYSIS_PROMPT = `You are an expert floor plan analyzer. Analyze this floor plan image with extreme precision.

YOUR TASKS:

1. CALIBRATION
   - Find all rooms/spaces with written dimensions (e.g. "3x4m", "5 x 6m", "2.8 x 3.6m")
   - Use the room whose SHORT side gives the most reliable pixel measurement
   - Measure that short wall in pixels to get your pixels-per-meter ratio

2. DOOR DETECTION (critical — distinguish these three types)
   A. SWING DOOR: A gap in a wall PLUS a quarter-circle arc drawn from one end of the gap. The arc shows the door panel sweeping open. Most internal doors.
   B. OPEN PASSAGE / ARCHWAY: A gap in a wall with NO arc. Just an opening, no door panel. E.g. wardrobe/robe entries, some connecting openings.
   C. SLIDING DOOR or EXTERNAL DOOR: A gap with parallel lines or no arc. Often balcony/patio doors.
   D. WINDOW: A gap in an EXTERIOR wall (outer perimeter) with a thin double-line or sill indication. NOT a door.

3. WALL MEASUREMENTS
   - Measure every wall segment in pixels, convert to meters using calibration
   - For walls with door/window gaps: measure the TOTAL span (gap included) as the full wall length
   - Note where doors/windows interrupt each wall

Return ONLY valid JSON (no markdown, no backticks, no explanation):

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
  "rooms": [
    {
      "name": "Living",
      "label": "5 x 6m",
      "bounding_box": { "x": 190, "y": 580, "w": 280, "h": 336 },
      "walls": [
        { "side": "north", "length_px": 280, "length_m": 5.0, "has_door": true, "has_window": false },
        { "side": "east",  "length_px": 336, "length_m": 6.0, "has_door": false, "has_window": false },
        { "side": "south", "length_px": 280, "length_m": 5.0, "has_door": false, "has_window": false },
        { "side": "west",  "length_px": 336, "length_m": 6.0, "has_door": false, "has_window": true }
      ]
    }
  ],
  "doors": [
    {
      "id": "D1",
      "type": "swing",
      "location": "Bed 2 south wall into corridor",
      "gap_x": 120,
      "gap_y": 490,
      "gap_width_px": 52,
      "gap_width_m": 0.9,
      "swing_from": "left",
      "swing_direction": "inward",
      "arc_center_x": 120,
      "arc_center_y": 490,
      "arc_radius_px": 52,
      "arc_start_deg": 0,
      "arc_end_deg": 90,
      "connects": ["Bed 2", "Corridor"]
    }
  ],
  "passages": [
    {
      "id": "P1",
      "type": "open_passage",
      "location": "Robe entry from Bed 2",
      "gap_x": 90,
      "gap_y": 520,
      "gap_width_px": 40,
      "gap_width_m": 0.7,
      "connects": ["Bed 2", "Robe"]
    }
  ],
  "windows": [
    {
      "id": "W1",
      "location": "North wall of Bed 1",
      "wall_side": "north",
      "center_x": 395,
      "center_y": 418,
      "width_px": 60,
      "width_m": 1.07
    }
  ],
  "summary": "Found 7 swing doors, 3 open passages, 4 windows. Calibrated using Living room (5x6m = 280x336px → 56px/m)."
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

  const fileInputRef = useRef(null)
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const containerRef = useRef(null)

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

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      setAnalysis(parsed)
      setActiveTab('doors')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setLoadingStep('')
    }
  }

  useEffect(() => {
    if (!analysis || !canvasRef.current || !imgRef.current) return
    drawOverlay()
  }, [analysis, showDimensions, showDoors, showWindows, showPassages, hoveredId])

  const drawOverlay = () => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return

    const dW = img.offsetWidth
    const dH = img.offsetHeight
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

    if (showDimensions && rooms.length > 0) {
      rooms.forEach(room => {
        const bb = room.bounding_box
        if (!bb) return
        const isHov = hoveredId === room.name
        ctx.strokeStyle = isHov ? '#378ADD' : '#378ADD55'
        ctx.lineWidth = isHov ? 2 : 1
        ctx.setLineDash([6, 4])
        ctx.strokeRect(px(bb.x), py(bb.y), px(bb.w), py(bb.h))
        ctx.setLineDash([])

        room.walls?.forEach(wall => {
          const lbl = wall.length_m?.toFixed(1) + 'm'
          ctx.font = `${isHov ? 'bold ' : ''}11px sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'

          let tx, ty
          const side = wall.side
          if (side === 'north') { tx = px(bb.x + bb.w / 2); ty = py(bb.y) - 10 }
          else if (side === 'south') { tx = px(bb.x + bb.w / 2); ty = py(bb.y + bb.h) + 10 }
          else if (side === 'west') { tx = px(bb.x) - 14; ty = py(bb.y + bb.h / 2) }
          else { tx = px(bb.x + bb.w) + 14; ty = py(bb.y + bb.h / 2) }

          const tw = lbl.length * 6.5 + 8
          ctx.fillStyle = '#185FA5'
          ctx.beginPath()
          ctx.roundRect(tx - tw / 2, ty - 8, tw, 16, 3)
          ctx.fill()
          ctx.fillStyle = '#fff'
          ctx.fillText(lbl, tx, ty)
        })
      })
    }

    if (showDoors) {
      doors.forEach(door => {
        const isHov = hoveredId === door.id
        const arcCx = px(door.arc_center_x)
        const arcCy = py(door.arc_center_y)
        const arcR = px(door.arc_radius_px)
        const startRad = (door.arc_start_deg || 0) * Math.PI / 180
        const endRad = (door.arc_end_deg || 90) * Math.PI / 180

        ctx.strokeStyle = isHov ? '#E24B4A' : '#E24B4Acc'
        ctx.lineWidth = isHov ? 3 : 2.5
        ctx.setLineDash([5, 3])
        ctx.beginPath()
        ctx.arc(arcCx, arcCy, arcR, startRad, endRad)
        ctx.stroke()
        ctx.setLineDash([])

        ctx.strokeStyle = isHov ? '#E24B4A' : '#E24B4Acc'
        ctx.lineWidth = isHov ? 4 : 3
        const gx1 = px(door.gap_x)
        const gy1 = py(door.gap_y)
        const gx2 = px(door.gap_x + door.gap_width_px)
        const gy2 = py(door.gap_y)
        ctx.beginPath()
        ctx.moveTo(gx1, gy1 - 3)
        ctx.lineTo(gx1, gy1 + 3)
        ctx.moveTo(gx2, gy2 - 3)
        ctx.lineTo(gx2, gy2 + 3)
        ctx.stroke()

        const lx = px(door.gap_x + door.gap_width_px / 2)
        const ly = py(door.gap_y) - 14
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

    if (showPassages) {
      passages.forEach(p => {
        const isHov = hoveredId === p.id
        ctx.strokeStyle = isHov ? '#1D9E75' : '#1D9E7599'
        ctx.lineWidth = isHov ? 3 : 2
        ctx.setLineDash([3, 3])
        const gx = px(p.gap_x)
        const gy = py(p.gap_y)
        const gw = px(p.gap_width_px)
        ctx.beginPath()
        ctx.moveTo(gx, gy)
        ctx.lineTo(gx + gw, gy)
        ctx.stroke()
        ctx.setLineDash([])

        const lx = gx + gw / 2
        const ly = gy - 14
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

    if (showWindows) {
      windows.forEach(w => {
        const isHov = hoveredId === w.id
        const cx = px(w.center_x)
        const cy = py(w.center_y)
        const hw = px(w.width_px) / 2
        ctx.strokeStyle = isHov ? '#BA7517' : '#BA751799'
        ctx.lineWidth = isHov ? 4 : 3
        ctx.beginPath()
        ctx.moveTo(cx - hw, cy)
        ctx.lineTo(cx + hw, cy)
        ctx.stroke()

        ctx.strokeStyle = isHov ? '#BA7517' : '#BA751799'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(cx - hw, cy - 5)
        ctx.lineTo(cx - hw, cy + 5)
        ctx.moveTo(cx + hw, cy - 5)
        ctx.lineTo(cx + hw, cy + 5)
        ctx.stroke()

        const lbl = w.id
        const tw = lbl.length * 7 + 10
        ctx.fillStyle = isHov ? '#854F0B' : '#BA7517'
        ctx.beginPath()
        ctx.roundRect(cx - tw / 2, cy - 22, tw, 16, 3)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 10px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(lbl, cx, cy - 14)
      })
    }
  }

  const cal = analysis?.calibration
  const doors = analysis?.doors || []
  const passages = analysis?.passages || []
  const windows = analysis?.windows || []
  const rooms = analysis?.rooms || []

  return (
    <div className="fpa-root">
      <header className="fpa-header">
        <div className="fpa-logo">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect x="1" y="1" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <rect x="11" y="1" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <rect x="1" y="11" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
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
                <button className={`fpa-toggle ${showDimensions ? 'on blue' : ''}`} onClick={() => setShowDimensions(v => !v)}>
                  <span className="tog-dot"></span> Dimensions
                </button>
                <button className={`fpa-toggle ${showDoors ? 'on red' : ''}`} onClick={() => setShowDoors(v => !v)}>
                  <span className="tog-dot"></span> Doors
                </button>
                <button className={`fpa-toggle ${showPassages ? 'on green' : ''}`} onClick={() => setShowPassages(v => !v)}>
                  <span className="tog-dot"></span> Passages
                </button>
                <button className={`fpa-toggle ${showWindows ? 'on amber' : ''}`} onClick={() => setShowWindows(v => !v)}>
                  <span className="tog-dot"></span> Windows
                </button>
                <button className="fpa-toggle reset" onClick={() => { setImage(null); setAnalysis(null); setError(null) }}>
                  Clear
                </button>
              </div>

              <div className="fpa-img-wrap" ref={containerRef}>
                <img
                  ref={imgRef}
                  src={image}
                  alt="Floor plan"
                  className="fpa-img"
                  onLoad={() => { if (analysis) drawOverlay() }}
                />
                <canvas ref={canvasRef} className="fpa-overlay" />
              </div>
            </div>
          )}

          {image && !analysis && (
            <button className="fpa-analyze-btn" onClick={analyze} disabled={loading}>
              {loading ? (
                <><span className="spin"></span>{loadingStep}</>
              ) : (
                <><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/><path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg> Analyze Floor Plan</>
              )}
            </button>
          )}

          {error && <div className="fpa-error">{error}</div>}
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
                <div className="fpa-cal-conf conf-{cal.confidence}">{cal.confidence} confidence</div>
              </div>
            )}

            <div className="fpa-tabs">
              {[
                { id: 'doors', label: `Doors (${doors.length})`, color: 'red' },
                { id: 'passages', label: `Passages (${passages.length})`, color: 'green' },
                { id: 'windows', label: `Windows (${windows.length})`, color: 'amber' },
                { id: 'rooms', label: `Rooms (${rooms.length})`, color: 'blue' },
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
                        <span className="fpa-item-type">Swing door</span>
                        <span className="fpa-item-dim">{d.gap_width_m?.toFixed(2)}m wide</span>
                      </div>
                      <div className="fpa-item-loc">{d.location}</div>
                      <div className="fpa-item-meta">
                        {d.connects?.join(' → ')}
                        {d.swing_from && <span className="fpa-chip">swing from {d.swing_from}</span>}
                        {d.swing_direction && <span className="fpa-chip">{d.swing_direction}</span>}
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
                        <span className="fpa-item-dim">{p.gap_width_m?.toFixed(2)}m wide</span>
                      </div>
                      <div className="fpa-item-loc">{p.location}</div>
                      <div className="fpa-item-meta">{p.connects?.join(' → ')}</div>
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
                        <span className="fpa-item-dim">{w.width_m?.toFixed(2)}m wide</span>
                      </div>
                      <div className="fpa-item-loc">{w.location}</div>
                      <div className="fpa-item-meta">{w.wall_side} wall</div>
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
                              <td><strong>{w.length_m?.toFixed(2)}m</strong> <span className="fpa-px">({Math.round(w.length_px)}px)</span></td>
                              <td>
                                {w.has_door && <span className="fpa-flag red">door</span>}
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
