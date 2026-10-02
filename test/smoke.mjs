// Quick end-to-end smoke run of markdown-annotator.html in the locally installed Chrome (headless).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'markdown-annotator.html')).href;
const plan = readFileSync(join(root, 'test', 'fixtures', 'PLAN.md'), 'utf8');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.W || 560), height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
await page.goto(url);
await page.evaluate(() => window.__markdownAnnotator.ready);
await page.evaluate((t) => window.__markdownAnnotator.openText('PLAN.md', t), plan);

// Comment 1 via keyboard flow: select, press C, type, Enter.
await page.evaluate(() => window.__markdownAnnotator.selectText('cross-request/cross-restart synchronization'));
await page.keyboard.press('c');
await page.keyboard.type('How does this survive a restart?');
await page.keyboard.press('Enter');

// Comment 2 inside the Go code block.
await page.evaluate(() => window.__markdownAnnotator.selectText('return domain.ProjectStatusFailed'));
await page.click('#pill');
await page.keyboard.type('Use Unknown, not Failed.');
await page.keyboard.press('Enter');

// Comment 3 on a nested tight list item, second occurrence of duplicate text.
await page.evaluate(() => window.__markdownAnnotator.selectText('unless `--force` is passed'.replace(/`/g, '')));
await page.keyboard.press('Enter');
await page.keyboard.type('Drop --force; nobody needs it.');
await page.keyboard.press('Enter');

// Comment 4: the duplicate sentence in Open questions.
await page.evaluate(() => window.__markdownAnnotator.selectText('The combination of mutex and database queries'));
await page.keyboard.press('c');
await page.keyboard.type('Why repeat this?');
await page.keyboard.press('Enter');

// Comment 5: table cell.
await page.evaluate(() => window.__markdownAnnotator.selectText('be conservative'));
await page.keyboard.press('c');
await page.keyboard.type('Explain why.');
await page.keyboard.press('Enter');

const out = await page.evaluate(() => window.__markdownAnnotator.output());
console.log('----- OUTPUT -----\n' + out + '----- END -----');
const notes = await page.$$eval('.note', (ns) => ns.map((n) => n.textContent));
console.log('notes:', notes);
await page.screenshot({ path: join(root, 'test', 'out', `smoke-${process.env.W || 560}.png`), fullPage: false });
console.log('errors:', errors);
await browser.close();
