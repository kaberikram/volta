import {decodeAudioFile, analyzeAudio, pickSection, gridFor, renderSection} from './audio.js';
import {analyzeVideo} from './video.js';
import {makePlan, describePlan} from './planner.js';
import {DotRenderer} from './renderer.js';
import {exportMp4, exportWebm} from './exporter.js';
import {clamp} from './util.js';

const $ = id => document.getElementById(id);
const S = {videoFile: null, audioFile: null, video: null, songBuf: null, A: null, start: 0, mix: null, grid: null, plan: null, playing: false, busy: false, lastExport: null};
window.dotfx = S;
const logEl = $('log');
function logKind(m) {
  const s = String(m);
  if (/^ERROR\b|\berror\b/i.test(s)) return 'bad';
  if (/^ready\b|^exported\b|loaded from cache|\bOK\b/i.test(s)) return 'good';
  if (/fail|unavailable|fallback|not available|^pick a\b/i.test(s)) return 'warn';
  return '';
}
const log = m => {
  const line = document.createElement('span');
  const kind = logKind(m);
  if (kind) line.className = kind;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${m}`;
  console.log('[dotfx]', m);
  logEl.append(line);
  logEl.scrollTop = 1e9;
};
const progress = (p, txt) => { $('bar').style.width = (clamp(p) * 100).toFixed(1) + '%'; $('progTxt').textContent = txt || ''; $('prog').hidden = false; };
window.addEventListener('error', e => log('ERROR ' + e.message));
window.addEventListener('unhandledrejection', e => log('ERROR ' + (e.reason && e.reason.message || e.reason)));

const R = new DotRenderer($('view'));
S.renderer = R;
const opts = () => ({seed: +$('seed').value || 1, intensity: +$('intensity').value, strobe: +$('strobe').value, palette: $('palette').value});
const fps = () => +$('fps').value;

function outSize(maxH) {
  const V = S.video; const a = $('aspect').value;
  const ar = a === 'source' ? (V ? V.srcW / V.srcH : 4 / 3) : a === '9:16' ? 9 / 16 : a === '1:1' ? 1 : 16 / 9;
  let H = maxH, W = H * ar;
  if (ar > 1) { W = maxH * ar; if (W > 1920) { W = 1920; H = W / ar; } }
  const ev = x => Math.max(16, Math.round(x / 2) * 2);
  return [ev(W), ev(H)];
}
function previewSize() { const [W, H] = outSize(+$('size').value); const k = Math.min(1, 720 / Math.max(W, H)); return [Math.round(W * k / 2) * 2, Math.round(H * k / 2) * 2]; }

// ---------- audio ----------
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function laneSize(c) {
  const dpr = devicePixelRatio || 1, cssW = c.clientWidth || 600, cssH = c.clientHeight || 48;
  c.width = Math.max(1, Math.round(cssW * dpr)); c.height = Math.max(1, Math.round(cssH * dpr));
  c.parentElement.style.setProperty('--lane-h', cssH + 'px');
  return {g: c.getContext('2d'), dpr, W: c.width, H: c.height};
}
function drawWave() {
  const c = $('wave'), {g, dpr, W, H} = laneSize(c), start = $('start');
  g.clearRect(0, 0, W, H); g.fillStyle = cssVar('--lane'); g.fillRect(0, 0, W, H);
  if (!S.A || !S.video) {
    g.fillStyle = cssVar('--line'); g.fillRect(0, H / 2 - dpr, W, 2 * dpr);
    start.style.setProperty('--win', '0px'); drawBeats(); return;
  }
  const A = S.A, wf = A.waveform, n = wf.length, mx = Math.max(...wf, 1e-6), D = A.duration, dur = S.video.dur;
  const x0 = S.start / D * W, x1 = (S.start + dur) / D * W, accent = cssVar('--accent'), mute = cssVar('--wave-mute');
  g.fillStyle = cssVar('--wave-wash'); g.fillRect(x0, 0, Math.max(0, x1 - x0), H);
  for (let i = 0; i < n; i++) { const x = i / n * W, h = wf[i] / mx * H * .86, inW = x >= x0 && x <= x1; g.fillStyle = inW ? accent : mute; g.fillRect(x, (H - h) / 2, Math.max(1, W / n), h); }
  g.fillStyle = accent; for (const b of A.bars) if (b.drop) g.fillRect(b.t / D * W, 0, Math.max(2, 2 * dpr), 8 * dpr);
  const win = D > 0 ? dur / D * c.clientWidth : c.clientWidth;
  start.style.setProperty('--win', Math.min(c.clientWidth, Math.max(8, win)) + 'px');
  drawBeats();
}
function drawBeats() {
  const c = $('beats'), {g, dpr, W, H} = laneSize(c);
  const mute = cssVar('--wave-mute'), accent = cssVar('--accent'), line = cssVar('--line'), ink = cssVar('--ink');
  g.clearRect(0, 0, W, H); g.fillStyle = cssVar('--lane'); g.fillRect(0, 0, W, H);
  const ruler = 14 * dpr; g.fillStyle = line; g.fillRect(0, ruler, W, dpr);
  if (!S.A || !S.video) return;
  const A = S.A, dur = S.video.dur || .001, t0 = S.start, D = A.duration, x = t => (t - t0) / dur * W;
  const wf = A.waveform, n = wf.length, mx = Math.max(...wf, 1e-6);
  const i0 = Math.max(0, Math.floor(t0 / D * n)), i1 = Math.min(n, Math.ceil((t0 + dur) / D * n));
  g.fillStyle = mute; const barW = Math.max(dpr, W / Math.max(1, i1 - i0));
  for (let i = i0; i < i1; i++) { const h = wf[i] / mx * (H - ruler - 16 * dpr) * .85, px = x((i + .5) / n * D); g.fillRect(px, ruler + (H - ruler - h) / 2, barW, h); }
  g.font = `${11 * dpr}px ${cssVar('--font-ui')}`; g.textBaseline = 'top'; g.fillStyle = mute;
  const step = dur > 30 ? 5 : dur > 12 ? 2 : 1;
  for (let s = 0; s <= dur + 1e-6; s += step) { const px = x(t0 + s); g.fillRect(px, ruler - 6 * dpr, dpr, 6 * dpr); if (px < W - 24 * dpr) g.fillText(s + 's', px + 3 * dpr, dpr); }
  const y = H - 8 * dpr;
  for (const t of A.beats) { if (t < t0 - 1e-3 || t >= t0 + dur) continue; g.beginPath(); g.arc(x(t), y, 1.6 * dpr, 0, Math.PI * 2); g.fill(); }
  for (const b of A.bars) {
    if (b.t < t0 - 1e-3 || b.t >= t0 + dur) continue;
    const px = x(b.t), r = 4.5 * dpr; g.fillStyle = b.drop ? accent : ink;
    g.beginPath(); g.moveTo(px, y - r); g.lineTo(px + r * .7, y); g.lineTo(px, y + r); g.lineTo(px - r * .7, y); g.closePath(); g.fill();
    g.fillStyle = mute;
  }
  if (document.body.dataset.ready) {
    const px = +$('scrub').value * W;
    g.strokeStyle = accent; g.lineWidth = Math.max(1, dpr); g.setLineDash([3 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(px, 6 * dpr); g.lineTo(px, H); g.stroke(); g.setLineDash([]);
    g.fillStyle = accent; g.fillRect(px - 3.5 * dpr, 0, 7 * dpr, 5 * dpr);
  }
}
function snapStart(t) {
  if (!$('snapBar').checked || !S.A || S.keep) return t;
  let best = t, bd = 1e9; for (const b of S.A.bars) { const d = Math.abs(b.t - t); if (d < bd) { bd = d; best = b.t; } } return best;
}
async function setStart(t, why) {
  const dur = S.video.dur, D = S.A.duration;
  const db = S.keep ? null : snapStart(t);
  S.start = S.keep ? 0 : clamp(db - 0.010, 0, Math.max(0, D - dur));
  $('start').max = Math.max(0.001, D - dur); $('start').value = S.start;
  $('startTxt').textContent = S.start.toFixed(2) + 's';
  S.mix = await renderSection(S.songBuf, S.start, dur, {fadeOut: S.keep ? .15 : .35});
  S.grid = gridFor(S.A, S.start, dur, S.keep ? null : db);
  log(`section ${why || ''}: ${S.start.toFixed(3)}s -> ${(S.start + dur).toFixed(3)}s, ${S.grid.beats.length} beats in window`);
  drawWave(); replan();
}
async function autoPick() {
  if (S.keep) return setStart(0, 'video audio');
  const p = pickSection(S.A, S.video.dur);
  log(`auto-pick: bar ${p.i} @ ${p.t.toFixed(2)}s score ${p.score.toFixed(2)}${p.drop ? ' (drop hit)' : ''}`);
  await setStart(p.t, 'auto');
}

// ---------- plan / preview ----------
function showOut() {
  const f = fps();
  if (!S.video && $('aspect').value === 'source') { $('outTxt').textContent = `${$('size').value}p · ${f} fps`; return; }
  const [W, H] = outSize(+$('size').value);
  $('outTxt').textContent = `${W} × ${H} · ${f} fps`;
}
function replan() {
  showOut();
  if (S.video) $('durTxt').textContent = S.video.dur.toFixed(2) + 's';
  if (!S.video || !S.grid) return;
  S.plan = makePlan(S.grid, S.video.dur, S.video, opts());
  document.body.dataset.ready = '1';
  $('planTxt').textContent = describePlan(S.plan);
  const [W, H] = previewSize(); R.setSize(W, H); R.setData(S.video, S.plan, fps());
  drawFrame(+$('scrub').value * S.video.dur);
}
let drawing = false, pending = null;
async function drawFrame(t) {
  if (!S.plan) return; if (drawing) { pending = t; return; }
  drawing = true; try { await R.renderAt(t); } catch (e) { log('render error ' + e.message); }
  drawing = false; $('time').textContent = t.toFixed(2) + 's';
  if (pending != null) { const p = pending; pending = null; drawFrame(p); }
}
let actx = null, srcNode = null, t0 = 0, off = 0;
function stop() { if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode = null; } S.playing = false; $('bPlay').textContent = '▶ Play'; }
async function play() {
  if (!S.plan || !S.mix) return; if (S.playing) { stop(); return; }
  actx = actx || new AudioContext(); await actx.resume();
  off = +$('scrub').value * S.video.dur; if (off >= S.video.dur - .05) off = 0;
  srcNode = actx.createBufferSource(); srcNode.buffer = S.mix; srcNode.connect(actx.destination);
  t0 = actx.currentTime + .03; srcNode.start(t0, off); S.playing = true; $('bPlay').textContent = '❚❚ Pause';
  const tick = async () => { if (!S.playing) return; const t = off + actx.currentTime - t0;
    if (t >= S.video.dur) { stop(); return; }
    $('scrub').value = Math.max(0, t) / S.video.dur;
    if (!drawing) { drawing = true; try { await R.renderAt(Math.max(0, Math.floor(t * fps()) / fps())); } catch (e) {} drawing = false; $('time').textContent = t.toFixed(2) + 's'; }
    requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

// ---------- pipeline ----------
async function analyze() {
  if (S.busy) return; S.videoFile = $('fVideo').files[0] || S.videoFile; S.audioFile = $('fAudio').files[0] || S.audioFile;
  S.keep = $('keepAudio').checked;
  if (!S.videoFile) { log('pick a video first'); return; }
  if (!S.keep && !S.audioFile) { log('pick a song, or tick "use the video\'s audio"'); return; }
  S.busy = true; stop(); setButtons();
  try {
    const t0 = performance.now(), q = $('quality').value;
    S.video = await analyzeVideo(S.videoFile, {fps: 30, colorW: 720, depthW: q === 'best' ? 322 : 266, step: q === 'best' ? 1 : 2}, log, progress);
    log(`video: ${S.video.srcW}x${S.video.srcH}, ${S.video.dur.toFixed(2)}s, ${S.video.n} frames; depth=${S.video.info.depth}, seg=${S.video.info.seg} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    progress(.97, 'analysing audio');
    S.songBuf = await decodeAudioFile(S.keep ? S.videoFile : S.audioFile);
    S.A = await analyzeAudio(S.songBuf);
    $('audioInfo').textContent = `${S.A.bpm.toFixed(1)} BPM · ${S.A.bars.length} bars · ${S.A.bars.filter(b => b.drop).length} drop hits · strong kicks on 1/8 grid ${(S.A.kickOnGrid * 100).toFixed(0)}% · song ${S.A.duration.toFixed(1)}s`;
    log('audio: ' + $('audioInfo').textContent);
    await autoPick();
    $('scrub').value = 0; drawFrame(0);
    progress(1, `ready - ${((performance.now() - t0) / 1000).toFixed(1)}s total`);
  } catch (e) { log('ERROR ' + e.message); console.error(e); progress(0, 'error: ' + e.message); throw e; }
  finally { S.busy = false; setButtons(); }
}
async function doExport() {
  if (!S.plan || S.busy) return; S.busy = true; stop(); setButtons();
  const [W, H] = outSize(+$('size').value), F = fps(), dur = S.video.dur, t0 = performance.now();
  let res;
  try {
    R.setSize(W, H); R.setData(S.video, S.plan, F);
    try { res = await exportMp4(R, S.mix, {W, H, fps: F, dur, bitrate: Math.round(W * H * F * +$('bitrate').value * (F > 30 ? .7 : 1))}, log, progress); }
    catch (e) { log('MP4/WebCodecs export failed (' + e.message + '), falling back to WebM'); res = await exportWebm(R, S.mix, {W, H, fps: F, dur}, log, progress); }
    res.seconds = (performance.now() - t0) / 1000; res.W = W; res.H = H; res.fps = F;
    S.lastExport = res;
    const url = URL.createObjectURL(res.blob), a = $('dl');
    a.href = url; a.download = `dotfx_seed${S.plan.seed}_${W}x${H}_${F}fps.${res.ext}`; a.textContent = `Download ${res.ext.toUpperCase()} (${(res.blob.size / 1e6).toFixed(1)} MB)`; a.style.display = 'inline-block';
    log(`exported ${W}x${H}@${F} ${res.videoCodec}+${res.audioCodec} ${(res.blob.size / 1e6).toFixed(2)}MB in ${res.seconds.toFixed(1)}s`);
    progress(1, 'export done');
  } catch (e) { log('ERROR export ' + e.message); console.error(e); throw e; }
  finally { const [pw, ph] = previewSize(); R.setSize(pw, ph); R.setData(S.video, S.plan, fps()); S.busy = false; setButtons(); drawFrame(+$('scrub').value * S.video.dur); }
  return res;
}
function setButtons() {
  for (const id of ['bAnalyze', 'bExport', 'bAuto', 'bReroll', 'bPlay']) $(id).disabled = S.busy || (id !== 'bAnalyze' && !S.plan);
  $('bAnalyze').classList.toggle('accent', !S.plan);
  $('bExport').classList.toggle('accent', !!S.plan);
}
function bindFileName(id, empty) {
  const input = $(id), name = input.parentElement.querySelector('.file-name');
  input.addEventListener('change', () => {
    const file = input.files[0];
    name.textContent = file ? file.name : empty;
    if (id === 'fVideo') $('clipName').textContent = file ? file.name : 'No clip';
  });
}
setButtons();
bindFileName('fVideo', 'Choose a clip');
bindFileName('fAudio', 'Choose a song');
drawWave();
showOut();

$('bAnalyze').onclick = () => analyze().catch(() => {});
$('bExport').onclick = () => doExport().catch(() => {});
$('bAuto').onclick = () => autoPick();
$('bReroll').onclick = () => { $('seed').value = (+$('seed').value || 1) + 1; replan(); };
$('bPlay').onclick = play;
$('start').oninput = () => { $('startTxt').textContent = (+$('start').value).toFixed(2) + 's'; S.start = +$('start').value; drawWave(); };
$('start').onchange = () => S.A && !S.keep && setStart(+$('start').value + .010, 'manual');
$('scrub').oninput = () => { if (S.playing) stop(); if (S.video) drawFrame(+$('scrub').value * S.video.dur); drawBeats(); };
for (const id of ['seed', 'fps', 'aspect', 'size']) $(id).onchange = replan;
const paletteNotes = {reference: 'red, cream, gold, blue'};
function showPalette() { $('paletteHint').textContent = paletteNotes[$('palette').value] || ''; }
$('palette').onchange = () => { showPalette(); replan(); };
for (const [id, txt] of [['intensity', 'intTxt'], ['strobe', 'strTxt']]) { $(id).oninput = () => $(txt).textContent = (+$(id).value).toFixed(2); $(id).onchange = replan; }
window.addEventListener('resize', drawWave);

// automation hooks (used by the headless test; harmless otherwise)
S.api = {analyze, doExport, replan, autoPick, setStart, set: (id, v) => { $(id).value = v; if (id === 'keepAudio') $(id).checked = !!v; },
  exportBase64: async () => { const r = S.lastExport; const buf = new Uint8Array(await r.blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); return btoa(s); }};
log('ready - WebGL2 OK. WebGPU: ' + ('gpu' in navigator ? 'API present' : 'not available (depth will use WASM)') + ', WebCodecs: ' + ('VideoEncoder' in window));
