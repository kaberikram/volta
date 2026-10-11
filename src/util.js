// small shared helpers: seeded RNG, math, IndexedDB cache
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOut = x => 1 - Math.pow(1 - clamp(x), 3);
export const easeIO = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export function rng(seed) {                   // mulberry32
  let a = (seed >>> 0) || 1;
  const f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  f.pick = arr => arr[Math.floor(f() * arr.length)];
  f.pickNot = (arr, not) => { const c = arr.filter(x => x !== not); return c.length ? f.pick(c) : f.pick(arr); };
  f.range = (a, b) => a + (b - a) * f();
  return f;
}
export const hex = h => { if (!/^#[0-9a-f]{6}$/i.test(h)) throw new Error('bad colour ' + h); return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
export const hsh = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
export function gaussSmooth(arr, sigma = 2) {
  const r = Math.ceil(sigma * 3), k = []; let s = 0;
  for (let i = -r; i <= r; i++) { const w = Math.exp(-i * i / (2 * sigma * sigma)); k.push(w); s += w; }
  return arr.map((_, i) => { let v = 0; for (let j = -r; j <= r; j++) v += arr[clamp(i + j, 0, arr.length - 1)] * k[j + r]; return v / s; });
}
export function fillNaN(arr) {
  const ok = arr.map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
  if (!ok.length) return arr.map(() => .5);
  return arr.map((v, i) => { if (Number.isFinite(v)) return v; let lo = null, hi = null;
    for (const p of ok) { if (p[0] < i) lo = p; else if (p[0] > i) { hi = p; break; } }
    if (!lo) return hi[1]; if (!hi) return lo[1]; const t = (i - lo[0]) / (hi[0] - lo[0]); return lo[1] + (hi[1] - lo[1]) * t; });
}
// --- tiny IndexedDB key/value cache
const DB = 'dotfx-cache', ST = 'kv';
function db() { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(ST); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
export async function cacheGet(key) { try { const d = await db(); return await new Promise((res, rej) => { const q = d.transaction(ST).objectStore(ST).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (e) { console.warn('cache get failed', e); return null; } }
export async function cachePut(key, val) { try { const d = await db(); await new Promise((res, rej) => { const tx = d.transaction(ST, 'readwrite'); tx.objectStore(ST).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) { console.warn('cache put failed', e); } }
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const smoothstep = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
export const easeIOC = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const backOut = (x, s = 1.7) => { x = clamp(x) - 1; return 1 + x * x * ((s + 1) * x + s); };
export const pct = (arr, p) => { const a = Float64Array.from(arr).sort(); return a.length ? a[clamp(Math.floor(p * (a.length - 1)), 0, a.length - 1)] : 0; };
export const angLerp = (a, b, t) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return a + d * t; };
// 3D / camera math shared by the dots renderer and the plates stage
export const DEG = Math.PI / 180, FOV0 = 40 * DEG, D0 = 1 / Math.tan(FOV0 / 2);
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], scl = (a, s) => a.map(x => x * s);
export const nrm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function lookAt(e, c, up) { const f = nrm(sub(c, e)), s = nrm(cross(f, up)), u = cross(s, f); return [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, e), -dot(u, e), dot(f, e), 1]; }
export function persp(fov, asp, n, f) { const k = 1 / Math.tan(fov / 2); return [k / asp, 0, 0, 0, 0, k, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; }
export function mm(a, b) { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; }
export const rotY = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
export const rotX = (v, a) => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
export const rotAxis = (v, k, a) => { const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v); return [0, 1, 2].map(i => v[i] * c + kv[i] * s + k[i] * kd * (1 - c)); };
export const elastic = (a, tau = .06, per = .2) => a < 0 ? 0 : Math.exp(-a / tau) * Math.cos(2 * Math.PI * a / per);
export const snap = a => a < 0 ? 0 : 1 - Math.exp(-a / .035) * Math.cos(2 * Math.PI * a / .3);
