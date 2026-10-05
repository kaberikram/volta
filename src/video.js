// Video: frame extraction (seek + draw), depth (transformers.js Depth-Anything-V2-small, WebGPU -> WASM),
// person segmentation (MediaPipe selfie-multiclass, depth-based fallback), motion, smoothing, pivots, cache.
import { clamp, gaussSmooth, fillNaN, cacheGet, cachePut } from './util.js';
const TJS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';
const MPV = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

export function loadVideoEl(file) {
  return new Promise((res, rej) => {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.onloadeddata = () => res(v); v.onerror = () => rej(new Error('video decode failed (codec not supported by this browser? HEVC needs Chrome on Mac/Win with HW decode)'));
    v.src = URL.createObjectURL(file);
  });
}
const seek = (v, t) => new Promise(res => { const on = () => { v.removeEventListener('seeked', on); res(); }; v.addEventListener('seeked', on); v.currentTime = t; });

const lastPc = {};
let depthModel = null, depthDevice = null, segmenter = null, segInfo = 'none';
async function getDepth(log) {
  if (depthModel) return depthModel;
  const T = await import(`${TJS}/+esm`);
  T.env.allowLocalModels = false;
  if (self.crossOriginIsolated) T.env.backends.onnx.wasm.numThreads = Math.min(8, navigator.hardwareConcurrency || 4);
  const tries = [];
  let adapter = null; try { adapter = navigator.gpu && await navigator.gpu.requestAdapter(); } catch (e) {}
  const soft = adapter && (adapter.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(adapter.info ? [adapter.info.vendor, adapter.info.architecture, adapter.info.device, adapter.info.description].join(' ') : ''));
  if (adapter && !soft) { if (adapter.features.has('shader-f16')) tries.push({device: 'webgpu', dtype: 'fp16'}); tries.push({device: 'webgpu', dtype: 'fp32'}); }
  else log(adapter ? 'depth: WebGPU adapter is a software fallback - using WASM instead' : 'depth: WebGPU not available - using WASM (slower)');
  tries.push({device: 'wasm', dtype: 'q8'});
  for (const o of tries) {
    try { log(`depth: loading Depth-Anything-V2-small (${o.device}/${o.dtype}) - first run downloads the model`);
      const m = await T.AutoModel.from_pretrained('onnx-community/depth-anything-v2-small', {...o, progress_callback: p => { if (p.status === 'progress' && p.total) { const pc = Math.floor(10 * p.loaded / p.total); if (pc !== lastPc[p.file]) { lastPc[p.file] = pc; if (p.total > 1e6) log(`depth model ${p.file}: ${pc * 10}% of ${(p.total / 1e6).toFixed(0)} MB`); } } }});
      depthModel = {m, T}; depthDevice = `${o.device}/${o.dtype}${o.device === 'wasm' ? (self.crossOriginIsolated ? ' x' + T.env.backends.onnx.wasm.numThreads + ' threads' : ' single-thread') : ''}`; log(`depth: using ${depthDevice}`); return depthModel;
    } catch (e) { log(`depth: ${o.device} failed (${e.message}), trying next`); }
  }
  throw new Error('depth model failed to load');
}
// Person mask. Primary: MediaPipe PoseLandmarker segmentation (detects full bodies at any distance, empty when nobody is in
// frame). Fallback: selfie-multiclass ImageSegmenter (good for close-ups, can over-segment wide shots). Last resort: depth threshold.
// Every variant returns a function imgData -> Float32Array person probability at the image resolution.
const resample = (src, mw, mh, aw, ah, out, add) => { for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) { const v = src[Math.min(mh - 1, Math.floor(y * mh / ah)) * mw + Math.min(mw - 1, Math.floor(x * mw / aw))]; out[y * aw + x] = add ? Math.max(out[y * aw + x], v) : v; } };
async function getSegmenter(log) {
  if (segmenter !== null) return segmenter;
  let V, fs;
  try { V = await import(`${MPV}/+esm`); fs = await V.FilesetResolver.forVisionTasks(`${MPV}/wasm`); }
  catch (e) { log('segmentation unavailable: ' + e.message); segmenter = false; segInfo = 'depth-threshold fallback'; return false; }
  const img = new ImageData(266, 196); for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) & 255;
  // 1) pose landmarker (GPU delegate only: its CPU path aborts in current tasks-vision builds when masks are requested)
  try {
    const pl = await V.PoseLandmarker.createFromOptions(fs, {baseOptions: {modelAssetPath: POSE_MODEL, delegate: 'GPU'}, runningMode: 'IMAGE', numPoses: 3, outputSegmentationMasks: true,
      minPoseDetectionConfidence: .4, minPosePresenceConfidence: .4});
    const run = (id) => { const aw = id.width, ah = id.height, out = new Float32Array(aw * ah); const r = pl.detect(id);
      (r.segmentationMasks || []).forEach(m => { resample(m.getAsFloat32Array(), m.width, m.height, aw, ah, out, true); m.close(); }); return out; };
    run(img); segmenter = run; segInfo = 'MediaPipe PoseLandmarker-lite mask (GPU)'; log('segmentation: ' + segInfo); return segmenter;
  } catch (e) { log('segmentation: pose landmarker unavailable (' + e.message + '), trying selfie segmenter'); }
  // 2) selfie multiclass, benchmark GPU vs CPU and keep the faster
  const cands = [];
  for (const delegate of ['GPU', 'CPU']) {
    try { const sg = await V.ImageSegmenter.createFromOptions(fs, {baseOptions: {modelAssetPath: SEG_MODEL, delegate}, runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true});
      const run1 = () => { const r = sg.segment(img); r.confidenceMasks[0].getAsFloat32Array(); r.close?.(); }; run1(); const t = performance.now(); for (let i = 0; i < 3; i++) run1(); const ms = (performance.now() - t) / 3;
      log(`segmentation selfie ${delegate}: ${ms.toFixed(0)} ms/frame`); cands.push({sg, delegate, ms}); if (delegate === 'GPU' && ms < 60) break;
    } catch (e) { log(`segmentation selfie ${delegate} failed: ${e.message}`); }
  }
  if (cands.length) { cands.sort((a, b) => a.ms - b.ms); cands.slice(1).forEach(c => c.sg.close?.()); const sg = cands[0].sg;
    segmenter = (id) => { const aw = id.width, ah = id.height, out = new Float32Array(aw * ah); const r = sg.segment(id); const bg = r.confidenceMasks[0];
      const a = bg.getAsFloat32Array(); for (let i = 0; i < a.length; i++) a[i] = 1 - a[i]; resample(a, bg.width, bg.height, aw, ah, out, false); r.close?.(); return out; };
    segInfo = `MediaPipe selfie-multiclass (${cands[0].delegate})`; log('segmentation: ' + segInfo); return segmenter; }
  segmenter = false; segInfo = 'depth-threshold fallback'; log('segmentation: using depth-threshold fallback'); return false;
}

// connected components on a binary mask (for removing pillar-like false positives)
function components(bin, w, h) {
  const lab = new Int32Array(w * h).fill(-1), out = []; const st = [];
  for (let i = 0; i < w * h; i++) { if (!bin[i] || lab[i] >= 0) continue; const id = out.length; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0; st.push(i); lab[i] = id; const px = [];
    while (st.length) { const p = st.pop(); px.push(p); n++; const x = p % w, y = (p / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const q of [p - 1, p + 1, p - w, p + w]) { if (q < 0 || q >= w * h || lab[q] >= 0 || !bin[q]) continue; if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue; lab[q] = id; st.push(q); } }
    out.push({px, x0, y0, x1, y1, n}); }
  return out;
}

/**
 * Analyse a video. Returns bundle: {w,h,fps,n,frames:[Blob jpg], aw,ah,step,dm:[Uint8Array RGBA (R=depth,G=mask)], motion, piv:[[x,y,d]], area, info}
 */
export async function analyzeVideo(file, opts, log = () => {}, progress = () => {}) {
  const {fps = 30, colorW = 720, depthW = 266, step = 2, useCache = true} = opts;
  const key = `v5|${file.name}|${file.size}|${fps}|${colorW}|${depthW}|${step}`;
  if (useCache) { const c = await cacheGet(key); if (c) { log('analysis: loaded from cache'); return c; } }
  const v = await loadVideoEl(file);
  if (!Number.isFinite(v.duration) || v.duration <= 0) throw new Error('video duration is unknown');
  const dur = v.duration, sw = v.videoWidth, sh = v.videoHeight;
  const cw = Math.min(colorW, sw), ch = Math.round(cw * sh / sw / 2) * 2;
  const aw = Math.round(depthW / 14) * 14, ah = Math.max(14, Math.round(aw * sh / sw / 14) * 14);
  const n = Math.floor(dur * fps);
  log(`video: ${sw}x${sh}, ${dur.toFixed(2)}s -> ${n} frames @${fps}fps; colour ${cw}x${ch}, depth ${aw}x${ah} every ${step} frame(s)`);
  const cc = new OffscreenCanvas(cw, ch), cx = cc.getContext('2d');
  const ac = new OffscreenCanvas(aw, ah), ax = ac.getContext('2d', {willReadFrequently: true});
  const D = await getDepth(log); const seg = await getSegmenter(log);
  const frames = [], dmRaw = [], motion = []; let prevGray = null; let lo = null, hi = null;
  const t0 = performance.now(); const tm = {seek: 0, depth: 0, seg: 0}; let tq;
  for (let i = 0; i < n; i++) {
    tq = performance.now();
    await seek(v, Math.min(dur - .001, (i + .5) / fps));
    tm.seek += performance.now() - tq;
    cx.drawImage(v, 0, 0, cw, ch);
    frames.push(await cc.convertToBlob({type: 'image/jpeg', quality: .88}));
    ax.drawImage(v, 0, 0, aw, ah);
    const imgD = ax.getImageData(0, 0, aw, ah), img = imgD.data;
    // motion (frame diff on gray)
    const gray = new Float32Array(aw * ah); for (let p = 0; p < aw * ah; p++) gray[p] = .299 * img[p * 4] + .587 * img[p * 4 + 1] + .114 * img[p * 4 + 2];
    let md = 0; if (prevGray) { for (let p = 0; p < gray.length; p++) md += Math.abs(gray[p] - prevGray[p]); md /= gray.length; } motion.push(md); prevGray = gray;
    if (i % step === 0) {
      // depth
      const px = new Float32Array(3 * aw * ah), mean = [.485, .456, .406], sd = [.229, .224, .225];
      for (let p = 0; p < aw * ah; p++) for (let c = 0; c < 3; c++) px[c * aw * ah + p] = (img[p * 4 + c] / 255 - mean[c]) / sd[c];
      tq = performance.now();
      const out = await D.m({pixel_values: new D.T.Tensor('float32', px, [1, 3, ah, aw])});
      const pd = out.predicted_depth.data; const srt = Float32Array.from(pd).sort();
      const l = srt[Math.floor(srt.length * .02)], h = srt[Math.floor(srt.length * .995)];
      lo = lo == null ? l : .8 * lo + .2 * l; hi = hi == null ? h : .8 * hi + .2 * h;
      const dep = new Float32Array(aw * ah); for (let p = 0; p < dep.length; p++) dep[p] = clamp((pd[p] - lo) / (hi - lo + 1e-6));
      tm.depth += performance.now() - tq; tq = performance.now();
      // person mask
      let mask = new Float32Array(aw * ah);
      if (seg) mask = seg(imgD);
      else { // fallback: nearest depth band in the middle of the frame
        const s2 = Float32Array.from(dep).sort(), th = s2[Math.floor(s2.length * .8)];
        for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) { const c = 1 - Math.abs(x / aw - .5) * 1.4; mask[y * aw + x] = dep[y * aw + x] > th && c > 0 ? 1 : 0; } }
      tm.seg += performance.now() - tq;
      dmRaw.push({dep, mask});
    }
    if (i % 5 === 0) { const el = (performance.now() - t0) / 1000; progress(i / n, `analysing frame ${i + 1}/${n} (${(el / (i + 1)).toFixed(2)} s/frame, ${depthDevice})`); }
  }
  log(`analysis timing: seek+decode ${(tm.seek / n).toFixed(0)} ms/frame, depth ${(tm.depth / Math.ceil(n / step)).toFixed(0)} ms/inference, segmentation ${(tm.seg / Math.ceil(n / step)).toFixed(0)} ms/frame`);
  progress(1, 'post-processing');
  // temporal smoothing (only where neighbours agree), pillar false-positive removal, pack RGBA
  const N = dmRaw.length, dm = [], area = [], cxs = [], cys = [], pds = [];
  for (let k = 0; k < N; k++) {
    const {dep, mask} = dmRaw[k], ds = Float32Array.from(dep), ms = Float32Array.from(mask);
    for (const j of [k - 1, k + 1]) { if (j < 0 || j >= N) continue; const b = dmRaw[j];
      for (let p = 0; p < ds.length; p++) { if (Math.abs(b.dep[p] - dep[p]) < .08) ds[p] = (ds[p] + b.dep[p] * .5) / 1.5; if (Math.abs(b.mask[p] - mask[p]) < .3) ms[p] = (ms[p] + b.mask[p] * .5) / 1.5; } }
    const bin = new Uint8Array(ms.length); for (let p = 0; p < ms.length; p++) bin[p] = ms[p] > .4 ? 1 : 0;
    for (const c of components(bin, aw, ah)) { let dsum = 0; for (const p of c.px) dsum += ds[p];
      if ((c.y0 < 3 && c.y1 - c.y0 > .8 * ah && dsum / c.n > .7) || c.n < aw * ah * .002) for (const p of c.px) ms[p] = 0; }
    const rgba = new Uint8Array(aw * ah * 4); let a = 0, sx = 0, sy = 0; const dl = [];
    for (let p = 0; p < ms.length; p++) { rgba[p * 4] = ds[p] * 255; rgba[p * 4 + 1] = ms[p] * 255; rgba[p * 4 + 3] = 255;
      if (ms[p] > .5) { a++; sx += p % aw; sy += (p / aw) | 0; dl.push(ds[p]); } }
    dm.push(rgba); area.push(a / ms.length);
    if (a / ms.length > .01) { dl.sort(); cxs.push(sx / a / aw); cys.push(sy / a / ah); pds.push(dl[dl.length >> 1]); } else { cxs.push(NaN); cys.push(NaN); pds.push(NaN); }
  }
  const sx = gaussSmooth(fillNaN(cxs), 2), sy = gaussSmooth(fillNaN(cys), 2), sp = gaussSmooth(fillNaN(pds), 2);
  const bundle = {w: cw, h: ch, srcW: sw, srcH: sh, fps, n, dur: n / fps, frames, aw, ah, step, dm, motion, area, piv: sx.map((x, i) => [x, sy[i], sp[i]]),
    info: {depth: depthDevice, seg: segInfo, secPerFrame: (performance.now() - t0) / 1000 / n}};
  if (useCache) await cachePut(key, bundle);
  URL.revokeObjectURL(v.src);
  return bundle;
}
