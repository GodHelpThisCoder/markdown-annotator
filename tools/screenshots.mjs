// Keystone screenshots of every major surface, using the built-in showcase document, at three viewports.
// Run: node tools/screenshots.mjs   (writes docs/screenshots/<width>x<height>[-light]/NN-surface.png)
// The theme follows the system by default, so each run pins the colour scheme: dark everywhere, light at two widths.
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'markdown-annotator.html')).href;
const sample = readFileSync(join(root, 'samples', 'showcase.md'), 'utf8').replace(/\r\n?/g, '\n');
const VIEWPORTS = [
  { w: 380, h: 860, scheme: 'dark' },
  { w: 760, h: 900, scheme: 'dark' },
  { w: 1280, h: 860, scheme: 'dark' },
  { w: 380, h: 860, scheme: 'light' },
  { w: 1280, h: 860, scheme: 'light' },
];

// Round 2: what the file looks like after the author (or an agent) addressed the first comments.
const ROUND2 = sample
  .replace('| Three-way text merge | good for prose | a base snapshot per note | moderate |', '| Three-way text merge | good for prose and lists | one base snapshot per note | moderate |')
  .replace(/> \*\*Note:\*\* the merge runs on the device[^\n]*\n> which keeps it stateless[^\n]*\n\n/, '')
  .replace('  return accepted.length;\n', '  await log.compact({ keepDays: 30 });\n  return accepted.length;\n')
  .replace('How long should a device keep operations', 'Decided: compaction runs on the device, after the server confirms receipt.\n\nHow long should a device keep operations');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const { w, h, scheme } of VIEWPORTS) {
  const dir = join(root, 'docs', 'screenshots', `${w}x${h}${scheme === 'light' ? '-light' : ''}`);
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: scheme });
  await ctx.addInitScript(() => {
    const clip = { writeText: async (t) => { window.__copied = t; }, readText: async () => window.__copied || '' };
    Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => clip });
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => ({ platform: 'macOS', mobile: false, brands: [] }) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => window.__markdownAnnotator.ready);
  // The pointer is parked in a corner first, so no row shows a stray hover state.
  const shot = async (name) => {
    await page.mouse.move(2, page.viewportSize().height - 2);
    await page.screenshot({ path: join(dir, `${name}.png`) });
  };
  const settle = () => page.waitForTimeout(250);
  const centre = (text, nth = 0, at = 0.4) => page.evaluate(([t, n, a]) => {
    const api = window.__markdownAnnotator;
    api.selectText(t, n);
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    window.scrollBy({ top: r.top - innerHeight * a, behavior: 'instant' });
    getSelection().removeAllRanges();
    document.querySelector('#pill').hidden = true;
  }, [text, nth, at]);
  const comment = async (text, body) => {
    await centre(text);
    await page.evaluate((t) => window.__markdownAnnotator.selectText(t), text);
    await page.keyboard.press('c');
    await page.keyboard.type(body);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
  };

  await page.click('#try-sample');
  await page.waitForSelector('#doc:not([hidden])');
  await settle();
  await shot('02-reading');

  await centre('Edits made offline are never lost', 0, 0.45);
  await page.evaluate(() => window.__markdownAnnotator.selectText('Edits made offline are never lost'));
  await settle();
  await shot('03-selection');

  await page.keyboard.press('c');
  await page.keyboard.type('Say what "never lost" means when the disk is full.');
  await settle();
  await shot('04-composer');
  await page.keyboard.press('Enter');

  await comment('loses edits', 'Give a concrete example of a lost edit.');
  await comment('await log.markSent(accepted);', 'What if markSent fails after the push succeeded?');
  await comment('the merge runs on the device, not on the server', 'Older clients may merge differently. Version the rules?');
  await centre('Two devices can edit the same paragraph', 0, 0.12);
  await settle();
  await shot('05-comments');

  await page.keyboard.press('g');
  await page.keyboard.type('Overall: strong proposal. Add a section on how conflicts are shown to users.');
  await page.evaluate(() => { const b = document.querySelector('#preview-box'); b.open = true; document.querySelector('.drawer-body').scrollTop = 0; });
  await settle();
  await shot('06-review');
  await page.keyboard.press('Escape');

  await page.keyboard.press('o');
  await settle();
  await shot('07-outline');
  await page.keyboard.press('Escape');

  await page.click('#btn-menu');
  await settle();
  await shot('08-menu');
  await page.keyboard.press('Escape');

  await page.click('#btn-menu');
  await page.click('#menu button:has-text("Settings")');
  await settle();
  await shot('09-settings');
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  await settle();
  await shot('10-shortcuts');
  await page.keyboard.press('Escape');

  // Copy round 1, then the file changes on disk.
  await page.keyboard.press('Meta+Enter');
  await page.waitForTimeout(150);
  await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), ROUND2);
  await page.waitForTimeout(150);
  await page.keyboard.press('n');
  await settle();
  await shot('11-changes');

  await page.keyboard.press('r');
  await page.evaluate(() => { const d = document.querySelector('#review details'); if (d) d.open = true; document.querySelector('#preview-box').open = false; });
  await settle();
  await shot('12-earlier-rounds');
  await page.keyboard.press('Escape');

  await page.click('#btn-menu');
  await page.click('#menu button:has-text("Close document")');
  await page.waitForSelector('#empty:not([hidden])');
  await page.waitForTimeout(300);
  await shot('01-start');

  console.log(`${w}x${h} ${scheme}: done${errors.length ? ` (errors: ${errors.join('; ')})` : ''}`);
  await ctx.close();
}
await browser.close();
