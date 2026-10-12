#!/usr/bin/env node
// Live webcam mode, headless (no camera, no models):
//  1. harness: the synthetic dancer through the real live analyzer and LiveCore (bundle, director, renderer) on two
//     clocks (camera time, song time): depth, fit, prints, orbit, then the transport (seek back / forward, paused with
//     a live camera, holds, live replans) and the edges (no frame yet, starting on dots, a long paused session).
//  2. app smoke test: the real editor with Chromium's fake camera; MediaPipe is unreachable here, so it runs in
//     brightness-depth mode (dots only): Go live, Space, scrub, ruler click, settings while live, Stop.
// Writes test/out/live_contact.png.
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
    check(st.calibrated && st.n === 500, 'live bundle grows frame by frame (camera time) and calibrates', `n ${st.n}, k ${st.k.toFixed(3)}`);
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
    // transport
    const tr = await page.evaluate(() => window.L.transport()), b = tr.back;
    check(b.after < b.before && b.same && b.maxT <= b.tb + 1e-9 && b.orbitN === b.nExp && b.jOk, 'seek back: later prints go (in place), the ring and the grid rewind', JSON.stringify({tb: +b.tb.toFixed(2), before: b.before, after: b.after, orbitN: b.orbitN}));
    check(!b.stage || b.drawn === b.expect, 'seek back: every ghost still on screen is drawn (slots restored)', JSON.stringify({stage: b.stage, drawn: b.drawn, expect: b.expect}));
    check(tr.replay.added >= 1 && tr.replay.sorted && tr.replay.unique && tr.replay.perBarOk, 'playing on after a seek prints again, no burst, in order', JSON.stringify(tr.replay));
    check(tr.fwd.added <= 1 && Math.abs(tr.fwd.angAfter - tr.fwd.angPred) < 1e-6, 'seek forward: no backlog of prints, the orbit carries on', JSON.stringify(tr.fwd));
    check(tr.paused.fi2 === tr.paused.top && tr.paused.fi2 > tr.paused.fi1 && tr.paused.differ, 'paused: the newest camera frame is on screen', JSON.stringify(tr.paused));
    check(tr.hold.inside === tr.hold.pin && tr.hold.after === tr.hold.top && tr.hold.top > tr.hold.pin, 'a hold shows the frame it entered on (pinned), then the camera again', JSON.stringify(tr.hold));
    check(!tr.flash || tr.flash.held < tr.flash.open - 3, 'paused: no beat flash held on screen', JSON.stringify(tr.flash || 'no flash frame'));
    const rp = tr.replan;
    check(rp.sameRing && rp.sameOrbit && rp.phi0 && rp.seedsKept, 'live replan (palette, strobe, punch, seed) keeps the ring, its orbit and its plates', JSON.stringify(rp));
    check(rp.matsOk && rp.matsChanged, 'a palette change recolours the printed ghosts');
    check(rp.drawn == null || rp.drawn === rp.expect, 'after a replan every ghost on screen is drawn', JSON.stringify({drawn: rp.drawn, expect: rp.expect}));
    check(rp.ms < 120, 'a live replan is quick', `${rp.ms.toFixed(1)} ms (16 s song, SwiftShader)`);
    const d = tr.dots;
    check(d.scene === 'dots' && d.dotsGhosts === 0 && d.maxAfter <= d.tSeek + 1e-9 && d.back && d.burst <= 1, 'dots and back: the ring waits, a seek on dots still rewinds it, no backlog', JSON.stringify(d));
    const ed = await page.evaluate(() => window.L.edges());
    check(ed.empty.core === null && ed.empty.r === -1 && !ed.empty.gl.error, 'before the first camera frame nothing renders and nothing throws', JSON.stringify(ed.empty));
    check(Number.isFinite(ed.phi0) && ed.orbit && ed.mix.phi0 === ed.phi0 && ed.mix.ghosts > 0 && ed.mix.finite, 'starting on dots: the ring is ready when plates come in', JSON.stringify(ed.mix));
    const m = ed.memory;
    check(m.grew === 2000 && m.stats0 && m.statsTop && m.env <= 660 && m.pool === 16 && m.dmKept <= 80 && m.render, 'long paused session: memory stays bounded', JSON.stringify(m));
    check(ed.gap.added === 2, 'a 10 s camera gap (hidden tab) continues instead of back-filling', JSON.stringify(ed.gap));
    check(ed.replan4 < 150 && !ed.gl.error, 'a live replan of a 4-minute song', `${ed.replan4.toFixed(1)} ms median (SwiftShader)`);
    const lu = await page.evaluate(async () => { const r = await window.L.run({secs: 2, size: 360, luma: true, shots: [40]}); const p = window.L.probe(1); return {scene: window.L.last.plan.scene, ok: !r.shots[0].gl.error, p}; });
    check(lu.scene === 'dots' && lu.ok, 'brightness-depth fallback (no person detection) runs dots only', JSON.stringify(lu.scene));
    await page.close();
    // ---- 2. the real editor with the fake camera
    const wav = path.join(OUT, 'live_song.wav'); songWav(wav);
    const app = await ctx.newPage(); app.on('pageerror', e => errs.push('app: ' + e.message)); app.on('console', m => { if (/^\[dotfx\]/.test(m.text())) log('app', m.text().slice(8, 200)); });
    await app.route('**/*', r => (isLocal(r.request().url()) ? r.continue() : r.abort()));
    await app.goto(`${origin}/index.html`); await app.waitForFunction(() => window.dotfx && window.dotfx.api);
    await app.evaluate(() => { window.dotfx.plan = {marker: 1}; document.getElementById('scrub').value = .3; });     // a clip edit to come back to
    await app.click('#srcCam'); await app.waitForFunction(() => document.getElementById('camWell').dataset.on === '1', null, {timeout: 15000});
    check(await app.evaluate(() => document.body.dataset.src === 'cam' && !!document.getElementById('camView').srcObject), 'Webcam source opens the camera');
    await app.setInputFiles('#fAudio', wav); await app.waitForFunction(() => window.dotfx.A && window.dotfx.plan, null, {timeout: 60000});
    const shown = id => app.evaluate(i => getComputedStyle(document.getElementById(i)).display !== 'none', id);
    const pre = await app.evaluate(() => ({bpm: window.dotfx.A.bpm, go: document.getElementById('bAnalyze').textContent, goOn: !document.getElementById('bAnalyze').disabled, play: document.getElementById('bPlay').disabled, scrub: !document.getElementById('scrub').disabled}));
    check(Math.abs(pre.bpm - 128) < 2 && pre.go === 'Go live' && pre.goOn && pre.play && pre.scrub, 'song analysed; Go live ready, the timeline picks the start', JSON.stringify(pre));
    check(!(await shown('bExport')) && !(await shown('dl')), 'no recording in webcam mode (Export and Download hidden)');
    await app.evaluate(() => { const s = document.getElementById('scrub'); s.value = .1; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); });
    await app.click('#bAnalyze');                                         // Go live: from the scrub position, then plays
    await app.waitForFunction(() => window.dotfx.liveOn && window.dotfx.liveSession.state === 'live', null, {timeout: 30000});
    await app.waitForFunction(() => window.dotfx.liveSession.playing, null, {timeout: 10000});
    const ses = () => app.evaluate(() => { const L = window.dotfx.liveSession; return {t: L.time(), playing: L.playing, renders: L.renders, state: L.state, n: L.V.n, dur: L.dur, btn: document.getElementById('bPlay').textContent}; });
    const a0 = await ses(); await app.waitForTimeout(1500); const a1 = await ses();
    check(a0.t >= .1 * a0.dur - .2 && a1.t > a0.t + .5 && a1.n > a0.n && a1.btn.includes('Pause'), 'Go live starts at the playhead and plays; the camera runs', JSON.stringify({t0: +a0.t.toFixed(2), t1: +a1.t.toFixed(2), n: a1.n, btn: a1.btn}));
    await app.keyboard.press('Space');                                    // focus is on Play after Go live: Space pauses
    await app.waitForTimeout(200); const b0 = await ses(); await app.waitForTimeout(1500); const b1 = await ses();
    check(b0.state === 'live' && !b0.playing && Math.abs(b1.t - b0.t) < 1e-6 && b1.renders > b0.renders && b1.n > b0.n, 'Space pauses: the song stops, the live picture keeps rendering', JSON.stringify({t: +b1.t.toFixed(3), renders: [b0.renders, b1.renders], n: [b0.n, b1.n]}));
    await app.evaluate(() => { const s = document.getElementById('scrub'); s.value = .5; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); });
    const c0 = await ses(); check(Math.abs(c0.t - .5 * c0.dur) < .05 && !c0.playing, 'scrub moves the song while live', `t ${c0.t.toFixed(2)} of ${c0.dur.toFixed(1)}`);
    await app.click('#bPlay'); await app.waitForTimeout(1200); const c1 = await ses();
    check(c1.playing && c1.t > c0.t + .4, 'Play resumes from the new position', `t ${c1.t.toFixed(2)}`);
    const box = await app.locator('#beats').boundingBox(); await app.mouse.click(box.x + box.width * .25, box.y + 6);
    const c2 = await ses(); check(Math.abs(c2.t - .25 * c2.dur) < .1 && !c2.playing, 'a click on the time ruler seeks', `t ${c2.t.toFixed(2)}`);
    // settings while live
    await app.evaluate(() => { const set = (id, v, ev) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(ev)); };
      set('strobe', .3, 'input'); set('strobe', .3, 'change'); set('palette', 'cool', 'change'); set('scene', 'plates', 'change'); set('size', '540', 'change'); set('seed', '7', 'change'); });
    await app.evaluate(() => { const e = document.getElementById('intensity'); e.value = .4; e.dispatchEvent(new Event('input')); });
    await app.waitForTimeout(400);
    const st2 = await app.evaluate(() => { const S = window.dotfx, R = S.renderer, L = S.liveSession; return {live: S.liveOn && L.state === 'live', same: R.plan === S.plan && L.plan === S.plan, strobe: S.plan.strobe, palette: S.plan.palette, seed: S.plan.seed, intensity: S.plan.intensity,
      scene: S.plan.scene, note: S.plan.sceneNote, W: R.W, H: R.H, out: document.getElementById('outTxt').textContent, mode: L.mode}; });
    check(st2.live && st2.same && st2.strobe === .3 && st2.palette === 'cool' && st2.seed === 7 && st2.intensity === .4, 'settings change while live (strobe, palette, seed, punch while dragging)', JSON.stringify(st2));
    check(Math.max(st2.W, st2.H) <= 1280 && st2.out.startsWith(`${st2.W} × ${st2.H} · 30 fps`), 'output size changes live; the header shows the live size', JSON.stringify({W: st2.W, H: st2.H, out: st2.out}));
    check(st2.mode !== 'luma' || (st2.scene === 'dots' && /person detection/.test(st2.note)), 'without person detection live stays dots only, with a note', JSON.stringify({mode: st2.mode, scene: st2.scene}));
    const r0 = (await ses()).renders; await app.waitForTimeout(600); check((await ses()).renders > r0, 'still rendering after the changes');
    await app.click('#bAnalyze');                                         // Stop
    await app.waitForFunction(() => window.dotfx.liveSession.state === 'idle' && !window.dotfx.liveOn, null, {timeout: 10000});
    const after = await app.evaluate(() => ({go: document.getElementById('bAnalyze').textContent, live: document.body.dataset.live || null, play: document.getElementById('bPlay').disabled, cam: !!document.getElementById('camView').srcObject}));
    check(after.go === 'Go live' && !after.live && after.play && after.cam, 'Stop leaves live (the camera preview stays on)', JSON.stringify(after));
    await app.click('#srcVideo');
    const back = await app.evaluate(() => ({src: document.body.dataset.src, cam: !!document.getElementById('camView').srcObject, plan: window.dotfx.plan && window.dotfx.plan.marker, scrub: +document.getElementById('scrub').value}));
    check(back.src === 'video' && !back.cam && back.plan === 1 && Math.abs(back.scrub - .3) < 1e-6, 'back to Video closes the camera and restores the clip edit', JSON.stringify(back));
  } catch (e) { check(false, 'run', e.stack || e.message); }
  finally { for (const e of errs) check(false, 'page error', e); await browser.close(); srv.close(); }
  const fails = results.filter(r => !r).length; log(`live: ${results.length - fails} passed, ${fails} failed`); process.exitCode = fails ? 1 : 0;
}
await main();
