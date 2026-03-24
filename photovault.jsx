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

// ── Layer 2: Luminance Histogram ─────────────────────────────────────────────
// Rotation-invariant pre-filter. A rotated or format-converted image has the
// exact same pixel population, so its histogram is identical regardless of
// orientation. We bucket 256 greyscale values into 64 bins and compare.
// Threshold is Chi-squared distance — low = similar, high = different.
const HISTOGRAM_THRESHOLD = 0.015; // tune: 0=identical, ~0.02=very similar

function extractHistogram(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const bins = new Float32Array(64); // 256 grey levels → 64 bins of 4
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
    const grey = Math.round(0.299*r + 0.587*g + 0.114*b); // 0-255
    bins[Math.floor(grey / 4)]++;
  }
  // Normalise to [0,1]
  for (let i = 0; i < 64; i++) bins[i] /= total;
  return bins;
}

function chiSquaredDistance(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const sum = a[i] + b[i];
    if (sum > 0) dist += (a[i] - b[i]) ** 2 / sum;
  }
  return dist;
}

// ── Layer 3: Multi-rotation dHash (8×8) ──────────────────────────────────────
// Computes dHash at all 4 rotations (0°, 90°, 180°, 270°) and stores all four.
// On comparison, the incoming image's hash is checked against every stored
// rotation variant — a match at ANY rotation is flagged as a duplicate.
// Threshold: Hamming distance ≤ DHASH_THRESHOLD bits out of 64.
const DHASH_THRESHOLD = 8;

// Draw image onto a 9×8 canvas (optionally rotated) and return greyscale pixels
function drawRotated(img, degrees) {
  const canvas = document.createElement("canvas");
  const swap = degrees === 90 || degrees === 270;
  canvas.width  = swap ? 8 : 9;
  canvas.height = swap ? 9 : 8;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  // For swapped dimensions we draw at 8×9 rotated to produce 9×8 effective pixels
  const dw = swap ? 8 : 9, dh = swap ? 9 : 8;
  ctx.drawImage(img, -dw/2, -dh/2, dw, dh);
  ctx.restore();
  return { ctx, w: canvas.width, h: canvas.height };
}

function dHashFromCtx(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  // We always want an 8-wide difference, so use the 9-col dimension
  // Layout: 9 cols × 8 rows → compare col[n] vs col[n+1] for each row
  const cols = w > h ? w : h; // 9
  const rows = w > h ? h : w; // 8
  const grey = [];
  for (let i = 0; i < cols * rows; i++) {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
    grey.push(0.299*r + 0.587*g + 0.114*b);
  }
  let hash = "";
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < rows; col++) { // 8 comparisons per row
      hash += grey[row*cols + col] > grey[row*cols + col + 1] ? "1" : "0";
    }
  }
  return hash; // 64-char binary string
}

// Returns { histogram, dHashes: [0°,90°,180°,270°] } for a file
async function computePerceptualFingerprint(file) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        // Full-size canvas for histogram (sample up to 128×128 for speed)
        const sampleSize = 128;
        const hCanvas = document.createElement("canvas");
        hCanvas.width = sampleSize; hCanvas.height = sampleSize;
        const hCtx = hCanvas.getContext("2d");
        hCtx.drawImage(img, 0, 0, sampleSize, sampleSize);
        const histogram = extractHistogram(hCtx, sampleSize, sampleSize);

        // dHash at 4 rotations
        const dHashes = [0, 90, 180, 270].map(deg => {
          const { ctx, w, h } = drawRotated(img, deg);
          return dHashFromCtx(ctx, w, h);
        });

        URL.revokeObjectURL(url);
        resolve({ histogram, dHashes });
      } catch(e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("fingerprint load failed")); };
    img.src = url;
  });
}

// Hamming distance between two 64-char binary strings
function hammingDistance(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return dist;
}

// Best (minimum) Hamming distance between incoming hash and all 4 stored rotations
function bestRotationDistance(incomingHash, storedDHashes) {
  return Math.min(...storedDHashes.map(h => hammingDistance(incomingHash, h)));
}

// ── Metadata extraction ────────────────────────────────────────────────────────
// Extracts image dimensions from a stable base64 dataUrl (not a revocable blob URL)
// so it cannot race with other steps that call URL.revokeObjectURL on the same file.
function extractMetadataFromDataUrl(dataUrl, file) {
  return new Promise((resolve) => {
    const meta = {
      name: file.name, size: file.size, type: file.type,
      lastModified: new Date(file.lastModified).toISOString(),
      sizeFormatted: file.size > 1024 * 1024
        ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
        : `${(file.size / 1024).toFixed(1)} KB`,
    };
    const img = new Image();
    img.onload = () => {
      meta.width       = img.naturalWidth;
      meta.height      = img.naturalHeight;
      meta.aspectRatio = (img.naturalWidth / img.naturalHeight).toFixed(3);
      meta.orientation = img.naturalWidth > img.naturalHeight ? "landscape"
        : img.naturalWidth < img.naturalHeight ? "portrait" : "square";
      meta.megapixels  = ((img.naturalWidth * img.naturalHeight) / 1_000_000).toFixed(2);
      resolve(meta);
    };
    img.onerror = (e) => {
      console.warn("extractMetadataFromDataUrl: img load failed", e);
      resolve(meta); // resolve without dimensions rather than hanging
    };
    img.src = dataUrl;
  });
}

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

// ── EXIF extraction via exifr (loaded from CDN on first use) ─────────────────
let _exifr = null;
async function loadExifr() {
  if (_exifr) return _exifr;
  await new Promise((res, rej) => {
    if (window.exifr) { _exifr = window.exifr; return res(); }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js";
    s.onload = () => { _exifr = window.exifr; res(); };
    s.onerror = rej;
    document.head.appendChild(s);
  });
  return _exifr;
}

// Human-readable labels for the most useful EXIF tags
const EXIF_LABELS = {
  Make:                   "Camera make",
  Model:                  "Camera model",
  LensModel:              "Lens",
  FocalLength:            "Focal length",
  FocalLengthIn35mmFormat:"Focal length (35mm)",
  FNumber:                "Aperture",
  ExposureTime:           "Shutter speed",
  ISO:                    "ISO",
  ExposureBiasValue:      "Exposure bias",
  ExposureProgram:        "Exposure program",
  MeteringMode:           "Metering mode",
  Flash:                  "Flash",
  WhiteBalance:           "White balance",
  Software:               "Software",
  DateTimeOriginal:       "Date taken",
  GPSLatitude:            "GPS latitude",
  GPSLongitude:           "GPS longitude",
  GPSAltitude:            "GPS altitude",
  ImageDescription:       "Description",
  Copyright:              "Copyright",
  Artist:                 "Artist",
  ColorSpace:             "Color space",
  XResolution:            "X resolution",
  YResolution:            "Y resolution",
  Orientation:            "EXIF orientation",
};

function formatExifValue(key, val) {
  if (val === undefined || val === null) return null;
  if (key === "FNumber")           return `f/${val}`;
  if (key === "FocalLength" || key === "FocalLengthIn35mmFormat") return `${val} mm`;
  if (key === "ExposureTime")      return val < 1 ? `1/${Math.round(1/val)}s` : `${val}s`;
  if (key === "ISO")               return String(val);
  if (key === "ExposureBiasValue") return `${val > 0 ? "+" : ""}${val} EV`;
  if (key === "GPSLatitude" || key === "GPSLongitude") {
    if (Array.isArray(val)) return val.map(v => v.toFixed ? v.toFixed(6) : v).join(", ");
    return typeof val === "number" ? val.toFixed(6) : String(val);
  }
  if (key === "GPSAltitude")       return `${Math.round(val)} m`;
  if (val instanceof Date)         return val.toLocaleString();
  if (typeof val === "number")     return val.toFixed(2).replace(/\.?0+$/, "");
  if (typeof val === "object")     return JSON.stringify(val);
  return String(val);
}

async function extractExif(file) {
  try {
    const exifr = await loadExifr();
    const raw = await exifr.parse(file, {
      tiff: true, exif: true, gps: true, iptc: false, xmp: false,
    });
    if (!raw) return null;
    const result = {};
    for (const [key, label] of Object.entries(EXIF_LABELS)) {
      if (raw[key] !== undefined) {
        const formatted = formatExifValue(key, raw[key]);
        if (formatted !== null) result[label] = formatted;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch(e) {
    console.warn("EXIF extraction failed:", e.message);
    return null;
  }
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
    if (idx[id]) {
      // If updates includes meta, deep-merge it rather than replacing
      if (updates.meta) {
        updates = { ...updates, meta: { ...idx[id].meta, ...updates.meta } };
      }
      idx[id] = { ...idx[id], ...updates };
      await window.storage.set("pv:index", JSON.stringify(idx));
    }
  } catch(e) { console.error(e); }
}

// ── Three-layer duplicate checker ────────────────────────────────────────────
// Returns { duplicate: bool, reason: string, matchName: string, detail: string }
//
//  Layer 1 — SHA-256 content hash   : exact byte-for-byte match (any format)
//  Layer 2 — Histogram chi-squared  : rotation-invariant colour/tone gate
//  Layer 3 — Multi-rotation dHash   : structural confirmation at 0/90/180/270°
//
// A file must pass ALL three layers to be considered unique.
async function checkDuplicate(contentHash, fingerprint) {
  const idx = await loadIndex();
  const existing = Object.values(idx);

  // ── Layer 1: exact content match ─────────────────────────────────────────
  const exactMatch = existing.find(p => p.meta?.contentHash === contentHash);
  if (exactMatch) {
    return { duplicate: true, reason: "exact",
             matchName: exactMatch.meta.originalName,
             detail: "identical file content" };
  }

  if (!fingerprint) return { duplicate: false };
  const { histogram: inHist, dHashes: inDHashes } = fingerprint;

  // ── Layers 2 + 3: perceptual check against every stored image ────────────
  for (const p of existing) {
    if (!p.meta?.histogram || !p.meta?.dHashes) continue;

    // Layer 2 — histogram gate (fast, rotation-invariant)
    const storedHist = new Float32Array(p.meta.histogram);
    const histDist   = chiSquaredDistance(inHist, storedHist);
    if (histDist > HISTOGRAM_THRESHOLD) continue; // histograms too different → skip

    // Layer 3 — multi-rotation dHash confirmation
    const bestDist = bestRotationDistance(inDHashes[0], p.meta.dHashes);
    if (bestDist <= DHASH_THRESHOLD) {
      const rotation = [0,90,180,270].find(
        (deg, i) => hammingDistance(inDHashes[0], p.meta.dHashes[i]) === bestDist
      );
      return {
        duplicate: true,
        reason: "perceptual",
        matchName: p.meta.originalName,
        detail: `histogram Δ=${histDist.toFixed(4)}, dHash ${bestDist} bits apart${rotation !== 0 ? ` (rotated ${rotation}°)` : ""}`,
      };
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

      // ── Layers 2+3: perceptual fingerprint (histogram + multi-rotation dHash)
      setStatusMsg(`Fingerprinting ${f.name}…`);
      let fingerprint = null;
      try { fingerprint = await computePerceptualFingerprint(f); }
      catch(e) { console.warn("Fingerprint failed:", e); }

      // ── Duplicate check (all three layers)
      setStatusMsg(`Checking ${f.name} for duplicates…`);
      const dupeResult = await checkDuplicate(contentHash, fingerprint);
      if (dupeResult.duplicate) {
        const reason = dupeResult.reason === "exact"
          ? `exact duplicate of "${dupeResult.matchName}"`
          : `visual duplicate of "${dupeResult.matchName}" — ${dupeResult.detail}`;
        skipped.push({ name: f.name, reason });
        setProgress(Math.round(((i + 1) / files.length) * 100));
        continue;
      }

      setStatusMsg(`Processing ${f.name}…`);

      // Read file into dataUrl FIRST — gives us a stable base64 source
      // that can't be revoked, avoiding any race with createObjectURL
      const dataUrl = await new Promise(res => {
        const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(f);
      });

      // Extract image dimensions from the stable dataUrl
      const meta = await extractMetadataFromDataUrl(dataUrl, f);
      const photoId = uid();
      const ext     = f.name.split(".").pop().toLowerCase();

      meta.originalName   = f.name;
      meta.storedFilename = `${photoId}.${ext}`;
      meta.contentHash    = contentHash;
      meta.histogram      = fingerprint ? Array.from(fingerprint.histogram) : null;
      meta.dHashes        = fingerprint ? fingerprint.dHashes : null;

      // Extract EXIF data (reads from original File object — safe, file is not revoked)
      setStatusMsg(`Reading EXIF data for ${f.name}…`);
      meta.exif = await extractExif(f);

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

// ── Markup Viewer ────────────────────────────────────────────────────────────
// Renders the image with markup overlay in the detail panel (read-only)
function MarkupViewer({ photo, markup }) {
  const canvasRef = useRef(null);
  const imgRef    = useRef(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !img.complete) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (markup && markup.length) {
      const scale = Math.min(canvas.width, canvas.height) / 1000;
      renderMarkup(ctx, markup, scale, scale);
    }
  }, [markup]);

  useEffect(() => { draw(); }, [draw]);

  return (
    <div style={{ position:"relative", maxWidth:"100%", maxHeight:"100%", lineHeight:0 }}>
      <img ref={imgRef} src={photo.dataUrl} alt="" onLoad={draw}
        style={{ display:"none" }} />
      <canvas ref={canvasRef}
        width={photo.meta.width  || 800}
        height={photo.meta.height || 600}
        style={{ maxWidth:"100%", maxHeight:"calc(100vh - 120px)", display:"block", borderRadius:4 }}
      />
    </div>
  );
}

// ── Markup Editor ─────────────────────────────────────────────────────────────
// Non-destructive: shapes stored as JSON in photo.meta.markup
// Original dataUrl is never modified.

const MARKUP_COLORS = ["#e05555","#6495ed","#f0a500","#27ae60","#9b59b6","#1abc9c","#ffffff","#1c2133"];

// Coords stored in intrinsic canvas pixel space.
// scaleX/scaleY only used for lineWidth/fontSize so strokes look consistent
// regardless of the image's native resolution.
function renderMarkup(ctx, shapes, scaleX, scaleY) {
  // Use the smaller dimension ratio so strokes aren't huge on tall/wide images
  const scale = Math.min(scaleX, scaleY);
  shapes.forEach(s => {
    ctx.save();
    ctx.strokeStyle  = s.color;
    ctx.fillStyle    = "transparent";
    ctx.lineWidth    = Math.max(1, (s.strokeWidth || 2) * scale);
    ctx.textBaseline = "top";
    ctx.font         = `bold ${Math.round((s.fontSize || 20) * scale)}px "Plus Jakarta Sans", sans-serif`;
    const { x, y, x2, y2 } = s;
    if (s.type === "rect") {
      ctx.strokeRect(x, y, x2 - x, y2 - y);
    } else if (s.type === "circle") {
      const rx = Math.abs(x2 - x) / 2;
      const ry = Math.abs(y2 - y) / 2;
      if (rx < 1 || ry < 1) { ctx.restore(); return; }
      ctx.beginPath();
      ctx.ellipse(x + (x2 - x) / 2, y + (y2 - y) / 2, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.type === "text") {
      ctx.shadowColor   = "rgba(0,0,0,0.6)";
      ctx.shadowBlur    = 4 * scale;
      ctx.shadowOffsetX = 1 * scale;
      ctx.shadowOffsetY = 1 * scale;
      ctx.fillStyle = s.color;
      ctx.fillText(s.text || "", x, y);
    }
    ctx.restore();
  });
}

function MarkupEditor({ photo, onSave, onClose }) {
  const canvasRef      = useRef(null);
  const imgRef         = useRef(null);
  const [tool, setTool]           = useState("rect");
  const [color, setColor]         = useState("#e05555");
  const [strokeWidth, setStroke]  = useState(2);
  const [fontSizeKey, setFontSizeKey] = useState("M"); // S | M | L
  const [shapes, setShapes]       = useState(photo.meta.markup || []);
  const [drawing, setDrawing]     = useState(false);
  const [current, setCurrent]     = useState(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [textInput, setTextInput] = useState({ visible:false, x:0, y:0, value:"" });

  // Draw everything onto the canvas
  const redraw = useCallback((shapeList, inProgress) => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Coords are intrinsic canvas pixels; pass scale=1 for shapes.
    // lineWidth/fontSize use a ratio of canvas dims so they look right at any resolution.
    const scale = Math.min(canvas.width, canvas.height) / 1000;
    renderMarkup(ctx, shapeList, scale, scale);
    if (inProgress) renderMarkup(ctx, [inProgress], scale, scale);
  }, [imgLoaded]);

  useEffect(() => { redraw(shapes, current); }, [shapes, current, redraw]);

  const getPos = (e) => {
    const canvas  = canvasRef.current;
    const rect    = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    // Map from displayed CSS pixels → intrinsic canvas pixels.
    // rect.width/height = displayed size; canvas.width/height = intrinsic size.
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top)  * scaleY,
    };
  };

  const onMouseDown = (e) => {
    if (e.button === 2) return;
    // If text input is already visible, commit it instead of starting a new action
    if (textInput.visible) { commitText(); return; }
    const pos = getPos(e); // intrinsic canvas pixels
    if (tool === "text") {
      const canvas  = canvasRef.current;
      const rect    = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      // Use setTimeout so the input mounts before autoFocus fires,
      // preventing the canvas from immediately reclaiming focus
      setTimeout(() => setTextInput({ visible:true, x:px, y:py, nx:pos.x, ny:pos.y, value:"" }), 0);
      return;
    }
    setDrawing(true);
    setCurrent({ type:tool, x:pos.x, y:pos.y, x2:pos.x, y2:pos.y, color, strokeWidth });
  };

  const onMouseMove = (e) => {
    if (!drawing || !current) return;
    const pos = getPos(e);
    setCurrent(c => ({ ...c, x2:pos.x, y2:pos.y }));
  };

  const onMouseUp = () => {
    if (!drawing || !current) return;
    setDrawing(false);
    if (Math.abs(current.x2 - current.x) > 0.005 || Math.abs(current.y2 - current.y) > 0.005) {
      setShapes(s => [...s, current]);
    }
    setCurrent(null);
  };

  const commitText = () => {
    if (textInput.value.trim()) {
      const canvas = canvasRef.current;
      const h = canvas?.height || 600;
      const fontSizeMap = { S: h * 0.025, M: h * 0.045, L: h * 0.075 };
      const fontSize = fontSizeMap[fontSizeKey] ?? h * 0.045;
      setShapes(s => [...s, {
        type:     "text",
        x:        textInput.nx,
        y:        textInput.ny,
        x2:       textInput.nx,
        y2:       textInput.ny,
        color,
        strokeWidth,
        fontSize,
        text:     textInput.value.trim(),
      }]);
    }
    setTextInput({ visible:false, x:0, y:0, value:"" });
  };

  const [saving, setSaving] = useState(false);

  const undo = () => setShapes(s => s.slice(0, -1));
  const clear = () => setShapes([]);

  const save = async () => {
    setSaving(true);
    await onSave(shapes);
    // onClose called by onSave handler; brief delay lets spinner show
    setTimeout(() => { setSaving(false); onClose(); }, 400);
  };

  const TOOLS = [
    { id:"rect",   icon:"▭", label:"Rectangle" },
    { id:"circle", icon:"◯", label:"Circle"    },
    { id:"text",   icon:"T", label:"Text"      },
  ];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(20,24,40,0.92)", backdropFilter:"blur(6px)", zIndex:200, display:"flex", flexDirection:"column" }}>

      {/* Toolbar */}
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"10px 20px", display:"flex", alignItems:"center", gap:12, flexShrink:0, flexWrap:"wrap" }}>

        {/* Title */}
        <span style={{ fontFamily:"'Plus Jakarta Sans',sans-serif", fontWeight:700, fontSize:14, color:C.text, marginRight:4 }}>
          Markup Editor
        </span>
        <span style={{ width:1, height:20, background:C.border2, flexShrink:0 }} />

        {/* Tool buttons */}
        <div style={{ display:"flex", gap:4 }}>
          {TOOLS.map(t => (
            <button key={t.id} onClick={() => setTool(t.id)} title={t.label}
              style={{ padding:"6px 12px", borderRadius:7, border:`1px solid ${tool===t.id ? C.blue : C.border}`, background:tool===t.id ? C.blueLight : C.surface2, color:tool===t.id ? C.blue : C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13, fontWeight:600, cursor:"pointer", transition:"all 0.15s" }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        <span style={{ width:1, height:20, background:C.border2, flexShrink:0 }} />

        {/* Color swatches */}
        <div style={{ display:"flex", gap:5, alignItems:"center" }}>
          {MARKUP_COLORS.map(col => (
            <button key={col} onClick={() => setColor(col)}
              style={{ width:20, height:20, borderRadius:"50%", background:col, border:`2.5px solid ${color===col ? C.blue : C.border}`, cursor:"pointer", padding:0, outline: color===col ? `2px solid ${C.blueLight}` : "none", transition:"all 0.12s" }} />
          ))}
        </div>
        <span style={{ width:1, height:20, background:C.border2, flexShrink:0 }} />

        {/* Stroke width */}
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11 }}>Width</span>
          {[1,2,4,6].map(w => (
            <button key={w} onClick={() => setStroke(w)}
              style={{ width:28, height:28, borderRadius:6, border:`1px solid ${strokeWidth===w ? C.blue : C.border}`, background:strokeWidth===w ? C.blueLight : C.surface2, color:strokeWidth===w ? C.blue : C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, fontWeight:600, cursor:"pointer" }}>
              {w}
            </button>
          ))}
        </div>
        <span style={{ width:1, height:20, background:C.border2, flexShrink:0 }} />

        {/* Font size — only shown for text tool */}
        {tool === "text" && (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11 }}>Size</span>
              {[
                { key:"S", label:"S", style:{ fontSize:11 } },
                { key:"M", label:"M", style:{ fontSize:13 } },
                { key:"L", label:"L", style:{ fontSize:16 } },
              ].map(({ key, label, style }) => (
                <button key={key} onClick={() => setFontSizeKey(key)}
                  style={{ width:32, height:28, borderRadius:6, border:`1px solid ${fontSizeKey===key ? C.blue : C.border}`, background:fontSizeKey===key ? C.blueLight : C.surface2, color:fontSizeKey===key ? C.blue : C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontWeight:700, cursor:"pointer", ...style }}>
                  {label}
                </button>
              ))}
            </div>
            <span style={{ width:1, height:20, background:C.border2, flexShrink:0 }} />
          </>
        )}

        {/* Undo / Clear */}
        <button onClick={undo} disabled={shapes.length===0}
          style={{ padding:"6px 12px", borderRadius:7, border:`1px solid ${C.border}`, background:C.surface2, color:shapes.length===0 ? C.textMute : C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, cursor:shapes.length===0?"default":"pointer" }}>
          ↩ Undo
        </button>
        <button onClick={clear} disabled={shapes.length===0}
          style={{ padding:"6px 12px", borderRadius:7, border:`1px solid ${C.border}`, background:C.surface2, color:shapes.length===0 ? C.textMute : C.red, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, cursor:shapes.length===0?"default":"pointer" }}>
          ✕ Clear
        </button>

        <div style={{ flex:1 }} />

        {/* Cancel / Save */}
        <button onClick={onClose}
          style={{ padding:"7px 16px", borderRadius:7, border:`1px solid ${C.border}`, background:C.surface2, color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, cursor:"pointer" }}>
          Cancel
        </button>
        <button onClick={save} disabled={saving}
          style={{ padding:"7px 18px", borderRadius:7, border:"none", background:C.blue, color:"#fff", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600, cursor:saving?"default":"pointer", boxShadow:`0 2px 8px rgba(100,149,237,0.4)`, display:"flex", alignItems:"center", gap:7, opacity:saving?0.85:1, transition:"opacity 0.2s" }}>
          {saving ? (
            <><span style={{ width:13, height:13, border:"2px solid rgba(255,255,255,0.35)", borderTopColor:"#fff", borderRadius:"50%", display:"inline-block", animation:"pvSpin 0.7s linear infinite" }} />Saving…</>
          ) : "Save Markup"}
        </button>
      </div>

      {/* Canvas area */}
      <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", padding:24, overflow:"hidden", position:"relative" }}>
        <div style={{ position:"relative", maxWidth:"100%", maxHeight:"100%", lineHeight:0 }}>
          {/* Hidden img used as source for canvas */}
          <img ref={imgRef} src={photo.dataUrl} alt=""
            onLoad={() => setImgLoaded(true)}
            style={{ display:"none" }} />

          <canvas ref={canvasRef}
            width={photo.meta.width  || 800}
            height={photo.meta.height || 600}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            style={{
              maxWidth:"calc(100vw - 48px)",
              maxHeight:"calc(100vh - 130px)",
              cursor: tool==="text" ? "text" : "crosshair",
              borderRadius:8,
              boxShadow:"0 8px 32px rgba(0,0,0,0.4)",
              display:"block",
            }}
          />

          {/* Floating text input */}
          {textInput.visible && (
            <div style={{ position:"absolute", left: textInput.x, top: textInput.y - 10, zIndex:20 }}
              onMouseDown={e => e.stopPropagation()}>
              <input autoFocus
                value={textInput.value}
                onChange={e => setTextInput(t => ({ ...t, value:e.target.value }))}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === "Enter") { e.preventDefault(); commitText(); }
                  if (e.key === "Escape") setTextInput({ visible:false, x:0, y:0, value:"" });
                }}
                style={{
                  background:"rgba(255,255,255,0.95)",
                  border:`2px solid ${color}`,
                  borderRadius:5, padding:"4px 10px",
                  fontFamily:"'Plus Jakarta Sans',sans-serif",
                  fontSize:15, color:C.text,
                  outline:"none", minWidth:140, display:"block",
                  boxShadow:"0 4px 16px rgba(0,0,0,0.25)",
                }}
                placeholder="Type text, press Enter"
              />
              <div style={{ display:"flex", gap:6, marginTop:4 }}>
                <button onMouseDown={e => { e.stopPropagation(); commitText(); }}
                  style={{ flex:1, padding:"4px 0", background:C.blue, color:"#fff", border:"none", borderRadius:4, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, fontWeight:600 }}>
                  ✓ Place
                </button>
                <button onMouseDown={e => { e.stopPropagation(); setTextInput({ visible:false, x:0, y:0, value:"" }); }}
                  style={{ flex:1, padding:"4px 0", background:C.surface2, color:C.textMid, border:`1px solid ${C.border}`, borderRadius:4, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={{ background:C.surface, borderTop:`1px solid ${C.border}`, padding:"6px 20px", display:"flex", alignItems:"center", gap:16 }}>
        <span style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11 }}>
          {shapes.length} shape{shapes.length!==1?"s":""} · Active tool: <strong style={{ color:C.blue }}>{TOOLS.find(t=>t.id===tool)?.label}</strong> · Color: <span style={{ display:"inline-block", width:10, height:10, borderRadius:"50%", background:color, border:`1px solid ${C.border}`, verticalAlign:"middle", marginLeft:2 }} />
        </span>
        <span style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11 }}>
          {photo.meta.width && `${photo.meta.width} × ${photo.meta.height} px`}
        </span>
      </div>
    </div>
  );
}

function PhotoDetail({ photo, onClose, onUpdate, onDelete }) {
  const [tags, setTags]           = useState(photo.tags);
  const [comment, setComment]     = useState(photo.comment);
  const [program, setProgram]     = useState(photo.program || "");
  const [saved, setSaved]           = useState(false);
  const [saving, setSaving]         = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showDownload, setShowDownload]   = useState(false);
  const [showMarkup, setShowMarkup] = useState(false);
  const [markup, setMarkup]         = useState(photo.meta.markup || []);

  const save = async () => {
    setSaving(true);
    await updatePhoto(photo.id, { tags, comment, program });
    onUpdate(photo.id, { tags, comment, program });
    setSaving(false);
    setSaved(true);
    setTimeout(() => onClose(), 600);
  };

  const saveMarkup = async (shapes) => {
    const updatedMeta = { ...photo.meta, markup: shapes };
    await updatePhoto(photo.id, { meta: updatedMeta });
    onUpdate(photo.id, { meta: updatedMeta });
    setMarkup(shapes);
  };

  // ── Download helpers ──────────────────────────────────────────────────────
  const downloadOriginal = () => {
    const originalName = photo.meta.originalName || photo.meta.name || "image";
    const a = document.createElement("a");
    a.href     = photo.dataUrl;
    a.download = originalName;
    a.click();
    setShowDownload(false);
  };

  const downloadWithMarkup = () => {
    const originalName = photo.meta.originalName || photo.meta.name || "image";
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      if (markup && markup.length) {
        const scale = Math.min(canvas.width, canvas.height) / 1000;
        renderMarkup(ctx, markup, scale, scale);
      }
      // Derive output format from original extension
      const ext  = originalName.split(".").pop().toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const a = document.createElement("a");
      a.href     = canvas.toDataURL(mime, 0.95);
      a.download = originalName;
      a.click();
      setShowDownload(false);
    };
    img.src = photo.dataUrl;
  };

  const [showExif, setShowExif] = useState(false);
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
  const exifEntries = m.exif ? Object.entries(m.exif) : [];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(28,33,51,0.38)", backdropFilter:"blur(8px)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ display:"flex", width:"min(1060px,95vw)", height:"min(680px,92vh)", borderRadius:16, overflow:"hidden", border:`1px solid ${C.border}`, boxShadow:"0 28px 72px rgba(28,40,80,0.2)" }}>

        {/* Image pane */}
        <div style={{ flex:1, background:C.surface2, display:"flex", alignItems:"center", justifyContent:"center" }}>
          <MarkupViewer photo={photo} markup={markup} />
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
              {/* Header row */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                <div style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase" }}>Metadata</div>
                {exifEntries.length > 0 && (
                  <button onClick={() => setShowExif(v => !v)}
                    style={{ display:"flex", alignItems:"center", gap:4, background: showExif ? C.blue : C.surface, border:`1px solid ${showExif ? C.blue : C.border2}`, borderRadius:5, padding:"2px 8px", cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:700, color: showExif ? "#fff" : C.textMid, letterSpacing:"0.04em", transition:"all 0.15s" }}>
                    {showExif ? "▲" : "▼"} EXIF
                  </button>
                )}
                {exifEntries.length === 0 && m.type && (
                  <span style={{ fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, color:C.textMute, fontStyle:"italic" }}>No EXIF</span>
                )}
              </div>

              {/* Standard fields */}
              {fields.map(([k, v]) => (
                <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:5, gap:8 }}>
                  <span style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, flexShrink:0 }}>{k}</span>
                  <span style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, textAlign:"right", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:160 }} title={v}>{v}</span>
                </div>
              ))}

              {/* EXIF expanded section */}
              {showExif && exifEntries.length > 0 && (
                <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}` }}>
                  <div style={{ color:C.blue, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>EXIF Data</div>
                  {exifEntries.map(([k, v]) => (
                    <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:5, gap:8 }}>
                      <span style={{ color:C.textMute, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, flexShrink:0 }}>{k}</span>
                      <span style={{ color:C.textMid, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, textAlign:"right", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:155 }} title={v}>{v}</span>
                    </div>
                  ))}
                </div>
              )}
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

            <div style={{ display:"flex", gap:8, marginBottom:8 }}>
              <button onClick={() => setShowMarkup(true)}
                style={{ flex:1, padding:"9px 0", background:markup.length > 0 ? "#f0f7ff" : C.surface2, color:markup.length > 0 ? C.blue : C.textMid, border:`1px solid ${markup.length > 0 ? C.blueMid : C.border}`, borderRadius:7, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                ✏ {markup.length > 0 ? `Edit Markup (${markup.length})` : "Add Markup"}
              </button>
              <button onClick={() => { setShowDownload(d => !d); setConfirmDelete(false); }}
                style={{ padding:"9px 12px", background: showDownload ? C.blueLight : C.surface2, color: showDownload ? C.blue : C.textMid, border:`1px solid ${showDownload ? C.blueMid : C.border}`, borderRadius:7, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", gap:5, transition:"all 0.15s" }}>
                ↓ Download
              </button>
            </div>

            {/* Download prompt */}
            {showDownload && (
              <div style={{ background:C.blueLight, border:`1px solid ${C.blueMid}`, borderRadius:8, padding:"10px 12px", marginBottom:8 }}>
                <div style={{ color:C.blue, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:11, fontWeight:700, marginBottom:8, letterSpacing:"0.04em", textTransform:"uppercase" }}>
                  Download as…
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={downloadOriginal}
                    style={{ flex:1, padding:"8px 0", background:C.surface, color:C.text, border:`1px solid ${C.border}`, borderRadius:7, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                    <span style={{ fontSize:16 }}>🖼</span>
                    <span>Original</span>
                    <span style={{ fontSize:10, color:C.textMute, fontWeight:400 }}>unmodified file</span>
                  </button>
                  <button onClick={downloadWithMarkup}
                    disabled={markup.length === 0}
                    style={{ flex:1, padding:"8px 0", background: markup.length > 0 ? C.surface : C.surface2, color: markup.length > 0 ? C.text : C.textMute, border:`1px solid ${markup.length > 0 ? C.border : C.border}`, borderRadius:7, cursor: markup.length > 0 ? "pointer" : "default", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                    <span style={{ fontSize:16 }}>✏</span>
                    <span>With Markup</span>
                    <span style={{ fontSize:10, color: markup.length > 0 ? C.textMute : C.textMute, fontWeight:400 }}>
                      {markup.length > 0 ? `${markup.length} annotation${markup.length !== 1 ? "s" : ""}` : "no markup yet"}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {confirmDelete ? (
              /* Confirmation state */
              <div style={{ background:"#fff5f5", border:`1px solid #f0c8c8`, borderRadius:8, padding:"10px 12px" }}>
                <div style={{ color:C.red, fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600, marginBottom:8, textAlign:"center" }}>
                  Delete this image permanently?
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => { onDelete(photo.id); onClose(); }}
                    style={{ flex:1, padding:"8px 0", background:C.red, color:"#fff", border:"none", borderRadius:7, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:700 }}>
                    Yes, delete
                  </button>
                  <button onClick={() => setConfirmDelete(false)}
                    style={{ flex:1, padding:"8px 0", background:C.surface2, color:C.textMid, border:`1px solid ${C.border}`, borderRadius:7, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:500 }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={save} disabled={saving || saved}
                  style={{ flex:1, padding:"9px 0", background:saved ? C.green : C.blue, color:"#fff", border:"none", borderRadius:7, cursor:saving||saved?"default":"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:600, transition:"background 0.3s", display:"flex", alignItems:"center", justifyContent:"center", gap:7 }}>
                  {saving ? (
                    <><span style={{ width:13, height:13, border:"2px solid rgba(255,255,255,0.35)", borderTopColor:"#fff", borderRadius:"50%", display:"inline-block", animation:"pvSpin 0.7s linear infinite" }} />Saving…</>
                  ) : saved ? "✓ Saved" : "Save Changes"}
                </button>
                <button onClick={() => setConfirmDelete(true)}
                  style={{ padding:"9px 12px", background:"#fff", color:C.red, border:`1px solid #f0c8c8`, borderRadius:7, cursor:"pointer", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:12, fontWeight:500 }}>
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {showMarkup && (
        <MarkupEditor
          photo={{ ...photo, meta: { ...photo.meta, markup } }}
          onSave={saveMarkup}
          onClose={() => setShowMarkup(false)}
        />
      )}
    </div>
  );
}

// ── Photo List ────────────────────────────────────────────────────────────────
function PhotoList({ photos, onSelect }) {
  const [sortCol, setSortCol] = useState("Ingested");
  const [sortDir, setSortDir] = useState("desc"); // "asc" | "desc"

  const handleSort = (label) => {
    if (sortCol === label) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(label);
      setSortDir("asc");
    }
  };

  // Column definitions — sortKey is a function returning the comparable value
  const cols = [
    { label: "Preview",    w: 56,   sortKey: null,
      render: p => (
        <img src={p.dataUrl} alt="" style={{ width:44, height:44, objectFit:"cover", borderRadius:6, border:`1px solid ${C.border}`, display:"block" }} />
      )},
    { label: "Filename",   flex: 3, sortKey: p => (p.meta.originalName || p.meta.name || "").toLowerCase(),
      render: p => (
        <div style={{ overflow:"hidden" }}>
          <div style={{ color:C.text, fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {p.meta.originalName || p.meta.name}
          </div>
          <div style={{ color:C.textMute, fontSize:11, marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {p.meta.storedFilename || "—"}
          </div>
        </div>
      )},
    { label: "Program",    flex: 2, sortKey: p => (p.program || "").toLowerCase(),
      render: p => p.program
        ? <span style={{ background:C.blueLight, color:C.blue, borderRadius:5, padding:"2px 8px", fontSize:11, fontWeight:600 }}>{p.program}</span>
        : <span style={{ color:C.textMute, fontSize:12 }}>—</span> },
    { label: "Tags",       flex: 2, sortKey: p => p.tags.length,
      render: p => (
        <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
          {p.tags.slice(0,3).map(t => <TagPill key={t} tag={t} small />)}
          {p.tags.length > 3 && <span style={{ color:C.textMute, fontSize:10, alignSelf:"center" }}>+{p.tags.length-3}</span>}
          {p.tags.length === 0 && <span style={{ color:C.textMute, fontSize:12 }}>—</span>}
        </div>
      )},
    { label: "Size",       w: 80,   sortKey: p => p.meta.size || 0,
      render: p => <span style={{ color:C.textMid, fontSize:12 }}>{p.meta.sizeFormatted || "—"}</span> },
    { label: "Dimensions", w: 100,  sortKey: p => (p.meta.width || 0) * (p.meta.height || 0),
      render: p => (
        <span style={{ color:C.textMid, fontSize:12 }}>
          {p.meta.width ? `${p.meta.width}×${p.meta.height}` : "—"}
        </span>
      )},
    { label: "Ingested",   w: 130,  sortKey: p => p.uploadedAt,
      render: p => (
        <span style={{ color:C.textMid, fontSize:12 }}>
          {new Date(p.uploadedAt).toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" })}
        </span>
      )},
    { label: "Comment",    flex: 2, sortKey: p => (p.comment || "").toLowerCase(),
      render: p => (
        <span style={{ color:C.textMute, fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", display:"block" }}>
          {p.comment || "—"}
        </span>
      )},
  ];

  // Sort the rows locally based on active column
  const activeCol = cols.find(c => c.label === sortCol);
  const sorted = activeCol?.sortKey
    ? [...photos].sort((a, b) => {
        const va = activeCol.sortKey(a), vb = activeCol.sortKey(b);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      })
    : photos;

  return (
    <div style={{ background:C.surface, borderRadius:10, border:`1px solid ${C.border}`, overflow:"hidden", boxShadow:`0 1px 4px rgba(28,40,80,0.06)` }}>
      {/* Header row */}
      <div style={{ display:"flex", alignItems:"center", background:C.surface2, borderBottom:`1px solid ${C.border}`, padding:"0 8px" }}>
        {cols.map(col => {
          const isActive = sortCol === col.label;
          const canSort  = !!col.sortKey;
          return (
            <div key={col.label}
              onClick={() => canSort && handleSort(col.label)}
              style={{
                flex: col.flex || `0 0 ${col.w}px`,
                padding: "9px 10px",
                display: "flex", alignItems: "center", gap: 4,
                color: isActive ? C.blue : C.textMute,
                fontFamily: "'Plus Jakarta Sans',sans-serif",
                fontSize: 10, fontWeight: 700,
                letterSpacing: "0.08em", textTransform: "uppercase",
                cursor: canSort ? "pointer" : "default",
                userSelect: "none",
                overflow: "hidden", whiteSpace: "nowrap",
                transition: "color 0.15s",
              }}>
              <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{col.label}</span>
              {canSort && (
                <span style={{ fontSize: 10, opacity: isActive ? 1 : 0.3, flexShrink: 0, color: isActive ? C.blue : C.textMute }}>
                  {isActive ? (sortDir === "asc" ? "▲" : "▼") : "⬍"}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Data rows */}
      {sorted.map((p, i) => (
        <PhotoListRow key={p.id} photo={p} cols={cols} even={i%2===0} onSelect={onSelect} />
      ))}
    </div>
  );
}

function PhotoListRow({ photo, cols, even, onSelect }) {
  const [hover, setHover] = useState(false);
  return (
    <div onClick={() => onSelect(photo.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display:"flex", alignItems:"center", padding:"6px 8px", cursor:"pointer", borderBottom:`1px solid ${C.border}`, background: hover ? C.blueLight : even ? C.surface : "#fafbfc", transition:"background 0.12s" }}>
      {cols.map(col => (
        <div key={col.label}
          style={{ flex:col.flex || `0 0 ${col.w}px`, padding:"4px 10px", overflow:"hidden", fontFamily:"'Plus Jakarta Sans',sans-serif", minWidth:0 }}>
          {col.render(photo)}
        </div>
      ))}
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
        {photo.meta.markup?.length > 0 && (
          <div style={{ position:"absolute", top:6, left:6, background:"rgba(100,149,237,0.9)", borderRadius:4, padding:"2px 7px" }}>
            <span style={{ color:"#fff", fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:10, fontWeight:600 }}>✏ {photo.meta.markup.length}</span>
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
  const [viewMode, setViewMode]     = useState("gallery"); // "gallery" | "list" 

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
        @keyframes pvSpin { to { transform: rotate(360deg); } }
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

          {/* View mode toggle */}
          <div style={{ display:"flex", background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden" }}>
            {[["gallery","⊞"],["list","☰"]].map(([mode, icon]) => (
              <button key={mode} onClick={() => setViewMode(mode)}
                title={mode === "gallery" ? "Gallery view" : "List view"}
                style={{ padding:"8px 12px", border:"none", background: viewMode===mode ? C.blue : "transparent", color: viewMode===mode ? "#fff" : C.textMid, cursor:"pointer", fontSize:15, lineHeight:1, transition:"all 0.15s" }}>
                {icon}
              </button>
            ))}
          </div>

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
              {viewMode === "gallery" ? (
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:16 }}>
                  {sorted.map(p => <PhotoCard key={p.id} photo={p} onClick={() => setSelected(p.id)} />)}
                </div>
              ) : (
                <PhotoList photos={sorted} onSelect={id => setSelected(id)} />
              )}
            </>
          )}
        </main>
      </div>

      {showUpload && <UploadModal onUpload={onUpload} onClose={() => setShowUpload(false)} />}
      {selectedPhoto && <PhotoDetail photo={selectedPhoto} onClose={() => setSelected(null)} onUpdate={onUpdate} onDelete={onDelete} />}
    </div>
  );
}
