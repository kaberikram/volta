#!/usr/bin/env node
// Builds test/fixtures/plan_dots_legacy.json: makePlan() output on the synthetic inputs (test/synth.js) for a fixed
// grid of seeds x palettes. It is the baseline the future 'dots only' scene must reproduce exactly.
//   node test/make_fixture.mjs          (re-run only when a plan change is intended, then review the diff)
// The helpers are exported so test/plan_test.mjs rebuilds exactly the same cases.
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makePlan } from '../src/planner.js';
import { synthBundle, synthSection, bundleDigest, fnv1a, SCRIPT } from './synth.js';

export const FIXTURE = fileURLToPath(new URL('./fixtures/plan_dots_legacy.json', import.meta.url));
export const SEEDS = [1, 2, 3, 7, 42];
export const PALETTES = ['reference', 'hot'];
export const BASE_OPTS = Object.freeze({intensity: 1, strobe: .7});
export const caseKey = (seed, palette) => `${seed}/${palette}`;

/** JSON replacer: typed arrays -> plain arrays (stable, order-preserving); everything else as JSON.stringify does it. */
export const replacer = (k, v) => (ArrayBuffer.isView(v) && !(v instanceof DataView) ? Array.from(v) : v);
/** Canonical JSON value of a plan (what the fixture stores, and what tests compare). */
export const canon = v => JSON.parse(JSON.stringify(v, replacer));

/** The synthetic inputs: bundle (no frames: the planner only reads fps/n/step/area) + section/grid via the real gridFor. */
export async function buildInputs() {
  const video = await synthBundle();
  const sec = synthSection(video.dur);
  return {video, ...sec};
}
/** grid fields the legacy planner read (gridFor later gained `drops` for the plates stage) */
export const legacyGrid = ({drops, ...g}) => (void drops, g);
export function inputDigest({video, grid, start, pick}) {
  return {bundle: bundleDigest(video), grid: fnv1a(JSON.stringify(canon(legacyGrid(grid)))), start, pickBar: pick.i};
}
/** plan fields added by the plates stage layer; everything else must match the legacy fixture in the 'dots' scene */
export const STAGE_KEYS = ['scene', 'sceneNote', 'stages', 'runs', 'stageBars', 'shots', 'ghosts', 'orbit'];
export const legacyPlan = p => Object.fromEntries(Object.entries(p).filter(([k]) => !STAGE_KEYS.includes(k)));
/** All fixture cases; `extra` is merged into makePlan's options (e.g. a future {scene: 'dots'}). */
export function buildPlans({video, grid}, extra = {}) {
  const plans = {};
  for (const seed of SEEDS) for (const palette of PALETTES)
    plans[caseKey(seed, palette)] = canon(legacyPlan(makePlan(grid, video.dur, video, {seed, palette, ...BASE_OPTS, scene: 'dots', ...extra})));
  return plans;
}

async function main() {
  const inputs = await buildInputs();
  const out = {
    about: 'makePlan() output on test/synth.js inputs (legacy dots-only planner). Regenerate with: node test/make_fixture.mjs',
    cases: {seeds: SEEDS, palettes: PALETTES, opts: BASE_OPTS},
    inputs: inputDigest(inputs),
    script: SCRIPT,
    grid: canon(legacyGrid(inputs.grid)),
    plans: buildPlans(inputs),
  };
  fs.mkdirSync(new URL('./fixtures/', import.meta.url), {recursive: true});
  const text = JSON.stringify(out, null, 1) + '\n';
  fs.writeFileSync(FIXTURE, text);
  const p1 = out.plans[caseKey(1, 'reference')];
  console.log(`wrote ${FIXTURE} (${(text.length / 1024).toFixed(0)} KB, ${Object.keys(out.plans).length} plans)`);
  console.log(`inputs ${JSON.stringify(out.inputs)}`);
  for (const [k, p] of Object.entries(out.plans)) console.log(`  ${k.padEnd(12)} roles ${p.roles.join(' ')} | ${p.sched.length} events, freeze frame ${p.freeze && p.freeze.frame}`);
  void p1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
