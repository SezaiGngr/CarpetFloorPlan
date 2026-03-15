import { useState, useRef, useEffect, useCallback } from "react";

/* ─── Compress image: FileReader → Image → Canvas ─── */
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
];

export default function App() {
  const [page, setPage]         = useState("home");
  const [imgURL, setImgURL]     = useState(null);
  const [imgData, setImgData]   = useState(null);
  const [rooms, setRooms]       = useState("");
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
    if (!file.type.startsWith("image/")) { setError("Not an image: " + file.type); return; }
    setError(null); setLogs([]);
    setImgURL(URL.createObjectURL(file));
    addLog(`File: ${file.name} | ${Math.round(file.size / 1024)}KB | ${file.type}`);
    setProgress("Compressing image…");
    try {
      const data = await compressImage(file, 900, 0.82);
      setImgData(data);
      addLog(`Compressed: ${data.w}×${data.h}px | ~${data.kb}KB`);
      setProgress("");
      setPage("analyse");
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

  const analyse = async () => {
    if (!imgData || !rooms.trim()) return;
    setLoading(true); setError(null); setLogs([]); setResult(null);
    addLog(`Sending image: ${imgData.kb}KB`);
    setProgress("Analysing floor plan…");

    try {
      // Calls YOUR Netlify serverless function — API key stays secret on server
      const resp = await fetch("/api/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageB64: imgData.b64, carpetedRooms: rooms })
      });

      addLog(`HTTP ${resp.status}`);
      const respData = await resp.json();

      if (respData.error) throw new Error(respData.error);
      if (!respData.text) throw new Error("No text in response");

      addLog(`Model reply: ${respData.text.slice(0, 150)}`);
      setProgress("Parsing results…");

      const parsed = extractJSON(respData.text);
      if (!Array.isArray(parsed.rooms) || !parsed.rooms.length) throw new Error("No rooms found");

      parsed.totalAreaM2 = Math.round(
        parsed.rooms.reduce((s, r) => s + (r.widthM || 0) * (r.lengthM || 0), 0) * 100
      ) / 100;

      setResult(parsed); setTab("plan"); setPage("result");
      addLog(`✓ ${parsed.rooms.length} rooms | ${parsed.totalAreaM2}m²`);
    } catch (e) {
      setError(e.message);
      addLog("✗ " + e.message);
    } finally {
      setLoading(false); setProgress("");
    }
  };

  const reset = () => {
    setPage("home"); setImgURL(null); setImgData(null);
    setRooms(""); setResult(null); setError(null); setLogs([]); setHover(null);
  };

  return (
    <div style={S.shell}>

      {/* TOP BAR */}
      <div style={S.bar}>
        <div onClick={reset} style={S.brand}>
          <span style={{ fontSize: 20, color: "#4CAF50" }}>▦</span>
          <div>
            <div style={S.bname}>CARPET<span style={{ color: "#4CAF50" }}>PLAN</span></div>
            <div style={S.bsub}>Ceaser Home</div>
          </div>
        </div>
        {page !== "home" && (
          <div style={S.crumbs}>
            <Crumb n="1" done={page !== "home"} active={page === "home"} label="Upload" />
            <div style={S.cline} />
            <Crumb n="2" done={page === "result"} active={page === "analyse"} label="Rooms" />
            <div style={S.cline} />
            <Crumb n="3" done={false} active={page === "result"} label="Results" />
          </div>
        )}
        {page === "result" && <button style={S.newBtn} onClick={reset}>+ New Job</button>}
      </div>

      {/* HOME */}
      {page === "home" && (
        <div style={S.page}>
          <div style={S.h1}>Floor Plan Estimator</div>
          <div style={S.h2}>Upload a floor plan → mark carpeted rooms → get instant measurements</div>

          <div style={S.uploadBox}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); processFile(e.dataTransfer.files[0]); }}>

            <label htmlFor="pick" style={S.bigBtn}>
              <span style={{ fontSize: 30 }}>📁</span>
              <span style={S.bLabel}>Choose Photo</span>
            </label>
            <input id="pick" type="file" accept="image/*" style={S.gone}
              onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ""; }} />

            <div style={S.orRow}>
              <div style={S.orLine} /><span style={S.orTxt}>OR</span><div style={S.orLine} />
            </div>

            <label htmlFor="cam" style={{ ...S.bigBtn, background: "#040d18", borderColor: "#183560" }}>
              <span style={{ fontSize: 30 }}>📷</span>
              <span style={{ ...S.bLabel, color: "#5aacdc" }}>Take Photo</span>
            </label>
            <input id="cam" type="file" accept="image/*" capture="environment" style={S.gone}
              onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = ""; }} />

            <div style={{ fontSize: 11, color: "#141440", textAlign: "center" }}>
              or drag & drop · or paste with Ctrl+V
            </div>
          </div>

          {progress && <div style={S.pill}>⏳ {progress}</div>}
          {error && <ErrBox msg={error} logs={logs} />}
        </div>
      )}

      {/* ANALYSE */}
      {page === "analyse" && (
        <div style={S.page}>
          <div style={S.twoCol}>
            <div style={S.card}>
              <div style={S.ctitle}>FLOOR PLAN</div>
              {imgURL && <img src={imgURL} alt="plan" style={S.planImg} />}
              {imgData && <div style={S.meta}>{imgData.w}×{imgData.h}px · ~{imgData.kb}KB</div>}
              <button style={S.smBtn} onClick={reset}>Change image</button>
            </div>

            <div style={S.card}>
              <div style={S.ctitle}>CARPETED AREAS</div>
              <div style={{ fontSize: 12, color: "#1e1e45", lineHeight: 1.6, marginBottom: 8 }}>
                List which rooms need carpet, or describe highlighted areas on the plan.
              </div>
              <textarea style={S.ta} rows={6} value={rooms}
                placeholder={"e.g. Bed 1, Bed 2\n\nor: rooms in yellow lines\n\nor: all bedrooms and hallway"}
                onChange={e => setRooms(e.target.value)} autoFocus />

              {error && <ErrBox msg={error} logs={logs} />}
              {progress && <div style={S.pill}>⏳ {progress}</div>}

              <button
                style={{ ...S.runBtn, ...(loading || !rooms.trim() ? S.runOff : {}) }}
                onClick={analyse}
                disabled={loading || !rooms.trim()}>
                {loading ? "◌  Analysing…" : "▶  Run Analysis"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RESULTS */}
      {page === "result" && result && (
        <div style={S.page}>

          <div style={S.summary}>
            <div>
              <div style={S.sLabel}>TOTAL CARPET</div>
              <div style={S.sBig}>{result.totalAreaM2}<span style={{ fontSize: 18, fontWeight: 400 }}> m²</span></div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={S.sLabel}>ROOMS</div>
              <div style={{ ...S.sBig, color: "#a8dadc" }}>{result.rooms.length}</div>
            </div>
            <div>
              <div style={S.sLabel}>SCALE</div>
              <div style={{ fontSize: 12, color: "#304a4a", marginTop: 4 }}>{result.scale?.ratio || "—"}</div>
            </div>
          </div>

          <div style={S.tabRow}>
            {[["plan", "Floor Plan"], ["table", "Measurements"], ["info", "Details"]].map(([k, l]) => (
              <button key={k} style={{ ...S.tabBtn, ...(tab === k ? S.tabOn : {}) }} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {tab === "plan" && (
            <div>
              <PlanSVG rooms={result.rooms} hover={hover} setHover={setHover} />
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {result.rooms.map((r, i) => {
                  const c = PALETTE[i % PALETTE.length];
                  return (
                    <div key={i}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: hover === i ? "#111128" : "#0a0a18", border: `1px solid ${hover === i ? c.border : "#12123a"}`, cursor: "pointer", transition: "all 0.15s" }}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                      <span style={{ width: 13, height: 13, borderRadius: 3, background: c.accent, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: c.text }}>{r.name}</span>
                      <span style={{ fontSize: 12, color: "#404070" }}>{r.widthM} × {r.lengthM}m</span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: c.accent, minWidth: 60, textAlign: "right" }}>
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
                    <div key={h} style={{ padding: "10px 10px", fontSize: 9, letterSpacing: 2, color: "#252555", textAlign: i > 0 ? "right" : "left" }}>{h}</div>
                  ))}
                </div>
                {result.rooms.map((r, i) => {
                  const c = PALETTE[i % PALETTE.length];
                  const sc = r.dimensionSource === "scaled";
                  return (
                    <div key={i}
                      style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.2fr 1fr", borderBottom: "1px solid #0a0a1a", background: hover === i ? "#141430" : i % 2 === 0 ? "#080818" : "#0b0b1e", cursor: "pointer", transition: "background 0.1s" }}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                      <div style={{ padding: "11px 10px", fontSize: 14, display: "flex", alignItems: "center", gap: 8, color: c.text }}>
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: c.accent, flexShrink: 0 }} />
                        {r.name}
                      </div>
                      <div style={S.td}>{sc ? "~" : ""}{r.widthM}m</div>
                      <div style={S.td}>{sc ? "~" : ""}{r.lengthM}m</div>
                      <div style={{ ...S.td, fontWeight: 700, color: c.accent }}>{(r.widthM * r.lengthM).toFixed(2)}</div>
                      <div style={{ ...S.td, paddingRight: 12 }}>
                        <span style={{ fontSize: 8, padding: "2px 6px", borderRadius: 4, background: sc ? "#160e00" : "#060e06", color: sc ? "#FFD700" : "#4CAF50", border: `1px solid ${sc ? "#302000" : "#103010"}` }}>
                          {sc ? "scaled" : "labelled"}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 14px", background: "#0a0a1e", borderTop: "2px solid #181848" }}>
                  <div style={{ fontSize: 9, letterSpacing: 3, color: "#303068", fontWeight: 700 }}>TOTAL CARPET AREA</div>
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

function Crumb({ n, done, active, label }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <div style={{ width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: done ? "#4CAF50" : active ? "#081808" : "#080810", border: `2px solid ${done ? "#4CAF50" : active ? "#4CAF50" : "#14143a"}`, color: done ? "#000" : active ? "#4CAF50" : "#202050" }}>
        {done ? "✓" : n}
      </div>
      <div style={{ fontSize: 8, letterSpacing: 1, color: active ? "#4CAF50" : "#141440" }}>{label}</div>
    </div>
  );
}

function PlanSVG({ rooms, hover, setHover }) {
  const W = 400, H = 320, P = 20, aW = W - P * 2, aH = H - P * 2;
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
          const py = Math.min(0.78, Math.max(0.02, room.position?.y ?? (0.08 + Math.floor(i / 3) * 0.44)));
          const pw = Math.min(0.48, Math.max(0.14, room.size?.w ?? 0.28));
          const ph = Math.min(0.45, Math.max(0.12, room.size?.h ?? 0.26));
          const rx = P + px * aW, ry = P + py * aH, rw = pw * aW, rh = ph * aH;
          const sc = room.dimensionSource === "scaled";
          return (
            <g key={i} style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {on && <rect x={rx + 4} y={ry + 4} width={rw} height={rh} fill={c.accent} opacity="0.15" rx="5" />}
              <rect x={rx} y={ry} width={rw} height={rh} fill={c.bg} opacity={on ? 1 : 0.82} stroke={on ? c.accent : c.border} strokeWidth={on ? 2.5 : 1.5} rx="4" />
              <rect x={rx + 2} y={ry + 2} width={rw - 4} height={4} fill={c.accent} opacity="0.5" rx="2" />
              <text x={rx + rw / 2} y={ry + rh / 2 - 10} textAnchor="middle" fill={c.text} style={{ fontSize: Math.min(12, rw / 5.5), fontWeight: 700, fontFamily: "sans-serif" }}>{room.name}</text>
              <text x={rx + rw / 2} y={ry + rh / 2 + 4} textAnchor="middle" fill={c.text} opacity="0.7" style={{ fontSize: Math.min(10, rw / 7), fontFamily: "monospace" }}>
                {sc ? "~" : ""}{room.widthM} × {sc ? "~" : ""}{room.lengthM}m
              </text>
              <text x={rx + rw / 2} y={ry + rh / 2 + 18} textAnchor="middle" fill={c.accent} style={{ fontSize: Math.min(11, rw / 6.5), fontWeight: 700, fontFamily: "monospace" }}>
                {(room.widthM * room.lengthM).toFixed(2)}m²
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const S = {
  shell:  { minHeight: "100vh", background: "#020208", color: "#e0e0f0", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display: "flex", flexDirection: "column" },
  bar:    { display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", background: "#040410", borderBottom: "1px solid #0e0e38", flexWrap: "wrap" },
  brand:  { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" },
  bname:  { fontSize: 16, fontWeight: 900, letterSpacing: 3 },
  bsub:   { fontSize: 8, color: "#181840", letterSpacing: 2 },
  crumbs: { display: "flex", alignItems: "center", gap: 6, marginLeft: 12 },
  cline:  { width: 20, height: 1, background: "#0e0e38" },
  newBtn: { marginLeft: "auto", background: "#4CAF50", color: "#000", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  page:   { flex: 1, padding: "24px 20px", maxWidth: 720, margin: "0 auto", width: "100%", boxSizing: "border-box" },
  h1:     { fontSize: 24, fontWeight: 800, color: "#b0b0d0", textAlign: "center", marginBottom: 10 },
  h2:     { fontSize: 13, color: "#1c1c48", textAlign: "center", marginBottom: 30, lineHeight: 1.6 },
  uploadBox: { background: "#040410", border: "2px dashed #141440", borderRadius: 16, padding: "32px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 },
  bigBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 14, background: "#081408", border: "2px solid #204820", borderRadius: 14, padding: "18px 32px", cursor: "pointer", width: "100%", maxWidth: 320, boxSizing: "border-box" },
  bLabel: { fontSize: 18, fontWeight: 700, color: "#4CAF50", letterSpacing: 1 },
  gone:   { position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" },
  orRow:  { display: "flex", alignItems: "center", gap: 12, width: "100%", maxWidth: 320 },
  orLine: { flex: 1, height: 1, background: "#0e0e38" },
  orTxt:  { fontSize: 9, color: "#141440", letterSpacing: 2 },
  pill:   { marginTop: 12, background: "#060e06", border: "1px solid #183018", borderRadius: 10, padding: "12px 18px", fontSize: 13, color: "#4CAF50", textAlign: "center" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" },
  card:   { background: "#040410", border: "1px solid #0e0e38", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 },
  ctitle: { fontSize: 9, letterSpacing: 3, color: "#4CAF50", fontWeight: 700 },
  planImg: { width: "100%", borderRadius: 10, display: "block" },
  meta:   { fontSize: 9, color: "#141440", textAlign: "center" },
  smBtn:  { background: "transparent", border: "1px solid #141440", color: "#202050", borderRadius: 7, padding: "6px 10px", fontSize: 11, cursor: "pointer" },
  ta:     { background: "#020208", border: "1px solid #14143a", borderRadius: 10, color: "#c0c0e0", padding: "13px", fontSize: 14, resize: "vertical", outline: "none", fontFamily: "inherit", lineHeight: 1.6 },
  runBtn: { background: "#4CAF50", color: "#000", border: "none", borderRadius: 12, padding: "16px", fontSize: 15, fontWeight: 800, cursor: "pointer", width: "100%", letterSpacing: 1 },
  runOff: { opacity: 0.3, cursor: "not-allowed" },
  summary: { display: "flex", gap: 20, padding: "16px 18px", background: "#040410", borderRadius: 14, marginBottom: 18, alignItems: "center", flexWrap: "wrap", border: "1px solid #0e0e38" },
  sLabel: { fontSize: 8, letterSpacing: 3, color: "#1a1a50", marginBottom: 2 },
  sBig:   { fontSize: 32, fontWeight: 900, color: "#4CAF50" },
  tabRow: { display: "flex", borderBottom: "2px solid #0c0c30", marginBottom: 18 },
  tabBtn: { flex: 1, padding: "11px 4px", background: "transparent", border: "none", color: "#1a1a48", fontSize: 12, fontWeight: 700, cursor: "pointer", letterSpacing: 1, borderBottom: "2px solid transparent", marginBottom: -2 },
  tabOn:  { color: "#4CAF50", borderBottom: "2px solid #4CAF50" },
  td:     { padding: "11px 10px", fontSize: 14, textAlign: "right", color: "#505090" },
  iHead:  { fontSize: 9, letterSpacing: 3, color: "#4CAF50", fontWeight: 700, marginBottom: 6 },
  logLine: { fontSize: 10, color: "#3a1a1a", wordBreak: "break-all", marginTop: 3, lineHeight: 1.4 },
};
