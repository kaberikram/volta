// Export: frame-accurate offline render -> WebCodecs (H.264 + AAC, Opus fallback) -> mp4-muxer. Fallback: MediaRecorder WebM (real time).
const MUX = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm';

async function pickVideoCodec(W, H, fps, bitrate) {
  const cands = ['avc1.640034', 'avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0034', 'avc1.42E034', 'avc1.42001F'];
  for (const codec of cands) { const cfg = {codec, width: W, height: H, bitrate, framerate: fps, avc: {format: 'avc'}};
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return {cfg, mux: 'avc'}; } catch (e) {} }
  for (const codec of ['vp09.00.40.08', 'av01.0.08M.08']) { const cfg = {codec, width: W, height: H, bitrate, framerate: fps};
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return {cfg, mux: codec.startsWith('vp09') ? 'vp9' : 'av1'}; } catch (e) {} }
  return null;
}
async function pickAudioCodec(sr, ch) {
  for (const [codec, mux, bitrate] of [['mp4a.40.2', 'aac', 192000], ['opus', 'opus', 160000]]) { const cfg = {codec, sampleRate: sr, numberOfChannels: ch, bitrate};
    try { const s = await AudioEncoder.isConfigSupported(cfg); if (s.supported) return {cfg, mux}; } catch (e) {} }
  return null;
}

export async function exportMp4(renderer, audioBuf, {W, H, fps, dur, bitrate}, log = () => {}, progress = () => {}) {
  if (!('VideoEncoder' in window)) throw new Error('WebCodecs unavailable');
  const {Muxer, ArrayBufferTarget} = await import(MUX);
  bitrate = bitrate || Math.round(W * H * fps * .14);
  const vc = await pickVideoCodec(W, H, fps, bitrate); if (!vc) throw new Error('no supported video encoder config');
  const ac = audioBuf ? await pickAudioCodec(audioBuf.sampleRate, audioBuf.numberOfChannels) : null;
  log(`export: video ${vc.cfg.codec} ${W}x${H}@${fps} ${(bitrate / 1e6).toFixed(1)}Mbps, audio ${ac ? ac.cfg.codec : 'none'}`);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: {codec: vc.mux, width: W, height: H, frameRate: fps},
    audio: ac ? {codec: ac.mux, sampleRate: audioBuf.sampleRate, numberOfChannels: audioBuf.numberOfChannels} : undefined});
  let err = null;
  const venc = new VideoEncoder({output: (c, m) => muxer.addVideoChunk(c, m), error: e => err = e});
  venc.configure(vc.cfg);
  const nF = Math.round(dur * fps);
  renderer.setSize(W, H);
  for (let i = 0; i < nF; i++) {
    if (err) throw err;
    await renderer.renderAt(i / fps);
    const vf = new VideoFrame(renderer.cv, {timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps)});
    venc.encode(vf, {keyFrame: i % (fps * 2) === 0}); vf.close();
    while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2));
    if (i % 5 === 0) progress(i / nF, `rendering frame ${i + 1}/${nF}`);
  }
  await venc.flush(); venc.close();
  if (ac) {
    const aenc = new AudioEncoder({output: (c, m) => muxer.addAudioChunk(c, m), error: e => err = e});
    aenc.configure(ac.cfg);
    const sr = audioBuf.sampleRate, ch = audioBuf.numberOfChannels, total = Math.min(audioBuf.length, Math.round(dur * sr)), block = 1024;
    const chans = [...Array(ch).keys()].map(c => audioBuf.getChannelData(c));
    for (let s = 0; s < total; s += block) { const len = Math.min(block, total - s), data = new Float32Array(len * ch);
      for (let c = 0; c < ch; c++) data.set(chans[c].subarray(s, s + len), c * len);
      const ad = new AudioData({format: 'f32-planar', sampleRate: sr, numberOfFrames: len, numberOfChannels: ch, timestamp: Math.round(s * 1e6 / sr), data});
      aenc.encode(ad); ad.close(); }
    await aenc.flush(); aenc.close();
  }
  if (err) throw err;
  muxer.finalize(); progress(1, 'export done');
  return {blob: new Blob([target.buffer], {type: 'video/mp4'}), ext: 'mp4', videoCodec: vc.cfg.codec, audioCodec: ac ? ac.cfg.codec : 'none'};
}

// fallback: real-time capture of the canvas + audio with MediaRecorder (WebM)
export async function exportWebm(renderer, audioBuf, {W, H, fps, dur}, log = () => {}, progress = () => {}) {
  log('export: MediaRecorder fallback (real time, WebM)');
  renderer.setSize(W, H);
  const stream = renderer.cv.captureStream(0), track = stream.getVideoTracks()[0];
  const actx = new AudioContext({sampleRate: audioBuf ? audioBuf.sampleRate : 48000}); const dest = actx.createMediaStreamDestination();
  if (audioBuf) dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const rec = new MediaRecorder(stream, {mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm'});
  const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  await renderer.renderAt(0); rec.start(250);
  let src = null; if (audioBuf) { src = actx.createBufferSource(); src.buffer = audioBuf; src.connect(dest); }
  const t0 = actx.currentTime + .05; if (src) src.start(t0);
  let last = -1;
  while (actx.currentTime - t0 < dur) { const t = Math.max(0, actx.currentTime - t0), f = Math.floor(t * fps);
    if (f !== last) { await renderer.renderAt(f / fps); track.requestFrame && track.requestFrame(); last = f; progress(t / dur, 'recording (real time)'); }
    await new Promise(r => requestAnimationFrame(r)); }
  rec.stop(); await done; actx.close();
  return {blob: new Blob(chunks, {type: 'video/webm'}), ext: 'webm', videoCodec: 'vp9/webm', audioCodec: 'opus'};
}
