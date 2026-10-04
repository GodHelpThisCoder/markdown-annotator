// Shared helpers for the end-to-end regression suite (test/e2e.test.mjs).
// Runs markdown-annotator.html from file:// in the locally installed Chrome (headless) through playwright-core.
import { chromium } from 'playwright-core';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const appUrl = pathToFileURL(join(root, 'markdown-annotator.html')).href;
export const fixture = (name) => readFileSync(join(root, 'test', 'fixtures', name), 'utf8').replace(/\r\n?/g, '\n');
export const PLAN = fixture('PLAN.md');
export const EDGE = fixture('EDGE.md');

export async function launch(extra = {}) {
  return chromium.launch({ channel: 'chrome', headless: true, timeout: 30000, ...extra });
}

/**
 * Chrome as a person runs it: an ordinary (not off-the-record) profile in a fresh temp folder, and none of
 * Playwright's default flags (it adds --no-sandbox, among others). The tab-close crash with file handles
 * (see the store in src/app.js) needs this setup to show up reliably. `crashed()` says whether the whole
 * browser went away.
 */
export async function launchProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'ma-profile-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chrome', headless: true, timeout: 30000, ignoreDefaultArgs: true,
    args: ['--remote-debugging-pipe', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--headless', 'about:blank'],
  });
  let gone = false;
  ctx.on('close', () => { gone = true; });
  return {
    ctx,
    crashed: () => gone,
    async close() { if (!gone) await ctx.close().catch(() => {}); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked */ } },
  };
}

/** Drop a real file from disk onto the page, as from Finder or Explorer: the page gets a real file handle. */
export async function dropFile(page, path) {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 200, y: 200, data });
  await cdp.detach();
}

// Platform emulation: the app reads navigator.userAgentData.platform, then navigator.platform.
const PLATFORMS = {
  win: { platform: 'Win32', uad: 'Windows' },
  mac: { platform: 'MacIntel', uad: 'macOS' },
};

/**
 * A fresh context (its own IndexedDB and localStorage) and page with the app loaded and ready.
 * opts.width/height: viewport. opts.platform: 'win' (default) or 'mac'.
 * opts.disk: { name, text } installs a fake showOpenFilePicker whose handle reads window.__diskText.
 * The clipboard is always stubbed (window.__clips collects writes; window.__clipFail makes them fail),
 * so the suite never touches the real system clipboard.
 */
export async function openApp(browser, opts = {}) {
  const { width = 900, height = 900, platform = 'win', disk = null, ctx: existing = null } = opts;
  const ctx = existing || (await browser.newContext({ viewport: { width, height } }));
  const p = PLATFORMS[platform];
  await ctx.addInitScript(({ p, disk }) => {
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => p.platform });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      get: () => ({ platform: p.uad, mobile: false, brands: [] }),
    });
    window.__clips = [];
    window.__clipFail = false;
    const clip = {
      writeText: async (t) => {
        if (window.__clipFail) throw new DOMException('denied', 'NotAllowedError');
        window.__clips.push(t);
      },
      readText: async () => window.__clips[window.__clips.length - 1] || '',
    };
    Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => clip });
    const realExec = document.execCommand.bind(document);
    document.execCommand = (cmd, ...rest) => (cmd === 'copy' ? (window.__clipFail ? false : (window.__clips.push('[execCommand]'), true)) : realExec(cmd, ...rest));
    if (disk) {
      window.__diskText = disk.text;
      window.__diskTs = 1000;
      window.__pickCount = 0;
      window.__reads = 0;
      const fakeHandle = {
        kind: 'file',
        name: disk.name,
        getFile: async () => {
          window.__reads++;
          if (window.__diskMissing) throw new DOMException('A requested file could not be found.', 'NotFoundError');
          return new File([window.__diskText], disk.name, { lastModified: window.__diskTs });
        },
        isSameEntry: async (o) => o === fakeHandle,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
      };
      window.showOpenFilePicker = async () => { window.__pickCount++; return [fakeHandle]; };
    } else {
      window.__pickCount = 0;
      window.showOpenFilePicker = async () => { window.__pickCount++; throw new DOMException('aborted', 'AbortError'); };
    }
  }, { p, disk });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(appUrl);
  await page.evaluate(() => window.__markdownAnnotator.ready);
  return { ctx, page, errors };
}

export const openText = (page, name, text, source = 'file') =>
  page.evaluate(([n, t, s]) => window.__markdownAnnotator.openText(n, t, s), [name, text, source]);

export const selectText = (page, exact, nth = 0) =>
  page.evaluate(([e, n]) => window.__markdownAnnotator.selectText(e, n), [exact, nth]);

export const output = (page, all = false) => page.evaluate((a) => window.__markdownAnnotator.output(a), all);

export const comments = (page) => page.evaluate(() => window.__markdownAnnotator.state.comments.map((c) => ({
  id: c.id, body: c.body, exact: c.exact, quote: c.quote, lineStart: c.lineStart, lineEnd: c.lineEnd,
  sent: !!c.sent, archived: !!c.archived, detached: !!c.detached, fuzzy: !!c.fuzzy, anchored: !!c.range, num: c.num ?? null,
})));

export const visible = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.hidden && el.getClientRects().length > 0; }, sel);

export const toasts = (page) => page.$$eval('#toasts .toast', (ts) => ts.map((t) => t.textContent));

export const clips = (page) => page.evaluate(() => window.__clips.slice());

/** Select `exact` (nth occurrence), press `key` ('c' or 'Enter') to open the composer, type the body, press Enter. */
export async function addComment(page, exact, body, { nth = 0, key = 'c' } = {}) {
  const ok = await selectText(page, exact, nth);
  if (!ok) throw new Error(`text not found in the rendered document: ${JSON.stringify(exact)}`);
  await page.keyboard.press(key);
  await page.waitForSelector('#composer:not([hidden])');
  await page.keyboard.type(body);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#composer', { state: 'hidden' });
  const all = await comments(page);
  return all[all.length - 1];
}

/** Client rects (viewport coordinates) of the nth occurrence of exact in the rendered text, without leaving a selection. */
export function rectsOf(page, exact, nth = 0) {
  return page.evaluate(([e, n]) => {
    if (!window.__markdownAnnotator.selectText(e, n)) return null;
    const sel = window.getSelection();
    const rects = Array.from(sel.getRangeAt(0).getClientRects()).filter((r) => r.width > 0.5).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    sel.removeAllRanges();
    document.querySelector('#pill').hidden = true;
    return rects;
  }, [exact, nth]);
}

/** Scroll the nth occurrence of exact to the middle of the viewport. */
export function scrollToText(page, exact, nth = 0) {
  return page.evaluate(([e, n]) => {
    window.__markdownAnnotator.selectText(e, n);
    const sel = window.getSelection();
    const r = sel.getRangeAt(0).getBoundingClientRect();
    window.scrollBy({ top: r.top - window.innerHeight / 2, behavior: 'instant' });
    sel.removeAllRanges();
    document.querySelector('#pill').hidden = true;
  }, [exact, nth]);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll fn() until it returns a truthy value (or throw after timeout). */
export async function until(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${message} (last value: ${JSON.stringify(last)})`);
}

/** Read the stored document record straight from IndexedDB (handle replaced by a flag). */
export function idbRecord(page, key = null) {
  return page.evaluate((k) => new Promise((resolve, reject) => {
    const req = indexedDB.open('markdown-annotator.v1');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('docs', 'readonly');
      const g = k ? tx.objectStore('docs').get(k) : tx.objectStore('docs').getAll();
      g.onsuccess = () => {
        const strip = (r) => r && ({ ...r, handle: r.handle ? 'present' : null });
        resolve(Array.isArray(g.result) ? g.result.map(strip) : strip(g.result));
        db.close();
      };
      g.onerror = () => reject(g.error);
    };
  }), key);
}
