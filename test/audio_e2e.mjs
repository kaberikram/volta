import {chromium} from 'playwright';
const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', headless: true});
const page = await browser.newPage();
page.on('console', m => console.log(m.text().slice(0, 400)));
await page.goto('http://localhost:8765/test/blank.html');
const r = await page.evaluate(async (f) => {
  const m = await import('/src/audio.js');
  const b = await (await fetch(f)).blob(); const ab = await m.decodeAudioFile(b);
  const A = await m.analyzeAudio(ab, s => console.log(s)); const p = m.pickSection(A, 12.53);
  return {bpm: A.bpm, phase: A.phase, onGrid: A.kickOnGrid, nK: A.nKicks, bars: A.bars.map(b => b.t.toFixed(2) + (b.drop ? '*' : '') + ':' + b.e.toFixed(3)).join(' '), pick: p};
}, process.argv[2] || '/test/song.mp3');
console.log(JSON.stringify(r, null, 1));
await browser.close();
