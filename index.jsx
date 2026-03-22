import { useState, useCallback, useRef, useEffect } from "react";

// ── Palette ────────────────────────────────────────────────────────────────────
const C = {
  bg:        "#f2f4f7",
  surface:   "#ffffff",
  surface2:  "#eef0f4",
  border:    "#dde1ea",
  border2:   "#c6ccd8",
  text:      "#1c2133",
  textMid:   "#526080",
  textMute:  "#8e9ab0",
  blue:      "#6495ed",
  blueDark:  "#4a7ad8",
  blueLight: "#dce8fb",
  blueMid:   "#a8c2f5",
  red:       "#e05555",
  green:     "#3fa876",
};

const TAG_PALETTE = [
  { bg: "#dce8fb", text: "#3464c8", border: "#a8c2f5" },
  { bg: "#fde8d6", text: "#c05020", border: "#f4b080" },
  { bg: "#d8f5ea", text: "#1e7a50", border: "#80d4aa" },
  { bg: "#f0dafc", text: "#8030b8", border: "#cca0ec" },
  { bg: "#fef4c8", text: "#9a6e00", border: "#f0cc60" },
  { bg: "#fbd8e8", text: "#c02858", border: "#f4a0c0" },
  { bg: "#d8f2fc", text: "#1878a8", border: "#80ccec" },
  { bg: "#e8fcd8", text: "#3c7a18", border: "#a0e880" },
];
function tagStyle(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

// ── Lookup lists ───────────────────────────────────────────────────────────────
const ProgramNames = ["Program A", "Program B", "Program C", "Program D"];

// ── ID & hashing ───────────────────────────────────────────────────────────────
const uid = () => crypto.randomUUID();

// ── Layer 1: SHA-256 of raw file bytes ────────────────────────────────────────
// Exact duplicate check — identical files always produce identical hashes
// regardless of filename, date, or origin. Fast: ~1-5ms per image.
async function computeContentHash(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Layer 2: Perceptual Hash (dHash 8x8) ─────────────────────────────────────
// Near-duplicate check — catches resized, re-compressed, re-exported versions
// of the same image. Shrinks image to 9x8 greyscale via canvas, then computes
// a 64-bit difference hash by comparing adjacent pixel brightness.
// Two images are near-duplicates if their Hamming distance <= PHASH_THRESHOLD.
const PHASH_THRESHOLD = 8; // bits different out of 64 (0=identical, ~10=similar)

async function computePHash(file) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        // Draw at 9×8 — we need 9 columns to produce 8 column-difference bits
        const canvas = document.createElement("canvas");
        canvas.width = 9; canvas.height = 8;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 9, 8);
        const { data } = ctx.getImageData(0, 0, 9, 8); // RGBA

        // Convert to greyscale using luminance weights
        const grey = [];
        for (let i = 0; i < 9 * 8; i++) {
          const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
          grey.push(0.299*r + 0.587*g + 0.114*b);
        }

        // Build 64-bit hash: for each row, compare each pixel to its right neighbour
        let hash = "";
        for (let row = 0; row < 8; row++) {
          for (let col = 0; col < 8; col++) {
            hash += grey[row*9 + col] > grey[row*9 + col + 1] ? "1" : "0";
          }
        }
        URL.revokeObjectURL(url);
        resolve(hash); // 64-char binary string
      } catch(e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("pHash load failed")); };
    img.src = url;
  });
}

// Hamming distance between two 64-char binary strings
function hammingDistance(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return dist;
}

// ── Metadata extraction ────────────────────────────────────────────────────────
function extractMetadata(file) {
  return new Promise((resolve) => {
    const meta = {
      name: file.name, size: file.size, type: file.type,
      lastModified: new Date(file.lastModified).toISOString(),
      sizeFormatted: file.size > 1024 * 1024
        ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
        : `${(file.size / 1024).toFixed(1)} KB`,
    };
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      meta.width = img.naturalWidth; meta.height = img.naturalHeight;
      meta.aspectRatio = (img.naturalWidth / img.naturalHeight).toFixed(3);
      meta.orientation = img.naturalWidth > img.naturalHeight ? "landscape"
        : img.naturalWidth < img.naturalHeight ? "portrait" : "square";
      meta.megapixels = ((img.naturalWidth * img.naturalHeight) / 1_000_000).toFixed(2);
      URL.revokeObjectURL(url); resolve(meta);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(meta); };
    img.src = url;
  });
}

// ── Storage (key-value) ────────────────────────────────────────────────────────
async function savePhoto(photo) {
  try {
    const idx = await loadIndex();
    idx[photo.id] = {
      id: photo.id, meta: photo.meta, tags: photo.tags,
      comment: photo.comment, program: photo.program, uploadedAt: photo.uploadedAt,
    };
    await window.storage.set("pv:index", JSON.stringify(idx));
    await window.storage.set(`pv:img:${photo.id}`, photo.dataUrl);
  } catch(e) { console.error(e); }
}

async function loadIndex() {
  try { const r = await window.storage.get("pv:index"); return r ? JSON.parse(r.value) : {}; }
  catch { return {}; }
}

async function loadAllPhotos() {
  const idx = await loadIndex();
  const out = [];
  for (const id of Object.keys(idx)) {
    try {
      const r = await window.storage.get(`pv:img:${id}`);
      if (r) out.push({ ...idx[id], dataUrl: r.value });
    } catch {}
  }
  return out.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

async function deletePhoto(id) {
  try {
    const idx = await loadIndex(); delete idx[id];
    await window.storage.set("pv:index", JSON.stringify(idx));
    await window.storage.delete(`pv:img:${id}`);
  } catch(e) { console.error(e); }
}

async function updatePhoto(id, updates) {
  try {
    const idx = await loadIndex();
    if (idx[id]) { idx[id] = { ...idx[id], ...updates }; await window.storage.set("pv:index", JSON.stringify(idx)); }
  } catch(e) { console.error(e); }
}

// Returns { duplicate: bool, reason: string, matchName: string|null }
// Layer 1: exact SHA-256 content match
// Layer 2: perceptual hash near-match (only if layer 1 passes)
async function checkDuplicate(contentHash, pHash) {
  const idx = await loadIndex();
  const existing = Object.values(idx);

  // Layer 1 — exact content match (instant)
  const exactMatch = existing.find(p => p.meta?.contentHash === contentHash);
  if (exactMatch) {
    return { duplicate: true, reason: "exact", matchName: exactMatch.meta.originalName };
  }

  // Layer 2 — perceptual near-duplicate (compare against all stored pHashes)
  for (const p of existing) {
    if (!p.meta?.pHash) continue;
    const dist = hammingDistance(pHash, p.meta.pHash);
    if (dist <= PHASH_THRESHOLD) {
      return { duplicate: true, reason: "near", matchName: p.meta.originalName, distance: dist };
    }
  }

  return { duplicate: false };
}

// ── TagPill ────────────────────────────────────────────────────────────────────
function TagPill({ tag, onRemove, small }) {
  const s = tagStyle(tag);
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:3, background:s.bg, color:s.text, border:`1px solid ${s.border}`, borderRadius:20, padding:small?"1px 8px":"3px 10px", fontSize:small?11:12, fontFamily:"'Plus Jakarta Sans',sans-serif", fontWeight:500, whiteSpace:"nowrap" }}>
      {tag}
      {onRemove && (
        <button onClick={()=>onRemove(tag)} style={{ background:"none", border:"none", color:s.text, cursor:"pointer", padding:0, fontSize:14, lineHeight:1, opacity:0.55, marginLeft:1 }}>×</button>
      )}
    </span>
  );
}

function TagInput({ tags, onChange }) {
  const [val, setVal] = useState("");
  const add = () => {
    const t = val.trim().toLowerCase().replace(/\s+/g, "-");
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setVal("");
  };
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:5, alignItems:"center" }}>
      {tags.map(t => <TagPill key={t} tag={t} onRemove={r => onChange(tags.filter(x => x !== r))} />)}
      <input value={val} onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
        placeholder="add tag…"
        style={{ background:"transparent", border:"none", outline:"none", color:C.text, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13, width:90, padding:"2px 0" }}
      />
    </div>
  );
}

// ── Upload Modal ───────────────────────────────────────────────────────────────
function UploadModal({ onUpload, onClose }) {
  const [files, setFiles]           = useState([]);
  const [previews, setPreviews]     = useState([]);
  const [tags, setTags]             = useState([]);
  const [comment, setComment]       = useState("");
  const [program, setProgram]       = useState("");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress]     = useState(0);
  const [statusMsg, setStatusMsg]   = useState("");
  const [dragOver, setDragOver]     = useState(false);
  const [duplicates, setDuplicates] = useState([]);

  const handleFiles = fl => {
    const arr = Array.from(fl).filter(f => f.type.startsWith("image/"));
    setFiles(arr); setPreviews(arr.map(f => URL.createObjectURL(f)));
    setDuplicates([]);
  };

  const upload = async () => {
    if (!files.length) return;
    setProcessing(true); setDuplicates([]);
    const results = [], skipped = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setProgress(Math.round(((i + 0.3) / files.length) * 100));

      // ── Layer 1: SHA-256 exact content hash
      setStatusMsg(`Hashing ${f.name}…`);
      const contentHash = await computeContentHash(f);

      // ── Layer 2: perceptual hash
      setStatusMsg(`Fingerprinting ${f.name}…`);
      let pHash = null;
      try { pHash = await computePHash(f); } catch(e) { console.warn("pHash failed:", e); }

      // ── Duplicate check (both layers)
      setStatusMsg(`Checking ${f.name} for duplicates…`);
      const dupeResult = await checkDuplicate(contentHash, pHash || "");
      if (dupeResult.duplicate) {
        const reason = dupeResult.reason === "exact"
          ? `exact duplicate of "${dupeResult.matchName}"`
          : `near-duplicate of "${dupeResult.matchName}" (${dupeResult.distance} bits different)`;
        skipped.push({ name: f.name, reason });
        setProgress(Math.round(((i + 1) / files.length) * 100));
        continue;
      }

      setStatusMsg(`Processing ${f.name}…`);
      const meta    = await extractMetadata(f);
      const photoId = uid();
      const ext     = f.name.split(".").pop().toLowerCase();

      meta.originalName   = f.name;
      meta.storedFilename = `${photoId}.${ext}`;
      meta.contentHash    = contentHash;
      meta.pHash          = pHash;

      const dataUrl = await new Promise(res => {
        const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(f);
      });

      const photo = { id:photoId, meta, tags:[...tags], comment, program, dataUrl, uploadedAt:new Date().toISOString() };
      setStatusMsg(`Saving ${f.name}…`);
      await savePhoto(photo);
      results.push(photo);
      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    previews.forEach(URL.revokeObjectURL);
    if (skipped.length) setDuplicates(skipped);
    setProcessing(false); setStatusMsg("");
    if (results.length) onUpload(results);
  };

  const FieldLabel = ({ label }) => (
    <label style={{ display:"block", color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, fontWeight:700, marginBottom:6, letterSpacing:"0.07em", textTransform:"uppercase" }}>{label}</label>
  );

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(28,33,51,0.32)", backdropFilter:"blur(6px)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:C.surface, borderRadius:16, border:`1px solid ${C.border}`, width:560, maxWidth:"95vw", maxHeight:"90vh", overflowY:"auto", boxShadow:"0 20px 60px rgba(28,33,80,0.16)", padding:32 }}>

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
          <h2 style={{ margin:0, fontFamily:"'Plus Jakarta Sans',sans-serif", color:C.text, fontSize:22, fontWeight:700 }}>Ingest Images</h2>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.textMute, cursor:"pointer", fontSize:22 }}>×</button>
        </div>

        {/* Drop zone */}
        <div
          onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => document.getElementById("pvFileInput").click()}
          style={{ border:`2px dashed ${dragOver ? C.blue : C.border2}`, borderRadius:10, padding:"28px 20px", textAlign:"center", cursor:"pointer", background:dragOver ? C.blueLight : C.surface2, transition:"all 0.2s", marginBottom:20 }}>
          <input id="pvFileInput" type="file" multiple accept="image/*" style={{ display:"none" }} onChange={e => handleFiles(e.target.files)} />
          {files.length === 0 ? (
            <>
              <div style={{ width:44, height:44, borderRadius:12, background:C.blueLight, margin:"0 auto 12px", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <span style={{ color:C.blue, fontSize:20 }}>↑</span>
              </div>
              <div style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:14 }}>
                Drop images here or <span style={{ color:C.blue, fontWeight:600 }}>click to browse</span>
              </div>
              <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, marginTop:4 }}>JPG · PNG · GIF · WEBP</div>
            </>
          ) : (
            <>
              <div style={{ display:"flex", flexWrap:"wrap", gap:8, justifyContent:"center", marginBottom:10 }}>
                {previews.map((u, i) => <img key={i} src={u} alt="" style={{ width:68, height:68, objectFit:"cover", borderRadius:6, border:`1px solid ${C.border}` }} />)}
              </div>
              <div style={{ color:C.blue, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600 }}>
                {files.length} image{files.length !== 1 ? "s" : ""} selected — click to change
              </div>
            </>
          )}
        </div>

        {/* Program */}
        <div style={{ marginBottom:16 }}>
          <FieldLabel label="Program Name" />
          <div style={{ position:"relative" }}>
            <select value={program} onChange={e => setProgram(e.target.value)}
              style={{ width:"100%", appearance:"none", WebkitAppearance:"none", background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 36px 10px 12px", color:program ? C.text : C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13, outline:"none", cursor:"pointer", transition:"all 0.2s" }}>
              <option value="">— Select a program —</option>
              {ProgramNames.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <span style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", color:C.textMute, fontSize:11, pointerEvents:"none" }}>▾</span>
          </div>
        </div>

        {/* Tags */}
        <div style={{ marginBottom:16 }}>
          <FieldLabel label="Tags" />
          <div style={{ background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 12px", minHeight:46 }}>
            <TagInput tags={tags} onChange={setTags} />
          </div>
        </div>

        {/* Comment */}
        <div style={{ marginBottom:24 }}>
          <FieldLabel label="Comment" />
          <textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="Describe these images…" rows={3}
            style={{ width:"100%", boxSizing:"border-box", background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 12px", color:C.text, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13, resize:"vertical", outline:"none", transition:"all 0.2s" }}
          />
        </div>

        {/* Duplicate warning */}
        {duplicates.length > 0 && (
          <div style={{ background:"#fff8e6", border:"1px solid #f0d080", borderRadius:8, padding:"10px 14px", marginBottom:16, display:"flex", gap:10, alignItems:"flex-start" }}>
            <span style={{ fontSize:16, flexShrink:0 }}>⚠</span>
            <div>
              <div style={{ color:"#7a5800", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:700, marginBottom:3 }}>
                {duplicates.length} duplicate{duplicates.length !== 1 ? "s" : ""} skipped
              </div>
              <div style={{ color:"#9a7200", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11 }}>{duplicates.join(", ")}</div>
            </div>
          </div>
        )}

        {processing ? (
          <div>
            <div style={{ background:C.surface2, borderRadius:8, height:6, marginBottom:8, overflow:"hidden" }}>
              <div style={{ width:`${progress}%`, height:"100%", background:C.blue, borderRadius:8, transition:"width 0.3s" }} />
            </div>
            <div style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, textAlign:"center" }}>
              {statusMsg || `${progress}%…`}
            </div>
          </div>
        ) : (
          <button onClick={upload} disabled={!files.length} style={{ width:"100%", padding:"13px 0", background:files.length ? C.blue : C.surface2, color:files.length ? "#fff" : C.textMute, border:"none", borderRadius:8, cursor:files.length ? "pointer" : "default", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:14, fontWeight:600, transition:"background 0.2s", boxShadow:files.length ? `0 2px 12px rgba(100,149,237,0.4)` : "none" }}>
            {files.length ? `Ingest ${files.length} Image${files.length !== 1 ? "s" : ""}` : "Select Images to Continue"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Photo Detail ───────────────────────────────────────────────────────────────
function PhotoDetail({ photo, onClose, onUpdate, onDelete }) {
  const [tags, setTags]       = useState(photo.tags);
  const [comment, setComment] = useState(photo.comment);
  const [program, setProgram] = useState(photo.program || "");
  const [saved, setSaved]     = useState(false);

  const save = async () => {
    await updatePhoto(photo.id, { tags, comment, program });
    onUpdate(photo.id, { tags, comment, program });
    setSaved(true); setTimeout(() => setSaved(false), 1800);
  };

  const m = photo.meta;
  const fields = [
    ["Original name",  m.originalName || m.name],
    ["Stored as",      m.storedFilename || "—"],
    ["Record UUID",    photo.id],
    ["Ingest hash",    m.ingestHash ? m.ingestHash.slice(0, 16) + "…" : "—"],
    ["File size",      m.sizeFormatted],
    ["Type",           m.type || "—"],
    ["Dimensions",     m.width ? `${m.width} × ${m.height} px` : "—"],
    ["Megapixels",     m.megapixels ? `${m.megapixels} MP` : "—"],
    ["Orientation",    m.orientation || "—"],
    ["Aspect ratio",   m.aspectRatio || "—"],
    ["Modified",       m.lastModified ? new Date(m.lastModified).toLocaleDateString() : "—"],
    ["Ingested",       new Date(photo.uploadedAt).toLocaleString()],
  ];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(28,33,51,0.38)", backdropFilter:"blur(8px)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ display:"flex", width:"min(1060px,95vw)", height:"min(680px,92vh)", borderRadius:16, overflow:"hidden", border:`1px solid ${C.border}`, boxShadow:"0 28px 72px rgba(28,40,80,0.2)" }}>

        {/* Image pane */}
        <div style={{ flex:1, background:C.surface2, display:"flex", alignItems:"center", justifyContent:"center" }}>
          <img src={photo.dataUrl} alt={m.originalName || m.name} style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain" }} />
        </div>

        {/* Meta pane */}
        <div style={{ width:300, background:C.surface, display:"flex", flexDirection:"column", borderLeft:`1px solid ${C.border}` }}>
          <div style={{ padding:"18px 20px 0", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <h3 style={{ margin:0, fontFamily:"'Plus Jakarta Sans',sans-serif", color:C.text, fontSize:15, fontWeight:600, wordBreak:"break-all", lineHeight:1.4 }}>
              {m.originalName || m.name}
            </h3>
            <button onClick={onClose} style={{ background:"none", border:"none", color:C.textMute, cursor:"pointer", fontSize:20, flexShrink:0, marginLeft:8 }}>×</button>
          </div>

          <div style={{ padding:"14px 20px", overflowY:"auto", flex:1 }}>

            <div style={{ background:C.surface2, borderRadius:8, padding:"12px 14px", marginBottom:14 }}>
              <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10 }}>Metadata</div>
              {fields.map(([k, v]) => (
                <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:5, gap:8 }}>
                  <span style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, flexShrink:0 }}>{k}</span>
                  <span style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, textAlign:"right", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:160 }} title={v}>{v}</span>
                </div>
              ))}
            </div>

            {/* Program */}
            <div style={{ marginBottom:14 }}>
              <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:7 }}>Program Name</div>
              <div style={{ position:"relative" }}>
                <select value={program} onChange={e => setProgram(e.target.value)}
                  style={{ width:"100%", appearance:"none", WebkitAppearance:"none", background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 30px 8px 10px", color:program ? C.text : C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, outline:"none", cursor:"pointer" }}>
                  <option value="">— None —</option>
                  {ProgramNames.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <span style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", color:C.textMute, fontSize:11, pointerEvents:"none" }}>▾</span>
              </div>
            </div>

            {/* Tags */}
            <div style={{ marginBottom:14 }}>
              <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:7 }}>Tags</div>
              <div style={{ background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px", minHeight:40 }}>
                <TagInput tags={tags} onChange={setTags} />
              </div>
            </div>

            {/* Comment */}
            <div style={{ marginBottom:16 }}>
              <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:7 }}>Comment</div>
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3}
                style={{ width:"100%", boxSizing:"border-box", background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px", color:C.text, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, resize:"none", outline:"none" }}
              />
            </div>

            <div style={{ display:"flex", gap:8 }}>
              <button onClick={save} style={{ flex:1, padding:"9px 0", background:saved ? C.green : C.blue, color:"#fff", border:"none", borderRadius:7, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600, transition:"background 0.3s" }}>
                {saved ? "✓ Saved" : "Save Changes"}
              </button>
              <button onClick={() => { onDelete(photo.id); onClose(); }} style={{ padding:"9px 12px", background:"#fff", color:C.red, border:`1px solid #f0c8c8`, borderRadius:7, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:500 }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Photo Card ─────────────────────────────────────────────────────────────────
function PhotoCard({ photo, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background:C.surface, borderRadius:10, border:`1px solid ${hover ? C.blueMid : C.border}`, overflow:"hidden", cursor:"pointer", transition:"all 0.18s", transform:hover ? "translateY(-3px)" : "none", boxShadow:hover ? `0 10px 30px rgba(100,149,237,0.18)` : `0 1px 4px rgba(28,40,80,0.06)` }}>
      <div style={{ position:"relative", paddingTop:"66%", background:C.surface2 }}>
        <img src={photo.dataUrl} alt={photo.meta.originalName || photo.meta.name} style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }} />
        {hover && (
          <div style={{ position:"absolute", inset:0, background:"rgba(100,149,237,0.14)", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ background:C.blue, color:"#fff", borderRadius:6, padding:"5px 16px", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600 }}>View</span>
          </div>
        )}
        {photo.meta.width && (
          <div style={{ position:"absolute", top:6, right:6, background:"rgba(255,255,255,0.9)", borderRadius:4, padding:"2px 7px" }}>
            <span style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10 }}>{photo.meta.width}×{photo.meta.height}</span>
          </div>
        )}
      </div>
      <div style={{ padding:"10px 12px" }}>
        <div style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:photo.program ? 3 : 6 }}>
          {photo.meta.originalName || photo.meta.name}
        </div>
        {photo.program && (
          <div style={{ display:"inline-flex", alignItems:"center", background:C.blueLight, color:C.blue, borderRadius:5, padding:"1px 8px", fontSize:11, fontFamily:"'Plus Jakarta Sans',sans-serif", fontWeight:600, marginBottom:6 }}>
            {photo.program}
          </div>
        )}
        <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:photo.comment ? 5 : 0 }}>
          {photo.tags.slice(0, 4).map(t => <TagPill key={t} tag={t} small />)}
          {photo.tags.length > 4 && <span style={{ color:C.textMute, fontSize:10, fontFamily:"'Plus Jakarta Sans',sans-serif", alignSelf:"center" }}>+{photo.tags.length - 4}</span>}
        </div>
        {photo.comment && (
          <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{photo.comment}</div>
        )}
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function PhotoVault() {
  const [photos, setPhotos]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [selected, setSelected]     = useState(null);
  const [query, setQuery]           = useState("");
  const [sortBy, setSortBy]         = useState("date");
  const [filterTag, setFilterTag]   = useState(null);

  useEffect(() => { loadAllPhotos().then(p => { setPhotos(p); setLoading(false); }); }, []);

  const allTags = [...new Set(photos.flatMap(p => p.tags))].sort();

  const filtered = photos.filter(p => {
    const q = query.toLowerCase();
    const tagMatch = filterTag ? p.tags.includes(filterTag) : true;
    const searchMatch = q
      ? p.tags.some(t => t.includes(q))
        || (p.comment && p.comment.toLowerCase().includes(q))
        || (p.meta.originalName || p.meta.name).toLowerCase().includes(q)
        || (p.program && p.program.toLowerCase().includes(q))
      : true;
    return tagMatch && searchMatch;
  });

  const sorted = [...filtered].sort((a, b) =>
    sortBy === "date" ? new Date(b.uploadedAt) - new Date(a.uploadedAt)
    : sortBy === "name" ? (a.meta.originalName||a.meta.name).localeCompare(b.meta.originalName||b.meta.name)
    : b.meta.size - a.meta.size
  );

  const onUpload = newPhotos => { setPhotos(p => [...newPhotos, ...p]); setShowUpload(false); };
  const onUpdate = (id, updates) => setPhotos(p => p.map(x => x.id === id ? { ...x, ...updates } : x));
  const onDelete = async id => { await deletePhoto(id); setPhotos(p => p.filter(x => x.id !== id)); };
  const selectedPhoto = selected ? photos.find(p => p.id === selected) : null;

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        body { background:${C.bg}; }
        ::-webkit-scrollbar { width:5px; background:${C.bg}; }
        ::-webkit-scrollbar-thumb { background:${C.border2}; border-radius:4px; }
        input,textarea,select { font-family:'Plus Jakarta Sans',sans-serif !important; }
        textarea:focus, input:focus { border-color:${C.blue} !important; box-shadow:0 0 0 3px ${C.blueLight} !important; outline:none !important; }
      `}</style>

      {/* Header */}
      <header style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"13px 28px", display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:10, boxShadow:"0 1px 6px rgba(28,40,80,0.07)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:9 }}>
            <div style={{ width:32, height:32, borderRadius:8, background:C.blue, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 2px 8px rgba(100,149,237,0.4)` }}>
              <span style={{ color:"#fff", fontSize:17, lineHeight:1 }}>◫</span>
            </div>
            <span style={{ fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:20, fontWeight:800, color:C.text, letterSpacing:"-0.02em" }}>PhotoVault</span>
          </div>
          <span style={{ width:1, height:18, background:C.border2, display:"inline-block" }} />
          <span style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13 }}>
            {photos.length} image{photos.length !== 1 ? "s" : ""} stored
          </span>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ position:"relative" }}>
            <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textMute, fontSize:15 }}>⌕</span>
            <input value={query} onChange={e => { setQuery(e.target.value); setFilterTag(null); }} placeholder="Search tags, comments, filenames…"
              style={{ background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 12px 8px 32px", color:C.text, fontSize:13, outline:"none", width:290, transition:"all 0.2s" }}
            />
          </div>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px", color:C.textMid, fontSize:12, outline:"none", cursor:"pointer" }}>
            <option value="date">Date</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
          </select>
          <button onClick={() => setShowUpload(true)} style={{ background:C.blue, color:"#fff", border:"none", borderRadius:8, padding:"9px 20px", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13, fontWeight:600, cursor:"pointer", boxShadow:`0 2px 8px rgba(100,149,237,0.4)`, letterSpacing:"0.01em" }}>
            + Ingest
          </button>
        </div>
      </header>

      <div style={{ display:"flex" }}>
        {/* Sidebar */}
        <aside style={{ width:210, borderRight:`1px solid ${C.border}`, padding:"18px 12px", flexShrink:0, position:"sticky", top:57, alignSelf:"flex-start", height:"calc(100vh - 57px)", overflowY:"auto", background:C.surface }}>
          <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10, paddingLeft:8 }}>Browse by Tag</div>

          <button onClick={() => { setFilterTag(null); setQuery(""); }} style={{ display:"block", width:"100%", textAlign:"left", background:!filterTag&&!query ? C.blueLight : "transparent", border:"none", borderRadius:7, padding:"7px 10px", color:!filterTag&&!query ? C.blue : C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13, fontWeight:!filterTag&&!query ? 600 : 400, cursor:"pointer", marginBottom:2 }}>
            All images
            <span style={{ float:"right", color:C.textMute, fontSize:11, fontWeight:400 }}>{photos.length}</span>
          </button>

          {allTags.map(t => {
            const count = photos.filter(p => p.tags.includes(t)).length;
            const s = tagStyle(t); const active = filterTag === t;
            return (
              <button key={t} onClick={() => { setFilterTag(t); setQuery(""); }} style={{ display:"block", width:"100%", textAlign:"left", background:active ? s.bg : "transparent", border:"none", borderRadius:7, padding:"6px 10px", color:active ? s.text : C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13, fontWeight:active ? 600 : 400, cursor:"pointer", marginBottom:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                <span style={{ marginRight:6, color:s.text, fontSize:8 }}>●</span>{t}
                <span style={{ float:"right", color:C.textMute, fontSize:11, fontWeight:400 }}>{count}</span>
              </button>
            );
          })}

          {allTags.length === 0 && (
            <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, paddingLeft:8, marginTop:6 }}>No tags yet</div>
          )}
        </aside>

        {/* Grid */}
        <main style={{ flex:1, padding:24 }}>
          {loading ? (
            <div style={{ textAlign:"center", paddingTop:80, color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:14 }}>Loading vault…</div>
          ) : sorted.length === 0 ? (
            <div style={{ textAlign:"center", paddingTop:80 }}>
              {photos.length === 0 ? (
                <>
                  <div style={{ width:72, height:72, borderRadius:16, background:C.blueLight, margin:"0 auto 20px", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <span style={{ fontSize:30, color:C.blue }}>◫</span>
                  </div>
                  <div style={{ fontFamily:"'Plus Jakarta Sans',sans-serif", color:C.text, fontSize:22, fontWeight:700, marginBottom:8 }}>Your vault is empty</div>
                  <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:14, marginBottom:24, maxWidth:360, margin:"0 auto 24px" }}>
                    Ingest images to build a queryable archive — browse by tag, program, or keyword.
                  </div>
                  <button onClick={() => setShowUpload(true)} style={{ background:C.blue, color:"#fff", border:"none", borderRadius:8, padding:"11px 26px", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:14, fontWeight:600, cursor:"pointer", boxShadow:`0 4px 16px rgba(100,149,237,0.4)` }}>
                    + Ingest First Images
                  </button>
                </>
              ) : (
                <div>
                  <div style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:14, marginBottom:12 }}>
                    No results for <strong style={{ color:C.blue }}>{query || filterTag}</strong>
                  </div>
                  <button onClick={() => { setQuery(""); setFilterTag(null); }} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"7px 16px", color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, cursor:"pointer" }}>
                    Clear filter
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              {(query || filterTag) && (
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
                  <span style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13 }}>{sorted.length} result{sorted.length !== 1 ? "s" : ""} for</span>
                  <span style={{ background:C.blueLight, color:C.blue, borderRadius:6, padding:"2px 10px", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600 }}>{filterTag || query}</span>
                  <button onClick={() => { setQuery(""); setFilterTag(null); }} style={{ background:"none", border:"none", color:C.textMute, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, textDecoration:"underline" }}>clear</button>
                </div>
              )}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:16 }}>
                {sorted.map(p => <PhotoCard key={p.id} photo={p} onClick={() => setSelected(p.id)} />)}
              </div>
            </>
          )}
        </main>
      </div>

      {showUpload && <UploadModal onUpload={onUpload} onClose={() => setShowUpload(false)} />}
      {selectedPhoto && <PhotoDetail photo={selectedPhoto} onClose={() => setSelected(null)} onUpdate={onUpdate} onDelete={onDelete} />}
    </div>
  );
}
