#!/usr/bin/env node
// Headless render regression test on synthetic inputs (no ML models, no network).
//   MODE=baseline node test/plates_e2e.mjs   -> render the plan at fixed key times, write test/fixtures/dots_hashes.json
//   node test/plates_e2e.mjs                 -> (MODE=check) re-render, compare hashes, scrub-order determinism,
//                                               PNG key frames + contact sheets in test/out/
// Optional env:
//   BASE=path.json   baseline file (default test/fixtures/dots_hashes.json)
//   INIT='{"opts":{"scene":"plates"}}'  JSON merged into H.init() options (baseline: stored in the file; check: overrides)
//   TAG=name         prefix of the PNGs written to test/out/ (default: baseline file name stem, e.g. "dots")
//   KEEP_OPEN=1      leave the server running after the run (manual inspection at /test/plates.html)
// Plates stage (MODE=check also runs these; MODE=stage / MODE=ui run one part):
//   SCENE=plates|mix (default plates)  SEED=1  PALETTE=reference  SIZE=540  FPS=30
//   FULL=1           also render every frame of the scene to test/out/<scene>.mp4 with a click track (needs ffmpeg)
//   SKIP_UI=1 / SKIP_STAGE=1
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { synthBundle, bundleDigest } from './synth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const MODE = (process.env.MODE || 'check').toLowerCase();
const BASE = path.resolve(ROOT, process.env.BASE || 'test/fixtures/dots_hashes.json');
const TAG = process.env.TAG || path.basename(BASE).replace(/_hashes\.json$|\.json$/, '');
const OUT = path.join(ROOT, 'test', 'out');
const PLAN_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plan_dots_legacy.json');
const DEFAULT_INIT = {seed: 1, palette: 'reference', size: 540, fps: 30, aspect: 'source', opts: {scene: 'dots'}};
const STAGE_KEYS = ['scene', 'sceneNote', 'stages', 'runs', 'stageBars', 'shots', 'ghosts', 'orbit'];
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];
const t0 = Date.now(), el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
const log = (...a) => console.log(el(), ...a);
if (!['baseline', 'check', 'stage', 'ui'].includes(MODE)) { console.error(`unknown MODE=${MODE} (baseline|check|stage|ui)`); process.exit(2); }

// ---------- playwright from the global node_modules
function loadPlaywright() {
  let groot = '/opt/node22/lib/node_modules';
  try { groot = execSync('npm root -g', {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim() || groot; } catch (e) { /* keep default */ }
  const exe = fs.existsSync(EXE) ? EXE : null;
  if (!exe) process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
  const req = createRequire(path.join(groot, 'noop.js'));
  return {pw: req('playwright'), exe, groot};
}

// ---------- static server (repo root) with cross-origin isolation headers
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'};
function serve() {
  const srv = http.createServer((req, res) => {
    let rel; try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400).end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      const h = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cache-Control': 'no-store'};
      if (err) { res.writeHead(404, h).end('not found'); return; }
      res.writeHead(200, {...h, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'}).end(buf);
    });
  });
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve(srv)); });
}
const isLocal = u => { try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'; } catch (e) { return /^(data|blob):/.test(u); } };

// ---------- helpers
const writePng = (file, dataUrl) => fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
const stripFx = p => { const {fx, ...rest} = p; void fx; return Object.fromEntries(Object.entries(rest).filter(([k]) => !STAGE_KEYS.includes(k))); };
const fmtT = t => t.toFixed(3).padStart(6);
const results = []; const check = (ok, name, detail = '') => { results.push({ok, name}); console.log(`${el()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); return ok; };
const warn = (name, detail) => console.log(`${el()} WARN  ${name}  ${detail}`);

const GL_CLEAN = {DEPTH_TEST: false, CULL_FACE: false, BLEND: false, POLYGON_OFFSET_FILL: false, SCISSOR_TEST: false, VERTEX_ARRAY_BINDING: 'default', FRAMEBUFFER_BINDING: null, error: 0};

/** plates stage: frames render through the stage, leave GL clean, are deterministic, and look like a dark laser stage. */
async function stageChecks(page, shoot, glExpect = GL_CLEAN) {
  const SCENE = process.env.SCENE || 'plates', fps = +(process.env.FPS || 30);
  const init = {seed: +(process.env.SEED || 1), palette: process.env.PALETTE || 'reference', size: +(process.env.SIZE || 540), fps, aspect: process.env.ASPECT || 'source', opts: {scene: SCENE}};
  const reinit = extra => page.evaluate(c => window.H.init(c), {...init, ...extra});
  let info = await reinit({});
  log(`stage ${SCENE}: ${info.W}x${info.H}@${fps} ${JSON.stringify(info.stage)} | ${info.describe.split('\n')[1]}`);
  if (!check(info.stage.ok && info.scene === SCENE && info.runs.length > 0, `stage ready for scene ${SCENE}`, JSON.stringify(info.stage))) return;
  const ft = t => Math.round(t * fps) / fps, inRun = t => info.runs.some(r => t >= r.t0 + 1e-6 && t < r.t1 - 1e-6), last = info.dur - 1 / fps, picks = [];
  const put = (label, t) => { t = ft(Math.min(last, Math.max(0, t))); if (inRun(t) && picks.length < 12 && !picks.some(p => Math.abs(p.t - t) < 3 / fps)) picks.push({label, t}); };
  for (const r of info.runs) { put('run-start', r.t0 + 2 / fps); put('run-mid', (r.t0 + r.t1) / 2); }
  for (const g of info.ghosts.filter(g => !g.seeded && !g.hidden).slice(0, 4)) put('spawn', g.t + 4 / fps);
  put('still', 6.5); put('still-late', 7.9); put('offgrid', 9.83); put('pan', 12.5); put('jump', 13.83);
  for (let k = 0; picks.length < 12 && k < 48; k++) put('even', (k + .5) / 48 * info.dur);
  picks.sort((a, b) => a.t - b.t);
  const shots = [];
  for (const p of picks) {
    const s = await shoot(p.t); shots.push(s);
    check(s.stats.stage === true && s.gl.error === 0, `stage frame t=${fmtT(p.t)} ${p.label.padEnd(9)} ${s.hash}`,
      `${s.stats.look.padEnd(7)} ${String(s.stats.shot).padEnd(5)} live ${s.stats.live} θ ${s.stats.theta} calm ${s.stats.calm} luma ${s.luma.toFixed(3)} red ${s.redFrac.toFixed(3)} cyan ${s.cyanFrac.toFixed(3)} ${s.ms}ms`);
    if (JSON.stringify(s.gl) !== JSON.stringify(glExpect)) check(false, `GL state after stage frame t=${fmtT(p.t)}`, `${JSON.stringify(s.gl)} != ${JSON.stringify(glExpect)}`);
    if (!(s.stats.live <= 16)) check(false, `ghost count t=${fmtT(p.t)}`, String(s.stats.live));
    if (!(s.luma > .01 && s.luma < .45)) check(false, `dark stage luma t=${fmtT(p.t)}`, s.luma.toFixed(3));
  }
  check(shots.every(s => JSON.stringify(s.gl) === JSON.stringify(glExpect)), 'GL state clean after every stage frame', JSON.stringify(glExpect));
  check(shots.some(s => s.redFrac > .003), 'red lasers / accents visible', shots.map(s => s.redFrac.toFixed(3)).join(' '));
  check(shots.some(s => s.cyanFrac > .0005), 'cyan light visible', shots.map(s => s.cyanFrac.toFixed(4)).join(' '));
  // scrub order, re-plan and frame rate must not change a frame
  for (const i of [1, Math.floor(picks.length / 2), picks.length - 2].filter(i => i >= 0 && i < picks.length)) {
    const t = picks[i].t, seq = [t, ft(Math.min(last, t + 4)), ft(Math.max(0, t - 3)), t], hs = [];
    for (const tt of seq) hs.push((await shoot(tt)).hash);
    check(hs[0] === hs[3] && hs[0] === shots[i].hash, `stage scrub-order determinism ${seq.map(x => x.toFixed(2)).join(' -> ')}`, hs.join(' '));
  }
  info = await reinit({}); { const s = await shoot(picks[0].t); check(s.hash === shots[0].hash, 'same frame after re-plan', `${shots[0].hash} ${s.hash}`); }
  { const i = Math.floor(picks.length / 2), t = picks[i].t; await reinit({fps: 60}); const s60 = await shoot(t); await reinit({});
    check(s60.stats.theta === shots[i].stats.theta && s60.stats.live === shots[i].stats.live, `30 vs 60 fps: same ring state at t=${t.toFixed(2)}`, `θ ${shots[i].stats.theta} / ${s60.stats.theta}`); }
  // fade lane at 0 shows the clip, identical to the dots edit (pick a time where both plans show the same footage frame)
  { const zero = [{t: 0, v: 0}, {t: info.dur, v: 0}]; let done = false;
    for (const p of picks) {
      await reinit({fx: zero}); const fA = await page.evaluate(t => window.H.footage(t), p.t), a = await shoot(p.t);
      await reinit({fx: zero, opts: {scene: 'dots'}}); const fB = await page.evaluate(t => window.H.footage(t), p.t), b = await shoot(p.t);
      if (fA !== fB) continue;
      check(a.hash === b.hash && a.stats.stage !== true, `fade lane at 0: stage frame == dots frame (t=${p.t.toFixed(2)})`, `${a.hash} ${b.hash}`); done = true; break;
    }
    if (!done) warn('fade lane check', 'no time with the same footage frame in both plans');
    await reinit({}); }
  // multisample path (the GPU tier), forced at 360p
  { const m = await reinit({size: 360, stageQ: {samples: 4}}); const s = await shoot(picks[0].t);
    check(m.stage.ok && s.gl.error === 0 && s.stats.stage === true, 'forced 4x MSAA stage frame', `samples ${m.stage.samples} hdr ${m.stage.hdr} ${s.hash}`); await reinit({}); }
  // cost vs the dots edit at the same size
  { const dotsInfo = await reinit({opts: {scene: 'dots'}}); void dotsInfo; let dm = 0; for (const p of picks.slice(0, 6)) dm += (await shoot(p.t)).ms; await reinit({});
    const sm = shots.slice(0, 6).reduce((a, s) => a + s.ms, 0), r = sm / Math.max(1, dm);
    (r < 3 ? check(true, 'stage cost vs dots', `${(sm / 6).toFixed(0)} vs ${(dm / 6).toFixed(0)} ms/frame (x${r.toFixed(2)})`) : warn('stage cost vs dots', `x${r.toFixed(2)} (${(sm / 6).toFixed(0)} vs ${(dm / 6).toFixed(0)} ms/frame)`)); }
  // key frames + contact sheet
  fs.mkdirSync(OUT, {recursive: true}); const items = [];
  for (const [i, p] of picks.entries()) { const url = await page.evaluate(tt => window.H.png(tt), p.t); writePng(path.join(OUT, `stage_${SCENE}_${String(i).padStart(2, '0')}_${p.t.toFixed(2)}s_${p.label}.png`), url);
    items.push({url, label: `${p.t.toFixed(2)}s ${p.label} ${shots[i].stats.look} ${shots[i].stats.shot}`}); }
  writePng(path.join(OUT, `stage_${SCENE}_contact.png`), await page.evaluate(([it, title]) => window.H.sheet(it, {cols: 4, w: 400, title}), [items, `stage ${SCENE}: ${info.W}x${info.H}@${fps} seed ${init.seed} ${init.palette}`]));
  log(`wrote stage_${SCENE}_contact.png and ${items.length} key frames to ${path.relative(ROOT, OUT)}/`);
  if (process.env.FULL) await renderMovie(page, init, info, SCENE);
}

/** every frame -> JPEGs -> ffmpeg MP4 with a click track on the beats (to judge the beat lock by eye and ear) */
async function renderMovie(page, init, info, SCENE) {
  const dir = path.join(OUT, `frames_${SCENE}`); fs.rmSync(dir, {recursive: true, force: true}); fs.mkdirSync(dir, {recursive: true});
  const nF = Math.round(info.dur * init.fps), tm = Date.now();
  for (let i = 0; i < nF; i++) { const r = await page.evaluate(t => window.H.jpg(t), i / init.fps);
    fs.writeFileSync(path.join(dir, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(r.url.slice(r.url.indexOf(',') + 1), 'base64'));
    if (i % 60 === 0) log(`movie ${SCENE}: frame ${i}/${nF} (${((Date.now() - tm) / Math.max(1, i) ).toFixed(0)} ms/frame)`); }
  const beats = await page.evaluate(() => window.H.grid.beats), sr = 48000, n = Math.ceil(info.dur * sr), pcm = new Int16Array(n);
  beats.forEach((b, k) => { const s0 = Math.round(b * sr), loud = k % 4 === 0 ? .9 : .45; for (let i = 0; i < .05 * sr && s0 + i < n; i++) pcm[s0 + i] += Math.round(32767 * loud * Math.exp(-i / (.012 * sr)) * Math.sin(2 * Math.PI * (k % 4 ? 1400 : 900) * i / sr)); });
  const wav = Buffer.alloc(44 + n * 2); wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40); Buffer.from(pcm.buffer).copy(wav, 44);
  const wavF = path.join(OUT, `click_${SCENE}.wav`), mp4 = path.join(OUT, `${SCENE}.mp4`); fs.writeFileSync(wavF, wav);
  try { execSync(`ffmpeg -hide_banner -loglevel error -y -framerate ${init.fps} -i "${dir}/%05d.jpg" -i "${wavF}" -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a aac -b:a 160k -shortest "${mp4}"`);
    check(fs.existsSync(mp4), `movie ${path.relative(ROOT, mp4)}`, `${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, ${nF} frames`); }
  catch (e) { check(false, 'ffmpeg', e.message.slice(0, 300)); }
}

/** the real editor (index.html) with the synthetic analysis injected: Scene control, plan text, timeline, preview. */
async function uiCheck(browser, origin) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}}), errs = [];
  page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await page.route('**/*', r => (isLocal(r.request().url()) ? r.continue() : r.abort()));
  await page.goto(`${origin}/index.html`, {waitUntil: 'load'}); await page.waitForFunction(() => window.dotfx && window.dotfx.api, null, {timeout: 30000});
  const pre = await page.evaluate(() => ({scene: document.getElementById('scene').value, hint: document.getElementById('sceneHint').textContent}));
  check(pre.scene === 'mix' && /dots/.test(pre.hint), 'UI: Scene defaults to dots + plates', JSON.stringify(pre));
  const r = await page.evaluate(async () => {
    const {synthBundle, synthAnalysis} = await import('/test/synth.js'), S = window.dotfx, V = await synthBundle({frames: 'browser'});
    S.video = V; S.A = synthAnalysis(V.dur); S.keep = false; S.fx = null;
    S.songBuf = new AudioBuffer({length: Math.ceil(S.A.duration * 48000), numberOfChannels: 2, sampleRate: 48000});
    await S.api.autoPick();
    const run = S.plan.runs[0], t = run ? (run.t0 + run.t1) / 2 : 1, sc = document.getElementById('scrub');
    sc.value = t / V.dur; sc.dispatchEvent(new Event('input')); await new Promise(res => setTimeout(res, 1500));
    return {scene: S.plan.scene, runs: S.plan.runs.length, ghosts: S.plan.ghosts.length, planTxt: document.getElementById('planTxt').textContent.split('\n').slice(0, 2).join(' / '), hint: document.getElementById('sceneHint').textContent};
  });
  check(r.scene === 'mix' && r.runs >= 1 && r.ghosts > 0 && /scene mix/.test(r.planTxt), 'UI: auto-edit alternates dots and plates', JSON.stringify(r));
  fs.mkdirSync(OUT, {recursive: true}); await page.screenshot({path: path.join(OUT, 'ui_mix.png')});
  for (const [val, re] of [['plates', /scene plates/], ['dots', /scene dots/]]) {
    await page.selectOption('#scene', val); await page.waitForTimeout(1500);
    const q = await page.evaluate(() => ({scene: window.dotfx.plan.scene, planTxt: document.getElementById('planTxt').textContent.split('\n')[1], hint: document.getElementById('sceneHint').textContent}));
    check(q.scene === val && re.test(q.planTxt), `UI: Scene -> ${val}`, JSON.stringify(q));
    if (val === 'plates') await page.screenshot({path: path.join(OUT, 'ui_plates.png')});
  }
  check(!errs.length, 'UI: no page errors', errs.join(' | ').slice(0, 300));
  await page.close();
}

async function main() {
  const {pw, exe, groot} = loadPlaywright();
  const srv = await serve(), port = srv.address().port, origin = `http://127.0.0.1:${port}`;
  log(`playwright ${pw.chromium ? 'ok' : '?'} from ${groot}; browser ${exe || '(PLAYWRIGHT_BROWSERS_PATH=' + process.env.PLAYWRIGHT_BROWSERS_PATH + ')'}; serving ${ROOT} at ${origin}`);
  const browser = await pw.chromium.launch({headless: true, args: ARGS, ...(exe ? {executablePath: exe} : {})});
  const page = await browser.newPage({viewport: {width: 1100, height: 700}});
  const pageProblems = [];
  page.on('console', m => { const ty = m.type(), tx = m.text();
    if (ty === 'error' || ty === 'warning' || tx.startsWith('[H]')) log(`page ${ty}:`, tx.slice(0, 400));
    if (ty === 'error' && !/Failed to load resource/.test(tx)) pageProblems.push(`console.error: ${tx.slice(0, 200)}`); });
  page.on('pageerror', e => { log('PAGEERROR', e.message); pageProblems.push(`pageerror: ${e.message}`); });
  page.on('requestfailed', r => { if (isLocal(r.url())) log('request failed', r.url(), r.failure()?.errorText); });
  await page.route('**/*', r => (isLocal(r.request().url()) ? r.continue() : r.abort()));
  try {
    await page.goto(`${origin}/test/plates.html`, {waitUntil: 'load'});
    await page.waitForFunction(() => window.H && window.H.ready, null, {timeout: 30000});
    const env = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c && c.getExtension('WEBGL_debug_renderer_info');
      return {webgl2: !!c, renderer: c ? (d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER)) : null, isolated: self.crossOriginIsolated}; });
    log(`browser ${browser.version()} | WebGL2 ${env.webgl2} | ${env.renderer} | crossOriginIsolated ${env.isolated}`);
    if (!env.webgl2) throw new Error('WebGL2 not available in headless chromium');

    const envInit = process.env.INIT ? JSON.parse(process.env.INIT) : {};
    const shoot = async t => { const a = Date.now(); const s = await page.evaluate(tt => window.H.shot(tt), t); s.ms = Date.now() - a; return s; };
    if (MODE === 'stage') await stageChecks(page, shoot);
    else if (MODE === 'ui') await uiCheck(browser, origin);
    else await dotsChecks(envInit, shoot, env);
  } catch (e) {
    check(false, 'harness run', e.stack || e.message);
  } finally {
    for (const p of pageProblems) check(false, 'page error', p);
    await browser.close();
    if (process.env.KEEP_OPEN) log(`server still running at ${origin}/test/plates.html (Ctrl+C to stop)`); else srv.close();
  }
  const fails = results.filter(r => !r.ok).length;
  log(`${MODE}: ${results.length - fails} passed, ${fails} failed`);
  process.exitCode = fails ? 1 : 0;

  async function dotsChecks(envInit, shoot, env) {
    let base = null;
    if (MODE === 'check') {
      if (!fs.existsSync(BASE)) throw new Error(`no baseline at ${path.relative(ROOT, BASE)}; run MODE=baseline node test/plates_e2e.mjs first`);
      base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
    }
    const init = {...DEFAULT_INIT, ...(base ? base.init : {}), ...envInit};
    const tb = Date.now();
    const info = await page.evaluate(cfg => window.H.init(cfg), init);
    log(`init ${JSON.stringify(init)} -> ${info.W}x${info.H} @${info.fps}fps, n=${info.n}, ${info.nSched} events, roles ${info.roles.join(' ')} (${((Date.now() - tb) / 1000).toFixed(1)}s incl. synthesising frames)`);

    // synthetic inputs: browser bundle vs Node bundle (same code; differences would mean engine-dependent Math)
    const dB = await page.evaluate(() => window.H.digest()), dN = bundleDigest(await synthBundle());
    if (JSON.stringify(dB) !== JSON.stringify(dN)) warn('bundle digest browser != node', `${JSON.stringify(dB)} vs ${JSON.stringify(dN)}`);
    else log(`bundle digest (browser == node): ${JSON.stringify(dB)}`);


    if (MODE === 'baseline') {
      const kt = await page.evaluate(() => window.H.keyTimes(12));
      const shots = [];
      for (const k of kt) { const s = await shoot(k.t); shots.push(s); log(`t=${fmtT(k.t)} f${String(k.f).padStart(3)} ${k.label.padEnd(11)} ${s.hash}  ${s.stats.look.padEnd(7)} luma ${s.luma.toFixed(3)} red ${s.redFrac.toFixed(3)} cyan ${s.cyanFrac.toFixed(3)} (${s.ms} ms)`); }
      // never write a nondeterministic baseline: re-render in reverse order and require identical pixels
      for (let i = kt.length - 1; i >= 0; i--) { const s = await shoot(kt[i].t); if (!check(s.hash === shots[i].hash, `baseline repeatability t=${fmtT(kt[i].t)} ${kt[i].label}`, s.hash === shots[i].hash ? '' : `${shots[i].hash} then ${s.hash}`)) break; }
      const gl0 = shots[0].gl;
      for (const s of shots) check(JSON.stringify(s.gl) === JSON.stringify(gl0) && s.gl.error === 0, `GL state after render t=${fmtT(s.t)}`, JSON.stringify(s.gl));
      if (results.every(r => r.ok) && !pageProblems.length) {
        const out = {about: 'DotRenderer framebuffer hashes (FNV-1a 32 of readPixels RGBA) on test/synth.js inputs. Regenerate: MODE=baseline node test/plates_e2e.mjs',
          size: init.size, W: info.W, H: info.H, fps: info.fps, init, browser: browser.version(), gl: env.renderer, bundle: dB,
          times: kt.map(k => k.t), frames: kt.map(k => k.f), labels: kt.map(k => k.label), hashes: shots.map(s => s.hash),
          stats: shots.map(s => ({look: s.stats.look, fi: s.stats.fi, freeze: s.stats.freeze, held: s.stats.held, luma: s.luma, redFrac: s.redFrac, cyanFrac: s.cyanFrac})), glState: gl0};
        fs.mkdirSync(path.dirname(BASE), {recursive: true}); fs.writeFileSync(BASE, JSON.stringify(out, null, 1) + '\n');
        log(`wrote ${path.relative(ROOT, BASE)}`);
      }
    } else {
      check(info.W === base.W && info.H === base.H && info.fps === base.fps, `output size ${info.W}x${info.H}@${info.fps}`, `baseline ${base.W}x${base.H}@${base.fps}`);
      if (base.browser !== browser.version()) warn('browser version differs from baseline', `${base.browser} -> ${browser.version()}`);
      // the plan the page rendered == the Node legacy fixture (only meaningful for the default dots config)
      const fx = fs.existsSync(PLAN_FIXTURE) ? JSON.parse(fs.readFileSync(PLAN_FIXTURE, 'utf8')) : null, key = `${init.seed}/${init.palette}`;
      if (fx && fx.plans[key] && JSON.stringify(init.opts || {}) === JSON.stringify({scene: 'dots'}) && (init.intensity ?? 1) === 1 && (init.strobe ?? .7) === .7) {
        const pagePlan = await page.evaluate(() => JSON.parse(JSON.stringify(window.H.plan)));
        check(JSON.stringify(stripFx(pagePlan)) === JSON.stringify(fx.plans[key]), `page plan == plan_dots_legacy.json[${key}]`);
      }
      const shots = [];
      for (let i = 0; i < base.times.length; i++) {
        const t = base.times[i], s = await shoot(t), b = base.stats[i]; shots.push(s);
        const ok = s.hash === base.hashes[i];
        check(ok, `t=${fmtT(t)} ${(base.labels[i] || '').padEnd(11)} ${s.hash}`, `${s.stats.look.padEnd(7)} luma ${s.luma.toFixed(3)} red ${s.redFrac.toFixed(3)} cyan ${s.cyanFrac.toFixed(3)} ${s.ms}ms` +
          (ok ? '' : `  | baseline ${base.hashes[i]} ${b.look} luma ${b.luma.toFixed(3)} red ${b.redFrac.toFixed(3)} cyan ${b.cyanFrac.toFixed(3)}`));
        if (JSON.stringify(s.gl) !== JSON.stringify(base.glState)) check(false, `GL state after render t=${fmtT(t)}`, `${JSON.stringify(s.gl)} != baseline ${JSON.stringify(base.glState)}`);
      }
      if (shots.every(s => JSON.stringify(s.gl) === JSON.stringify(base.glState))) check(true, 'GL state after every render matches baseline', JSON.stringify(base.glState));
      // scrub-order determinism: t, t+4, t-3, t
      const dur = info.dur, frameT = t => Math.round(t * info.fps) / info.fps, clampT = t => Math.min(dur - 1 / info.fps, Math.max(0, t));
      const scrubPicks = ['echo', 'pan', 'freeze'].map(l => base.labels.indexOf(l)).filter(i => i >= 0);
      for (const i of (scrubPicks.length ? scrubPicks : [Math.floor(base.times.length / 2)])) {
        const t = base.times[i], seq = [t, clampT(frameT(t + 4)), clampT(frameT(t - 3)), t], hs = [];
        for (const tt of seq) hs.push((await shoot(tt)).hash);
        check(hs[0] === hs[3] && hs[0] === base.hashes[i], `scrub-order determinism ${seq.map(x => x.toFixed(2)).join(' -> ')}`, hs.join(' '));
      }
      // key frames + contact sheets
      fs.mkdirSync(OUT, {recursive: true});
      const items = [];
      for (let i = 0; i < base.times.length; i++) {
        const t = base.times[i], url = await page.evaluate(tt => window.H.png(tt), t), name = `${TAG}_${String(i).padStart(2, '0')}_${t.toFixed(2)}s_${base.labels[i] || ''}.png`;
        writePng(path.join(OUT, name), url); items.push({url, label: `${t.toFixed(2)}s ${base.labels[i] || ''} ${shots[i].stats.look}`});
      }
      writePng(path.join(OUT, `${TAG}_contact.png`), await page.evaluate(([it, title]) => window.H.sheet(it, {cols: 4, w: 320, title}), [items, `${TAG}: ${info.W}x${info.H}@${info.fps} ${JSON.stringify(init)}`]));
      const synthT = [0.5, 3.4, 6.5, 9.83, 12.5, 13.83];
      writePng(path.join(OUT, 'synth_sheet.png'), await page.evaluate(ts => window.H.synthSheet(ts), synthT));
      log(`wrote ${items.length} key frames, ${TAG}_contact.png and synth_sheet.png to ${path.relative(ROOT, OUT)}/`);
      if (!process.env.SKIP_STAGE) await stageChecks(page, shoot, base.glState);
      if (!process.env.SKIP_UI) await uiCheck(browser, origin);
    }
  }
}
await main();
