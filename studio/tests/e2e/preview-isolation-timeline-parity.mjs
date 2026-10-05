// Packaged preview timeline QA with a disposable profile and authored project.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? 'out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX');
const root = await mkdtemp(join(tmpdir(), 'mpvfx-preview-timeline-parity-'));
const data = join(root, 'data');
const project = join(data, 'projects', 'Parity');
await mkdir(join(project, 'compositions'), { recursive: true });
const samples = 4 * 8000;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 8000) * 1200), 44 + i * 2);
await writeFile(join(project, 'tone.wav'), wav);
await writeFile(join(project, 'index.html'), `<!doctype html><html><body style="margin:0;background:#151b23;color:white">
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4" style="position:relative;width:640px;height:360px">
<div id="scene" data-hf-id="hf-scene" data-composition-id="scene" data-composition-src="compositions/scene.html" data-start="0" data-duration="4" data-track-index="0" data-width="640" data-height="360" style="position:absolute;left:0;top:0;width:640px;height:360px"></div>
<audio id="music" src="tone.wav" data-hf-id="hf-music" data-start="0" data-duration="4" data-track-index="1" data-timeline-role="music" data-volume="0.7"></audio>
<audio id="voice-a" src="tone.wav" data-hf-id="hf-voice-a" data-start="0" data-duration="2" data-track-index="2" data-audio-group="voices"></audio>
<audio id="voice-b" src="tone.wav" data-hf-id="hf-voice-b" data-start="2" data-duration="2" data-track-index="2" data-audio-group="voices"></audio>
<hf-audio-group id="voices" data-label="Voices" data-volume="0.6"></hf-audio-group>
</main></body></html>`);
await writeFile(join(project, 'compositions', 'scene.html'), `<!doctype html><html><body><section data-composition-id="scene" data-width="640" data-height="360" data-duration="4" style="position:relative;width:640px;height:360px;background:#263848"><div id="panel" data-hf-group="Panels" style="position:absolute;left:50px;top:40px;width:400px;height:200px"><div id="title-card" data-hf-id="hf-title" data-start="0" data-duration="4" style="background:#2d9d85;padding:30px;font-size:30px">Nested title</div></div></section></body></html>`);
let log = '';
const child = spawn(app, ['--remote-debugging-port=0', `--user-data-dir=${join(root, 'chromium')}`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', MPVFX_USER_DATA_DIR: data, MPVFX_HIDDEN_TEST_WINDOW: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', part => { log += part; });
child.stderr.on('data', part => { log += part; });
let browser;
const waitFor = async (read, timeout = 30000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    if (child.exitCode !== null) throw new Error(`App exited: ${log.slice(-1500)}`);
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${log.slice(-1500)}`);
};
const snapshot = page => page.evaluate(() => ({
  labels: [...document.querySelectorAll('[aria-label]')].map(el => el.getAttribute('aria-label')).filter(Boolean),
  text: document.body.innerText.slice(-6000),
  frames: [...document.querySelectorAll('iframe')].map(el => el.src),
}));
try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith('mpvfx://editor/'), { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => { location.hash = '#project/Parity'; });
  const frame = await waitFor(() => page.frames().find(item => item.url().includes('/api/projects/Parity/preview')));
  await waitFor(() => page.evaluate(() => document.querySelector('hyperframes-player')?.ready));
  await new Promise(done => setTimeout(done, 800));
  const initial = await snapshot(page);
  const sceneClip = await page.$eval('[aria-label="Scene, 0.0 to 4.0 seconds"]', el => ({ title: el.title, html: el.outerHTML.slice(0, 500) }));
  const preview = await frame.evaluate(() => ({ text: document.body.innerText, nested: !!document.getElementById('title-card'),
    audio: [...document.querySelectorAll('audio')].map(el => ({ id: el.id, readyState: el.readyState, src: el.currentSrc })) }));
  await page.screenshot({ path: join(root, 'timeline-initial.png') });
  const evidence = { root, initial, preview, sceneClip,
    manifest: await frame.evaluate(() => window.__clipManifest?.clips?.map(clip => ({
      id: clip.id, kind: clip.kind, parentCompositionId: clip.parentCompositionId, compositionSrc: clip.compositionSrc })) ?? []),
    nestedDom: await frame.evaluate(() => [...document.querySelectorAll('#scene, #title-card, [data-hf-inner-root]')]
      .map(el => ({ id: el.id, tag: el.tagName, parent: el.parentElement?.id,
        data: Object.fromEntries([...el.attributes].filter(attr => attr.name.startsWith('data-')).map(attr => [attr.name, attr.value])) }))) };
  const earlySceneRect = await page.$eval('[aria-label="Scene, 0.0 to 4.0 seconds"]', el => el.getBoundingClientRect().toJSON());
  await page.mouse.click(earlySceneRect.x + earlySceneRect.width / 2, earlySceneRect.y + earlySceneRect.height / 2);
  await new Promise(done => setTimeout(done, 450));
  evidence.earlySelection = await snapshot(page);
  evidence.earlySelection.selected = await page.$eval('[aria-label="Scene, 0.0 to 4.0 seconds"]', el => el.getAttribute('aria-pressed'));
  if (evidence.earlySelection.selected !== 'true' ||
    !evidence.earlySelection.labels.includes('Panels, 0.0 to 4.0 seconds')) {
    throw new Error('Selecting the composition did not reveal its nested group row');
  }
  await page.screenshot({ path: join(root, 'composition-expanded.png') });
  await frame.evaluate(() => {
    window.__audioPlayTrace = [];
    for (const el of document.querySelectorAll('audio')) {
      const original = el.play.bind(el);
      el.play = () => { window.__audioPlayTrace.push({ id: el.id, at: el.currentTime, muted: el.muted, volume: el.volume, time: performance.now() }); return original(); };
    }
  });
  await page.mouse.move(300, 586);
  await page.mouse.down();
  await page.mouse.move(318, 586, { steps: 5 });
  await page.mouse.up();
  await new Promise(done => setTimeout(done, 200));
  evidence.scrub = { trace: await frame.evaluate(() => window.__audioPlayTrace),
    time: await page.evaluate(() => document.querySelector('hyperframes-player')?.currentTime),
    playing: await page.evaluate(() => document.querySelector('hyperframes-player')?.playing) };
  if (!evidence.scrub.trace.some(event => event.id === 'music') ||
    evidence.scrub.trace.some(event => event.id !== 'music')) {
    throw new Error('Paused scrubbing did not preview only the music source');
  }
  await page.screenshot({ path: join(root, 'music-scrub.png') });
  const fxButtons = await page.$$('[aria-label="Effects"]');
  if (fxButtons.length < 2) throw new Error('Music and bus FX controls were not rendered');
  await page.evaluate(() => document.querySelectorAll('[aria-label="Effects"]')[1]?.click());
  evidence.fxPopover = await snapshot(page);
  if (!evidence.fxPopover.text.includes('Open rack')) throw new Error('The audio bus FX menu did not open');
  await page.screenshot({ path: join(root, 'bus-fx-popover.png') });
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  browser?.disconnect(); child.kill('SIGTERM');
  await writeFile(join(root, 'app.log'), log);
}
