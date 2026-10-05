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
export const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
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
