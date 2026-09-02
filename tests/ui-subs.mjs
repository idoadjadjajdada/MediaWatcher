/**
 * Browser-driven checks for ASS rendering and subtitle appearance.
 *
 * The unit tests cover the parser and the clamps; neither can tell you whether
 * a cue ends up on screen. These are the failures that only appear in a real
 * browser: an overlay that parses correctly and draws nothing, a positioned
 * sign mapped through the element's box instead of the letterboxed video's, an
 * appearance control that writes CSS `::cue` cannot act on, and a render loop
 * still running after the player closed.
 *
 * The library here carries no ASS at all - everything is subrip or PGS - so
 * this writes a sidecar next to a real file for the duration of the run and
 * removes it afterwards, including on failure.
 *
 * Needs a running server. Defaults to port 3001 so it never disturbs the one
 * on 3000; override with UI_SUBS_URL.
 *
 * Run:  MW_PASSWORD=... node tests/ui-subs.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const BASE = process.env.UI_SUBS_URL || 'http://127.0.0.1:3001';
const PASSWORD = process.env.MW_PASSWORD || process.env.AUTH_PASSWORD;

/** Playwright lives in the npx cache on this machine, not in node_modules. */
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
    if (!fs.existsSync(cache)) throw new Error('playwright not found and no npx cache');
    for (const entry of fs.readdirSync(cache)) {
      const candidate = path.join(cache, entry, 'node_modules', 'playwright');
      if (fs.existsSync(candidate)) return require(candidate);
    }
    throw new Error('playwright not found in node_modules or the npx cache');
  }
}

let total = 0;
let failures = 0;
function check(name, ok, detail) {
  total += 1;
  console.log(`  ${ok ? '[pass]' : '[FAIL]'} ${name}`);
  if (!ok && detail !== undefined) console.log(`         ${JSON.stringify(detail)}`);
  if (!ok) failures += 1;
}

if (!PASSWORD) {
  console.error('Set MW_PASSWORD (or AUTH_PASSWORD) so the gate can be passed.');
  process.exit(2);
}

/*
 * Two events on purpose: one ordinary bottom-centre line through the style's
 * own alignment, and one \pos sign at the top. They exercise the two different
 * coordinate paths in the renderer, which is where a letterboxing mistake
 * shows up. Both run for an hour so neither can expire mid-run.
 */
const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,40,1
Style: Sign,Verdana,64,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,1:00:00.00,Default,,0,0,0,,MEDIAWATCHER DIALOGUE LINE, with a comma
Dialogue: 1,0:00:00.00,1:00:00.00,Sign,,0,0,0,,{\\an8\\pos(960,90)}MEDIAWATCHER SIGN
`;

const pw = loadPlaywright();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

let sidecar = null;

try {
  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', PASSWORD);
  await page.uncheck('#remember');
  await page.click('.gate__submit');
  await page.waitForURL(`${BASE}/`, { timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { try { localStorage.setItem('mw.quality', 'low'); } catch { /* private mode */ } });

  const FILE = await page.evaluate(async () => {
    const api = await import('/js/api.js');
    const library = await api.getLibrary();
    const files = [];
    for (const show of library.shows || []) {
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) {
          for (const file of episode.files || []) files.push(file.path || file.file_path);
        }
      }
    }
    for (const movie of library.movies || []) {
      for (const file of movie.files || []) files.push(file.path || file.file_path);
    }
    return files.filter(Boolean)[0] || null;
  });

  if (!FILE) {
    console.error('No library files to test against.');
    process.exit(2);
  }

  // Named <stem>.ass so the existing sidecar discovery finds it unchanged.
  sidecar = path.join(path.dirname(FILE), `${path.basename(FILE, path.extname(FILE))}.ass`);
  if (fs.existsSync(sidecar)) {
    console.error(`Refusing to overwrite an existing subtitle: ${sidecar}`);
    process.exit(2);
  }
  fs.writeFileSync(sidecar, ASS, 'utf8');
  console.log(`\nfile:    ${path.basename(FILE)}`);
  console.log(`sidecar: ${path.basename(sidecar)}`);

  console.log('\ndiscovery');
  const tracks = await page.evaluate(async (f) => {
    const api = await import('/js/api.js');
    return api.listSubtitles(f);
  }, FILE);
  const assTrack = (tracks || []).find((t) => t.ext === '.ass');
  check('the sidecar is discovered', Boolean(assTrack), tracks);
  check('and is flagged as one the client must render', assTrack?.styled === true);

  console.log('\ndelivery');
  const served = await page.evaluate(async (f) => {
    const response = await fetch(`/api/subs?path=${encodeURIComponent(f)}`);
    return { type: response.headers.get('content-type'), body: (await response.text()).slice(0, 200) };
  }, FILE);
  check('ASS is served as ASS, not flattened', /x-ssa/.test(served.type || ''), served.type);
  check('the styles section survives delivery', served.body.includes('[Script Info]'));

  await page.evaluate(async (f) => {
    const m = await import('/js/player.js');
    await m.open(f);
  }, FILE);
  const ready = await page.waitForFunction(
    () => (document.getElementById('player-video')?.readyState ?? 0) >= 1,
    null, { timeout: 120000 }
  ).then(() => true).catch(() => false);
  check('the player reaches metadata', ready);

  // The ASS track is the first listed, so it is selected automatically.
  const drawn = await page.waitForFunction(
    () => (document.getElementById('player-ass')?.children.length ?? 0) > 0,
    null, { timeout: 15000 }
  ).then(() => true).catch(() => false);

  console.log('\nrendering');
  check('cues are drawn into the overlay', drawn);

  const cues = await page.evaluate(() => {
    const overlay = document.getElementById('player-ass');
    const video = document.getElementById('player-video');
    return Array.from(overlay?.children || []).map((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        text: node.textContent,
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        centreX: Math.round(box.left + box.width / 2),
        colour: style.color,
        font: style.fontFamily,
        weight: style.fontWeight,
        fontSize: Math.round(parseFloat(style.fontSize)),
        shadow: style.textShadow
      };
    }).concat([{ videoHeight: video.clientHeight, videoWidth: video.clientWidth, centre: video.clientWidth / 2 }]);
  });

  const meta = cues.pop();
  const dialogue = cues.find((c) => c.text.includes('DIALOGUE'));
  const sign = cues.find((c) => c.text.includes('SIGN'));

  check('both events are on screen', Boolean(dialogue) && Boolean(sign), cues.map((c) => c.text));
  // The trap a naive comma split would hit, verified end to end this time.
  check('a comma inside dialogue survives to the screen',
    dialogue?.text.includes('with a comma'), dialogue?.text);
  check('the \\an8 sign is above the dialogue', sign && dialogue && sign.top < dialogue.top,
    { sign: sign?.top, dialogue: dialogue?.top });
  check('the dialogue sits in the lower half',
    dialogue && dialogue.top > meta.videoHeight / 2, { top: dialogue?.top, height: meta.videoHeight });
  // &H0000FFFF is yellow once the byte order is reversed; read as #RRGGBB it
  // would come out cyan, so this catches the parser bug end to end.
  check('the sign takes its style colour, byte order and all',
    /rgba?\(\s*255,\s*255,\s*0/.test(sign?.colour || ''), sign?.colour);
  check('the sign is bold, from -1 in its style', Number(sign?.weight) >= 700, sign?.weight);
  check('the sign uses its own font', /Verdana/i.test(sign?.font || ''), sign?.font);
  check('the dialogue uses its own font', /Arial/i.test(dialogue?.font || ''), dialogue?.font);
  check('an outline is drawn', (dialogue?.shadow || '').length > 0);
  // \pos(960,...) on a 1920-wide script is the horizontal centre.
  check('a positioned sign is centred on the video, not the element',
    sign && Math.abs(sign.centreX - meta.centre) < 40, { sign: sign?.centreX, centre: meta.centre });

  console.log('\nappearance');
  const before = cues.find((c) => c.text.includes('DIALOGUE')).fontSize;
  await page.evaluate(async () => {
    const m = await import('/js/player.js');
    m.setSubtitleStyle({ size: 200 });
  });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const node = Array.from(document.getElementById('player-ass').children)
      .find((n) => n.textContent.includes('DIALOGUE'));
    return Math.round(parseFloat(getComputedStyle(node).fontSize));
  });
  check('the size preference scales ASS cues too', after > before * 1.5, { before, after });

  const cueRule = await page.evaluate(() => document.getElementById('subtitle-cue-style')?.textContent || '');
  check('a ::cue rule exists for the WebVTT path', cueRule.includes('::cue'));
  check('and carries the chosen size', /font-size:\s*200%/.test(cueRule), cueRule.slice(0, 120));

  await page.evaluate(async () => {
    const m = await import('/js/player.js');
    m.setSubtitleColour('yellow');
  });
  const colourRule = await page.evaluate(() => document.getElementById('subtitle-cue-style')?.textContent || '');
  check('the colour reaches the rule as a hex value', /#ffe14d/i.test(colourRule));

  await page.evaluate(async () => {
    const m = await import('/js/player.js');
    m.resetSubtitleStyle();
  });
  const reset = await page.evaluate(() => document.getElementById('subtitle-cue-style')?.textContent || '');
  check('reset returns the rule to the default size', /font-size:\s*100%/.test(reset));

  console.log('\nteardown');
  await page.evaluate(async () => {
    const m = await import('/js/player.js');
    await m.close({ save: false });
  });
  await page.waitForTimeout(400);
  // A render loop left running would keep repainting against a dead context.
  const overlayGone = await page.evaluate(() => {
    const overlay = document.getElementById('player-ass');
    return overlay === null || overlay.children.length === 0;
  });
  check('the overlay stops drawing when the player closes', overlayGone);
} finally {
  // The sidecar goes even if a check threw: it lives in the real library.
  if (sidecar && fs.existsSync(sidecar)) {
    fs.unlinkSync(sidecar);
    console.log(`\nremoved ${path.basename(sidecar)}`);
  }
  await browser.close();
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
