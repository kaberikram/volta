# DotFX Builder

A browser app that turns **any clip + any song** into a beat-locked, 3D dot-particle music edit
in the style of `clip2_dots_v2`. It all runs on your machine: video analysis (AI depth + person
segmentation), audio analysis, edit planning, WebGL2 rendering and MP4 encoding. No server, no upload.

## Run it

```bash
cd dotfx-builder
python3 serve.py            # -> http://localhost:8000   (recommended: enables multi-threaded WASM)
# or
python3 -m http.server 8000 # works too, but the WASM fallback runs single-threaded
# or
npx serve .
```

Open **http://localhost:8000** in **Chrome** (desktop, recent version). Opening `index.html` as a `file://` URL
won't work because ES modules and the models need http.

The first run downloads the models and libraries from public CDNs (needs internet). The browser caches them after that:
- Depth-Anything-V2-small ONNX (Hugging Face): ~50 MB fp16 on WebGPU, or ~27 MB int8 on the WASM fallback
- MediaPipe PoseLandmarker-lite (~6 MB, person mask), selfie-multiclass segmenter fallback (~16 MB, only downloaded if needed), MediaPipe WASM runtime (~10 MB)
- transformers.js / onnxruntime-web (~25 MB), mp4-muxer (small)

## How to use

1. **Inputs**: pick a video (mp4/mov, any aspect) and a song (mp3/wav/m4a). To keep the clip's own sound
   instead, tick *keep the video's own audio*.
2. Click **Analyse & auto-edit**. The progress bar shows the per-frame analysis. When it finishes, the app has:
   - found the tempo, the beat phase, bars and drop hits
   - auto-picked the punchiest section of the song that matches the video length, starting on a downbeat (a drop if there is one)
   - generated an edit plan and shown a live preview
3. **Song section**: the waveform shows the chosen window (orange box; yellow ticks = detected drops).
   Drag **Start** to choose a different part (it snaps to bars unless you untick that), or press *Auto-pick*.
4. **Style**: *Reroll* (or type a seed) for a new deterministic edit. *Scene* picks the visual language:
   - *dots + plates* (default) alternates the dot looks with **pose plates**: on strong beats and sudden moves the
     dancer's pose freezes into a stack of thin horizontal plates (like a sliced 3D print). The plates stay on a dark
     laser stage with fog, a reflective grid floor and cyan/white spots. They drift out to a ring and orbit while the
     dancer is still; new ones glow, old ones darken and collapse.
   - *dots only* is the original edit.
   - *plates only* keeps the whole edit on the stage.

   *Punch* scales camera hits, shake, recoil and flash strength. *Strobe amount* controls how many 1-frame raw/colour
   strobes (blackouts on the stage) there are. *Palette* changes the colour family.
5. **Output**: aspect (source, 9:16 TikTok/Reels crop that follows the person, 1:1, 16:9), size (540/720/1080p),
   quality (bitrate), fps 30/60. Press **Play** to preview with audio, or drag the scrub bar.
6. **Render & export MP4**: an offline, frame-accurate render (it isn't a screen capture, so slow machines don't drop frames).
   When it's done a **Download** link appears.

Analysis results are cached in IndexedDB (keyed by file name + size + settings), so re-opening the same clip is instant.

## Live webcam mode

1. In **Clip**, switch **Video / Webcam** to *Webcam* and allow the camera. If you have more than one, pick it in the
   camera menu. The upload path is unchanged; switching back to *Video* restores your clip and its edit.
2. Pick **any song**. It's analysed right away (tempo, bars, drops), and the timeline shows the plates sections and the
   fade lane for the whole track.
3. **Go live** starts at the playhead (drag it first to start anywhere). Once the stage has measured you (well under
   a second), the song plays. The dots and the plates stage follow the song's beat grid (looks, strobes, flashes,
   camera shots, plates sections) and your moves. Strong beats and sudden moves freeze your pose into plates, which
   orbit faster when you stand still.
4. Use it like the clip editor, with the camera always live:
   - **Play / Pause** (or **Space**) moves the song. While paused, the edit at that point stays on screen and you keep
     dancing in it. One-frame strobes, flashes and kick shake aren't held.
   - **Scrub** with the playhead, or click the time ruler above the beat lane. Going back re-performs from there:
     plates printed later are cleared, and the ring keeps everything up to that point. Going forward carries the ring on.
   - **Every setting applies instantly**: Strobe and Punch while you drag, Palette (the plates on stage are
     recoloured), Scene, Reroll/seed, the fade lane and Output size. The ring of plates survives all of them, even a
     switch to dots and back.
   - Freezes and holds in the edit show the camera frame from the moment the song entered them.
5. **Stop** leaves live; the camera preview stays on. To change camera or song, Stop first.

Webcam mode is for playing live; it doesn't record. Live always runs at 30 fps, and the long side of the canvas is
capped at 1280 px. If frames run slow, the app first drops MSAA and the dancer's floor reflection, then runs person
detection on every other frame. The log shows each step and the ms per frame.

**Depth, live.** Depth-Anything is too slow for 30 fps in a browser, and brightness alone (like a luma height map)
puts dark clothes behind the wall. Live mode builds a depth map from things that are cheap to get every frame:
- **Person vs background.** MediaPipe PoseLandmarker in VIDEO mode (GPU) gives a person mask and 33 landmarks.
  The background becomes a floor-like gradient behind you.
- **Body volume.** A distance transform of the mask (a few ms on a 266 px-wide map) makes the middle of the body
  nearer than its edges, so the dots read as a rounded figure instead of a flat cut-out.
- **Limbs.** Each landmark's z is drawn as a capsule along the bone, so an arm reaching toward the camera comes out nearer.
- **Distance.** The person's apparent size (torso length) sets how near the whole figure is: step toward the camera
  and it comes forward.
- **Detail.** A little brightness on top for folds and texture.

Masks and depth are smoothed over time only where they agree, so fast moves don't leave trails. If MediaPipe can't
load, it falls back to the selfie segmenter. If that also fails, it uses the brightness depth, dots only.

**Two clocks.** The footage runs on camera time: frames are numbered by their capture time, never rewind, and the
newest one is always the dancer on screen (earlier song frames used by trails and motion blur are the camera's recent
history). The edit runs on song time, as you hear it (`AudioContext.getOutputTimestamp`), and that's what Play, Pause
and the playhead move. So any point of the song can be tried on the live dancer.

## What it does (pipeline)

| Stage | Implementation (`src/`) |
|---|---|
| Audio decode | `audio.js`: Web Audio `decodeAudioData` (48 kHz) |
| Kick / onset | 2x biquad low-pass at 150 Hz, then RMS envelope (5.8 ms hop) and positive log-flux |
| Tempo + phase | comb filter over the whole track (80–180 BPM coarse, then 0.01 BPM / 3 ms fine). Checked against detected kick peaks (share of strong low-band hits on the 1/8 grid) |
| Bars / drops | downbeat = beat offset with the biggest energy jumps + kicks. Per-bar energy = RMS × kick density. A drop is a loud bar ≥ ~1.5× the previous two |
| Section pick | every downbeat window of video length is scored on mean energy + drop strength + weakest bar. Start = downbeat − 10 ms |
| Mix | OfflineAudioContext slice, 5 ms fade-in / 0.35 s fade-out, RMS loudness match (~ −12…−14 LUFS), limiter at −1.5 dBFS |
| Frames | `video.js`: seeks every 1/30 s, 720 px colour JPEG per frame |
| Depth | transformers.js + Depth-Anything-V2-small. Tries WebGPU fp16, then WebGPU fp32, then WASM int8 (multi-thread when cross-origin isolated). Rolling percentile normalisation |
| Person mask | MediaPipe PoseLandmarker-lite segmentation masks (GPU delegate). It finds full bodies at any distance and returns an empty mask when nobody is in frame. Falls back to the selfie-multiclass ImageSegmenter (GPU/CPU, benchmarked; picks the faster), then to a depth-threshold mask |
| Clean-up | 3-frame temporal agreement, removes "pillar" false positives (top-touching, full-height, far components), centroid pivot + depth smoothing, frame-diff motion |
| Plates stage plan | `planner.js` + `pose.js`: picks runs of bars (about 40%) for the stage and spawns pose ghosts on strong beats and pose-change onsets, snapped to the 1/8 grid with a novelty gate. Each ghost gets a material (red gloss/glass, white, graphite, teal stone), a ring slot and a lifetime (cap 14, at least 8 kept). The ring's orbit integrates faster while the dancer is still. Each plates bar gets a camera shot (orbit, ground skim, top-down, push-in, side track, laser rake). Plates are cut from the person mask at a fixed 8.5 cm pitch |
| Planner | `planner.js`: seeded. Per-bar roles (`drop`, `half`, `quarter`, `spark`, `accel`, `freeze`, `echo`, `end`) → look schedule at varying rates, 1-frame strobes, downbeat flashes, detonations, echo hits, holds → slam, freeze-orbit, fly-through, scatter/re-form, camera swings, per-bar camera snaps |
| Renderer | `renderer.js` + `shaders.js`: WebGL2 point cloud (each dot is a source pixel lifted by depth). Figure shells and depth layers, always-moving camera (kick dolly/whip alternating, bar snaps, drop orbit, fly-through, freeze orbit), shockwave rings, detonations with recoil, scatter + re-form, DOF, fog, bloom, chromatic split, shake, motion trails. Looks: LED source-colour dots, macro LED, ink-on-cream, gold-on-black, flat colour dots, inverted dots, glowing sparkle cloud, rainbow echo, raw strobe. No magenta |
| Stage renderer | `stage.js`: HDR (RGBA16F, 4x MSAA on GPUs) synthetic stage. Planar-reflection floor with a white/red grid and arcs, height fog, spot cones and pools, red laser fans and cages, light pillars, a hoop at the dancer, instanced superellipse plates (print-in, glide, spin, collapse), and the live dancer as dense source-colour dots via the point shader. Then bloom, tonemap, camera motion blur and the shared composite (flash, shake, fade lane). Falls back to a dots look if WebGL can't run it |
| Live webcam | `live.js`: camera frames via `requestVideoFrameCallback` → PoseLandmarker (VIDEO mode) mask + landmarks → hybrid depth (mask distance-field relief, landmark limb z, size-based distance, luma detail), per-frame pose stats and fit, a 16-slot GPU frame pool on camera time, and a director that spawns ghosts on the 1/8 grid of song time and integrates the orbit. Play / pause / seek move the song; a seek re-performs from there; a settings change re-plans in place and keeps the ring |
| Export | `exporter.js`: WebCodecs `VideoEncoder` (H.264 High) + `AudioEncoder` (AAC, or Opus if AAC isn't available), muxed with mp4-muxer (fast-start). Falls back to MediaRecorder WebM (real time) if WebCodecs fails |

## Notes / limits

- **Chrome on macOS is the target**: WebGPU depth, GPU segmentation and AAC encoding are all available there.
  Other Chromium browsers should work. Firefox/Safari aren't supported (WebCodecs/WebGPU gaps).
- **Speed**: analysis is the slow part. On an Apple-silicon Mac with WebGPU, expect a few minutes or less for a 15 s clip.
  On the WASM fallback (no WebGPU) it's about 0.25 s per depth frame plus seeking. *fast* quality runs depth on every
  2nd frame (in-between frames reuse it); *best* runs every frame at a higher resolution.
- Clips are analysed at 30 fps for their full length. The edit length = video length. Longer clips take proportionally longer to analyse.
- **iPhone HDR/HEVC .mov**: Chrome on Mac decodes HEVC with hardware. Colours come out the way Chrome tone-maps HDR,
  which can look a bit flat. If a file won't load (e.g. HEVC on a machine without a decoder), convert it first:
  `ffmpeg -i in.mov -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac out.mp4`.
- The tempo model assumes a **constant tempo** (fine for most electronic, pop and hip-hop). Songs with tempo drift or no
  clear kick will get a weaker grid. Use the Start slider to pick by ear.
- If AAC encoding isn't available (e.g. Chrome on Linux), the MP4 carries **Opus** audio. It plays in Chrome, VLC
  and ffmpeg, but QuickTime and some social uploaders want AAC. Re-mux with `ffmpeg -i in.mp4 -c:v copy -c:a aac out.mp4`.
- Exports are encoded at the chosen bitrate. 1080p60 "high" is ~15 Mbps.
- **Live mode** needs a camera. Good light and the whole body in frame give the best mask. Hiding the tab pauses
  the song.

## Files

```
index.html        UI
serve.py          static server with COOP/COEP headers (multi-thread WASM)
src/app.js        UI wiring, preview/playback, pipeline orchestration (window.dotfx.api for automation)
src/audio.js      decode, tempo/beat/bar/drop analysis, section pick, final mix
src/video.js      frame extraction, depth, segmentation, mask clean-up, pivots, cache
src/planner.js    seeded edit planner + palettes
src/renderer.js   WebGL2 dot/point-cloud renderer, camera, looks (and the plates stage branch)
src/stage.js      plates stage: HDR scene, rig, camera shots, ghosts, dancer
src/pose.js       pose stats, source -> stage mapping, movement envelope, plate geometry
src/shaders.js    GLSL (dots, bloom, composite)
src/exporter.js   WebCodecs + mp4-muxer export, MediaRecorder fallback
src/live.js       live webcam mode: analyzer (mask + hybrid depth), live bundle, director, core, session (camera + song transport)
src/util.js       helpers (seeded RNG, smoothing, IndexedDB cache)
test/             headless end-to-end test (Playwright + Chrome)
```

## Synthetic tests (no models, no network)

`test/synth.js` fabricates an analysis bundle (a drawn dancer with depth and mask, motion, a 128 BPM grid). Run:

```bash
node --test test/plan_test.mjs        # planner: dots edit unchanged, determinism, plates runs, ghosts, orbit
node test/plates_e2e.mjs              # renders through the real renderer in headless Chromium (SwiftShader):
                                      # dots baseline hashes, scrub determinism, GL state, stage frames -> test/out/
SCENE=plates FULL=1 node test/plates_e2e.mjs   # also writes MP4s to test/out/ (needs ffmpeg)
node test/live_e2e.mjs                # live mode: the synthetic dancer as camera frames through the real analyzer and
                                      # LiveCore (depth, fit, spawns, orbit, seek back/forward, paused with a live camera,
                                      # holds, live replans, memory over a long session, GL state), then the real UI with
                                      # Chromium's fake camera: Go live, Space, scrub, ruler click, settings live, Stop
```

## Headless test

```bash
python3 serve.py 8765 &
cd test && npm i playwright            # or symlink an existing node_modules
# put a clip as test/clip2_h264.mp4 and a song as test/song.mp3, then:
BR=0.08 node e2e.mjs                   # env: SIZE=540|720|1080 FPS=30|60 ASPECT=source|9:16|1:1 KEEP=1 OUT=out.mp4
```
The test uses system Google Chrome (`/usr/bin/google-chrome`, it has the H.264 encoder) with SwiftShader. It uploads the files,
runs analysis, writes a screenshot, exports through the real UI code path and saves the MP4. `e2e_run.log` has the log
from the run that made `test_output_small.mp4`.
