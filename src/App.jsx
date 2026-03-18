import { useState, useRef, useEffect, useCallback } from "react";

function compressImage(file, maxPx = 900, quality = 0.85) {
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
  throw new Error("No JSON: " + raw.slice(0, 100));
}

// Room type colours — blueprint style
function getRoomColor(name) {
  const n = name.toLowerCase();
  if (n.includes("bed") || n.includes("master"))   return { fill: "#1a3a5c", stroke: "#2980b9", text: "#a8d8f0", label: "#7ec8e3" };
  if (n.includes("living") || n.includes("lounge")) return { fill: "#1a4a2a", stroke: "#27ae60", text: "#a8e6c0", label: "#6dd5a0" };
  if (n.includes("dining"))                         return { fill: "#1a4a2a", stroke: "#27ae60", text: "#a8e6c0", label: "#6dd5a0" };
  if (n.includes("kitchen"))                        return { fill: "#3a2a1a", stroke: "#e67e22", text: "#ffd9a8", label: "#f0a060" };
  if (n.includes("bath") || n.includes("ensuite"))  return { fill: "#1a2a4a", stroke: "#8e44ad", text: "#d8b4f8", label: "#b07dd8" };
  if (n.includes("garage") || n.includes("car"))    return { fill: "#2a2a2a", stroke: "#7f8c8d", text: "#c0c0c0", label: "#a0a0a0" };
  if (n.includes("balcony") || n.includes("patio")) return { fill: "#1a3a3a", stroke: "#16a085", text: "#a0e0d8", label: "#60c8c0" };
  if (n.includes("hall") || n.includes("entry"))    return { fill: "#2a2a1a", stroke: "#d4ac0d", text: "#f8e8a0", label: "#e0c840" };
  if (n.includes("robe") || n.includes("wardrobe")) return { fill: "#2a1a2a", stroke: "#9b59b6", text: "#e8c0f8", label: "#c090e0" };
  if (n.includes("laundry") || n.includes("l'dry")) return { fill: "#1a2a3a", stroke: "#2980b9", text: "#a8d8f0", label: "#70b8e0" };
  if (n.includes("study") || n.includes("office"))  return { fill: "#2a1a1a", stroke: "#c0392b", text: "#f8c0c0", label: "#e08080" };
  return { fill: "#1e1e2e", stroke: "#5555aa", text: "#c0c0e8", label: "#8080c8" };
}

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
  const [selectedRoom, setSelectedRoom] = useState(null);

  const addLog = useCallback((m) => setLogs(p => [...p, String(m)]), []);

  const processFile = useCallback(async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Not an image file"); return; }
    setError(null); setLogs([]); setResult(null); setSelectedRoom(null);
    setImgURL(URL.createObjectURL(file));
    setProgress("Compressing…");
    addLog(`File: ${file.name} | ${Math.round(file.size / 1024)}KB`);
    try {
      const data = await compressImage(file, 900, 0.85);
      setImgData(data);
      addLog(`Ready: ${data.w}×${data.h}px | ~${data.kb}KB`);
      setProgress("");
      setPage("analysing");
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

  const analyse = useCallback(async (imgInfo) => {
    if (!imgInfo) return;
    setLoading(true); setError(null); setResult(null);
    setProgress("AI is reading floor plan…");
    addLog(`Sending ${imgInfo.kb}KB to API`);
    try {
      const resp = await fetch("/api/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageB64: imgInfo.b64 })
      });
      addLog(`HTTP ${resp.status}`);
      const respData = await resp.json();
      if (respData.error) throw new Error(respData.error);
      addLog(`Reply: ${respData.text?.slice(0, 120)}`);
      setProgress("Drawing floor plan…");
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
      setPage("error");
    } finally {
      setLoading(false);
      setProgress("");
    }
  }, [addLog]);

  useEffect(() => {
    if (page === "analysing" && imgData) {
      analyse(imgData);
    }
  }, [page, imgData]);

  const reset = () => {
    setPage("home"); setImgURL(null); setImgData(null);
    setResult(null); setError(null); setLogs([]);
    setHover(null); setSelectedRoom(null);
  };

  return (
    <div style={S.shell}>
      <div style={S.bar}>
        <div onClick={reset} style={S.brand}>
          <span style={{ fontSize: 22, color: "#4CAF50" }}>▦</span>
          <div>
            <div style={S.bname}>CARPET<span style={{ color: "#4CAF50" }}>FLOOR</span>PLAN</div>
            <div style={S.bsub}>Ceaser Home · Auto Measure</div>
          </div>
        </div>
        {page === "result" && (
          <button style={S.newBtn} onClick={reset}>+ New Plan</button>
        )}
      </div>

      {/* HOME */}
      {page === "home" && (
        <div style={S.page}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={S.h1}>Floor Plan Measurer</div>
            <div style={S.h2}>Upload a floor plan photo → AI draws it and measures every room</div>
            <div style={{ fontSize: 12, color: "#4CAF50", marginTop: 6 }}>No room selection needed — fully automatic</div>
          </div>

          <div style={S.uploadBox}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); processFile(e.dataTransfer.files[0]); }}>

            <label htmlFor="pick" style={S.bigBtn}>
              <span style={{ fontSize: 38 }}>📐</span>
              <div>
                <div style={S.bLabel}>Upload Floor Plan</div>
                <div style={S.bSub}>Photo · Screenshot · Scan</div>
              </div>
            </label>
            <input id="pick" type="file" accept="image/*" style={S.gone}
              onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ""; }} />

            <div style={S.orRow}><div style={S.orLine} /><span style={S.orTxt}>OR</span><div style={S.orLine} /></div>

            <label htmlFor="cam" style={{ ...S.bigBtn, background: "#040d18", borderColor: "#183560" }}>
              <span style={{ fontSize: 38 }}>📷</span>
              <div>
                <div style={{ ...S.bLabel, color: "#5aacdc" }}>Take Photo</div>
                <div style={S.bSub}>Point at floor plan</div>
              </div>
            </label>
            <input id="cam" type="file" accept="image/*" capture="environment" style={S.gone}
              onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ""; }} />

            <div style={{ fontSize: 11, color: "#141440", textAlign: "center" }}>or drag & drop · paste Ctrl+V</div>
          </div>
        </div>
      )}

      {/* ANALYSING */}
      {page === "analysing" && (
        <div style={S.page}>
          <div style={S.analysingWrap}>
            {imgURL && <img src={imgURL} alt="plan" style={S.analysingImg} />}
            <div style={S.analysingOverlay}>
              <div style={S.spinnerWrap}>
                <div style={S.spinnerRing} />
                <span style={{ fontSize: 30 }}>▦</span>
              </div>
              <div style={S.analysingTitle}>{progress || "Measuring rooms…"}</div>
              <div style={S.analysingSubtitle}>AI is mapping your floor plan</div>
            </div>
          </div>
        </div>
      )}

      {/* ERROR */}
      {page === "error" && (
        <div style={S.page}>
          {imgURL && <img src={imgURL} alt="plan" style={{ width: "100%", borderRadius: 10, marginBottom: 16, opacity: 0.5 }} />}
          <div style={S.errBox}>
            <div style={S.errTitle}>⚠ {error}</div>
            {logs.map((l, i) => <div key={i} style={S.logLine}>{l}</div>)}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button style={{ ...S.bigBtn, flex: 1, maxWidth: "none" }} onClick={() => { setPage("analysing"); analyse(imgData); }}>
              <span>↺</span><div><div style={S.bLabel}>Try Again</div></div>
            </button>
            <button style={{ ...S.bigBtn, flex: 1, maxWidth: "none", background: "#080818", borderColor: "#202040" }} onClick={reset}>
              <span>←</span><div><div style={{ ...S.bLabel, color: "#8080c0" }}>New Plan</div></div>
            </button>
          </div>
        </div>
      )}

      {/* RESULT */}
      {page === "result" && result && (
        <div style={S.page}>
          <div style={S.summary}>
            <div>
              <div style={S.sLabel}>TOTAL FLOOR AREA</div>
              <div style={S.sBig}>{result.totalAreaM2}<span style={{ fontSize: 15, fontWeight: 400 }}> m²</span></div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={S.sLabel}>ROOMS</div>
              <div style={{ ...S.sBig, color: "#a8dadc" }}>{result.rooms.length}</div>
            </div>
            <div>
              <div style={S.sLabel}>SCALE</div>
              <div style={{ fontSize: 11, color: "#2a4a4a", marginTop: 4 }}>{result.scale?.ratio || "—"}</div>
            </div>
          </div>

          <div style={S.tabRow}>
            {[["plan", "Floor Plan"], ["table", "All Rooms"], ["info", "Notes"]].map(([k, l]) => (
              <button key={k} style={{ ...S.tabBtn, ...(tab === k ? S.tabOn : {}) }} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {tab === "plan" && (
            <div>
              {/* Blueprint floor plan */}
              <BlueprintPlan
                rooms={result.rooms}
                hover={hover}
                setHover={setHover}
                selected={selectedRoom}
                setSelected={setSelectedRoom}
              />

              {/* Selected room detail */}
              {selectedRoom !== null && result.rooms[selectedRoom] && (
                <RoomDetail room={result.rooms[selectedRoom]} onClose={() => setSelectedRoom(null)} />
              )}

              {/* Room list */}
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 5 }}>
                {result.rooms.map((r, i) => {
                  const c = getRoomColor(r.name);
                  const sc = r.dimensionSource === "scaled";
                  return (
                    <div key={i}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8, background: hover === i || selectedRoom === i ? "#111128" : "#0a0a18", border: `1px solid ${hover === i ? c.stroke : "#12123a"}`, cursor: "pointer" }}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                      onClick={() => setSelectedRoom(selectedRoom === i ? null : i)}>
                      <span style={{ width: 12, height: 12, borderRadius: 3, background: c.stroke, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: c.label }}>{r.name}</span>
                      <span style={{ fontSize: 11, color: "#404070" }}>
                        {sc ? "~" : ""}{r.widthM} × {sc ? "~" : ""}{r.lengthM}m
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: c.stroke, minWidth: 60, textAlign: "right" }}>
                        {(r.widthM * r.lengthM).toFixed(2)} m²
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "table" && (
            <div>
              <div style={{ border: "1px solid #14143a", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.2fr 1fr", background: "#0a0a1e", borderBottom: "1px solid #14143a" }}>
                  {["Room", "Width", "Length", "Area m²", "Source"].map((h, i) => (
                    <div key={h} style={{ padding: "10px 8px", fontSize: 9, letterSpacing: 2, color: "#252555", textAlign: i > 0 ? "right" : "left" }}>{h}</div>
                  ))}
                </div>
                {result.rooms.map((r, i) => {
                  const c = getRoomColor(r.name);
                  const sc = r.dimensionSource === "scaled";
                  return (
                    <div key={i}
                      style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.2fr 1fr", borderBottom: "1px solid #0a0a1a", background: hover === i ? "#141430" : i % 2 === 0 ? "#080818" : "#0b0b1e", cursor: "pointer" }}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                      <div style={{ padding: "10px 8px", fontSize: 13, display: "flex", alignItems: "center", gap: 7, color: c.label }}>
                        <span style={{ width: 9, height: 9, borderRadius: 2, background: c.stroke, flexShrink: 0 }} />
                        {r.name}
                      </div>
                      <div style={S.td}>{sc ? "~" : ""}{r.widthM}m</div>
                      <div style={S.td}>{sc ? "~" : ""}{r.lengthM}m</div>
                      <div style={{ ...S.td, fontWeight: 700, color: c.stroke }}>{(r.widthM * r.lengthM).toFixed(2)}</div>
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
              <div style={{ marginTop: 14, background: "#060e06", border: "1px solid #183018", borderLeft: "4px solid #4CAF50", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 9, letterSpacing: 3, color: "#4CAF50", marginBottom: 6 }}>SCALE CALIBRATION</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#d0e8d0", marginBottom: 8 }}>{result.scale?.ratio || "—"}</div>
                {result.scale?.references?.map((r, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#306030", marginTop: 4 }}>· {r}</div>
                ))}
              </div>
            </div>
          )}

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
            <span style={{ fontSize: 22 }}>📐</span>
            <div><div style={S.bLabel}>Measure Another Plan</div></div>
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Blueprint floor plan SVG ── */
function BlueprintPlan({ rooms, hover, setHover, selected, setSelected }) {
  const W = 420, H = 380, PAD = 28;
  const aW = W - PAD * 2, aH = H - PAD * 2;
  const WALL = 3;

  // Find actual bounds from room positions
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  rooms.forEach(r => {
    const x = r.position?.x ?? 0;
    const y = r.position?.y ?? 0;
    const w = r.size?.w ?? 0.25;
    const h = r.size?.h ?? 0.25;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  });
  const rangeX = Math.max(maxX - minX, 0.1);
  const rangeY = Math.max(maxY - minY, 0.1);

  // Map fraction to SVG coords, fitting to available area
  const toX = (fx) => PAD + ((fx - minX) / rangeX) * aW;
  const toY = (fy) => PAD + ((fy - minY) / rangeY) * aH;
  const toW = (fw) => (fw / rangeX) * aW;
  const toH = (fh) => (fh / rangeY) * aH;

  return (
    <div style={{ background: "#03080f", border: "2px solid #1a3a5a", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "8px 12px", background: "#040d18", borderBottom: "1px solid #1a3a5a", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, color: "#2a6a9a", letterSpacing: 2 }}>FLOOR PLAN</span>
        <span style={{ fontSize: 9, color: "#1a3a5a", marginLeft: "auto" }}>tap room for details</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        <defs>
          <pattern id="bp" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#061828" strokeWidth="0.5"/>
          </pattern>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        {/* Background */}
        <rect width={W} height={H} fill="#03080f"/>
        <rect width={W} height={H} fill="url(#bp)"/>

        {/* Outer boundary */}
        <rect x={PAD - 4} y={PAD - 4} width={aW + 8} height={aH + 8}
          fill="none" stroke="#1a3a5a" strokeWidth="1" strokeDasharray="4 4"/>

        {/* Rooms */}
        {rooms.map((room, i) => {
          const c = getRoomColor(room.name);
          const on = hover === i || selected === i;
          const px = room.position?.x ?? (0.05 + (i % 3) * 0.32);
          const py = room.position?.y ?? (0.08 + Math.floor(i / 3) * 0.35);
          const pw = room.size?.w ?? 0.28;
          const ph = room.size?.h ?? 0.25;

          const rx = toX(px), ry = toY(py);
          const rw = Math.max(40, toW(pw));
          const rh = Math.max(30, toH(ph));
          const sc = room.dimensionSource === "scaled";

          // Dimension text sizes
          const nameSize = Math.min(11, Math.max(7, rw / 7));
          const dimSize  = Math.min(9,  Math.max(6, rw / 9));
          const areaSize = Math.min(10, Math.max(6, rw / 8));

          // Door arc
          const dw = room.doorWall || "south";
          const dp = room.doorPos ?? 0.3;
          const doorLen = Math.min(rw * 0.25, rh * 0.25, 18);
          let door = null;
          if (dw === "south") {
            const dx = rx + rw * dp;
            door = <g stroke={c.stroke} fill="none" strokeWidth="1" opacity="0.8">
              <line x1={dx} y1={ry + rh} x2={dx} y2={ry + rh - doorLen}/>
              <path d={`M ${dx} ${ry + rh} A ${doorLen} ${doorLen} 0 0 1 ${dx + doorLen} ${ry + rh}`}/>
            </g>;
          } else if (dw === "north") {
            const dx = rx + rw * dp;
            door = <g stroke={c.stroke} fill="none" strokeWidth="1" opacity="0.8">
              <line x1={dx} y1={ry} x2={dx} y2={ry + doorLen}/>
              <path d={`M ${dx} ${ry} A ${doorLen} ${doorLen} 0 0 0 ${dx + doorLen} ${ry}`}/>
            </g>;
          } else if (dw === "west") {
            const dy = ry + rh * dp;
            door = <g stroke={c.stroke} fill="none" strokeWidth="1" opacity="0.8">
              <line x1={rx} y1={dy} x2={rx + doorLen} y2={dy}/>
              <path d={`M ${rx} ${dy} A ${doorLen} ${doorLen} 0 0 1 ${rx} ${dy + doorLen}`}/>
            </g>;
          } else if (dw === "east") {
            const dy = ry + rh * dp;
            door = <g stroke={c.stroke} fill="none" strokeWidth="1" opacity="0.8">
              <line x1={rx + rw} y1={dy} x2={rx + rw - doorLen} y2={dy}/>
              <path d={`M ${rx + rw} ${dy} A ${doorLen} ${doorLen} 0 0 0 ${rx + rw} ${dy + doorLen}`}/>
            </g>;
          }

          return (
            <g key={i} style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              onClick={() => setSelected(selected === i ? null : i)}>

              {/* Room fill */}
              <rect x={rx} y={ry} width={rw} height={rh}
                fill={c.fill} opacity={on ? 1 : 0.85}
                stroke={c.stroke} strokeWidth={on ? WALL + 1 : WALL}
                filter={on ? "url(#glow)" : ""}/>

              {/* Colour accent bar */}
              <rect x={rx + WALL} y={ry + WALL} width={rw - WALL * 2} height={4}
                fill={c.stroke} opacity="0.4"/>

              {/* Door */}
              {door}

              {/* Dimension lines - width */}
              {rw > 50 && (
                <g stroke={c.stroke} strokeWidth="0.5" opacity="0.5">
                  <line x1={rx + 4} y1={ry + rh - 8} x2={rx + rw - 4} y2={ry + rh - 8}/>
                  <line x1={rx + 4} y1={ry + rh - 11} x2={rx + 4} y2={ry + rh - 5}/>
                  <line x1={rx + rw - 4} y1={ry + rh - 11} x2={rx + rw - 4} y2={ry + rh - 5}/>
                </g>
              )}

              {/* Room name */}
              <text x={rx + rw / 2} y={ry + rh / 2 - (rh > 50 ? 10 : 6)} textAnchor="middle"
                fill={c.text} style={{ fontSize: nameSize, fontWeight: 700, fontFamily: "sans-serif" }}>
                {room.name}
              </text>

              {/* Dimensions */}
              {rh > 40 && (
                <text x={rx + rw / 2} y={ry + rh / 2 + (rh > 55 ? 4 : 2)} textAnchor="middle"
                  fill={c.text} opacity="0.7" style={{ fontSize: dimSize, fontFamily: "monospace" }}>
                  {sc ? "~" : ""}{room.widthM}×{sc ? "~" : ""}{room.lengthM}m
                </text>
              )}

              {/* Area */}
              {rh > 55 && (
                <text x={rx + rw / 2} y={ry + rh / 2 + 16} textAnchor="middle"
                  fill={c.stroke} style={{ fontSize: areaSize, fontWeight: 700, fontFamily: "monospace" }}>
                  {(room.widthM * room.lengthM).toFixed(2)}m²
                </text>
              )}

              {/* Scaled indicator */}
              {sc && (
                <text x={rx + rw - 3} y={ry + 10} textAnchor="end"
                  fill="#FFD700" opacity="0.7" style={{ fontSize: 7, fontFamily: "monospace" }}>~</text>
              )}
            </g>
          );
        })}

        {/* Compass */}
        <text x={W - 12} y={H - 8} textAnchor="end" fill="#1a3a5a"
          style={{ fontSize: 9, fontFamily: "monospace", letterSpacing: 1 }}>N↑</text>

        {/* Scale note */}
        <text x={12} y={H - 8} fill="#1a3a5a"
          style={{ fontSize: 8, fontFamily: "monospace" }}>
          ~ = scaled · solid = labelled
        </text>
      </svg>
    </div>
  );
}

/* ── Selected room detail popup ── */
function RoomDetail({ room, onClose }) {
  const c = getRoomColor(room.name);
  const sc = room.dimensionSource === "scaled";
  return (
    <div style={{ background: c.fill, border: `2px solid ${c.stroke}`, borderRadius: 12, padding: "14px 16px", marginTop: 10, position: "relative" }}>
      <button onClick={onClose} style={{ position: "absolute", top: 8, right: 10, background: "transparent", border: "none", color: c.text, fontSize: 18, cursor: "pointer" }}>×</button>
      <div style={{ fontSize: 9, letterSpacing: 3, color: c.stroke, marginBottom: 4 }}>ROOM DETAIL</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: c.label, marginBottom: 10 }}>{room.name}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div>
          <div style={{ fontSize: 8, color: c.text, opacity: 0.6, letterSpacing: 1 }}>WIDTH</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: c.text }}>{sc ? "~" : ""}{room.widthM}m</div>
        </div>
        <div>
          <div style={{ fontSize: 8, color: c.text, opacity: 0.6, letterSpacing: 1 }}>LENGTH</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: c.text }}>{sc ? "~" : ""}{room.lengthM}m</div>
        </div>
        <div>
          <div style={{ fontSize: 8, color: c.text, opacity: 0.6, letterSpacing: 1 }}>AREA</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: c.stroke }}>{(room.widthM * room.lengthM).toFixed(2)} m²</div>
        </div>
      </div>
      {room.notes && <div style={{ marginTop: 10, fontSize: 12, color: c.text, opacity: 0.7 }}>{room.notes}</div>}
      <div style={{ marginTop: 8, fontSize: 9, color: c.text, opacity: 0.5 }}>
        Source: {room.dimensionSource} · Door: {room.doorWall || "—"}
      </div>
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
  h1:       { fontSize: 26, fontWeight: 900, color: "#c0c0e0", marginBottom: 10 },
  h2:       { fontSize: 13, color: "#303060", lineHeight: 1.6 },
  uploadBox:{ background: "#040410", border: "2px dashed #141440", borderRadius: 16, padding: "28px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 },
  bigBtn:   { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, background: "#081408", border: "2px solid #204820", borderRadius: 14, padding: "16px 28px", cursor: "pointer", width: "100%", maxWidth: 340, boxSizing: "border-box" },
  bLabel:   { fontSize: 16, fontWeight: 700, color: "#4CAF50", letterSpacing: 1 },
  bSub:     { fontSize: 11, color: "#2a4a2a", marginTop: 2 },
  gone:     { position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" },
  orRow:    { display: "flex", alignItems: "center", gap: 12, width: "100%", maxWidth: 340 },
  orLine:   { flex: 1, height: 1, background: "#0e0e38" },
  orTxt:    { fontSize: 9, color: "#141440", letterSpacing: 2 },
  analysingWrap: { position: "relative", borderRadius: 14, overflow: "hidden", background: "#040410", border: "1px solid #0e0e38", minHeight: 260 },
  analysingImg: { width: "100%", display: "block", opacity: 0.35 },
  analysingOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
  spinnerWrap: { position: "relative", width: 60, height: 60, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 },
  spinnerRing: { position: "absolute", width: 60, height: 60, borderRadius: "50%", border: "3px solid transparent", borderTop: "3px solid #4CAF50", animation: "spin 1s linear infinite" },
  analysingTitle: { fontSize: 18, fontWeight: 700, color: "#4CAF50" },
  analysingSubtitle: { fontSize: 12, color: "#2a4a2a", marginTop: 6 },
  summary:  { display: "flex", gap: 16, padding: "14px 16px", background: "#040410", borderRadius: 14, marginBottom: 16, alignItems: "center", flexWrap: "wrap", border: "1px solid #0e0e38" },
  sLabel:   { fontSize: 8, letterSpacing: 3, color: "#1a1a50", marginBottom: 2 },
  sBig:     { fontSize: 28, fontWeight: 900, color: "#4CAF50" },
  tabRow:   { display: "flex", borderBottom: "2px solid #0c0c30", marginBottom: 16 },
  tabBtn:   { flex: 1, padding: "10px 4px", background: "transparent", border: "none", color: "#1a1a48", fontSize: 12, fontWeight: 700, cursor: "pointer", letterSpacing: 1, borderBottom: "2px solid transparent", marginBottom: -2 },
  tabOn:    { color: "#4CAF50", borderBottom: "2px solid #4CAF50" },
  td:       { padding: "10px 8px", fontSize: 13, textAlign: "right", color: "#505090" },
  iHead:    { fontSize: 9, letterSpacing: 3, color: "#4CAF50", fontWeight: 700, marginBottom: 6 },
  errBox:   { background: "#0c0303", border: "1px solid #300c0c", borderRadius: 10, padding: "14px 16px" },
  errTitle: { color: "#ff6060", fontWeight: 700, fontSize: 14, marginBottom: 8 },
  logLine:  { fontSize: 10, color: "#502020", wordBreak: "break-all", marginTop: 3, lineHeight: 1.4 },
};
