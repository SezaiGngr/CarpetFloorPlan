import { useState, useRef, useEffect, useCallback } from "react";

/* ─── Compress image ─── */
function compressImage(file, maxPx = 900, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image decode failed"));
      img.onload = () => {
        try {
          const scale = Math.min(1, maxPx / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
          const w = Math.round(img.naturalWidth * scale);
          const h = Math.round(img.naturalHeight * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          const dataURL = canvas.toDataURL("image/jpeg", quality);
          const b64 = dataURL.split(",")[1];
          resolve({ b64, w, h, kb: Math.round(b64.length * 0.75 / 1024) });
        } catch (e) { reject(new Error("Canvas: " + e.message)); }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function extractJSON(raw) {
  if (!raw?.trim()) throw new Error("Empty response");
  for (const fn of [
    () => JSON.parse(raw.trim()),
    () => JSON.parse(raw.replace(/```json/gi, "").replace(/```/g, "").trim()),
    () => { const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); if (a >= 0 && b > a) return JSON.parse(raw.slice(a, b + 1)); throw 0; }
  ]) { try { return fn(); } catch {} }
  throw new Error("No JSON found: " + raw.slice(0, 120));
}

const PALETTE = [
  { bg: "#1a472a", border: "#2d6a4f", text: "#b7e4c7", accent: "#52b788" },
  { bg: "#1b263b", border: "#415a77", text: "#a8dadc", accent: "#457b9d" },
  { bg: "#4a1942", border: "#6d2b6b", text: "#f4c2e8", accent: "#c77daa" },
  { bg: "#3d2314", border: "#7f4f24", text: "#ffe8d6", accent: "#bc6c25" },
  { bg: "#1c3a2e", border: "#2d6a4f", text: "#cce8da", accent: "#40916c" },
  { bg: "#2c1654", border: "#5a189a", text: "#e0aaff", accent: "#9d4edd" },
  { bg: "#3d0c02", border: "#9b2226", text: "#ffccd5", accent: "#e63946" },
  { bg: "#0d3b2e", border: "#1b7a5a", text: "#b7e4c7", accent: "#2d9e6b" },
];

export default function App() {
  const [page, setPage]         = useState("home");
  const [imgURL, setImgURL]     = useState(null);
  const [imgData, setImgData]   = useState(null);
  const [loading, setLoading]   = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const [logs, setLogs]         = useState([]);
  const [tab, setTab]           = useState("plan");
  const [hover, setHover]       = useState(null);

  const addLog = useCallback((m) => setLogs(p => [...p, String(m)]), []);

  const processFile = useCallback(async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Not an image file"); return; }
    setError(null); setLogs([]); setResult(null);
    setImgURL(URL.createObjectURL(file));
    setProgress("Compressing image…");
    addLog(`File: ${file.name} | ${Math.round(file.size / 1024)}KB`);
    try {
      const data = await compressImage(file, 900, 0.82);
      setImgData(data);
      addLog(`Compressed: ${data.w}×${data.h}px | ~${data.kb}KB`);
      setProgress("");
      setPage("preview");
    } catch (e) {
      setError("Image error: " + e.message);
      setProgress("");
    }
  }, [addLog]);

  useEffect(() => {
    const onPaste = (e) => {
      for (const item of (e.clipboardData?.items || [])) {
        if (item.type.startsWith("image/")) { processFile(item.getAsFile()); return; }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [processFile]);

  const analyse = useCallback(async (data) => {
    const imgInfo = data || imgData;
    if (!imgInfo) return;
    setLoading(true); setError(null); setLogs([]); setResult(null);
    setProgress("Analysing floor plan…");
    addLog(`Sending: ${imgInfo.kb}KB`);

    const prompt = `You are a professional floor plan analyst and carpet installation quantity surveyor.

Analyse this floor plan image carefully. Identify and measure EVERY room in the floor plan.
Do NOT skip any room — measure all of them including bedrooms, living areas, hallways, studies, lounge, dining, and any other spaces visible.

For each room:
1. Read any labelled dimensions directly from the plan
2. For rooms without labels, calculate dimensions using the scale from labelled rooms
3. Estimate the position and size as fractions of the full image

RESPOND WITH ONLY A JSON OBJECT. No text before or after. No markdown. Start with { end with }.

{
  "scale": {
    "ratio": "128px/m",
    "references": ["Living/Dining 3.6m wide = 460px"]
  },
  "rooms": [
    {
      "name": "Bed 1",
      "widthM": 3.2,
      "lengthM": 3.0,
      "dimensionSource": "labelled",
      "position": { "x": 0.54, "y": 0.76 },
      "size": { "w": 0.28, "h": 0.22 },
      "notes": ""
    }
  ],
  "sanityFlags": [],
  "totalAreaM2": 9.6
}

Rules:
- Include EVERY room visible on the plan — do not skip any
- position x,y = top-left of room as fraction of full image (0.0–1.0)
- size w,h = room width/height as fraction of full image (0.0–1.0)
- dimensionSource: "labelled" if shown on plan, "scaled" if you calculated it
- totalAreaM2 = sum of all widthM × lengthM`;

    try {
      const resp = await fetch("/api/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageB64: imgInfo.b64, carpetedRooms: "ALL ROOMS" })
      });

      addLog(`HTTP ${resp.status}`);
      const respData = await resp.json();
      if (respData.error) throw new Error(respData.error);
      if (!respData.text) throw new Error("No text in response");

      addLog(`Reply: ${respData.text.slice(0, 150)}`);
      setProgress("Parsing results…");

      const parsed = extractJSON(respData.text);
      if (!Array.isArray(parsed.rooms) || !parsed.rooms.length) throw new Error("No rooms found");

      parsed.totalAreaM2 = Math.round(
        parsed.rooms.reduce((s, r) => s + (r.widthM || 0) * (r.lengthM || 0), 0) * 100
      ) / 100;

      setResult(parsed);
      setTab("plan");
      setPage("result");
      addLog(`✓ ${parsed.rooms.length} rooms | ${parsed.totalAreaM2}m²`);
    } catch (e) {
      setError(e.message);
      addLog("✗ " + e.message);
    } finally {
      setLoading(false);
      setProgress("");
    }
  }, [imgData, addLog]);

  // Auto-analyse when image is ready
  useEffect(() => {
    if (page === "preview" && imgData && !loading && !result) {
      analyse(imgData);
    }
  }, [page, imgData]);

  const reset = () => {
    setPage("home"); setImgURL(null); setImgData(null);
    setResult(null); setError(null); setLogs([]); setHover(null);
  };

  return (
    <div style={S.shell}>

      {/* TOP BAR */}
      <div style={S.bar}>
        <div onClick={reset} style={S.brand}>
          <span style={{ fontSize: 22, color: "#4CAF50" }}>▦</span>
          <div>
            <div style={S.bname}>CARPET<span style={{ color: "#4CAF50" }}>FLOOR</span>PLAN</div>
            <div style={S.bsub}>Ceaser Home · Auto Measure</div>
          </div>
        </div>
        {page !== "home" && (
          <button style={S.newBtn} onClick={reset}>+ New Plan</button>
        )}
      </div>

      {/* ═══ HOME ═══ */}
      {page === "home" && (
        <div style={S.page}>
          <div style={S.heroWrap}>
            <div style={S.h1}>Floor Plan Measurer</div>
            <div style={S.h2}>
              Upload any floor plan → AI measures every room automatically
            </div>
            <div style={S.h3}>No room selection needed — just upload and go</div>
          </div>

          <div style={S.uploadBox}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); processFile(e.dataTransfer.files[0]); }}>

            <label htmlFor="pick" style={S.bigBtn}>
              <span style={{ fontSize: 36 }}>📐</span>
              <div>
                <div style={S.bLabel}>Upload Floor Plan</div>
                <div style={S.bSub}>Photo · PDF scan · Screenshot</div>
              </div>
            </label>
            <input id="pick" type="file" accept="image/*" style={S.gone}
              onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ""; }} />

            <div style={S.orRow}>
              <div style={S.orLine} /><span style={S.orTxt}>OR</span><div style={S.orLine} />
            </div>

            <label htmlFor="cam" style={{ ...S.bigBtn, background: "#040d18", borderColor: "#183560" }}>
              <span style={{ fontSize: 36 }}>📷</span>
              <div>
                <div style={{ ...S.bLabel, color: "#5aacdc" }}>Take Photo</div>
                <div style={S.bSub}>Point camera at floor plan</div>
              </div>
            </label>
            <input id="cam" type="file" accept="image/*" capture="environment" style={S.gone}
              onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ""; }} />

            <div style={{ fontSize: 11, color: "#141440", textAlign: "center" }}>
              or drag & drop · or paste Ctrl+V
            </div>
          </div>

          {progress && <div style={S.pill}>⏳ {progress}</div>}
          {error && <ErrBox msg={error} logs={logs} />}
        </div>
      )}

      {/* ═══ PREVIEW / ANALYSING ═══ */}
      {page === "preview" && (
        <div style={S.page}>
          <div style={S.analysingCard}>
            {imgURL && <img src={imgURL} alt="plan" style={S.analysingImg} />}
            <div style={S.analysingOverlay}>
              <div style={S.spinner}>⟳</div>
              <div style={S.analysingText}>Measuring all rooms…</div>
              <div style={S.analysingSubText}>AI is reading your floor plan</div>
            </div>
          </div>
          {error && (
            <div style={{ marginTop: 16 }}>
              <ErrBox msg={error} logs={logs} />
              <button style={{ ...S.bigBtn, marginTop: 12, width: "100%", maxWidth: "100%", justifyContent: "center" }}
                onClick={() => analyse(imgData)}>
                <span style={{ fontSize: 20 }}>↺</span>
                <div><div style={S.bLabel}>Try Again</div></div>
              </button>
              <button style={{ ...S.bigBtn, marginTop: 8, width: "100%", maxWidth: "100%", justifyContent: "center", background: "#080810", borderColor: "#202040" }}
                onClick={reset}>
                <span style={{ fontSize: 20 }}>←</span>
                <div><div style={{ ...S.bLabel, color: "#8080c0" }}>Upload Different Plan</div></div>
              </button>
            </div>
          )}
        </div>
      )}

      {/* ═══ RESULT ═══ */}
      {page === "result" && result && (
        <div style={S.page}>

          {/* Summary strip */}
          <div style={S.summary}>
            <div>
              <div style={S.sLabel}>TOTAL AREA</div>
              <div style={S.sBig}>{result.totalAreaM2}<span style={{ fontSize: 16, fontWeight: 400 }}> m²</span></div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={S.sLabel}>ROOMS FOUND</div>
              <div style={{ ...S.sBig, color: "#a8dadc" }}>{result.rooms.length}</div>
            </div>
            <div>
              <div style={S.sLabel}>SCALE</div>
              <div style={{ fontSize: 11, color: "#304a4a", marginTop: 4, maxWidth: 120 }}>{result.scale?.ratio || "—"}</div>
            </div>
          </div>

          {/* Tabs */}
          <div style={S.tabRow}>
            {[["plan", "Floor Plan"], ["table", "All Rooms"], ["info", "Details"]].map(([k, l]) => (
              <button key={k} style={{ ...S.tabBtn, ...(tab === k ? S.tabOn : {}) }} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {/* PLAN TAB */}
          {tab === "plan" && (
            <div>
              <PlanSVG rooms={result.rooms} hover={hover} setHover={setHover} />
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 5 }}>
                {result.rooms.map((r, i) => {
                  const c = PALETTE[i % PALETTE.length];
                  return (
                    <div key={i}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8, background: hover === i ? "#111128" : "#0a0a18", border: `1px solid ${hover === i ? c.border : "#12123a"}`, cursor: "pointer", transition: "all 0.15s" }}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                      <span style={{ width: 12, height: 12, borderRadius: 3, background: c.accent, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: c.text }}>{r.name}</span>
                      <span style={{ fontSize: 11, color: "#404070" }}>
                        {r.dimensionSource === "scaled" ? "~" : ""}{r.widthM} × {r.dimensionSource === "scaled" ? "~" : ""}{r.lengthM}m
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: c.accent, minWidth: 60, textAlign: "right" }}>
                        {(r.widthM * r.lengthM).toFixed(2)} m²
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TABLE TAB */}
          {tab === "table" && (
            <div>
              <div style={{ border: "1px solid #14143a", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.2fr 1fr", background: "#0a0a1e", borderBottom: "1px solid #14143a" }}>
                  {["Room", "Width", "Length", "Area m²", "Source"].map((h, i) => (
                    <div key={h} style={{ padding: "10px 8px", fontSize: 9, letterSpacing: 2, color: "#252555", textAlign: i > 0 ? "right" : "left" }}>{h}</div>
                  ))}
                </div>
                {result.rooms.map((r, i) => {
                  const c = PALETTE[i % PALETTE.length];
                  const sc = r.dimensionSource === "scaled";
                  return (
                    <div key={i}
                      style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.2fr 1fr", borderBottom: "1px solid #0a0a1a", background: hover === i ? "#141430" : i % 2 === 0 ? "#080818" : "#0b0b1e", cursor: "pointer" }}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                      <div style={{ padding: "10px 8px", fontSize: 13, display: "flex", alignItems: "center", gap: 7, color: c.text }}>
                        <span style={{ width: 9, height: 9, borderRadius: 2, background: c.accent, flexShrink: 0 }} />
                        {r.name}
                      </div>
                      <div style={S.td}>{sc ? "~" : ""}{r.widthM}m</div>
                      <div style={S.td}>{sc ? "~" : ""}{r.lengthM}m</div>
                      <div style={{ ...S.td, fontWeight: 700, color: c.accent }}>{(r.widthM * r.lengthM).toFixed(2)}</div>
                      <div style={{ ...S.td, paddingRight: 10 }}>
                        <span style={{ fontSize: 8, padding: "2px 5px", borderRadius: 3, background: sc ? "#160e00" : "#060e06", color: sc ? "#FFD700" : "#4CAF50", border: `1px solid ${sc ? "#302000" : "#103010"}` }}>
                          {sc ? "scaled" : "labelled"}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 12px", background: "#0a0a1e", borderTop: "2px solid #181848" }}>
                  <div style={{ fontSize: 9, letterSpacing: 3, color: "#303068", fontWeight: 700 }}>TOTAL FLOOR AREA</div>
                  <div style={{ fontSize: 28, fontWeight: 900, color: "#4CAF50" }}>{result.totalAreaM2} m²</div>
                </div>
              </div>

              {result.scale && (
                <div style={{ marginTop: 14, background: "#060e06", border: "1px solid #183018", borderLeft: "4px solid #4CAF50", borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 9, letterSpacing: 3, color: "#4CAF50", marginBottom: 6 }}>SCALE CALIBRATION</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#d0e8d0", marginBottom: 8 }}>{result.scale.ratio}</div>
                  {result.scale.references?.map((r, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#306030", marginTop: 4 }}>· {r}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* INFO TAB */}
          {tab === "info" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {result.sanityFlags?.filter(Boolean).length > 0 && (
                <div>
                  <div style={S.iHead}>SANITY CHECKS</div>
                  {result.sanityFlags.filter(Boolean).map((f, i) => (
                    <div key={i} style={{ padding: "10px 14px", background: "#060610", border: "1px solid #101032", borderRadius: 8, marginTop: 8, fontSize: 13, color: "#5060a0", lineHeight: 1.5 }}>
                      <span style={{ color: "#4CAF50", marginRight: 8 }}>✓</span>{f}
                    </div>
                  ))}
                </div>
              )}
              {result.rooms.some(r => r.notes) && (
                <div>
                  <div style={S.iHead}>ROOM NOTES</div>
                  {result.rooms.filter(r => r.notes).map((r, i) => (
                    <div key={i} style={{ padding: "12px 14px", background: "#060610", border: "1px solid #101032", borderRadius: 8, marginTop: 8 }}>
                      <div style={{ fontSize: 9, letterSpacing: 1, color: "#4CAF50", marginBottom: 4 }}>{r.name.toUpperCase()}</div>
                      <div style={{ fontSize: 13, color: "#405080", lineHeight: 1.6 }}>{r.notes}</div>
                    </div>
                  ))}
                </div>
              )}
              <div>
                <div style={S.iHead}>DEBUG LOG</div>
                <div style={{ background: "#030308", border: "1px solid #0c0c28", borderRadius: 8, padding: 12 }}>
                  {logs.map((l, i) => <div key={i} style={S.logLine}>{l}</div>)}
                </div>
              </div>
            </div>
          )}

          <button style={{ ...S.bigBtn, marginTop: 20, width: "100%", maxWidth: "100%", justifyContent: "center" }} onClick={reset}>
            <span style={{ fontSize: 20 }}>📐</span>
            <div><div style={S.bLabel}>Measure Another Plan</div></div>
          </button>
        </div>
      )}
    </div>
  );
}

function ErrBox({ msg, logs }) {
  return (
    <div style={{ marginTop: 10, background: "#0c0303", border: "1px solid #300c0c", borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ color: "#ff6060", fontWeight: 700, fontSize: 14, marginBottom: logs?.length ? 10 : 0 }}>⚠ {msg}</div>
      {logs?.map((l, i) => <div key={i} style={{ fontSize: 10, color: "#502020", wordBreak: "break-all", marginTop: 3, lineHeight: 1.4 }}>{l}</div>)}
    </div>
  );
}

function PlanSVG({ rooms, hover, setHover }) {
  const W = 400, H = 340, P = 20, aW = W - P * 2, aH = H - P * 2;
  return (
    <div style={{ background: "#040410", border: "1px solid #0e0e38", borderRadius: 14, overflow: "hidden" }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        <defs>
          <pattern id="g" width="15" height="15" patternUnits="userSpaceOnUse">
            <circle cx="7.5" cy="7.5" r="0.4" fill="#0c0c36" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="#040410" />
        <rect width={W} height={H} fill="url(#g)" />
        <rect x={P} y={P} width={aW} height={aH} fill="none" stroke="#141440" strokeWidth="1" rx="4" />
        {rooms.map((room, i) => {
          const c = PALETTE[i % PALETTE.length], on = hover === i;
          const px = Math.min(0.84, Math.max(0.02, room.position?.x ?? (0.04 + (i % 3) * 0.31)));
          const py = Math.min(0.78, Math.max(0.02, room.position?.y ?? (0.08 + Math.floor(i / 3) * 0.28)));
          const pw = Math.min(0.48, Math.max(0.12, room.size?.w ?? 0.28));
          const ph = Math.min(0.45, Math.max(0.10, room.size?.h ?? 0.22));
          const rx = P + px * aW, ry = P + py * aH, rw = pw * aW, rh = ph * aH;
          const sc = room.dimensionSource === "scaled";
          return (
            <g key={i} style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {on && <rect x={rx + 4} y={ry + 4} width={rw} height={rh} fill={c.accent} opacity="0.15" rx="5" />}
              <rect x={rx} y={ry} width={rw} height={rh} fill={c.bg} opacity={on ? 1 : 0.82}
                stroke={on ? c.accent : c.border} strokeWidth={on ? 2.5 : 1.5} rx="4" />
              <rect x={rx + 2} y={ry + 2} width={rw - 4} height={4} fill={c.accent} opacity="0.5" rx="2" />
              <text x={rx + rw / 2} y={ry + rh / 2 - 9} textAnchor="middle" fill={c.text}
                style={{ fontSize: Math.min(11, rw / 5.5), fontWeight: 700, fontFamily: "sans-serif" }}>{room.name}</text>
              <text x={rx + rw / 2} y={ry + rh / 2 + 4} textAnchor="middle" fill={c.text} opacity="0.7"
                style={{ fontSize: Math.min(9, rw / 7), fontFamily: "monospace" }}>
                {sc ? "~" : ""}{room.widthM}×{sc ? "~" : ""}{room.lengthM}m</text>
              <text x={rx + rw / 2} y={ry + rh / 2 + 16} textAnchor="middle" fill={c.accent}
                style={{ fontSize: Math.min(10, rw / 6.5), fontWeight: 700, fontFamily: "monospace" }}>
                {(room.widthM * room.lengthM).toFixed(2)}m²</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const S = {
  shell:    { minHeight: "100vh", background: "#020208", color: "#e0e0f0", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display: "flex", flexDirection: "column" },
  bar:      { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", background: "#040410", borderBottom: "1px solid #0e0e38", flexWrap: "wrap" },
  brand:    { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" },
  bname:    { fontSize: 14, fontWeight: 900, letterSpacing: 2 },
  bsub:     { fontSize: 8, color: "#181840", letterSpacing: 2 },
  newBtn:   { marginLeft: "auto", background: "#4CAF50", color: "#000", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  page:     { flex: 1, padding: "20px 16px", maxWidth: 680, margin: "0 auto", width: "100%", boxSizing: "border-box" },
  heroWrap: { textAlign: "center", marginBottom: 28 },
  h1:       { fontSize: 26, fontWeight: 900, color: "#c0c0e0", marginBottom: 10 },
  h2:       { fontSize: 14, color: "#303060", lineHeight: 1.5, marginBottom: 6 },
  h3:       { fontSize: 12, color: "#4CAF50", letterSpacing: 1 },
  uploadBox:{ background: "#040410", border: "2px dashed #141440", borderRadius: 16, padding: "28px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 },
  bigBtn:   { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, background: "#081408", border: "2px solid #204820", borderRadius: 14, padding: "16px 28px", cursor: "pointer", width: "100%", maxWidth: 340, boxSizing: "border-box", textDecoration: "none" },
  bLabel:   { fontSize: 17, fontWeight: 700, color: "#4CAF50", letterSpacing: 1 },
  bSub:     { fontSize: 11, color: "#2a4a2a", marginTop: 2 },
  gone:     { position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" },
  orRow:    { display: "flex", alignItems: "center", gap: 12, width: "100%", maxWidth: 340 },
  orLine:   { flex: 1, height: 1, background: "#0e0e38" },
  orTxt:    { fontSize: 9, color: "#141440", letterSpacing: 2 },
  pill:     { marginTop: 12, background: "#060e06", border: "1px solid #183018", borderRadius: 10, padding: "12px 18px", fontSize: 13, color: "#4CAF50", textAlign: "center" },
  analysingCard: { position: "relative", borderRadius: 14, overflow: "hidden", background: "#040410", border: "1px solid #0e0e38" },
  analysingImg: { width: "100%", display: "block", opacity: 0.4 },
  analysingOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(4,4,16,0.7)" },
  spinner:  { fontSize: 40, color: "#4CAF50", animation: "spin 1.5s linear infinite", marginBottom: 12 },
  analysingText: { fontSize: 18, fontWeight: 700, color: "#4CAF50", letterSpacing: 1 },
  analysingSubText: { fontSize: 12, color: "#2a4a2a", marginTop: 6 },
  summary:  { display: "flex", gap: 16, padding: "14px 16px", background: "#040410", borderRadius: 14, marginBottom: 16, alignItems: "center", flexWrap: "wrap", border: "1px solid #0e0e38" },
  sLabel:   { fontSize: 8, letterSpacing: 3, color: "#1a1a50", marginBottom: 2 },
  sBig:     { fontSize: 30, fontWeight: 900, color: "#4CAF50" },
  tabRow:   { display: "flex", borderBottom: "2px solid #0c0c30", marginBottom: 16 },
  tabBtn:   { flex: 1, padding: "10px 4px", background: "transparent", border: "none", color: "#1a1a48", fontSize: 12, fontWeight: 700, cursor: "pointer", letterSpacing: 1, borderBottom: "2px solid transparent", marginBottom: -2 },
  tabOn:    { color: "#4CAF50", borderBottom: "2px solid #4CAF50" },
  td:       { padding: "10px 8px", fontSize: 13, textAlign: "right", color: "#505090" },
  iHead:    { fontSize: 9, letterSpacing: 3, color: "#4CAF50", fontWeight: 700, marginBottom: 6 },
  logLine:  { fontSize: 10, color: "#3a1a1a", wordBreak: "break-all", marginTop: 3, lineHeight: 1.4 },
};
