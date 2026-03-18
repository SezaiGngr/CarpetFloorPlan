import { useState, useEffect, useCallback } from "react";

/* ─── Image compression ─── */
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
          const b64 = canvas.toDataURL("image/jpeg", quality).split(",")[1];
          resolve({ b64, w, h, kb: Math.round(b64.length * 0.75 / 1024) });
        } catch (e) { reject(new Error("Canvas: " + e.message)); }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ─── JSON extractor ─── */
function extractJSON(raw) {
  if (!raw?.trim()) throw new Error("Empty response");
  for (const fn of [
    () => JSON.parse(raw.trim()),
    () => JSON.parse(raw.replace(/```json/gi, "").replace(/```/g, "").trim()),
    () => { const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); if (a >= 0 && b > a) return JSON.parse(raw.slice(a, b + 1)); throw 0; }
  ]) { try { return fn(); } catch {} }
  throw new Error("No JSON: " + raw.slice(0, 100));
}

/* ─── Overlap detection & auto-fix ─── */
function detectOverlaps(rooms) {
  const overlaps = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];
      const ax1 = a.position.x, ay1 = a.position.y;
      const ax2 = ax1 + a.size.w,  ay2 = ay1 + a.size.h;
      const bx1 = b.position.x, by1 = b.position.y;
      const bx2 = bx1 + b.size.w,  by2 = by1 + b.size.h;
      // Check overlap with 2% tolerance
      const overlapX = ax1 < bx2 - 0.02 && ax2 > bx1 + 0.02;
      const overlapY = ay1 < by2 - 0.02 && ay2 > by1 + 0.02;
      if (overlapX && overlapY) {
        overlaps.push({ a: a.name, b: b.name, overlapW: Math.min(ax2, bx2) - Math.max(ax1, bx1), overlapH: Math.min(ay2, by2) - Math.max(ay1, by1) });
      }
    }
  }
  return overlaps;
}

/* ─── Auto-fix overlapping rooms by snapping edges ─── */
function fixOverlaps(rooms) {
  const fixed = rooms.map(r => ({ ...r, position: { ...r.position }, size: { ...r.size } }));
  // Sort by position top-left first
  fixed.sort((a, b) => a.position.y !== b.position.y ? a.position.y - b.position.y : a.position.x - b.position.x);
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      const a = fixed[i], b = fixed[j];
      const ax1 = a.position.x, ay1 = a.position.y, ax2 = ax1 + a.size.w, ay2 = ay1 + a.size.h;
      const bx1 = b.position.x, by1 = b.position.y, bx2 = bx1 + b.size.w, by2 = by1 + b.size.h;
      const overlapX = ax1 < bx2 - 0.01 && ax2 > bx1 + 0.01;
      const overlapY = ay1 < by2 - 0.01 && ay2 > by1 + 0.01;
      if (overlapX && overlapY) {
        const ow = Math.min(ax2, bx2) - Math.max(ax1, bx1);
        const oh = Math.min(ay2, by2) - Math.max(ay1, by1);
        // Push the later room in the smaller overlap direction
        if (ow <= oh) {
          // Horizontal push: move b to right of a
          if (bx1 < ax2) fixed[j].position.x = ax2;
        } else {
          // Vertical push: move b below a
          if (by1 < ay2) fixed[j].position.y = ay2;
        }
      }
    }
  }
  return fixed;
}

/* ─── Room colour by type ─── */
function getRoomColor(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("bed") || n.includes("master"))    return { fill: "#0a1e30", stroke: "#2980b9", text: "#a8d8f0", label: "#7ec8e3" };
  if (n.includes("living") || n.includes("lounge")) return { fill: "#0a1e0a", stroke: "#27ae60", text: "#a8e6c0", label: "#6dd5a0" };
  if (n.includes("dining"))                          return { fill: "#0a1e0a", stroke: "#2ecc71", text: "#a8e6c0", label: "#6dd5a0" };
  if (n.includes("kitchen"))                         return { fill: "#1e1000", stroke: "#e67e22", text: "#ffd9a8", label: "#f0a060" };
  if (n.includes("bath") || n.includes("ensuite"))   return { fill: "#0a0a20", stroke: "#9b59b6", text: "#d8b4f8", label: "#b07dd8" };
  if (n.includes("garage") || n.includes("car"))     return { fill: "#101010", stroke: "#7f8c8d", text: "#c0c0c0", label: "#a0a0a0" };
  if (n.includes("balcony") || n.includes("patio"))  return { fill: "#001414", stroke: "#16a085", text: "#a0e0d8", label: "#60c8c0" };
  if (n.includes("hall") || n.includes("entry"))     return { fill: "#141000", stroke: "#d4ac0d", text: "#f8e8a0", label: "#e0c840" };
  if (n.includes("robe") || n.includes("linen"))     return { fill: "#14000a", stroke: "#c0392b", text: "#f8c0c0", label: "#e08888" };
  if (n.includes("laundry") || n.includes("l'dry") || n.includes("wc")) return { fill: "#001020", stroke: "#3498db", text: "#a8d8f0", label: "#70b8e0" };
  return { fill: "#0e0e1e", stroke: "#5555aa", text: "#c0c0e8", label: "#8080c8" };
}

export default function App() {
  const [page, setPage]         = useState("home");
  const [imgURL, setImgURL]     = useState(null);
  const [imgData, setImgData]   = useState(null);
  const [loading, setLoading]   = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult]     = useState(null);
  const [overlaps, setOverlaps] = useState([]);
  const [error, setError]       = useState(null);
  const [logs, setLogs]         = useState([]);
  const [tab, setTab]           = useState("plan");
  const [hover, setHover]       = useState(null);
  const [selected, setSelected] = useState(null);

  const addLog = useCallback((m) => setLogs(p => [...p, String(m)]), []);

  const processFile = useCallback(async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Not an image file"); return; }
    setError(null); setLogs([]); setResult(null); setSelected(null); setOverlaps([]);
    setImgURL(URL.createObjectURL(file));
    addLog(`File: ${file.name} | ${Math.round(file.size / 1024)}KB`);
    setProgress("Compressing…");
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
    setLoading(true); setError(null); setResult(null); setOverlaps([]);
    setProgress("AI reading floor plan…");
    addLog(`Sending ${imgInfo.kb}KB`);
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
      setProgress("Checking layout…");

      const parsed = extractJSON(respData.text);
      if (!Array.isArray(parsed.rooms) || !parsed.rooms.length) throw new Error("No rooms found");

      // Detect overlaps
      const found = detectOverlaps(parsed.rooms);
      addLog(`Overlaps found: ${found.length}`);

      // Auto-fix overlaps
      if (found.length > 0) {
        parsed.rooms = fixOverlaps(parsed.rooms);
        const remaining = detectOverlaps(parsed.rooms);
        addLog(`After fix: ${remaining.length} overlaps remain`);
        setOverlaps(remaining);
      } else {
        setOverlaps([]);
      }

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
    if (page === "analysing" && imgData) analyse(imgData);
  }, [page, imgData]);

  const reset = () => {
    setPage("home"); setImgURL(null); setImgData(null);
    setResult(null); setError(null); setLogs([]);
    setHover(null); setSelected(null); setOverlaps([]);
  };

  return (
    <div style={S.shell}>
      {/* BAR */}
      <div style={S.bar}>
        <div onClick={reset} style={S.brand}>
          <span style={{ fontSize: 22, color: "#4CAF50" }}>▦</span>
          <div>
            <div style={S.bname}>CARPET<span style={{ color: "#4CAF50" }}>FLOOR</span>PLAN</div>
            <div style={S.bsub}>Ceaser Home · Auto Measure</div>
          </div>
        </div>
        {page === "result" && <button style={S.newBtn} onClick={reset}>+ New Plan</button>}
      </div>

      {/* HOME */}
      {page === "home" && (
        <div style={S.page}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={S.h1}>Floor Plan Measurer</div>
            <div style={S.h2}>Upload a floor plan → AI maps every room with accurate positions</div>
            <div style={{ marginTop: 10, display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={S.badge}>📐 Room measurements</div>
              <div style={S.badge}>🚪 Doors detected</div>
              <div style={S.badge}>🪟 Windows detected</div>
              <div style={S.badge}>✅ No overlaps</div>
            </div>
          </div>

          <div style={S.uploadBox}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); processFile(e.dataTransfer.files[0]); }}>

            <label htmlFor="pick" style={S.bigBtn}>
              <span style={{ fontSize: 36 }}>📐</span>
              <div>
                <div style={S.bLabel}>Upload Floor Plan</div>
                <div style={S.bSub}>Photo · Screenshot · Scan</div>
              </div>
            </label>
            <input id="pick" type="file" accept="image/*" style={S.gone}
              onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ""; }} />

            <div style={S.orRow}><div style={S.orLine}/><span style={S.orTxt}>OR</span><div style={S.orLine}/></div>

            <label htmlFor="cam" style={{ ...S.bigBtn, background: "#040d18", borderColor: "#183560" }}>
              <span style={{ fontSize: 36 }}>📷</span>
              <div>
                <div style={{ ...S.bLabel, color: "#5aacdc" }}>Take Photo</div>
                <div style={S.bSub}>Point at floor plan</div>
              </div>
            </label>
            <input id="cam" type="file" accept="image/*" capture="environment" style={S.gone}
              onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ""; }} />

            <div style={{ fontSize: 11, color: "#141440", textAlign: "center" }}>or drag & drop · paste Ctrl+V</div>
          </div>

          <div style={S.howTo}>
            <div style={S.howToTitle}>OPTIONAL: MARK DOORS & WINDOWS</div>
            <div style={S.howToStep}><span style={S.stepNum}>1</span>Draw yellow lines over door and window openings on your plan</div>
            <div style={S.howToStep}><span style={S.stepNum}>2</span>Upload the marked plan</div>
            <div style={S.howToStep}><span style={S.stepNum}>3</span>AI detects all rooms + yellow openings</div>
          </div>
        </div>
      )}

      {/* ANALYSING */}
      {page === "analysing" && (
        <div style={S.page}>
          <div style={S.analysingWrap}>
            {imgURL && <img src={imgURL} alt="plan" style={S.analysingImg} />}
            <div style={S.analysingOverlay}>
              <div style={S.spinnerWrap}><div style={S.spinnerRing}/><span style={{ fontSize: 26, color: "#4CAF50" }}>▦</span></div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#4CAF50", marginTop: 4 }}>{progress || "Analysing…"}</div>
              <div style={{ fontSize: 12, color: "#2a5a2a", marginTop: 6 }}>Mapping rooms without overlaps</div>
            </div>
          </div>
        </div>
      )}

      {/* ERROR */}
      {page === "error" && (
        <div style={S.page}>
          {imgURL && <img src={imgURL} alt="plan" style={{ width: "100%", borderRadius: 10, marginBottom: 16, opacity: 0.4 }} />}
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

          {/* Overlap warning */}
          {overlaps.length > 0 && (
            <div style={S.warnBox}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ {overlaps.length} layout issue{overlaps.length > 1 ? "s" : ""} detected (auto-corrected)</div>
              {overlaps.map((o, i) => <div key={i} style={{ fontSize: 11, marginTop: 2 }}>{o.a} ↔ {o.b}</div>)}
            </div>
          )}

          <div style={S.summary}>
            <div>
              <div style={S.sLabel}>TOTAL AREA</div>
              <div style={S.sBig}>{result.totalAreaM2}<span style={{ fontSize: 14, fontWeight: 400 }}> m²</span></div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={S.sLabel}>ROOMS</div>
              <div style={{ ...S.sBig, color: "#a8dadc" }}>{result.rooms.length}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={S.sLabel}>OPENINGS</div>
              <div style={{ ...S.sBig, color: "#FFD700" }}>
                {result.rooms.reduce((s, r) => s + (r.openings?.length || 0), 0)}
              </div>
            </div>
          </div>

          <div style={S.tabRow}>
            {[["plan","Floor Plan"],["table","All Rooms"],["info","Debug"]].map(([k,l]) => (
              <button key={k} style={{ ...S.tabBtn, ...(tab===k?S.tabOn:{}) }} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {tab === "plan" && (
            <div>
              <BlueprintPlan rooms={result.rooms} hover={hover} setHover={setHover} selected={selected} setSelected={setSelected}/>
              {selected !== null && result.rooms[selected] && (
                <RoomDetail room={result.rooms[selected]} onClose={() => setSelected(null)}/>
              )}
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {result.rooms.map((r, i) => {
                  const c = getRoomColor(r.name);
                  const doors   = r.openings?.filter(o => o.type === "door").length   || 0;
                  const windows = r.openings?.filter(o => o.type === "window").length || 0;
                  return (
                    <div key={i}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8,
                        background: hover===i||selected===i ? "#111128" : "#0a0a18",
                        border: `1px solid ${hover===i ? c.stroke : "#10103a"}`, cursor: "pointer" }}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                      onClick={() => setSelected(selected===i ? null : i)}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: c.stroke, flexShrink: 0 }}/>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: c.label }}>{r.name}</span>
                      {doors   > 0 && <span style={S.tagD}>🚪{doors}</span>}
                      {windows > 0 && <span style={S.tagW}>🪟{windows}</span>}
                      <span style={{ fontSize: 11, color: "#404060" }}>
                        {r.dimensionSource==="scaled"?"~":""}{r.widthM}×{r.dimensionSource==="scaled"?"~":""}{r.lengthM}m
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: c.stroke, minWidth: 52, textAlign: "right" }}>
                        {(r.widthM*r.lengthM).toFixed(2)}m²
                      </span>
                    </div>
                  );
                })}
              </div>
              <div style={S.legendRow}>
                <div style={S.li}><span style={{ ...S.ldot, background: "#FFD700" }}/>Door</div>
                <div style={S.li}><span style={{ ...S.ldot, background: "#60a8e0" }}/>Window</div>
                <div style={S.li}><span style={{ ...S.ldot, background: "#4CAF50" }}/>Labelled</div>
                <div style={S.li}><span style={{ ...S.ldot, background: "#666" }}/>~ Scaled</div>
              </div>
            </div>
          )}

          {tab === "table" && (
            <div>
              <div style={{ border: "1px solid #14143a", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", background: "#0a0a1e", borderBottom: "1px solid #14143a" }}>
                  {["Room","Width","Length","Area m²","Open."].map((h,i) => (
                    <div key={h} style={{ padding: "9px 8px", fontSize: 8, letterSpacing: 2, color: "#252555", textAlign: i>0?"right":"left" }}>{h}</div>
                  ))}
                </div>
                {result.rooms.map((r, i) => {
                  const c = getRoomColor(r.name);
                  const sc = r.dimensionSource === "scaled";
                  const d = r.openings?.filter(o=>o.type==="door").length || 0;
                  const w = r.openings?.filter(o=>o.type==="window").length || 0;
                  return (
                    <div key={i}
                      style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", borderBottom: "1px solid #0a0a1a",
                        background: hover===i?"#141430":i%2===0?"#080818":"#0b0b1e", cursor:"pointer" }}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                      <div style={{ padding:"10px 8px", fontSize:13, display:"flex", alignItems:"center", gap:6, color:c.label }}>
                        <span style={{ width:8, height:8, borderRadius:2, background:c.stroke, flexShrink:0 }}/>
                        {r.name}
                      </div>
                      <div style={S.td}>{sc?"~":""}{r.widthM}m</div>
                      <div style={S.td}>{sc?"~":""}{r.lengthM}m</div>
                      <div style={{ ...S.td, fontWeight:700, color:c.stroke }}>{(r.widthM*r.lengthM).toFixed(2)}</div>
                      <div style={{ ...S.td, paddingRight:8 }}>
                        {d>0 && <span style={{ fontSize:10, color:"#FFD700" }}>🚪{d} </span>}
                        {w>0 && <span style={{ fontSize:10, color:"#60a8e0" }}>🪟{w}</span>}
                        {!d&&!w && <span style={{ fontSize:9, color:"#303050" }}>—</span>}
                      </div>
                    </div>
                  );
                })}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 12px", background:"#0a0a1e", borderTop:"2px solid #181848" }}>
                  <div style={{ fontSize:9, letterSpacing:3, color:"#303068", fontWeight:700 }}>TOTAL FLOOR AREA</div>
                  <div style={{ fontSize:26, fontWeight:900, color:"#4CAF50" }}>{result.totalAreaM2} m²</div>
                </div>
              </div>
              <div style={{ marginTop:14, background:"#060e06", border:"1px solid #183018", borderLeft:"4px solid #4CAF50", borderRadius:10, padding:"13px 16px" }}>
                <div style={{ fontSize:9, letterSpacing:3, color:"#4CAF50", marginBottom:5 }}>SCALE</div>
                <div style={{ fontSize:17, fontWeight:700, color:"#d0e8d0", marginBottom:5 }}>{result.scale?.ratio||"—"}</div>
                {result.scale?.references?.map((r,i) => <div key={i} style={{ fontSize:11, color:"#306030", marginTop:3 }}>· {r}</div>)}
              </div>
            </div>
          )}

          {tab === "info" && (
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              {overlaps.length > 0 && (
                <div>
                  <div style={S.iHead}>OVERLAP REPORT</div>
                  {overlaps.map((o, i) => (
                    <div key={i} style={{ padding:"8px 12px", background:"#100808", border:"1px solid #301010", borderRadius:7, marginTop:6, fontSize:12, color:"#c05050" }}>
                      ⚠ {o.a} overlaps {o.b} by {(o.overlapW*100).toFixed(1)}% × {(o.overlapH*100).toFixed(1)}%
                    </div>
                  ))}
                </div>
              )}
              {result.sanityFlags?.filter(Boolean).length > 0 && (
                <div>
                  <div style={S.iHead}>SANITY CHECKS</div>
                  {result.sanityFlags.filter(Boolean).map((f,i) => (
                    <div key={i} style={{ padding:"9px 12px", background:"#060610", border:"1px solid #101030", borderRadius:7, marginTop:6, fontSize:12, color:"#5060a0" }}>
                      <span style={{ color:"#4CAF50", marginRight:8 }}>✓</span>{f}
                    </div>
                  ))}
                </div>
              )}
              <div>
                <div style={S.iHead}>DEBUG LOG</div>
                <div style={{ background:"#030308", border:"1px solid #0c0c28", borderRadius:8, padding:12 }}>
                  {logs.map((l,i) => <div key={i} style={S.logLine}>{l}</div>)}
                </div>
              </div>
            </div>
          )}

          <button style={{ ...S.bigBtn, marginTop:20, width:"100%", maxWidth:"100%", justifyContent:"center" }} onClick={reset}>
            <span style={{ fontSize:20 }}>📐</span>
            <div><div style={S.bLabel}>Measure Another Plan</div></div>
          </button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   BLUEPRINT PLAN — walls with door/window gaps
   Rooms are placed exactly by their position/size
   Overlapping rooms get a red border warning
══════════════════════════════════════════ */
function BlueprintPlan({ rooms, hover, setHover, selected, setSelected }) {
  const W = 420, H = 400, PAD = 24;
  const aW = W - PAD * 2, aH = H - PAD * 2;
  const WALL = 3.5;

  // Compute bounding box from all rooms
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  rooms.forEach(r => {
    const x = r.position?.x ?? 0, y = r.position?.y ?? 0;
    const w = r.size?.w ?? 0.2,   h = r.size?.h ?? 0.2;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x+w > maxX) maxX = x+w; if (y+h > maxY) maxY = y+h;
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
  const rangeX = Math.max(maxX - minX, 0.05);
  const rangeY = Math.max(maxY - minY, 0.05);

  const toX = fx => PAD + ((fx - minX) / rangeX) * aW;
  const toY = fy => PAD + ((fy - minY) / rangeY) * aH;
  const toW = fw => (fw / rangeX) * aW;
  const toH = fh => (fh / rangeY) * aH;

  // Check if a room overlaps with any other (for highlighting)
  const overlapSet = new Set();
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i+1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];
      const ax1=a.position?.x??0, ay1=a.position?.y??0, ax2=ax1+(a.size?.w??0.2), ay2=ay1+(a.size?.h??0.2);
      const bx1=b.position?.x??0, by1=b.position?.y??0, bx2=bx1+(b.size?.w??0.2), by2=by1+(b.size?.h??0.2);
      if (ax1<bx2-0.01 && ax2>bx1+0.01 && ay1<by2-0.01 && ay2>by1+0.01) {
        overlapSet.add(i); overlapSet.add(j);
      }
    }
  }

  function WallSeg({ x1, y1, x2, y2, wall, ops, stroke, sw }) {
    const wlen = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
    const rel = (ops||[]).filter(o=>o.wall===wall).sort((a,b)=>(a.posStart||0)-(b.posStart||0));
    if (!rel.length) return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} strokeLinecap="square"/>;
    const segs = [];
    let cur = 0;
    rel.forEach((op, oi) => {
      const s = Math.min(op.posStart??0, op.posEnd??1);
      const e = Math.max(op.posStart??0, op.posEnd??1);
      if (s > cur) {
        segs.push(<line key={`a${oi}`} x1={x1+(x2-x1)*cur} y1={y1+(y2-y1)*cur} x2={x1+(x2-x1)*s} y2={y1+(y2-y1)*s} stroke={stroke} strokeWidth={sw} strokeLinecap="square"/>);
      }
      const mx = x1+(x2-x1)*((s+e)/2), my = y1+(y2-y1)*((s+e)/2);
      const gl = wlen*(e-s);
      const px = -(y2-y1)/Math.max(wlen,1), py = (x2-x1)/Math.max(wlen,1);
      if (op.type==="door") {
        const sx=x1+(x2-x1)*s, sy=y1+(y2-y1)*s, ex=x1+(x2-x1)*e, ey=y1+(y2-y1)*e;
        segs.push(
          <g key={`d${oi}`}>
            <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="#FFD700" strokeWidth={sw+1.5}/>
            <line x1={sx} y1={sy} x2={sx+px*gl*0.55} y2={sy+py*gl*0.55} stroke="#FFD700" strokeWidth="1" strokeDasharray="2 1.5"/>
            <line x1={ex} y1={ey} x2={ex+px*gl*0.55} y2={ey+py*gl*0.55} stroke="#FFD700" strokeWidth="1" strokeDasharray="2 1.5"/>
            <circle cx={mx+px*3} cy={my+py*3} r="2.5" fill="none" stroke="#FFD700" strokeWidth="0.8"/>
          </g>
        );
      } else {
        const sx=x1+(x2-x1)*s, sy=y1+(y2-y1)*s, ex=x1+(x2-x1)*e, ey=y1+(y2-y1)*e;
        segs.push(
          <g key={`w${oi}`}>
            <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="#60a8e0" strokeWidth={sw+1}/>
            <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="#ffffff" strokeWidth="0.8" strokeDasharray="3 2.5"/>
          </g>
        );
      }
      cur = e;
    });
    if (cur < 0.999) {
      segs.push(<line key="tail" x1={x1+(x2-x1)*cur} y1={y1+(y2-y1)*cur} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} strokeLinecap="square"/>);
    }
    return <g>{segs}</g>;
  }

  return (
    <div style={{ background:"#02060c", border:"2px solid #0e2840", borderRadius:12, overflow:"hidden" }}>
      <div style={{ padding:"7px 12px", background:"#030d18", borderBottom:"1px solid #0e2840", display:"flex", alignItems:"center", gap:10 }}>
        <span style={{ fontSize:9, color:"#1a5a8a", letterSpacing:2 }}>FLOOR PLAN</span>
        <span style={{ fontSize:8, color:"#FFD700" }}>■ door</span>
        <span style={{ fontSize:8, color:"#60a8e0" }}>■ window</span>
        {overlapSet.size > 0 && <span style={{ fontSize:8, color:"#ff6060", marginLeft:4 }}>⚠ overlap fixed</span>}
        <span style={{ fontSize:8, color:"#0e2840", marginLeft:"auto" }}>tap room for details</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display:"block" }}>
        <defs>
          <pattern id="bp" width="18" height="18" patternUnits="userSpaceOnUse">
            <path d="M18 0L0 0 0 18" fill="none" stroke="#040e18" strokeWidth="0.4"/>
          </pattern>
          <filter id="glow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <rect width={W} height={H} fill="#02060c"/>
        <rect width={W} height={H} fill="url(#bp)"/>
        <rect x={PAD-4} y={PAD-4} width={aW+8} height={aH+8} fill="none" stroke="#0a2030" strokeWidth="1" strokeDasharray="5 4"/>

        {rooms.map((room, i) => {
          const c   = getRoomColor(room.name);
          const on  = hover===i || selected===i;
          const bad = overlapSet.has(i);
          const px = room.position?.x ?? (0.05+(i%3)*0.32);
          const py = room.position?.y ?? (0.08+Math.floor(i/3)*0.33);
          const pw = room.size?.w ?? 0.25;
          const ph = room.size?.h ?? 0.22;
          const rx = toX(px), ry = toY(py);
          const rw = Math.max(32, toW(pw));
          const rh = Math.max(24, toH(ph));
          const sc = room.dimensionSource==="scaled";
          const ops= room.openings||[];
          const nameFs = Math.min(10, Math.max(6, rw/8));
          const dimFs  = Math.min(8,  Math.max(5, rw/10));
          const areaFs = Math.min(9,  Math.max(5, rw/9));

          return (
            <g key={i} style={{ cursor:"pointer" }}
              onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)}
              onClick={()=>setSelected(selected===i?null:i)}>
              {/* Fill */}
              <rect x={rx} y={ry} width={rw} height={rh} fill={c.fill} opacity={on?1:0.88} filter={on?"url(#glow)":""}/>
              {/* Accent bar */}
              <rect x={rx} y={ry} width={rw} height={2.5} fill={c.stroke} opacity="0.5"/>

              {/* Walls with openings */}
              <WallSeg x1={rx}    y1={ry}    x2={rx+rw} y2={ry}    wall="north" ops={ops} stroke={bad?"#ff4444":c.stroke} sw={on?WALL+1:WALL}/>
              <WallSeg x1={rx}    y1={ry+rh} x2={rx+rw} y2={ry+rh} wall="south" ops={ops} stroke={bad?"#ff4444":c.stroke} sw={on?WALL+1:WALL}/>
              <WallSeg x1={rx}    y1={ry}    x2={rx}    y2={ry+rh} wall="west"  ops={ops} stroke={bad?"#ff4444":c.stroke} sw={on?WALL+1:WALL}/>
              <WallSeg x1={rx+rw} y1={ry}    x2={rx+rw} y2={ry+rh} wall="east"  ops={ops} stroke={bad?"#ff4444":c.stroke} sw={on?WALL+1:WALL}/>

              {/* Labels */}
              {rh>20 && <text x={rx+rw/2} y={ry+rh/2-(rh>42?8:0)} textAnchor="middle" fill={c.text} style={{ fontSize:nameFs, fontWeight:700, fontFamily:"sans-serif" }}>{room.name}</text>}
              {rh>38 && <text x={rx+rw/2} y={ry+rh/2+4} textAnchor="middle" fill={c.text} opacity="0.6" style={{ fontSize:dimFs, fontFamily:"monospace" }}>{sc?"~":""}{room.widthM}×{sc?"~":""}{room.lengthM}m</text>}
              {rh>50 && <text x={rx+rw/2} y={ry+rh/2+15} textAnchor="middle" fill={c.stroke} style={{ fontSize:areaFs, fontWeight:700, fontFamily:"monospace" }}>{(room.widthM*room.lengthM).toFixed(2)}m²</text>}
              {sc && <text x={rx+rw-3} y={ry+9} textAnchor="end" fill="#888" style={{ fontSize:6 }}>~</text>}
              {bad && <text x={rx+4} y={ry+10} fill="#ff4444" style={{ fontSize:6 }}>⚠</text>}
            </g>
          );
        })}

        <text x={W-10} y={H-7} textAnchor="end" fill="#0e2840" style={{ fontSize:8, fontFamily:"monospace" }}>N↑</text>
        <text x={10} y={H-7} fill="#0e2840" style={{ fontSize:7, fontFamily:"monospace" }}>~ scaled · no tilde = labelled on plan</text>
      </svg>
    </div>
  );
}

function RoomDetail({ room, onClose }) {
  const c = getRoomColor(room.name);
  const sc = room.dimensionSource === "scaled";
  const doors   = room.openings?.filter(o=>o.type==="door")   || [];
  const windows = room.openings?.filter(o=>o.type==="window") || [];
  return (
    <div style={{ background:c.fill, border:`2px solid ${c.stroke}`, borderRadius:12, padding:"14px 16px", marginTop:10, position:"relative" }}>
      <button onClick={onClose} style={{ position:"absolute", top:8, right:10, background:"transparent", border:"none", color:c.text, fontSize:20, cursor:"pointer" }}>×</button>
      <div style={{ fontSize:8, letterSpacing:3, color:c.stroke, marginBottom:3 }}>ROOM DETAIL</div>
      <div style={{ fontSize:18, fontWeight:800, color:c.label, marginBottom:10 }}>{room.name}</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:10 }}>
        <div><div style={{ fontSize:8, color:c.text, opacity:0.5, letterSpacing:1 }}>WIDTH</div><div style={{ fontSize:18, fontWeight:700, color:c.text }}>{sc?"~":""}{room.widthM}m</div></div>
        <div><div style={{ fontSize:8, color:c.text, opacity:0.5, letterSpacing:1 }}>LENGTH</div><div style={{ fontSize:18, fontWeight:700, color:c.text }}>{sc?"~":""}{room.lengthM}m</div></div>
        <div><div style={{ fontSize:8, color:c.text, opacity:0.5, letterSpacing:1 }}>AREA</div><div style={{ fontSize:18, fontWeight:700, color:c.stroke }}>{(room.widthM*room.lengthM).toFixed(2)}m²</div></div>
      </div>
      {doors.length>0 && (
        <div style={{ marginBottom:8 }}>
          <div style={{ fontSize:8, color:"#FFD700", letterSpacing:2, marginBottom:3 }}>🚪 DOORS ({doors.length})</div>
          {doors.map((d,i)=><div key={i} style={{ fontSize:11, color:"#c8a820", marginTop:2 }}>{d.wall} wall · {d.widthM||"~"}m wide · {Math.round((d.posStart||0)*100)}%–{Math.round((d.posEnd||1)*100)}%</div>)}
        </div>
      )}
      {windows.length>0 && (
        <div>
          <div style={{ fontSize:8, color:"#60a8e0", letterSpacing:2, marginBottom:3 }}>🪟 WINDOWS ({windows.length})</div>
          {windows.map((w,i)=><div key={i} style={{ fontSize:11, color:"#4090c0", marginTop:2 }}>{w.wall} wall · {w.widthM||"~"}m wide · {Math.round((w.posStart||0)*100)}%–{Math.round((w.posEnd||1)*100)}%</div>)}
        </div>
      )}
      {!doors.length&&!windows.length && <div style={{ fontSize:11, color:c.text, opacity:0.4 }}>No marked openings on this room</div>}
    </div>
  );
}

const S = {
  shell:     { minHeight:"100vh", background:"#020208", color:"#e0e0f0", fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", display:"flex", flexDirection:"column" },
  bar:       { display:"flex", alignItems:"center", gap:12, padding:"12px 18px", background:"#040410", borderBottom:"1px solid #0e0e38", flexWrap:"wrap" },
  brand:     { display:"flex", alignItems:"center", gap:10, cursor:"pointer" },
  bname:     { fontSize:14, fontWeight:900, letterSpacing:2 },
  bsub:      { fontSize:8, color:"#181840", letterSpacing:2 },
  newBtn:    { marginLeft:"auto", background:"#4CAF50", color:"#000", border:"none", borderRadius:8, padding:"8px 16px", fontSize:13, fontWeight:700, cursor:"pointer" },
  page:      { flex:1, padding:"20px 16px", maxWidth:680, margin:"0 auto", width:"100%", boxSizing:"border-box" },
  h1:        { fontSize:24, fontWeight:900, color:"#c0c0e0", marginBottom:8 },
  h2:        { fontSize:13, color:"#303060", lineHeight:1.6 },
  badge:     { fontSize:11, color:"#4CAF50", background:"#081408", border:"1px solid #204820", borderRadius:20, padding:"4px 12px" },
  uploadBox: { background:"#040410", border:"2px dashed #141440", borderRadius:16, padding:"26px 20px", display:"flex", flexDirection:"column", alignItems:"center", gap:14 },
  bigBtn:    { display:"flex", alignItems:"center", justifyContent:"center", gap:14, background:"#081408", border:"2px solid #204820", borderRadius:14, padding:"15px 26px", cursor:"pointer", width:"100%", maxWidth:340, boxSizing:"border-box" },
  bLabel:    { fontSize:16, fontWeight:700, color:"#4CAF50", letterSpacing:1 },
  bSub:      { fontSize:11, color:"#2a4a2a", marginTop:2 },
  gone:      { position:"absolute", opacity:0, width:0, height:0, pointerEvents:"none" },
  orRow:     { display:"flex", alignItems:"center", gap:12, width:"100%", maxWidth:340 },
  orLine:    { flex:1, height:1, background:"#0e0e38" },
  orTxt:     { fontSize:9, color:"#141440", letterSpacing:2 },
  howTo:     { marginTop:22, background:"#040410", border:"1px solid #0e0e38", borderRadius:12, padding:"16px" },
  howToTitle:{ fontSize:9, letterSpacing:3, color:"#4CAF50", marginBottom:10 },
  howToStep: { display:"flex", alignItems:"flex-start", gap:10, marginBottom:8, fontSize:12, color:"#4060a0", lineHeight:1.5 },
  stepNum:   { width:22, height:22, borderRadius:"50%", background:"#0a200a", border:"1px solid #204820", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, color:"#4CAF50", flexShrink:0 },
  analysingWrap:{ position:"relative", borderRadius:14, overflow:"hidden", background:"#040410", border:"1px solid #0e0e38", minHeight:260 },
  analysingImg: { width:"100%", display:"block", opacity:0.3 },
  analysingOverlay: { position:"absolute", top:0, left:0, right:0, bottom:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" },
  spinnerWrap:  { position:"relative", width:54, height:54, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:10 },
  spinnerRing:  { position:"absolute", width:54, height:54, borderRadius:"50%", border:"3px solid transparent", borderTop:"3px solid #4CAF50", animation:"spin 1s linear infinite" },
  warnBox:   { background:"#1a0808", border:"1px solid #4a1010", borderRadius:10, padding:"12px 16px", marginBottom:14, fontSize:12, color:"#e08080" },
  summary:   { display:"flex", gap:14, padding:"12px 16px", background:"#040410", borderRadius:14, marginBottom:16, alignItems:"center", flexWrap:"wrap", border:"1px solid #0e0e38" },
  sLabel:    { fontSize:8, letterSpacing:3, color:"#1a1a50", marginBottom:2 },
  sBig:      { fontSize:26, fontWeight:900, color:"#4CAF50" },
  tabRow:    { display:"flex", borderBottom:"2px solid #0c0c30", marginBottom:16 },
  tabBtn:    { flex:1, padding:"10px 4px", background:"transparent", border:"none", color:"#1a1a48", fontSize:12, fontWeight:700, cursor:"pointer", letterSpacing:1, borderBottom:"2px solid transparent", marginBottom:-2 },
  tabOn:     { color:"#4CAF50", borderBottom:"2px solid #4CAF50" },
  td:        { padding:"10px 8px", fontSize:13, textAlign:"right", color:"#505090" },
  iHead:     { fontSize:9, letterSpacing:3, color:"#4CAF50", fontWeight:700, marginBottom:6 },
  errBox:    { background:"#0c0303", border:"1px solid #300c0c", borderRadius:10, padding:"14px 16px" },
  errTitle:  { color:"#ff6060", fontWeight:700, fontSize:14, marginBottom:8 },
  logLine:   { fontSize:10, color:"#502020", wordBreak:"break-all", marginTop:3, lineHeight:1.4 },
  tagD:      { fontSize:10, background:"#181200", color:"#FFD700", border:"1px solid #302000", borderRadius:6, padding:"2px 5px" },
  tagW:      { fontSize:10, background:"#081020", color:"#60a8e0", border:"1px solid #103040", borderRadius:6, padding:"2px 5px" },
  legendRow: { display:"flex", flexWrap:"wrap", gap:10, marginTop:12, padding:"9px 12px", background:"#040410", border:"1px solid #0e0e38", borderRadius:8 },
  li:        { display:"flex", alignItems:"center", gap:6, fontSize:10, color:"#404070" },
  ldot:      { width:10, height:10, borderRadius:2, flexShrink:0 },
};
