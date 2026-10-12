#!/usr/bin/env node
// Live webcam mode, headless (no camera, no models):
//  1. harness: the synthetic dancer through the real live analyzer / bundle / director / renderer (test/live.html)
//  2. app smoke test: the real editor with Chromium's fake camera; MediaPipe is unreachable here, so the take runs in
//     brightness-depth mode (dots only); Go live -> Record -> Stop must produce a playable file with video and audio.
// Writes test/out/live_contact.png and test/out/live_take.(webm|mp4).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..'), OUT = path.join(ROOT, 'test', 'out');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const t0 = Date.now(), el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's', log = (...a) => console.log(el(), ...a);
const results = []; const check = (ok, name, detail = '') => { results.push(ok); console.log(`${el()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); return ok; };
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav'};
const isLocal = u => { try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost'; } catch (e) { return /^(data|blob):/.test(u); } };
function serve() {
  const srv = http.createServer((req, res) => { let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel); if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (e, b) => { const h = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cache-Control': 'no-store'};
      if (e) { res.writeHead(404, h).end(); return; } res.writeHead(200, {...h, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream'}).end(b); }); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}
// a 24 s, 128 BPM song with a kick on every beat (and a louder downbeat) so the beat tracker has something to lock to
function songWav(file) {
  const sr = 22050, dur = 24, n = sr * dur, pcm = new Int16Array(n), P = 60 / 128;
  for (let k = 0; k * P < dur; k++) { const s0 = Math.round((.25 + k * P) * sr), loud = k % 4 === 0 ? 1 : .7;
    for (let i = 0; i < .2 * sr && s0 + i < n; i++) { const tt = i / sr, f = 55 + 90 * Math.exp(-tt / .03); pcm[s0 + i] += Math.round(26000 * loud * Math.exp(-tt / .09) * Math.sin(2 * Math.PI * f * tt)); }
    const h0 = Math.round((.25 + (k + .5) * P) * sr); for (let i = 0; i < .03 * sr && h0 + i < n; i++) pcm[h0 + i] += Math.round(2500 * Math.exp(-i / (.008 * sr)) * Math.sin(i * 1.7) * Math.sin(i * 2.9)); }
  const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); Buffer.from(pcm.buffer).copy(b, 44); fs.writeFileSync(file, b);
}
const writePng = (f, url) => fs.writeFileSync(f, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));

async function main() {
  let groot = '/opt/node22/lib/node_modules'; try { groot = execSync('npm root -g', {encoding: 'utf8'}).trim() || groot; } catch (e) {}
  const {chromium} = createRequire(path.join(groot, 'noop.js'))('playwright');
  const srv = await serve(), origin = `http://127.0.0.1:${srv.address().port}`; fs.mkdirSync(OUT, {recursive: true});
  const browser = await chromium.launch({headless: true, ...(fs.existsSync(EXE) ? {executablePath: EXE} : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport: {width: 1400, height: 900}}); await ctx.grantPermissions(['camera']);
  const errs = [];
  try {
    // ---- 1. harness
    const page = await ctx.newPage(); page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await page.route('**/*', r => (isLocal(r.request().url()) ? r.continue() : r.abort()));
    await page.goto(`${origin}/test/live.html`); await page.waitForFunction(() => window.L && window.L.ready, null, {timeout: 30000});
    const shots = [45, 120, 200, 215, 240, 300, 380, 415].map(f => f);
    const run = await page.evaluate(sh => window.L.run({secs: 16, size: 540, scene: 'mix', shots: sh}), shots);
    const ms = run.ms.slice(20).sort((a, b) => a - b), med = ms[ms.length >> 1];
    log(`analyzer CPU per frame: median ${med.toFixed(1)} ms, p90 ${ms[Math.floor(ms.length * .9)].toFixed(1)} ms (SwiftShader page; real browsers are faster)`);
    const st = await page.evaluate(() => window.L.stats());
    check(st.calibrated && st.n === 480, 'live bundle grows frame by frame and calibrates', `n ${st.n}, k ${st.k.toFixed(3)}`);
    check(st.dmKept <= 80 && st.pool === 16, 'memory stays bounded (depth ring, GPU frame pool)', `dm kept ${st.dmKept}, pool ${st.pool}`);
    const pr = await page.evaluate(() => [window.L.probe(6.5), window.L.probe(3.4), window.L.probe(12.5)]);
    for (const [i, p] of pr.entries()) check(p.person > p.background + .2, `depth: person in front of the room (${['still', 'crouch', 'pan'][i]})`, JSON.stringify(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v == null ? v : +v.toFixed(3)]))));
    check(pr[0].torsoCentre > pr[0].torsoEdge + .02 || pr[0].torsoEdgeMask < .5, 'depth: round body (torso centre nearer than its edge)', `${pr[0].torsoCentre.toFixed(3)} vs ${pr[0].torsoEdge.toFixed(3)}`);
    check(pr[0].armR > pr[0].armL + .02, 'depth: the arm reaching to the camera comes forward (landmarks)', `right ${pr[0].armR.toFixed(3)} left ${pr[0].armL.toFixed(3)}`);
    const P = st.P, onGrid = t => { const x = (t - st.beats0) / (P / 2); return Math.abs(x - Math.round(x)) < 1e-6; }, vis = st.ghosts.filter(g => !g.hidden);
    check(st.runs.length > 0 && vis.length >= 3, 'live plates: ghosts print during the plates runs', `${st.ghosts.length} ghosts (${vis.length} visible), runs ${st.runs.map(r => r.t0.toFixed(1) + '-' + r.t1.toFixed(1)).join(' ')}`);
    check(st.ghosts.every(g => onGrid(g.t)), 'live plates: every print lands on the 1/8 beat grid');
    const calmStill = st.orbit.slice(7, 9).map(o => o.calm), calmMove = st.orbit.slice(1, 4).map(o => o.calm);     // t = 7.0, 7.9 vs 1-3 s
    check(Math.min(...calmStill) > .6 && Math.max(...calmMove) < .6, 'live orbit: calm while the dancer holds still', `still ${calmStill.map(x => x.toFixed(2))} moving ${calmMove.map(x => x.toFixed(2))}`);
    const stage = run.shots.filter(s => s.st.stage), bad = run.shots.filter(s => s.gl.error || s.gl.DEPTH_TEST || s.gl.BLEND || s.gl.VERTEX_ARRAY_BINDING !== 'default' || s.gl.FRAMEBUFFER_BINDING !== null);
    check(stage.length >= 2 && run.shots.length - stage.length >= 1, 'live frames render both scenes', `${stage.length} stage / ${run.shots.length - stage.length} dots`);
    check(!bad.length, 'GL state clean after live frames', JSON.stringify(bad.map(s => s.gl)));
    writePng(path.join(OUT, 'live_contact.png'), await page.evaluate(u => window.L.sheet(u), run.shots.map(s => s.png)));
    const lu = await page.evaluate(async () => { const r = await window.L.run({secs: 2, size: 360, luma: true, shots: [40]}); const p = window.L.probe(1); return {scene: window.L.last.plan.scene, ok: !r.shots[0].gl.error, p}; });
    check(lu.scene === 'dots' && lu.ok, 'brightness-depth fallback (no person detection) runs dots only', JSON.stringify(lu.scene));
    await page.close();
    // ---- 2. the real editor with the fake camera
    const wav = path.join(OUT, 'live_song.wav'); songWav(wav);
    const app = await ctx.newPage(); app.on('pageerror', e => errs.push('app: ' + e.message)); app.on('console', m => { if (/^\[dotfx\]/.test(m.text())) log('app', m.text().slice(8, 200)); });
    await app.route('**/*', r => (isLocal(r.request().url()) ? r.continue() : r.abort()));
    await app.goto(`${origin}/index.html`); await app.waitForFunction(() => window.dotfx && window.dotfx.api);
    await app.click('#srcCam'); await app.waitForFunction(() => document.getElementById('camWell').dataset.on === '1', null, {timeout: 15000});
    check(await app.evaluate(() => document.body.dataset.src === 'cam' && !!document.getElementById('camView').srcObject), 'Webcam source opens the camera');
    await app.setInputFiles('#fAudio', wav); await app.waitForFunction(() => window.dotfx.A && window.dotfx.plan, null, {timeout: 60000});
    const pre = await app.evaluate(() => ({bpm: window.dotfx.A.bpm, go: document.getElementById('bAnalyze').textContent, goOn: !document.getElementById('bAnalyze').disabled, runs: window.dotfx.plan.runs.length}));
    check(Math.abs(pre.bpm - 128) < 2 && pre.go === 'Go live' && pre.goOn, 'song analysed; Go live ready', JSON.stringify(pre));
    await app.evaluate(() => { window.dotfx.countIn = 1; });
    await app.click('#bExport');                                          // Record: a fresh take with the recorder on
    await app.waitForFunction(() => window.dotfx.liveOn && window.dotfx.liveSession.state === 'live', null, {timeout: 30000});
    await app.waitForTimeout(3500);
    const mid = await app.evaluate(() => ({n: window.dotfx.liveSession.V.n, scene: window.dotfx.plan.scene, note: window.dotfx.plan.sceneNote, rec: document.getElementById('recTxt').textContent, btn: document.getElementById('bExport').textContent, mode: window.dotfx.liveSession.mode}));
    check(mid.n > 30 && mid.btn === 'Stop' && /REC/.test(mid.rec), 'live take runs and records', JSON.stringify(mid));
    check(mid.mode !== 'luma' || (mid.scene === 'dots' && /person detection/.test(mid.note)), 'without person detection the take is dots only, with a note', JSON.stringify({mode: mid.mode, scene: mid.scene}));
    await app.click('#bExport');                                          // Stop: saves the take
    await app.waitForFunction(() => document.getElementById('dl').style.display !== 'none', null, {timeout: 20000});
    const file = await app.evaluate(async () => { const a = document.getElementById('dl'), b = await (await fetch(a.href)).blob(), u8 = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return {name: a.download, type: b.type, b64: btoa(s)}; });
    const take = path.join(OUT, 'live_take.' + (/mp4/.test(file.type) ? 'mp4' : 'webm')); fs.writeFileSync(take, Buffer.from(file.b64, 'base64'));
    let probe = ''; try { probe = execSync(`ffprobe -v error -show_entries stream=codec_type,codec_name -show_entries format=duration -of compact "${take}"`, {encoding: 'utf8'}); } catch (e) { probe = 'ffprobe failed: ' + e.message; }
    const dur = +((probe.match(/duration=([\d.]+)/) || [])[1] || 0);
    check(/codec_type=video/.test(probe) && /codec_type=audio/.test(probe) && dur > 2, 'recording has picture and song', `${file.type} ${probe.replace(/\n/g, ' ')}`);
    const after = await app.evaluate(() => ({live: window.dotfx.liveOn, go: document.getElementById('bAnalyze').textContent, rec: document.getElementById('bExport').textContent}));
    check(!after.live && after.go === 'Go live' && after.rec === 'Record', 'controls return after the take', JSON.stringify(after));
    await app.click('#srcVideo'); check(await app.evaluate(() => document.body.dataset.src === 'video' && !document.getElementById('camView').srcObject), 'back to Video closes the camera');
  } catch (e) { check(false, 'run', e.stack || e.message); }
  finally { for (const e of errs) check(false, 'page error', e); await browser.close(); srv.close(); }
  const fails = results.filter(r => !r).length; log(`live: ${results.length - fails} passed, ${fails} failed`); process.exitCode = fails ? 1 : 0;
}
await main();
