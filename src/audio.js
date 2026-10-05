// Audio: decode, low-band kick flux, tempo + phase, bars/downbeats, drop detection, punchiest-section pick, final mix.
import { clamp } from './util.js';
const ASR = 22050, HOP = 128, HT = HOP / ASR;

export async function decodeAudioFile(file, sampleRate = 48000) {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, sampleRate);
  return await ctx.decodeAudioData(buf);
}
async function renderMono(ab, sr, lowpassHz) {
  const len = Math.ceil(ab.duration * sr);
  const ctx = new OfflineAudioContext(1, len, sr);
  const src = ctx.createBufferSource(); src.buffer = ab;
  let node = src;
  if (lowpassHz) for (let i = 0; i < 2; i++) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpassHz; f.Q.value = .707; node.connect(f); node = f; }
  node.connect(ctx.destination); src.start();
  return (await ctx.startRendering()).getChannelData(0);
}
function frameRms(x) { const n = Math.floor(x.length / HOP), o = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < HOP; j++) { const v = x[i * HOP + j]; s += v * v; } o[i] = Math.sqrt(s / HOP); } return o; }
function flux(e) { const o = new Float32Array(e.length); let p = Math.log(1e-5 + e[0]);
  for (let i = 1; i < e.length; i++) { const l = Math.log(1e-5 + e[i]); o[i] = Math.max(0, l - p); p = l; } return o; }

export async function analyzeAudio(ab, onProgress = () => {}) {
  onProgress('audio: filtering');
  const full = await renderMono(ab, ASR, 0), low = await renderMono(ab, ASR, 150);
  const rms = frameRms(full), lowE = frameRms(low), kf = flux(lowE), n = kf.length;
  // normalise kick flux
  const sorted = Float32Array.from(kf).sort(); const p99 = sorted[Math.floor(n * .995)] || 1;
  for (let i = 0; i < n; i++) kf[i] = Math.min(1.5, kf[i] / p99);
  onProgress('audio: tempo');
  // tempo + phase: comb filter over the whole track (mean kick flux at the beat positions).
  // coarse scan 80-180 BPM, then fine scan; mild prior toward 95-170 to avoid octave errors.
  const comb = (bpm, ph) => { const P = 60 / bpm; let s = 0, c = 0; for (let t = ph; t < ab.duration; t += P) { const i = Math.round(t / HT); if (i < 1 || i >= n - 1) continue; s += Math.max(kf[i - 1], kf[i], kf[i + 1]); c++; } return c ? s / c : 0; };
  const prior = bpm => (bpm >= 95 && bpm <= 170) ? 1 : .9;
  let bb = {s: -1};
  for (let bpm = 80; bpm <= 180; bpm += .25) { const P = 60 / bpm; for (let ph = 0; ph < P; ph += .008) { const s = comb(bpm, ph) * prior(bpm); if (s > bb.s) bb = {s, bpm, ph}; } }
  const c0 = bb.bpm; bb = {s: -1};
  for (let bpm = c0 - .4; bpm <= c0 + .4; bpm += .01) { const P = 60 / bpm; for (let ph = 0; ph < P; ph += HT / 2) { const s = comb(bpm, ph); if (s > bb.s) bb = {s, bpm, ph}; } }
  const bpm = bb.bpm, P = 60 / bpm, phase = bb.ph;
  // kick peaks for verification
  const peaks = []; const W8 = Math.round(.08 / HT); let lastPk = -1;
  for (let i = W8; i < n - W8; i++) { if (kf[i] < .45) continue; let ok = true; for (let j = i - W8; j <= i + W8; j++) if (kf[j] > kf[i]) { ok = false; break; } if (ok && i * HT - lastPk > .1) { peaks.push(i * HT); lastPk = i * HT; } }
  const strong = peaks.filter(t => kf[Math.round(t / HT)] > .8);
  const H8 = P / 2, onGrid = strong.filter(t => { const d = ((t - phase) % H8 + H8) % H8; return Math.min(d, H8 - d) < .03; }).length; // verify: strong low-band hits land on the 1/8 grid
  // beats
  const beats = []; for (let t = phase; t < ab.duration; t += P) beats.push(t);
  const at = (arr, t, w = .03) => { const a = Math.max(0, Math.floor((t - w) / HT)), b = Math.min(n - 1, Math.ceil((t + w) / HT)); let m = 0; for (let i = a; i <= b; i++) m = Math.max(m, arr[i]); return m; };
  const meanR = (t0, t1) => { const a = Math.max(0, Math.floor(t0 / HT)), b = Math.min(n, Math.ceil(t1 / HT)); let s = 0; for (let i = a; i < b; i++) s += rms[i]; return b > a ? s / (b - a) : 0; };
  const beatKick = beats.map(t => at(kf, t)), beatRms = beats.map(t => meanR(t, t + P));
  // downbeat offset: section changes (rms jumps) happen on downbeats; kicks on downbeats are usually strongest
  const nov = beats.map((t, k) => Math.max(0, beatRms[k] - (k >= 2 ? (beatRms[k - 1] + beatRms[k - 2]) / 2 : beatRms[k])));
  let dOff = 0, dBest = -1;
  for (let d = 0; d < 4; d++) { let s = 0; for (let k = d; k < beats.length; k += 4) s += nov[k] * 3 + beatKick[k] * .2; if (s > dBest) { dBest = s; dOff = d; } }
  const bars = []; for (let k = dOff; k < beats.length; k += 4) bars.push({k, t: beats[k], e: 0});
  for (const b of bars) { let s = 0, kk = 0; for (let j = 0; j < 4 && b.k + j < beats.length; j++) { s += beatRms[b.k + j]; kk += beatKick[b.k + j]; } b.e = (s / 4) * (.5 + kk / 4); }
  const es = bars.map(b => b.e).sort((a, b) => a - b), e70 = es[Math.floor(es.length * .7)] || 0;
  bars.forEach((b, i) => { const prev = i > 1 ? (bars[i - 1].e + bars[i - 2].e) / 2 : i > 0 ? bars[0].e : 0; b.dropS = clamp((b.e / Math.max(prev, 1e-6) - 1) / 3); b.drop = b.e >= e70 && b.dropS > .15; });
  onProgress(`audio: ${bpm.toFixed(2)} BPM, ${(100 * onGrid / Math.max(1, strong.length)).toFixed(0)}% of strong kicks on the 1/8 grid`);
  // waveform envelope for display
  const W = 1200, wf = new Float32Array(W); const ch = full; const step = ch.length / W;
  for (let i = 0; i < W; i++) { let m = 0; const a = Math.floor(i * step), b = Math.floor((i + 1) * step); for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(ch[j])); wf[i] = m; }
  return {duration: ab.duration, bpm, P, phase, beats, beatKick, beatRms, bars, kickOnGrid: onGrid / Math.max(1, strong.length), nKicks: peaks.length, waveform: wf};
}

// choose the punchiest window of length dur starting on a downbeat (bonus if it is a drop)
export function pickSection(A, dur) {
  let best = null; const maxE = Math.max(...A.bars.map(b => b.e), 1e-9);
  for (let i = 0; i < A.bars.length; i++) {
    const s = A.bars[i].t; if (s + dur > A.duration + .05) break;
    let sum = 0, c = 0; for (let j = i; j < A.bars.length && A.bars[j].t < s + dur; j++) { sum += A.bars[j].e; c++; }
    const lowest = Math.min(...A.bars.slice(i, i + Math.max(1, c)).map(b => b.e));
    const score = sum / c / maxE + .6 * (A.bars[i].drop ? A.bars[i].dropS : 0) + .25 * lowest / maxE;
    if (!best || score > best.score) best = {i, t: s, score, drop: A.bars[i].drop};
  }
  if (!best) best = {i: 0, t: A.bars[0]?.t || 0, score: 0, drop: false};
  return best;
}

// beat grid relative to the output timeline (song start = startTime)
export function gridFor(A, startTime, dur, downbeatT) {
  const beats = [], kick = [];
  A.beats.forEach((t, k) => { const r = t - startTime; if (r >= -1e-3 && r < dur) { beats.push(Math.max(0, r)); kick.push(A.beatKick[k]); } });
  const db = downbeatT != null ? downbeatT : A.bars.reduce((m, b) => (b.t >= startTime - 1e-3 && (m == null || b.t < m)) ? b.t : m, null);
  const firstBar = beats.findIndex(b => Math.abs(b - (db - startTime)) < .02);
  return {beats, kick, barOffset: Math.max(0, firstBar), P: A.P};
}

// final mix: slice, fades, rough loudness normalisation (-14 LUFS-ish via RMS), soft limiter
export async function renderSection(ab, start, dur, {fadeOut = .3, targetDb = -14} = {}) {
  const sr = 48000, len = Math.ceil(dur * sr);
  const ctx = new OfflineAudioContext(2, len, sr);
  const src = ctx.createBufferSource(); src.buffer = ab;
  const g = ctx.createGain(), lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = .001; lim.release.value = .08;
  // measure rms of the window
  const ch = ab.getChannelData(0), a = Math.floor(start * ab.sampleRate), b = Math.min(ch.length, Math.floor((start + dur) * ab.sampleRate));
  let s = 0, c = 0; for (let i = a; i < b; i += 8) { s += ch[i] * ch[i]; c++; }
  const rmsDb = 10 * Math.log10(s / Math.max(1, c) + 1e-12), gain = Math.pow(10, clamp(targetDb - rmsDb, -24, 18) / 20);
  g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(gain, .005);
  g.gain.setValueAtTime(gain, Math.max(.01, dur - fadeOut)); g.gain.linearRampToValueAtTime(0, dur);
  src.connect(g); g.connect(lim); lim.connect(ctx.destination); src.start(0, Math.max(0, start));
  return await ctx.startRendering();
}
