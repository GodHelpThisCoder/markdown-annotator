// End-to-end regression suite for markdown-annotator.html (see SPEC.md).
// Run: npm test   (builds, then runs node --test "test/*.test.mjs")
// Uses playwright-core with the locally installed Chrome, headless. One browser, a fresh context per test.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launch, openApp, openText, selectText, output, comments, visible, toasts, clips, addComment,
  rectsOf, scrollToText, until, sleep, idbRecord, appUrl, PLAN, EDGE, launchProfile, dropFile,
} from './helpers.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { if (browser) await browser.close(); });

// Run a test body with a fresh context; always closes it and fails on uncaught page errors.
async function withApp(opts, fn) {
  const app = await openApp(opts.browser ? opts.browser() : browser, opts);
  try {
    await fn(app);
    assert.deepEqual(app.errors, [], 'no page errors or console errors');
  } finally {
    await app.ctx.close();
  }
}

// PLAN.md with two lines inserted under the H1 (everything below shifts by +2).
const PLAN_SHIFTED = PLAN.replace('# Plan: Async Deploy Pipeline\n', '# Plan: Async Deploy Pipeline\n\nA new intro paragraph Claude added.\n');

// ---------------------------------------------------------------------------
describe('open and render', () => {
  test('openText renders the document with safe Markdown defaults', () => withApp({}, async ({ page }) => {
    assert.ok(await visible(page, '#empty'), 'start screen first');
    assert.ok(!(await visible(page, '#bar')), 'no top bar on the start screen');
    await openText(page, 'PLAN.md', PLAN);
    assert.ok(await visible(page, '#doc'));
    assert.ok(!(await visible(page, '#empty')));
    assert.equal(await page.textContent('#crumb-file'), 'PLAN.md');
    assert.equal(await page.title(), 'PLAN.md · Markdown Annotator');
    const info = await page.evaluate(() => {
      const doc = document.querySelector('#doc');
      const ext = doc.querySelector('a[href="https://example.com/spec"]');
      return {
        text: doc.textContent,
        h1: doc.querySelector('h1').id,
        goals: !!doc.querySelector('#h-goals'),
        frag: doc.querySelector('a[href^="#"]').getAttribute('href'),
        extTarget: ext.getAttribute('target'),
        extRel: ext.getAttribute('rel'),
        links: Array.from(doc.querySelectorAll('a')).map((a) => a.textContent),
        frontmatter: !!doc.querySelector('pre.frontmatter'),
        hr: doc.querySelectorAll('hr').length,
        tasks: doc.querySelectorAll('li.task input[type=checkbox]').length,
        checked: doc.querySelectorAll('li.task input:checked').length,
        tableWrap: !!doc.querySelector('.table-wrap > table'),
        tree: doc.querySelector('pre.nowrap:not(.frontmatter)')?.textContent.includes('handlers/'),
      };
    });
    assert.ok(info.text.includes('<project-id>'), 'raw HTML-like prose stays visible as text');
    assert.equal(info.h1, 'h-plan-async-deploy-pipeline');
    assert.ok(info.goals);
    assert.equal(info.frag, '#h-goals', 'fragment links point at prefixed heading ids');
    assert.equal(info.extTarget, '_blank');
    assert.equal(info.extRel, 'noopener noreferrer');
    assert.deepEqual(info.links, ['the spec', 'goals'], 'README.md and main.py are not linkified');
    assert.ok(info.frontmatter, 'front matter renders as a block, not an <hr> plus heading');
    assert.equal(info.hr, 1, 'only the real thematic break is an <hr>');
    assert.equal(info.tasks, 3);
    assert.equal(info.checked, 1);
    assert.ok(info.tableWrap, 'tables sit in a scroll wrapper');
    assert.ok(info.tree, 'directory trees never wrap');
  }));

  test('pasted Markdown takes its name from the first heading', () => withApp({}, async ({ page }) => {
    await page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, '# Pasted plan\n\nSome text to review.\n');
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc), { message: 'pasted doc' });
    const doc = await page.evaluate(() => ({ ...window.__markdownAnnotator.state.doc }));
    assert.equal(doc.source, 'paste');
    assert.equal(doc.name, 'Pasted plan');
  }));
});

// ---------------------------------------------------------------------------
describe('commenting', () => {
  test('keyboard flow: select, C, type, Enter', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    assert.ok(await selectText(page, 'cross-request/cross-restart synchronization'));
    await until(() => visible(page, '#pill'), { message: 'pill' });
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    assert.equal(await page.textContent('#cmp-title'), 'New comment · line 36');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'cmp-text', 'focus moves to the composer');
    assert.equal(await page.inputValue('#cmp-text'), '', 'the C key press is not typed into the composer');
    assert.equal(await page.evaluate(() => CSS.highlights.get('cr-pending').size), 1, 'passage stays painted while typing');
    await page.keyboard.type('How does this survive a restart?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#composer', { state: 'hidden' });
    const [c] = await comments(page);
    assert.equal(c.body, 'How does this survive a restart?');
    assert.equal(c.exact, 'cross-request/cross-restart synchronization');
    assert.equal(c.lineStart, 36);
    assert.equal(c.lineEnd, 36);
    assert.equal(await page.evaluate(() => CSS.highlights.get('cr-note').size), 1, 'saved comment is painted');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#doc mark, #doc [data-comment]').length), 0, 'no DOM wrapping');
    const notes = await page.$$eval('#doc .note', (ns) => ns.map((n) => n.textContent));
    assert.deepEqual(notes, ['1How does this survive a restart?']);
    assert.equal(await page.textContent('#chip-count'), '1');
    assert.equal(await page.textContent('#copy-label'), 'Copy 1');
  }));

  test('Enter with a selection also opens the composer; Shift+Enter adds a newline', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('first line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');
    assert.ok(await visible(page, '#composer'), 'Shift+Enter does not save');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#composer', { state: 'hidden' });
    const [c] = await comments(page);
    assert.equal(c.body, 'first line\nsecond line');
  }));

  test('pill click flow with a real mouse drag', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await scrollToText(page, 'provides complete concurrent');
    const rects = await rectsOf(page, 'provides complete concurrent');
    const r = rects[0];
    const y = (r.top + r.bottom) / 2;
    await page.mouse.move(r.left + 1, y);
    await page.mouse.down();
    await page.mouse.move((r.left + r.right) / 2, y, { steps: 4 });
    await page.mouse.move(r.right - 1, y, { steps: 4 });
    await page.mouse.up();
    await until(() => visible(page, '#pill'), { message: 'pill after drag' });
    const sel = await page.evaluate(() => window.getSelection().toString());
    assert.match(sel, /provides complete concurren/);
    const pill = await page.locator('#pill').boundingBox();
    // The pill sits next to the selection (in the right margin, or just above it) and never covers it.
    const overlaps = pill.x < r.right && pill.x + pill.width > r.left && pill.y < r.bottom && pill.y + pill.height > r.top;
    assert.ok(!overlaps, `pill covers the selection (pill ${JSON.stringify(pill)}, text ${JSON.stringify(r)})`);
    assert.ok(pill.y + pill.height <= r.top + 2 || (pill.x >= r.right && Math.abs(pill.y + pill.height / 2 - (r.top + r.bottom) / 2) < 20), `pill is beside or above the selection (pill y ${pill.y}, text top ${r.top})`);
    await page.click('#pill');
    await page.waitForSelector('#composer:not([hidden])');
    assert.match(await page.textContent('#cmp-title'), /line 36/);
    await page.keyboard.type('Is it complete?');
    await page.click('#cmp-save');
    await page.waitForSelector('#composer', { state: 'hidden' });
    const [c] = await comments(page);
    assert.equal(c.body, 'Is it complete?');
    assert.equal(c.lineStart, 36);
  }));

  test('double-click a word, then C', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await scrollToText(page, 'SSE');
    const [r] = await rectsOf(page, 'SSE');
    await page.mouse.dblclick((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    await until(() => visible(page, '#pill'), { message: 'pill after dblclick' });
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('Why SSE?');
    await page.keyboard.press('Enter');
    const [c] = await comments(page);
    assert.equal(c.exact, 'SSE');
    assert.equal(c.lineStart, 15);
  }));

  test('bare keys are ignored in text fields and with modifiers', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await page.keyboard.press('g');
    await until(() => page.evaluate(() => document.activeElement && document.activeElement.id === 'general'), { message: 'general note focus' });
    await page.keyboard.type('or jkn c');
    assert.equal(await page.inputValue('#general'), 'or jkn c', 'letters typed into the general note stay there');
    assert.ok(await visible(page, '#review'), 'R/O typed in a field do not toggle drawers');
    assert.ok(!(await visible(page, '#outline')));
    await page.keyboard.press('Escape');
    assert.ok(!(await visible(page, '#review')));
    await page.keyboard.press('Control+s');
    await until(async () => (await toasts(page)).some((t) => t.includes('save automatically')), { message: 'Mod+S toast' });
  }));
});

// ---------------------------------------------------------------------------
describe('line numbers', () => {
  // [exact, nth, lineStart, lineEnd, location fragment expected in the output heading]
  const CASES = [
    ['status: draft', 0, 3, 3, 'line 3, front matter'],
    ['Goals', 0, 12, 12, 'line 12, heading'],
    ['layer, the project service', 0, 9, 9, 'line 9, under "Plan: Async Deploy Pipeline"'],
    ['and report progress over SSE', 0, 15, 15, 'line 15, under "Plan: Async Deploy Pipeline > Goals"'],
    ['while one is in progress', 0, 17, 17, 'line 17,'],
    ['unless --force is passed', 0, 18, 18, 'line 18, under "Plan: Async Deploy Pipeline > Goals"'],
    ['It queries deployments with status=deploying for a project.', 0, 23, 23, 'line 23,'],
    ['Wire it into the service', 0, 25, 25, 'line 25,'],
    ['Add the repository query', 0, 30, 30, 'line 30, under "Plan: Async Deploy Pipeline > Tasks"'],
    ['cross-request/cross-restart synchronization', 0, 36, 36, 'line 36, under "Plan: Async Deploy Pipeline > Design"'],
    ['database queries\n(for cross-request', 0, 35, 36, 'lines 35-36, under "Plan: Async Deploy Pipeline > Design"'],
    ['waits for a running up to finish.', 0, 40, 40, 'line 40,'],
    ['func deriveProjectStatus', 0, 47, 47, 'line 47, code block under "Design > Step 6: Add Helper Function for Status…"'],
    ['return domain.ProjectStatusFailed', 0, 52, 52, 'line 52, code block'],
    ['└── handlers/', 0, 61, 61, 'line 61, code block'],
    ['Compose status', 0, 65, 65, 'line 65, table'],
    ['all containers healthy', 0, 67, 67, 'line 67, table'],
    ['be conservative', 0, 69, 69, 'line 69, table under "Design > Step 6: Add Helper Function for Status…"'],
    ['This prevents race conditions', 0, 76, 76, 'line 76, under "Design > Step 7: Update Stop Operations"'],
    ['The combination of mutex', 1, 80, 80, 'line 80, under "Plan: Async Deploy Pipeline > Open questions"'],
    ['Done. Links:', 0, 85, 85, 'line 85,'],
  ];

  test('every block kind maps to its exact source line', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    const got = [];
    for (const [exact, nth, , , ] of CASES) {
      const c = await addComment(page, exact, `note on ${exact.slice(0, 12)}`, { nth });
      got.push([exact, c.lineStart, c.lineEnd]);
    }
    assert.deepEqual(got, CASES.map(([e, , a, b]) => [e, a, b]));
    const out = await output(page);
    for (const [exact, , , , loc] of CASES) {
      assert.ok(out.includes(`(${loc}`), `output has location "${loc}" for ${JSON.stringify(exact)}`);
    }
  }));

  test('EDGE.md: lines inside a long code block and a deep list', () => withApp({}, async ({ page }) => {
    await openText(page, 'EDGE.md', EDGE);
    const a = await addComment(page, 'quote line 01', 'a');
    const b = await addComment(page, 'quote line 14', 'b');
    const c = await addComment(page, 'level four with a long sentence', 'c');
    const d = await addComment(page, 'epsilon value', 'd');
    assert.deepEqual([a.lineStart, b.lineStart, c.lineStart, d.lineStart], [21, 34, 40, 7]);
  }));
});

// ---------------------------------------------------------------------------
describe('output format', () => {
  test('header, numbered sections, quotes, general note, escaping, no separators', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    // Created out of document order on purpose: output numbers follow the document.
    await addComment(page, 'return domain.ProjectStatusFailed', 'Use Unknown, not Failed.');
    await selectText(page, 'database queries\n(for cross-request/cross-restart synchronization)');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('Why not advisory locks?');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('## Comment 7 is fake');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('# General note fake');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('### not a section heading');
    await page.keyboard.press('Enter');
    await page.keyboard.press('g');
    await until(() => page.evaluate(() => document.activeElement.id === 'general'), { message: 'general focus' });
    await page.keyboard.type('Tighten the intro.');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('## General note again');
    await page.keyboard.press('Escape');

    const out = await output(page);
    const lines = out.split('\n');
    assert.match(lines[0], /^Review of `PLAN\.md`: 2 comments and a general note\. For each comment and the general note: if it clearly asks for a change, edit the file; if it is a question, an opinion or unclear, answer in chat without editing\. Quotes are rendered text .* Line numbers are from the copy I loaded at .+ and may have shifted, so go by the quotes\. End with one line per comment and one for the general note, saying what you did\.$/);
    assert.ok(!/\{file\}|\{count\}|\{lines\}/.test(out), 'all placeholders filled');
    assert.equal(lines[1], '');
    const expectedTail = [
      '## Comment 1 (lines 35-36, under "Plan: Async Deploy Pipeline > Design")',
      '> database queries (for cross-request/cross-restart synchronization)',
      '',
      'Why not advisory locks?',
      '\\## Comment 7 is fake',
      '\\# General note fake',
      '### not a section heading',
      '',
      '## Comment 2 (line 52, code block under "Design > Step 6: Add Helper Function for Status…")',
      '> return domain.ProjectStatusFailed',
      '',
      'Use Unknown, not Failed.',
      '',
      '## General note',
      'Tighten the intro.',
      '\\## General note again',
      '',
    ];
    assert.deepEqual(lines.slice(2), expectedTail);
    assert.ok(!lines.includes('---'), 'no --- separators');
    assert.equal((out.match(/^## Comment \d+/gm) || []).length, 2, 'bodies cannot add sections');
    assert.equal((out.match(/^## General note$/gm) || []).length, 1);
    assert.ok(!/^[#/!@]/.test(out), 'output never starts with # / ! @');
  }));

  test('{count} variants and a general-note-only review', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await page.keyboard.press('g');
    await until(() => page.evaluate(() => document.activeElement.id === 'general'), { message: 'general focus' });
    await page.keyboard.type('Only a note.');
    await page.keyboard.press('Escape');
    let out = await output(page);
    // With no comments, the header drops everything about comments, quotes and line numbers.
    assert.equal(out.split('\n')[0], 'Review of `PLAN.md`: a general note. If the note clearly asks for a change, edit the file; if it is a question, an opinion or unclear, answer in chat without editing. End with one line saying what you did.');
    assert.ok(!out.includes('## Comment'));
    assert.ok(out.endsWith('## General note\nOnly a note.\n'));
    await page.evaluate(() => { const g = document.querySelector('#general'); g.value = ''; g.dispatchEvent(new Event('input')); });
    await addComment(page, 'be conservative', 'One.');
    out = await output(page);
    assert.match(out, /^Review of `PLAN\.md`: 1 comment\. If the comment clearly asks for a change, edit the file; .* The quote is rendered text .* so match it loosely\. .* End with one line saying what you did\.\n/);
    await addComment(page, 'SSE', 'Two.');
    assert.match(await output(page), /^Review of `PLAN\.md`: 2 comments\. For each comment: .* Quotes are rendered text .* End with one line per comment saying what you did\.\n/);
  }));

  test('pasted documents and the file path override', () => withApp({}, async ({ page }) => {
    await openText(page, 'Pasted plan', '# Pasted plan\n\nSome text to review here.\n', 'paste');
    await addComment(page, 'text to review', 'Hm.');
    let out = await output(page);
    assert.match(out, /^Review of the document I copied, titled "Pasted plan": 1 comment\. If the comment clearly asks for a change, make it; if it is a question, an opinion or unclear, answer in chat without editing\. Make changes in the file the document comes from if you can see it; if it exists only in this chat, reply with the whole revised document; if you can't find it, ask me\./);
    assert.ok(out.includes('Line numbers count from the first line I copied.'));
    assert.ok(out.includes('## Comment 1 (line 3, under "Pasted plan")'));
    await page.keyboard.press('r');
    await page.waitForSelector('#review:not([hidden])');
    await page.fill('#path', 'docs/PLAN.md');
    out = await output(page);
    assert.match(out, /^Review of `docs\/PLAN\.md`: 1 comment\. If the comment clearly asks for a change, edit the file;/);
    assert.ok(out.includes('Line numbers count from the first line I copied, which may not be line 1 of the file, so go by the quote.'));
    assert.ok(!out.includes('Make changes in the file the document comes from'), 'a typed path is treated as the file');
    const preview = await page.evaluate(() => { const b = document.querySelector('#preview-box'); b.open = true; return document.querySelector('#preview').textContent; });
    assert.equal(preview, out, 'the Review preview shows exactly what Copy produces');
  }));

  test('pasted text without a heading is described by its first words, never "Pasted Markdown"', () => withApp({}, async ({ page }) => {
    await openText(page, 'Pasted Markdown', 'Fieldnotes users write in places with poor signal. Today an edit made offline is lost.\n\n- one\n- two\n', 'paste');
    await page.evaluate(() => { window.__markdownAnnotator.state.general = 'test'; });
    const out = await output(page);
    assert.equal(out, 'Review of the document I copied, which starts "Fieldnotes users write in places with poor signal": a general note. If the note clearly asks for a change, make it; if it is a question, an opinion or unclear, answer in chat without editing. Make changes in the file the document comes from if you can see it; if it exists only in this chat, reply with the whole revised document; if you can\'t find it, ask me. End with one line saying what you did.\n\n## General note\ntest\n');
    // A long first sentence is cut at a word, with an ellipsis.
    await openText(page, 'Pasted Markdown', `${'word '.repeat(30)}end.\n`, 'paste');
    await page.evaluate(() => { window.__markdownAnnotator.state.general = 'x'; });
    assert.match(await output(page), /^Review of the document I copied, which starts "(word ){11}word…": a general note\./);
  }));

  test('pasted text is described by whatever block it opens with', () => withApp({}, async ({ page }) => {
    const lead = async (text) => {
      await openText(page, 'Pasted Markdown', text, 'paste');
      await page.evaluate(() => { window.__markdownAnnotator.state.general = 'x'; });
      return (await output(page)).split(':')[0];
    };
    assert.equal(await lead('```js\nconst x = 1;\n```\n\nLater text.\n'), 'Review of the document I copied, which starts "const x = 1;"');
    assert.equal(await lead('| Strategy | Cost |\n|---|---|\n| A | B |\n\nLater text.\n'), 'Review of the document I copied, which starts "Strategy | Cost"');
    assert.equal(await lead('---\ntitle: "Sync plan"\nstatus: draft\n---\n\nLater text.\n'), 'Review of the document I copied, titled "Sync plan"');
    assert.equal(await lead('---\nstatus: draft\n---\n\nLater text here now.\n'), 'Review of the document I copied, which starts "Later text here now"');
    assert.equal(await lead('- first item here\n- second\n'), 'Review of the document I copied, which starts "first item here"');
    assert.equal(await lead('Dr. Smith wrote this plan. More follows.\n'), 'Review of the document I copied, which starts "Dr. Smith wrote this plan"');
  }));

  test('a comment whose passage is gone gets a header sentence telling the agent to check it first', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Why?');
    await addComment(page, 'status: draft', 'Mark this as ready.');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN.replace(/status: draft/g, 'status: ready'));
    const out = await output(page);
    assert.ok(out.split('\n')[0].includes(' Comment 2 quotes text that is no longer in the file, so check whether it is already done before changing anything. '), out.split('\n')[0]);
    assert.ok(out.includes('## Comment 2 (was line 3;'), 'the detached comment is the one named');
    assert.ok(out.includes(' Line numbers (except those marked "was") are from the copy I loaded '), 'the line-number sentence does not vouch for "was line 3"');
  }));

  test('a review whose only comment lost its passage makes no line-number claim', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'status: draft', 'Mark this as ready.');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN.replace(/status: draft/g, 'status: ready'));
    const head = (await output(page)).split('\n')[0];
    assert.ok(!head.includes('Line numbers'), head);
    assert.ok(head.includes(' Comment 1 quotes text that is no longer in the file, so check whether it is already done before changing anything. '), head);
  }));

  test('in pasted text, a gone passage is "no longer in the document"', () => withApp({}, async ({ page }) => {
    await openText(page, 'Pasted plan', '# Pasted plan\n\nSome text to review here.\n\nMore text.\n', 'paste');
    await addComment(page, 'text to review', 'Hm.');
    await page.evaluate(() => window.__markdownAnnotator.applyUpdate('# Pasted plan\n\nMore text.\n'));
    const out = await output(page);
    assert.ok(out.includes('Comment 1 quotes text that is no longer in the document,'), out.split('\n')[0]);
    assert.ok(out.includes('## Comment 1 (was line 3; the quoted text is no longer in the document,'), out);
  }));

  test('front matter titles: plain, quoted or commented; anything fancier is skipped', () => withApp({}, async ({ page }) => {
    const lead = async (text) => {
      await openText(page, 'Pasted Markdown', text, 'paste');
      await page.evaluate(() => { window.__markdownAnnotator.state.general = 'x'; });
      return (await output(page)).split(': a general note')[0];
    };
    assert.equal(await lead('---\ntitle: Sync plan # draft\n---\n\nBody text here now.\n'), 'Review of the document I copied, titled "Sync plan"');
    assert.equal(await lead('---\ntitle: "My \\"quoted\\" doc"\n---\n\nBody text here now.\n'), 'Review of the document I copied, titled "My \'quoted\' doc"');
    assert.equal(await lead("---\ntitle: 'It''s here'\n---\n\nBody text here now.\n"), 'Review of the document I copied, titled "It\'s here"');
    const body = 'Review of the document I copied, which starts "Body text here now"';
    assert.equal(await lead('---\ntitle: >\n  Sync plan\n---\n\nBody text here now.\n'), body);
    assert.equal(await lead('---\ntitle: Sync\n  plan\n---\n\nBody text here now.\n'), body, 'a multi-line plain title is skipped');
    assert.equal(await lead('---\ntitle: "Sync\\nplan"\n---\n\nBody text here now.\n'), body, 'an unsupported escape is skipped');
    assert.equal(await lead('---\ntitle: ~\n---\n\nBody text here now.\n'), body, 'a null title is skipped');
    assert.equal(await lead('---\ntitle: null # draft\n---\n\nBody text here now.\n'), body, 'a commented null title is skipped');
    assert.equal(await lead('---\ntitle: Sync\n\n  plan\n---\n\nBody text here now.\n'), body, 'a continuation after a blank line is still multi-line');
  }));

  test('an earlier saved default header still adapts; an edited one is used as written', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await page.evaluate(() => { window.__markdownAnnotator.state.general = 'Only a note.'; });
    const OLD = 'Review of {file}: {count}. For each comment: if it clearly asks for a change, edit {file}; if it is a question, an opinion or unclear, answer in chat and leave that part unedited. Quotes are rendered text with the Markdown syntax removed, so match them loosely. {lines} End with one line per comment saying what you did.';
    await page.evaluate((h) => { window.__markdownAnnotator.settings.header = h; }, OLD);
    assert.match(await output(page), /^Review of `PLAN\.md`: a general note\. If the note clearly asks/);
    // An edited template: {lines} is empty without comments, and the gap it leaves is closed up.
    await page.evaluate(() => { window.__markdownAnnotator.settings.header = 'Fix {file} ({count}). {lines} Thanks.'; });
    assert.ok((await output(page)).startsWith('Fix `PLAN.md` (a general note). Thanks.\n\n## General note'));
    await page.evaluate(() => { window.__markdownAnnotator.settings.header = 'Check {file}: {lines}.'; });
    assert.ok((await output(page)).startsWith('Check `PLAN.md`:.\n\n'), 'only the empty placeholder and its space go');
    // Nothing else in the person's text changes: spacing, punctuation and indented lines stay.
    const own = 'Edit the .env file and {file}, then type :wq ; ok\n  - nested  item';
    await page.evaluate((h) => { window.__markdownAnnotator.settings.header = h; }, own);
    assert.ok((await output(page)).startsWith('Edit the .env file and `PLAN.md`, then type :wq ; ok\n  - nested  item\n\n'));
    // An empty {lines} written twice, or alone on its line, leaves no double space or blank line.
    await page.evaluate(() => { window.__markdownAnnotator.settings.header = 'A {lines} {lines} B\n{lines}\nC'; });
    assert.ok((await output(page)).startsWith('A B\nC\n\n'));
    // Placeholders are filled in one pass: a "{lines}" inside the typed path stays.
    await page.evaluate(() => { const api = window.__markdownAnnotator; api.state.path = 'docs/{lines}.md'; api.settings.header = 'Fix {file} {lines} ok'; });
    assert.ok((await output(page)).startsWith('Fix `docs/{lines}.md` ok\n\n'));
  }));

  test('custom headers: placeholders, a leading # and an empty header', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Why?');
    await page.evaluate(() => { window.__markdownAnnotator.settings.header = '# Fix {file} ({count})'; });
    let out = await output(page);
    assert.ok(out.startsWith('Review: # Fix `PLAN.md` (1 comment)\n\n## Comment 1'), out.slice(0, 80));
    await page.evaluate(() => { window.__markdownAnnotator.settings.header = '   '; });
    out = await output(page);
    assert.ok(out.startsWith('Review of `PLAN.md`:\n\n## Comment 1'), out.slice(0, 80));
  }));

  test('long quotes are capped per line and elided after 10 lines', () => withApp({}, async ({ page }) => {
    await openText(page, 'EDGE.md', EDGE);
    await addComment(page, 'quote line 01\nquote line 02\nquote line 03\nquote line 04\nquote line 05\nquote line 06\nquote line 07\nquote line 08\nquote line 09\nquote line 10\nquote line 11\nquote line 12', 'Too long.');
    const out = await output(page);
    const sec1 = out.split('## Comment 1')[1];
    assert.match(sec1, /^ \(lines 21-32, code block under "Edge cases for layout and quoting"\)\n/);
    const q = sec1.split('\n').filter((l) => l.startsWith('>'));
    assert.deepEqual(q, ['> quote line 01', '> quote line 02', '> quote line 03', '> quote line 04', '> quote line 05', '> quote line 06', '> [… 4 lines omitted …]', '> quote line 11', '> quote line 12']);
    // A single-line selection of the 300-character line is quoted whole when short; select the whole line to test the cap.
    const full = await page.evaluate(() => document.querySelector('code.language-js').textContent.trimEnd());
    await addComment(page, full, 'cap');
    const capped = (await output(page)).split('\n').find((l) => l.startsWith('> const'));
    assert.ok(capped.includes(' […] '), 'line capped');
    assert.equal(capped.length, 2 + 160 + 5 + 60);
    assert.ok(capped.endsWith("xxxx-END';"));
  }));
});

// ---------------------------------------------------------------------------
describe('copy', () => {
  test('Mod+Enter copies, marks sent, and "Copy again" re-copies the same batch', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Explain why.');
    await addComment(page, 'SSE', 'Why SSE?');
    const expected = await output(page);
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'first copy' });
    assert.equal((await clips(page))[0], expected, 'clipboard gets exactly output()');
    let cs = await comments(page);
    assert.ok(cs.every((c) => c.sent), 'copied comments are sent');
    assert.deepEqual(await page.$$eval('#doc .note', (ns) => ns.map((n) => [n.classList.contains('sent'), n.querySelector('.n').textContent])), [[true, '✓1'], [true, '✓2']]);
    assert.equal(await page.evaluate(() => CSS.highlights.get('cr-sent').size), 2);
    assert.equal(await page.textContent('#copy-label'), 'Copy again');
    assert.ok(await page.evaluate(() => document.querySelector('#btn-copy').classList.contains('quiet')));
    assert.ok((await toasts(page)).some((t) => t.includes('Copied 2 comments')));

    await page.click('#btn-copy');
    await until(async () => (await clips(page)).length === 2, { message: 'copy again' });
    assert.equal((await clips(page))[1], expected, 'Copy again re-copies the last batch verbatim');

    await addComment(page, 'Wire it into the service', 'When?');
    assert.equal(await page.textContent('#copy-label'), 'Copy 1');
    const third = await output(page);
    assert.match(third, /: 1 comment\./);
    assert.ok(third.includes('> Wire it into the service') && !third.includes('Explain why.'), 'only unsent comments');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 3, { message: 'third copy' });
    assert.equal((await clips(page))[2], third);

    await page.keyboard.press('Control+Shift+Enter');
    await until(async () => (await clips(page)).length === 4, { message: 'copy all' });
    const all = (await clips(page))[3];
    assert.match(all, /: 3 comments\./);
    assert.ok(all.indexOf('> SSE') < all.indexOf('> Wire it') && all.indexOf('> Wire it') < all.indexOf('> be conservative'), 'copy all keeps document order');
    cs = await comments(page);
    assert.ok(cs.every((c) => c.sent));
  }));

  test('Mod+Enter in the composer saves, then copies', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('Explain why.');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'copy from composer' });
    assert.ok(!(await visible(page, '#composer')));
    assert.ok((await clips(page))[0].includes('Explain why.'));
    const [c] = await comments(page);
    assert.ok(c.sent);
  }));

  test('a failed clipboard write leaves comments unsent and selects the preview', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Explain why.');
    const expected = await output(page);
    await page.evaluate(() => { window.__clipFail = true; });
    await page.keyboard.press('Control+Enter');
    await until(() => visible(page, '#review'), { message: 'review drawer after failure' });
    const st = await page.evaluate(() => ({ open: document.querySelector('#preview-box').open, sel: window.getSelection().toString(), pre: document.querySelector('#preview').textContent }));
    assert.ok(st.open);
    assert.equal(st.pre, expected);
    assert.equal(st.sel.trim(), expected.trim(), 'preview text is selected for a manual copy');
    const [c] = await comments(page);
    assert.equal(c.sent, false, 'not marked sent when the write fails');
    assert.ok((await toasts(page)).some((t) => t.includes("Couldn't reach the clipboard")));
  }));

  test('nothing to copy says so', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await page.keyboard.press('Control+Enter');
    await until(async () => (await toasts(page)).some((t) => t.startsWith('Nothing to copy yet')), { message: 'nothing toast' });
    assert.equal((await clips(page)).length, 0);
  }));
});

// ---------------------------------------------------------------------------
describe('undo', () => {
  test('Esc discards a typed comment and Undo restores it', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('Half-written thought');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#composer', { state: 'hidden' });
    assert.equal((await comments(page)).length, 0);
    await page.locator('#toasts .toast', { hasText: 'Comment discarded.' }).getByRole('button', { name: 'Undo' }).click();
    await page.waitForSelector('#composer:not([hidden])');
    assert.equal(await page.inputValue('#cmp-text'), 'Half-written thought');
    assert.equal(await page.textContent('#cmp-title'), 'New comment · line 69');
    await page.keyboard.press('Enter');
    const [c] = await comments(page);
    assert.equal(c.body, 'Half-written thought');
    assert.equal(c.exact, 'be conservative');
  }));

  test('Esc on an empty composer just closes it', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#composer', { state: 'hidden' });
    assert.ok(!(await toasts(page)).some((t) => t.includes('discarded')));
    assert.equal((await comments(page)).length, 0);
  }));

  test('edit via the inline note, delete with Undo, and edit via a highlight click', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    const orig = await addComment(page, 'cross-request/cross-restart synchronization', 'First take.');
    await page.click('#doc .note');
    await page.waitForSelector('#composer:not([hidden])');
    assert.equal(await page.textContent('#cmp-title'), 'Comment 1 · line 36');
    assert.equal(await page.inputValue('#cmp-text'), 'First take.');
    assert.ok(await visible(page, '#cmp-delete'));
    await page.fill('#cmp-text', 'Second take.');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#composer', { state: 'hidden' });
    assert.equal((await comments(page))[0].body, 'Second take.');

    // Esc on an edit discards it; Undo brings the edited text back.
    await page.click('#doc .note');
    await page.fill('#cmp-text', 'Third take.');
    await page.keyboard.press('Escape');
    assert.equal((await comments(page))[0].body, 'Second take.');
    await page.locator('#toasts .toast', { hasText: 'Edit discarded.' }).getByRole('button', { name: 'Undo' }).click();
    assert.equal(await page.inputValue('#cmp-text'), 'Third take.');
    await page.keyboard.press('Escape');

    await page.click('#doc .note');
    await page.click('#cmp-delete');
    assert.equal((await comments(page)).length, 0);
    assert.equal(await page.$$eval('#doc .note', (n) => n.length), 0);
    await page.locator('#toasts .toast', { hasText: 'Comment deleted.' }).getByRole('button', { name: 'Undo' }).click();
    const [back] = await comments(page);
    assert.equal(back.id, orig.id);
    assert.equal(back.body, 'Second take.');
    assert.ok(back.anchored);
    assert.equal(back.lineStart, 36);

    // A real click on the highlighted passage reopens it.
    await scrollToText(page, 'cross-request/cross-restart synchronization');
    const [r] = await rectsOf(page, 'cross-restart');
    await page.mouse.click((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    await page.waitForSelector('#composer:not([hidden])');
    assert.equal(await page.inputValue('#cmp-text'), 'Second take.');
    // Saving an empty body deletes (with Undo).
    await page.fill('#cmp-text', '');
    await page.keyboard.press('Enter');
    assert.equal((await comments(page)).length, 0);
    assert.ok((await toasts(page)).some((t) => t.includes('Comment deleted.')));
  }));

  test('the end of a drag over a highlight does not open the editor', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'cross-request/cross-restart synchronization', 'x');
    await scrollToText(page, 'cross-request/cross-restart synchronization');
    const [r] = await rectsOf(page, 'cross-request/cross-restart synchronization');
    const y = (r.top + r.bottom) / 2;
    await page.mouse.move(r.left + 2, y);
    await page.mouse.down();
    await page.mouse.move(r.left + 60, y, { steps: 5 });
    await page.mouse.up();
    await sleep(200);
    assert.ok(!(await visible(page, '#composer')), 'drag-select over a comment does not open the editor');
    assert.ok(await visible(page, '#pill'), 'it offers a new (overlapping) comment instead');
  }));

  test('J/K step through comments', () => withApp({ height: 500 }, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    const a = await addComment(page, 'status: draft', 'a');
    const b = await addComment(page, 'be conservative', 'b');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press('j');
    let act = await page.$eval('#doc .note.active', (n) => n.dataset.id).catch(() => null);
    assert.ok(act === a.id || act === b.id);
    const first = act;
    await page.keyboard.press('j');
    act = await page.$eval('#doc .note.active', (n) => n.dataset.id);
    assert.notEqual(act, first);
    await page.keyboard.press('k');
    act = await page.$eval('#doc .note.active', (n) => n.dataset.id);
    assert.equal(act, first);
  }));
});

// ---------------------------------------------------------------------------
describe('persistence', () => {
  test('reload restores the document, comments, sent state, general note and path', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    const a = await addComment(page, 'be conservative', 'Explain why.');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'copy' });
    const b = await addComment(page, 'SSE', 'Why SSE?');
    await page.keyboard.press('r');
    await page.waitForSelector('#review:not([hidden])');
    await page.fill('#general', 'Overall fine.');
    await page.fill('#path', 'docs/PLAN.md');
    await page.keyboard.press('Escape');
    const before = await output(page);
    await sleep(500); // debounced save
    await page.reload();
    await page.evaluate(() => window.__markdownAnnotator.ready);
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc), { message: 'restored doc' });
    assert.equal(await page.textContent('#crumb-file'), 'PLAN.md');
    const cs = await comments(page);
    assert.deepEqual(cs.map((c) => [c.id, c.sent, c.anchored, c.lineStart]), [[a.id, true, true, 69], [b.id, false, true, 15]]);
    assert.equal(await page.$$eval('#doc .note', (n) => n.length), 2);
    assert.equal(await output(page), before, 'the same review string after a reload');
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.general), 'Overall fine.');
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.path), 'docs/PLAN.md');
    assert.ok(!(await visible(page, '#live')), 'a snapshot shows no live dot');
  }));

  test('closing returns to a start screen that lists the document', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'x');
    await page.click('#btn-menu');
    await page.getByRole('menuitem', { name: 'Close document' }).click();
    await until(() => visible(page, '#recent'), { message: 'recent list' });
    const items = await page.$$eval('#recent-list .open', (bs) => bs.map((b) => b.textContent));
    assert.equal(items.length, 1);
    assert.match(items[0], /^PLAN\.md1 comment · just now$/);
    await page.click('#recent-list .open');
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc), { message: 'reopen' });
    assert.equal((await comments(page)).length, 1);
  }));
});

// ---------------------------------------------------------------------------
describe('watched file', () => {
  test('a disk change re-anchors, shifts lines, marks changes and archives sent comments', () => withApp({ disk: { name: 'PLAN.md', text: PLAN } }, async ({ page }) => {
    await page.keyboard.press('Control+o');
    await until(() => page.evaluate(() => !!(window.__markdownAnnotator.state.doc && window.__markdownAnnotator.state.doc.handle)), { message: 'watched doc' });
    assert.equal(await page.evaluate(() => window.__pickCount), 1);
    assert.ok(await visible(page, '#live'));
    assert.ok(!(await page.evaluate(() => document.querySelector('#live').classList.contains('off'))), 'live dot on');
    const sent = await addComment(page, 'cross-request/cross-restart synchronization', 'Restart?');
    let out = await output(page);
    assert.ok(out.includes('Line numbers matched the file on disk when I copied this.'), 'fresh read of a watched file');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'copy' });
    const b = await addComment(page, 'be conservative', 'Explain why.');
    const c = await addComment(page, 'return domain.ProjectStatusFailed', 'Unknown.');
    assert.deepEqual([b.lineStart, c.lineStart], [69, 52]);

    // Claude edits the file: two lines inserted near the top and one list item changed.
    const next = PLAN_SHIFTED.replace('- Status survives a server restart', '- Status survives a server restart and a crash');
    await page.evaluate((t) => { window.__diskText = t; window.__diskTs = 2000; }, next);
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro paragraph')), { message: 'poll picked up the change', timeout: 4000 });

    const cs = await comments(page);
    const byId = Object.fromEntries(cs.map((x) => [x.id, x]));
    assert.equal(byId[sent.id].archived, true, 'sent comment archived');
    assert.equal(byId[b.id].lineStart, 71);
    assert.equal(byId[c.id].lineStart, 54);
    assert.ok(byId[b.id].anchored && byId[c.id].anchored);
    const chg = await page.$$eval('#doc .chg', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(chg, ['A new intro paragraph Claude added.', 'Status survives a server restart and a crash']);
    assert.ok((await toasts(page)).some((t) => t.includes('PLAN.md updated · 2 changes · 1 sent → Earlier rounds')));
    out = await output(page);
    assert.match(out, /^Review of `PLAN\.md`: 2 comments\./);
    assert.ok(out.includes('Line numbers matched the file on disk when I copied this.'));
    assert.ok(out.includes('## Comment 1 (line 54, code block') && out.includes('## Comment 2 (line 71, table'));
    assert.ok(!out.includes('Restart?'), 'archived comments are not sent again');
    assert.equal(await page.textContent('#chip-count'), '2');

    // N jumps to a changed block.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.keyboard.press('n');
    const top = await page.$eval('#doc .chg', (e) => e.getBoundingClientRect().top);
    assert.ok(top >= 0 && top < 900, `N scrolled a change into view (top ${top})`);

    // Earlier rounds lists the archived comment, and Restore brings it back unsent at its new line.
    await page.keyboard.press('r');
    await page.waitForSelector('#review:not([hidden])');
    const summary = await page.textContent('#review-list details summary');
    assert.match(summary, /Earlier rounds · 1/);
    await page.click('#review-list details summary span');
    await page.locator('#review-list .review-item.archived .act').click();
    const restored = (await comments(page)).find((x) => x.id === sent.id);
    assert.deepEqual([restored.archived, restored.sent, restored.anchored, restored.lineStart], [false, false, true, 38]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('#doc .chg', (e) => e.length), 0, 'Esc clears the change marks');

    // The handle cannot be cloned into IndexedDB here, so the record is kept without it.
    await sleep(400);
    const recs = await idbRecord(page);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].handle, null);
    assert.equal(recs[0].comments.length, 3);
    assert.ok(recs[0].text.includes('A new intro paragraph'));
  }));

  test('the drop zone opens the picker and a same-text touch does not re-render', () => withApp({ disk: { name: 'PLAN.md', text: PLAN } }, async ({ page }) => {
    await page.click('#drop');
    await until(() => page.evaluate(() => !!(window.__markdownAnnotator.state.doc && window.__markdownAnnotator.state.doc.handle)), { message: 'watched doc' });
    await addComment(page, 'be conservative', 'x');
    await page.evaluate(() => { window.__diskTs = 5000; document.querySelector('#doc h1').dataset.marker = 'same'; });
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.doc.lastModified === 5000), { message: 'touch seen' });
    assert.equal(await page.evaluate(() => document.querySelector('#doc h1').dataset.marker), 'same', 'no re-render for an unchanged text');
    assert.equal(await page.$$eval('#doc .chg', (e) => e.length), 0);
    assert.ok(!(await toasts(page)).some((t) => t.includes('updated')));
  }));

  test('render lock: an update waits while the composer is open, then applies after save', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('draft');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN_SHIFTED);
    assert.ok(await visible(page, '#btn-pending'), '"Updated ↻" shows');
    assert.ok(!(await page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro'))), 'held back');
    assert.ok(await visible(page, '#composer'));
    assert.equal(await page.inputValue('#cmp-text'), 'draft');
    await sleep(1100);
    assert.ok(!(await page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro'))), 'still held while typing');
    await page.keyboard.press('Enter');
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro')), { message: 'applied after save' });
    assert.ok(!(await visible(page, '#btn-pending')));
    const [c] = await comments(page);
    assert.equal(c.body, 'draft');
    assert.equal(c.lineStart, 71);
    assert.ok(c.anchored);
  }));

  test('"Updated ↻" applies at once and keeps the open draft', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('draft');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN_SHIFTED);
    await page.click('#btn-pending');
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro')), { message: 'applied now' });
    assert.ok(await visible(page, '#composer'), 'composer reopened on the passage');
    assert.equal(await page.inputValue('#cmp-text'), 'draft');
    assert.equal(await page.textContent('#cmp-title'), 'New comment · line 71');
    await page.locator('#cmp-text').press('Enter');
    const [c] = await comments(page);
    assert.equal(c.lineStart, 71);
    assert.equal(c.exact, 'be conservative');
  }));

  test('render lock: an update waits while text is selected', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await until(() => visible(page, '#pill'), { message: 'pill' });
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN_SHIFTED);
    assert.ok(!(await page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro'))), 'held while selecting');
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro')), { message: 'applied after the selection clears' });
  }));
});

// ---------------------------------------------------------------------------
describe('re-anchoring', () => {
  test('fuzzy: an edited passage re-anchors and quotes the current text', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    const c = await addComment(page, 'This plan moves deployments off the request thread.', 'Which thread?');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN.replace('deployments off the request', 'deployments away from the request'));
    const [after] = await comments(page);
    assert.equal(after.id, c.id);
    assert.ok(after.anchored && after.fuzzy && !after.detached);
    const out = await output(page);
    assert.ok(out.includes('## Comment 1 (line 8, under "Plan: Async Deploy Pipeline"; text edited since I commented)\n> This plan moves deployments away from the request thread.\n'), out);
    await page.keyboard.press('r');
    assert.ok((await page.textContent('#review-list')).includes('text edited'));
  }));

  test('detached: a vanished passage is reported last with its old line', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'Status survives a server restart', 'Prove it.');
    await addComment(page, 'be conservative', 'Why?');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN.replace('- Status survives a server restart\n', '- Something entirely different\n'));
    const cs = await comments(page);
    assert.ok(cs[0].detached && !cs[0].anchored);
    assert.ok(cs[1].anchored);
    assert.ok(await visible(page, '#detached'));
    assert.match(await page.textContent('#detached'), /1 comment lost its text in this version\./);
    await page.click('#detached .link-btn');
    assert.equal(await page.$$eval('#detached .note', (n) => n.length), 1);
    const out = await output(page);
    assert.ok(out.includes('## Comment 1 (line 69, table'));
    assert.ok(out.includes('## Comment 2 (was line 19; the quoted text is no longer in the file, so it may already be changed)\n> Status survives a server restart\n\nProve it.'), out);
  }));

  test('duplicate text stays on the occurrence that was commented', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'The combination of mutex', 'Second one.', { nth: 1 });
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN_SHIFTED);
    const [c] = await comments(page);
    assert.equal(c.lineStart, 82);
    assert.match(await output(page), /\(line 82, under "Plan: Async Deploy Pipeline > Open questions"\)/);
  }));

  test('reflowed paragraphs still match exactly', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'database queries\n(for cross-request', 'x');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN.replace('and database queries\n(for cross-request', 'and database\nqueries (for cross-request'));
    const [c] = await comments(page);
    assert.ok(c.anchored && !c.fuzzy);
    assert.deepEqual([c.lineStart, c.lineEnd], [35, 36]);
  }));
});

// ---------------------------------------------------------------------------
describe('narrow layout (360 px)', () => {
  // Real (non-hidden) scrollbars, as on Windows desktop Chrome: the page reserves a scrollbar gutter.
  let scrollBrowser;
  before(async () => { scrollBrowser = await launch({ ignoreDefaultArgs: ['--hide-scrollbars'] }); });
  after(async () => { if (scrollBrowser) await scrollBrowser.close(); });
  const overflow = (page) => page.evaluate(() => {
    const de = document.documentElement;
    const wide = Array.from(document.querySelectorAll('body *')).filter((el) => {
      if (el.closest('.table-wrap, pre, #doc .note .b, .quote-probe') && !el.matches('.table-wrap, pre')) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && cs.visibility !== 'hidden' && (r.right > de.clientWidth + 0.5 || r.left < -0.5);
    }).map((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.className}`).slice(0, 5);
    return { sw: de.scrollWidth, cw: de.clientWidth, wide };
  });

  test('no horizontal overflow on any surface', () => withApp({ width: 360, height: 760, browser: () => scrollBrowser }, async ({ page }) => {
    let o = await overflow(page);
    assert.ok(o.sw <= o.cw, `start screen ${JSON.stringify(o)}`);
    for (const [name, text] of [['EDGE.md', EDGE], ['PLAN.md', PLAN]]) {
      await openText(page, name, text);
      o = await overflow(page);
      assert.ok(o.sw <= o.cw && !o.wide.length, `${name}: ${JSON.stringify(o)}`);
    }
    await addComment(page, 'be conservative', 'A fairly long comment body that needs to wrap inside the inline note at narrow widths without overflowing.');
    await scrollToText(page, 'This prevents race conditions');
    await selectText(page, 'This prevents race conditions');
    await until(() => visible(page, '#pill'), { message: 'pill' });
    o = await overflow(page);
    assert.ok(o.sw <= o.cw && !o.wide.length, `pill: ${JSON.stringify(o)}`);
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    o = await overflow(page);
    assert.ok(o.sw <= o.cw && !o.wide.length, `composer: ${JSON.stringify(o)}`);
    await page.keyboard.press('Escape');
    for (const key of ['r', 'o', '?']) {
      await page.keyboard.press(key);
      await sleep(50);
      o = await overflow(page);
      assert.ok(o.sw <= o.cw && !o.wide.length, `surface ${key}: ${JSON.stringify(o)}`);
      await page.keyboard.press('Escape');
    }
    await page.click('#btn-menu');
    o = await overflow(page);
    assert.ok(o.sw <= o.cw && !o.wide.length, `menu: ${JSON.stringify(o)}`);
    await page.keyboard.press('Escape');
    const bar = await page.evaluate(() => Array.from(document.querySelectorAll('#bar > *')).filter((e) => !e.hidden && e.getClientRects().length).map((e) => [e.id, Math.round(e.getBoundingClientRect().right)]));
    for (const [id, right] of bar) assert.ok(right <= 360, `${id} fits in the bar (${right})`);
    assert.ok(bar.some(([id]) => id === 'btn-copy'), 'Copy button visible at 360 px');
  }));

  test('wide tables scroll inside their wrapper', () => withApp({ width: 360, height: 760 }, async ({ page }) => {
    await openText(page, 'EDGE.md', EDGE);
    const t = await page.$eval('#doc .table-wrap', (w) => ({ sw: w.scrollWidth, cw: w.clientWidth, ox: getComputedStyle(w).overflowX }));
    assert.ok(t.sw > t.cw, 'table is wider than the column');
    assert.equal(t.ox, 'auto');
  }));
});

// ---------------------------------------------------------------------------
describe('Mod key per platform', () => {
  test('macOS: ⌘ labels, ⌘O opens, ⌘Enter copies, Ctrl+O does not open', () => withApp({ platform: 'mac', disk: { name: 'PLAN.md', text: PLAN } }, async ({ page }) => {
    assert.deepEqual(await page.$$eval('#empty kbd[data-mod]', (k) => k.map((x) => x.textContent)), ['⌘O', '⌘V', '⌘Enter']);
    await page.keyboard.press('Control+o');
    await sleep(100);
    assert.equal(await page.evaluate(() => window.__pickCount), 0, 'Ctrl+O is not Mod+O on a Mac');
    await page.keyboard.press('Meta+o');
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc), { message: 'opened via ⌘O' });
    await addComment(page, 'be conservative', 'Why?');
    assert.match(await page.getAttribute('#btn-copy', 'title'), /\(⌘Enter\)$/);
    await page.keyboard.press('Meta+Enter');
    await until(async () => (await clips(page)).length === 1, { message: '⌘Enter copy' });
    await page.keyboard.press('?');
    const keys = await page.textContent('#keys');
    assert.ok(keys.includes('⌘Enter') && keys.includes('⌘O') && !keys.includes('Ctrl+'), keys);
  }));

  test('Windows: Ctrl labels, Ctrl+O opens, Meta+O does not', () => withApp({ platform: 'win', disk: { name: 'PLAN.md', text: PLAN } }, async ({ page }) => {
    assert.deepEqual(await page.$$eval('#empty kbd[data-mod]', (k) => k.map((x) => x.textContent)), ['Ctrl+O', 'Ctrl+V', 'Ctrl+Enter']);
    await page.keyboard.press('Meta+o');
    await sleep(100);
    assert.equal(await page.evaluate(() => window.__pickCount), 0, 'Meta+O is not Mod+O on Windows');
    await page.keyboard.press('Control+o');
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc), { message: 'opened via Ctrl+O' });
    await addComment(page, 'be conservative', 'Why?');
    assert.match(await page.getAttribute('#btn-copy', 'title'), /\(Ctrl\+Enter\)$/);
    await page.keyboard.press('Meta+Enter');
    await sleep(100);
    assert.equal((await clips(page)).length, 0, 'Meta+Enter does not copy on Windows');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'Ctrl+Enter copy' });
    await page.keyboard.press('?');
    const keys = await page.textContent('#keys');
    assert.ok(keys.includes('Ctrl+Enter') && !keys.includes('⌘'), keys);
  }));
});

// ---------------------------------------------------------------------------
describe('other ways in', () => {
  test('dropping a file opens it without navigating away', () => withApp({}, async ({ page }) => {
    const url = page.url();
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'PLAN.md', { type: 'text/markdown' }));
      const opts = { dataTransfer: dt, bubbles: true, cancelable: true };
      document.body.dispatchEvent(new DragEvent('dragover', opts));
      document.body.dispatchEvent(new DragEvent('drop', opts));
    }, PLAN);
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc), { message: 'dropped doc' });
    assert.equal(page.url(), url);
    assert.equal(await page.textContent('#crumb-file'), 'PLAN.md');
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.liveMode), 'snapshot');
    await until(async () => !(await visible(page, '#dropzone')), { message: 'drop overlay hidden' });
  }));

  test('the <input type=file> fallback opens a snapshot', () => withApp({}, async ({ page }) => {
    await page.setInputFiles('#file-input', { name: 'PLAN.md', mimeType: 'text/markdown', buffer: Buffer.from(PLAN) });
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc), { message: 'input doc' });
    await addComment(page, 'be conservative', 'x');
    assert.match(await output(page), /Line numbers are from the copy I loaded at .+ and may have shifted, so go by the quotes?\./);
  }));

  test('outline lists H1-H4 with unsent counts and jumps to a heading', () => withApp({ height: 600 }, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'x');
    await page.keyboard.press('o');
    await page.waitForSelector('#outline:not([hidden])');
    const items = await page.$$eval('#outline-list a', (as) => as.map((a) => [a.dataset.l, a.querySelector('.t').textContent, a.querySelector('.c')?.textContent || '']));
    assert.deepEqual(items, [
      ['1', 'Plan: Async Deploy Pipeline', ''], ['2', 'Goals', ''], ['2', 'Tasks', ''], ['2', 'Design', ''],
      ['3', 'Step 6: Add Helper Function for Status Derivation', '1'], ['3', 'Step 7: Update Stop Operations', ''], ['2', 'Open questions', ''],
    ]);
    await page.click('#outline-list a:nth-child(4)');
    assert.ok(!(await visible(page, '#outline')));
    const top = await page.$eval('#h-design', (h) => h.getBoundingClientRect().top);
    assert.ok(top > 30 && top < 120, `Design heading near the top under the bar (${top})`);
  }));

  test('a watched file that disappears shows the snapshot state', () => withApp({ disk: { name: 'PLAN.md', text: PLAN } }, async ({ page }) => {
    await page.keyboard.press('Control+o');
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc?.handle), { message: 'watched doc' });
    await addComment(page, 'be conservative', 'x');
    await page.evaluate(() => { window.__diskMissing = true; });
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.liveMode === 'missing'), { message: 'missing mode' });
    assert.ok(await page.evaluate(() => document.querySelector('#live').classList.contains('off')));
    assert.match(await output(page), /Line numbers are from the copy I loaded at .+ and may have shifted, so go by the quotes?\./);
  }));
});

// ---------------------------------------------------------------------------
// Regressions for bugs found by the first audit (formerly todo tests).
describe('fixed bugs', () => {
  test('Copy during a held update must not send stale line numbers as current', () => withApp({ disk: { name: 'PLAN.md', text: PLAN } }, async ({ page }) => {
    await page.keyboard.press('Control+o');
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc?.handle), { message: 'watched doc' });
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('Explain why.');
    await page.evaluate((t) => { window.__diskText = t; window.__diskTs = 2000; }, PLAN_SHIFTED);
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.pendingText != null), { message: 'update held' });
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'copy' });
    const out = (await clips(page))[0];
    // On disk "be conservative" is now on line 71.
    assert.ok(out.includes('## Comment 1 (line 71,') && !out.includes('(line 69,'), `the held update is applied before copying, so the line is current:\n${out}`);
    assert.ok(out.includes('Line numbers matched the file on disk when I copied this.'), out.split('\n')[0]);
    await sleep(300);
    assert.equal(await page.textContent('#copy-label'), 'Copy again', 'the batch just sent can still be copied again');
  }));

  test('tab-indented code is quoted without " | " artefacts', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    const exact = await page.evaluate(() => { const t = window.__markdownAnnotator.state.index.text; const i = t.indexOf('switch s.Status'); return t.slice(i, t.indexOf('docker.ComposeProjectStatusRunning', i) + 34); });
    await addComment(page, exact, 'Handle stopped too.');
    const out = await output(page);
    assert.ok(out.includes('## Comment 1 (lines 48-49, code block'));
    assert.ok(!out.includes(' | case'), `quote mangled:\n${out}`);
  }));

  test("two tabs: saving in one tab keeps the other tab's new comments", () => withApp({}, async ({ page: A, ctx }) => {
    await openText(A, 'PLAN.md', PLAN);
    await sleep(300);
    const B = await ctx.newPage();
    await B.goto(A.url());
    await B.evaluate(() => window.__markdownAnnotator.ready);
    await until(() => B.evaluate(() => window.__markdownAnnotator.state.doc?.key === 'file:PLAN.md'), { message: 'B restored' });
    await addComment(A, 'be conservative', 'from A');
    await until(async () => (await comments(B)).length === 1, { message: 'B synced' });
    await selectText(B, 'SSE');
    await B.keyboard.press('c');
    await B.waitForSelector('#composer:not([hidden])');
    await B.keyboard.type('from B');
    await addComment(A, 'status: draft', 'A second');
    await sleep(600);
    await B.keyboard.press('Enter');
    await sleep(800);
    const stored = await idbRecord(A, 'file:PLAN.md');
    assert.deepEqual(stored.comments.map((c) => c.body).sort(), ['A second', 'from A', 'from B']);
  }));

  test('an edit to a sent comment survives a forced update', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Explain why.');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'copy' });
    await page.click('#doc .note');
    await page.fill('#cmp-text', 'Explain why, with an example.');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN_SHIFTED);
    await page.click('#btn-pending');
    await page.locator('#cmp-text').press('Enter');
    const [c] = await comments(page);
    assert.equal(c.body, 'Explain why, with an example.');
    assert.ok(!c.archived && c.anchored, JSON.stringify(c));
    assert.ok((await output(page)).includes('(line 71, table'));
  }));
});

// ---------------------------------------------------------------------------
// Regressions for the second audit round.
describe('regressions: anchoring, focus and drags', () => {
  test('UTF-16 files with a byte-order mark open as text', () => withApp({}, async ({ page }) => {
    const text = ['# Plan', '', 'UTF-16 text here.', ''].join('\n');
    const body = Buffer.from(text, 'utf16le');
    await page.setInputFiles('#file-input', { name: 'u16.md', mimeType: 'text/markdown', buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), body]) });
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc), { message: 'opened' });
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.doc.text), text);
  }));

  test('line numbers stay exact after a wrapped image alt or link title, even mid-paragraph', () => withApp({}, async ({ page }) => {
    await openText(page, 'W.md', [
      '# P', '', 'Text ![a diagram', 'of the flow](data:image/gif;base64,R0lGODlhAQABAAAAACw=) mid', 'third line quokka.', '',
      'A [titled link](https://e.com', '"The title") continuing', 'on a third line raven.', '',
    ].join('\n'));
    await addComment(page, 'third line quokka.', 'q');
    await addComment(page, 'on a third line raven.', 'r');
    const out = await output(page);
    assert.ok(out.includes('## Comment 1 (line 5,'), out);
    assert.ok(out.includes('## Comment 2 (line 9,'), out);
  }));

  test('an edited short passage with a twin elsewhere is flagged, not silently moved', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'The combination of mutex', 'Why twice?', { nth: 1 });
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN.replace('The combination of mutex and database queries\nis repeated here', 'We rely on a mutex and database queries\nhere'));
    const out = await output(page);
    assert.ok(/## Comment 1 \([^)]*(moved since I commented|no longer in the file)/.test(out), out);
  }));

  test('a word inserted near the start of a long passage re-anchors on the whole passage', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    const exact = 'The combination of mutex (for in-process synchronization) and database queries';
    await addComment(page, exact, 'Why not advisory locks?');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN.replace('The combination of mutex (for in-process', 'The combination of a mutex (for in-process'));
    const out = await output(page);
    assert.ok(out.includes('text edited since I commented'), out);
    assert.ok(out.includes('> The combination of a mutex'), out);
  }));

  test('focus returns to the note after saving a keyboard comment and after an edit', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.keyboard.type('Explain why.');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('note')), true, 'new note focused');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type(' Please.');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('note')), true, 'edited note focused');
  }));

  test('Undo of "Clear sent" restores only the cleared comments', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'A');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'copy' });
    await addComment(page, 'status: draft', 'C');
    await page.click('#btn-menu');
    await page.click('#menu button:has-text("Clear sent comments")');
    await page.click('#doc .note');
    await page.fill('#cmp-text', 'C edited');
    await page.locator('#cmp-text').press('Enter');
    await page.click('#toasts .toast:has-text("Cleared") button');
    const bodies = (await comments(page)).map((c) => c.body).sort();
    assert.deepEqual(bodies, ['A', 'C edited']);
  }));

  test('Esc with a drawer open closes the drawer and keeps the composer', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.keyboard.type('half-written');
    await page.click('#btn-review');
    await page.keyboard.press('Escape');
    assert.ok(!(await visible(page, '#review')));
    assert.ok(await visible(page, '#composer'));
    assert.equal(await page.inputValue('#cmp-text'), 'half-written');
  }));

  test('a drag released over the top bar comments only up to the first visible line', () => withApp({ height: 700 }, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await scrollToText(page, 'provides complete concurrent');
    const r = await rectsOf(page, 'provides complete concurrent');
    await page.mouse.move(r[0].left + 3, (r[0].top + r[0].bottom) / 2);
    await page.mouse.down();
    await page.mouse.move(r[0].left, 60, { steps: 4 });
    await page.mouse.move(200, 12, { steps: 4 });
    await page.mouse.up();
    await sleep(150);
    // The first source line visible under the bar when the drag ended (opening the composer may scroll).
    const topLine = await page.evaluate(() => {
      const barBottom = document.querySelector('#bar').getBoundingClientRect().bottom;
      const el = [...document.querySelectorAll('#doc p, #doc h1, #doc h2, #doc h3, #doc pre, #doc tr')].find((e) => e.getBoundingClientRect().bottom > barBottom);
      return +el.closest('[data-ls]').dataset.ls;
    });
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    const title = await page.textContent('#cmp-title');
    const first = +/lines? (\d+)/.exec(title)[1];
    assert.ok(topLine > 3, 'the test scrolled away from the document start');
    assert.ok(first >= topLine, `passage should start at the first visible line (${topLine}), got "${title}"`);
  }));
});

// ---------------------------------------------------------------------------
// Regressions for the final check.
describe('regressions: tables, scrolling and earlier rounds', () => {
  test('a changed table row keeps its cells aligned with the header', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN.replace('| unknown | Failed | be conservative |', '| unknown | Failed | be strict and fail closed |'));
    const cols = await page.evaluate(() => {
      const table = document.querySelector('#doc table');
      const head = [...table.querySelectorAll('thead th')].map((c) => Math.round(c.getBoundingClientRect().left));
      const row = table.querySelector('tr.chg');
      return { head, row: row ? [...row.children].map((c) => Math.round(c.getBoundingClientRect().left)) : null, cells: row ? row.children.length : 0 };
    });
    assert.ok(cols.row, 'the changed row is marked');
    assert.equal(cols.cells, 3);
    assert.deepEqual(cols.row, cols.head);
  }));

  test('after a drag clamped at the top bar, scrolling does not shrink or drop the comment', () => withApp({ height: 700 }, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await scrollToText(page, 'provides complete concurrent');
    const r = await rectsOf(page, 'provides complete concurrent');
    await page.mouse.move(r[0].left + 3, (r[0].top + r[0].bottom) / 2);
    await page.mouse.down();
    await page.mouse.move(r[0].left, 60, { steps: 4 });
    await page.mouse.move(200, 12, { steps: 4 });
    await page.mouse.up();
    await sleep(150);
    const before = await page.evaluate(() => String(getSelection()).length);
    await page.mouse.wheel(0, 400);
    await sleep(200);
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    const quote = await page.evaluate(() => { const c = window.__markdownAnnotator; return c.state.comments.length; });
    assert.equal(quote, 0);
    const title = await page.textContent('#cmp-title');
    assert.ok(/lines \d+–36/.test(title), title);
    assert.ok(before > 100, 'the clamped selection was kept');
  }));

  test('J with only earlier-round comments says where they are', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'A');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await clips(page)).length === 1, { message: 'copy' });
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN_SHIFTED);
    await page.locator('body').press('j');
    assert.ok((await toasts(page)).some((t) => t.includes('1 is in Earlier rounds')), JSON.stringify(await toasts(page)));
  }));
});

// ---------------------------------------------------------------------------
// Regressions found by an external code review.
describe('regressions: held updates, undo and sync', () => {
  test('a held update does not commit the new file metadata before its text', () => withApp({ disk: { name: 'PLAN.md', text: PLAN } }, async ({ page }) => {
    await page.keyboard.press('Control+o');
    await until(() => page.evaluate(() => !!window.__markdownAnnotator.state.doc?.handle), { message: 'watched doc' });
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('draft');
    await page.evaluate((t) => { window.__diskText = t; window.__diskTs = 2000; }, PLAN_SHIFTED);
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.pendingText != null), { message: 'update held' });
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.doc.lastModified), 1000, 'shown text still pairs with the old metadata');
    await page.keyboard.press('Enter');
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.pendingText == null && window.__markdownAnnotator.state.doc.lastModified === 2000), { message: 'applied with its metadata' });
  }));

  test('Undo from one document never acts on another', () => withApp({}, async ({ page }) => {
    await openText(page, 'A.md', '# A\n\nAlpha passage here.\n');
    await addComment(page, 'Alpha passage', 'about A');
    await page.click('#doc .note');
    await page.click('#cmp-delete');
    assert.ok((await toasts(page)).some((t) => t.includes('Comment deleted.')));
    await openText(page, 'B.md', '# B\n\nBeta passage here.\n');
    assert.ok(!(await toasts(page)).some((t) => t.includes('Comment deleted.')), 'the Undo toast is gone');
    assert.deepEqual(await comments(page), []);
  }));

  test('an edit made while the clipboard write is pending stays unsent', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Original instruction');
    await page.evaluate(() => { navigator.clipboard.writeText = (t) => new Promise((r) => { window.__release = () => { window.__clips.push(t); r(); }; }); });
    await page.keyboard.press('Control+Enter');
    await until(() => page.evaluate(() => typeof window.__release === 'function'), { message: 'write pending' });
    await page.evaluate(() => { const c = window.__markdownAnnotator.state.comments[0]; c.body = 'Revised instruction'; c.updated = Date.now() + 5; });
    await page.evaluate(() => window.__release());
    await sleep(100);
    assert.ok((await clips(page))[0].includes('Original instruction'));
    const [c] = await comments(page);
    assert.equal(c.sent, false, 'the revision that was not copied is still unsent');
  }));

  test('the "moved" warning survives a re-render and a reload', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'The combination of mutex', 'Why twice?', { nth: 1 });
    const v2 = PLAN.replace('The combination of mutex and database queries\nis repeated here', 'We rely on a mutex and database queries\nhere');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), v2);
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), v2 + '\nOne more line.\n');
    assert.ok((await output(page)).includes('seems to have moved'), 'after a re-render');
    await sleep(400);
    await page.reload();
    await page.evaluate(() => window.__markdownAnnotator.ready);
    assert.ok((await output(page)).includes('seems to have moved'), 'after a reload');
  }));

  test('a point inside a multi-line inline code span gets its own source line', () => withApp({}, async ({ page }) => {
    await openText(page, 'C.md', ['# P', '', 'before `alpha', 'beta` after', 'last line'].join('\n'));
    await addComment(page, 'beta', 'b');
    await addComment(page, 'last line', 'l');
    const out = await output(page);
    assert.ok(out.includes('## Comment 1 (line 4,'), out);
    assert.ok(out.includes('## Comment 2 (line 5,'), out);
  }));
});

describe('regressions: newer updates and partial copies', () => {
  test('a newer update applied while an older one is held is not overwritten by the older one', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    const V2 = PLAN.replace('# Plan: Async Deploy Pipeline\n', '# Plan: Async Deploy Pipeline\n\nVersion two.\n');
    const V3 = PLAN.replace('# Plan: Async Deploy Pipeline\n', '# Plan: Async Deploy Pipeline\n\nVersion three.\n');
    await selectText(page, 'be conservative');
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), V2);
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.pendingText != null), true, 'V2 held by the selection');
    // The selection ends; before the queued V2 is retried, a newer V3 arrives and applies.
    await page.evaluate(async (t) => {
      window.getSelection().removeAllRanges();
      await new Promise((r) => setTimeout(r, 0));
      window.__markdownAnnotator.applyUpdate(t);
    }, V3);
    await sleep(400);
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('Version three.')), true, 'V3 stays');
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.pendingText), null);
  }));

  test('copying only part of the fallback preview does not mark the batch sent; copying all of it does', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Instruction A');
    await addComment(page, 'status: draft', 'Instruction B');
    await page.evaluate(() => { window.__clipFail = true; });
    await page.keyboard.press('Control+Enter');
    await until(() => page.evaluate(() => !document.querySelector('#review').hidden), { message: 'fallback preview' });
    // Part of the preview only.
    await page.evaluate(() => { const r = document.createRange(); const t = document.querySelector('#preview').firstChild; r.setStart(t, 0); r.setEnd(t, 40); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Control+c');
    await sleep(100);
    assert.deepEqual((await comments(page)).map((c) => c.sent), [false, false], 'a partial copy marks nothing');
    // The whole preview.
    await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#preview')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Control+c');
    await until(async () => (await comments(page)).every((c) => c.sent), { message: 'whole copy marks sent' });
  }));
});

// ---------------------------------------------------------------------------
const LAYOUT_DOC = `# Notes

A short opening line.

- First item
- Second item that is a little longer

| Strategy | Merge quality | Storage cost | Complexity |
|---|---|---|---|
| Last writer wins | loses edits | none | trivial |
| Three-way text merge | good for prose | a base snapshot per note | moderate |

\`\`\`ts
export async function flush(log: OpLog, api: SyncApi, options: FlushOptions): Promise<number> {
  return 0;
}
\`\`\`
`;

describe('design pass 2', () => {
  for (const width of [760, 1280]) {
    test(`at ${width} px the pill sits right after a selection that ends its line`, () => withApp({ width, height: 800 }, async ({ page }) => {
      await openText(page, 'notes.md', LAYOUT_DOC);
      const [r] = await rectsOf(page, 'First item');
      await selectText(page, 'First item');
      await until(() => visible(page, '#pill'), { message: 'pill' });
      const pill = await page.locator('#pill').boundingBox();
      assert.ok(pill.x >= r.right && pill.x - r.right <= 24, `pill starts just after the selection (pill x ${pill.x}, selection right ${r.right})`);
      assert.ok(Math.abs(pill.y + pill.height / 2 - (r.top + r.bottom) / 2) < 6, 'pill is on the same line');
    }));
  }

  test('at 380 px the pill covers neither the selection nor the heading text above it', () => withApp({ width: 380, height: 800 }, async ({ page }) => {
    await openText(page, 'notes.md', LAYOUT_DOC);
    const [r] = await rectsOf(page, 'Second item that is a little longer');
    const words = await rectsOf(page, 'First item');
    await selectText(page, 'Second item that is a little longer');
    await until(() => visible(page, '#pill'), { message: 'pill' });
    const pill = await page.locator('#pill').boundingBox();
    const hits = (q) => pill.x < q.right && pill.x + pill.width > q.left && pill.y < q.bottom && pill.y + pill.height > q.top;
    assert.ok(!hits(r), 'pill does not cover the selection');
    assert.ok(!words.some(hits), 'pill does not cover the line above');
  }));

  test('with the Review drawer open, the update toast stays on screen and wraps whole phrases', () => withApp({ width: 760, height: 900 }, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Why?');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await comments(page)).every((c) => c.sent), { message: 'sent' });
    await page.keyboard.press('r');
    await until(() => visible(page, '#review'), { message: 'drawer' });
    await page.evaluate((t) => window.__markdownAnnotator.applyUpdate(t), PLAN_SHIFTED);
    await until(async () => (await toasts(page)).some((t) => t.includes('Earlier rounds')), { message: 'update toast' });
    const box = await page.locator('#toasts .toast').last().boundingBox();
    const drawer = await page.locator('#review').boundingBox();
    const foot = await page.locator('#review .drawer-foot').boundingBox();
    assert.ok(box.x >= drawer.x + 8 && box.x + box.width <= drawer.x + drawer.width - 8, `toast is docked in the drawer (toast ${JSON.stringify(box)}, drawer ${JSON.stringify(drawer)})`);
    assert.ok(box.y + box.height <= foot.y, 'toast sits above the drawer footer');
    const body = await page.locator('#review .drawer-body').boundingBox();
    assert.ok(body.y + body.height <= box.y + 1, 'the toast takes room below the drawer body instead of covering it');
    // Bar controls the drawer would cut through are hidden while it is open.
    assert.equal(await page.$eval('#btn-copy', (b) => getComputedStyle(b).visibility), 'hidden');
    const lines = await page.$$eval('#toasts .toast:last-child .nw', (ns) => ns.map((n) => new Set(Array.from(n.getClientRects()).map((r) => Math.round(r.top))).size));
    assert.ok(lines.length >= 2 && lines.every((n) => n === 1), `each phrase stays on one line: ${lines}`);
    await page.keyboard.press('Escape');
    await until(async () => !(await visible(page, '#review')), { message: 'drawer closed' });
    assert.equal(await page.evaluate(() => document.querySelector('#toasts').parentElement === document.body), true, 'toasts return to the page');
  }));

  test('at full width the menu hangs from its button', () => withApp({ width: 1280, height: 800 }, async ({ page }) => {
    await openText(page, 'notes.md', LAYOUT_DOC);
    await page.click('#btn-menu');
    await until(() => visible(page, '#menu'), { message: 'menu' });
    const btn = await page.locator('#btn-menu').boundingBox();
    const menu = await page.locator('#menu').boundingBox();
    assert.ok(Math.abs(menu.x + menu.width - (btn.x + btn.width)) <= 1, `menu right ${menu.x + menu.width} vs button right ${btn.x + btn.width}`);
    const labels = await page.$$eval('#menu button > span:first-child', (s) => s.map((x) => x.textContent));
    assert.ok(labels.includes('Copy review') && labels.includes('Copy all, sent included'), labels.join(' | '));
  }));

  test('at 380 px a four-column table keeps short cells on one line and scrolls', () => withApp({ width: 380, height: 800 }, async ({ page }) => {
    await openText(page, 'notes.md', LAYOUT_DOC);
    const t = await page.$eval('#doc .table-wrap', (w) => ({ sw: w.scrollWidth, cw: w.clientWidth }));
    assert.ok(t.sw > t.cw, 'the table scrolls sideways');
    const r = await rectsOf(page, 'good for prose');
    assert.equal(new Set(r.map((x) => Math.round(x.top))).size, 1, '"good for prose" is on one line');
  }));

  test('wrapped code hangs its continuation lines past the line start', () => withApp({ width: 380, height: 800 }, async ({ page }) => {
    await openText(page, 'notes.md', LAYOUT_DOC);
    const r = await rectsOf(page, 'export async function flush(log: OpLog, api: SyncApi, options: FlushOptions): Promise<number> {');
    const lefts = [...new Set(r.map((x) => Math.round(x.left)))];
    assert.ok(r.length >= 2, 'the line wraps');
    assert.ok(Math.min(...r.slice(1).map((x) => x.left)) - r[0].left >= 20, `continuations are indented (lefts ${lefts})`);
  }));
});

// ---------------------------------------------------------------------------
describe('design pass 3', () => {
  test('a table that scrolls sideways fades out at the edge that has more', () => withApp({ width: 380, height: 800 }, async ({ page }) => {
    await openText(page, 'notes.md', LAYOUT_DOC);
    const cls = () => page.$eval('#doc .table-wrap', (w) => ({ l: w.classList.contains('more-l'), r: w.classList.contains('more-r'), mask: getComputedStyle(w).maskImage }));
    await until(async () => (await cls()).r, { message: 'more-r at the start' });
    let c = await cls();
    assert.ok(!c.l && c.mask !== 'none', JSON.stringify(c));
    assert.match(await page.$eval('#doc .table-wrap', (w) => getComputedStyle(w, '::after').content), /Scroll sideways/);
    await page.$eval('#doc .table-wrap', (w) => { w.scrollLeft = w.scrollWidth; });
    await until(async () => { const x = await cls(); return x.l && !x.r; }, { message: 'more-l only at the end' });
  }));

  test('a setting hides the "Scroll sideways" labels and keeps the fade, and it persists', () => withApp({ width: 380, height: 800 }, async ({ page }) => {
    await openText(page, 'notes.md', LAYOUT_DOC);
    const after = () => page.$eval('#doc .table-wrap', (w) => ({ display: getComputedStyle(w, '::after').display, mask: getComputedStyle(w).maskImage }));
    await until(async () => (await after()).display === 'block', { message: 'label shown by default' });
    await page.click('#btn-menu');
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    await until(() => visible(page, '#settings'), { message: 'settings' });
    assert.equal(await page.isChecked('#set-hints'), true);
    await page.click('#set-hints');
    const a = await after();
    assert.equal(a.display, 'none', 'label hidden');
    assert.notEqual(a.mask, 'none', 'fade stays');
    await page.reload();
    await page.evaluate(() => window.__markdownAnnotator.ready);
    await until(async () => (await page.$('#doc .table-wrap')) && (await after()).display === 'none', { message: 'still hidden after a reload' });
  }));

  test('the section label follows the heading in the top quarter of the window', () => withApp({ width: 760, height: 800 }, async ({ page }) => {
    const para = 'Filler sentence for scrolling the document. '.repeat(6);
    const doc = `# Top\n\n${Array(25).fill(para).join('\n\n')}\n\n## Middle\n\n${Array(25).fill(para).join('\n\n')}\n`;
    await openText(page, 'long.md', doc);
    await page.evaluate(() => {
      const hd = [...document.querySelectorAll('#doc h2')].find((e) => e.textContent.includes('Middle'));
      window.scrollBy(0, hd.getBoundingClientRect().top - document.querySelector('#bar').offsetHeight - 100);
    });
    await until(async () => (await page.textContent('#crumb-sec')) === 'Middle', { message: 'crumb shows Middle' });
  }));
});

// ---------------------------------------------------------------------------
describe('agents and scripts', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const openLink = async (page, hash) => {
    await page.goto('about:blank');
    await page.goto(`${appUrl}#${hash}`);
    await page.evaluate(() => window.__markdownAnnotator.ready);
  };
  const info = (page) => page.evaluate(() => window.markdownAnnotator.document());

  test('a link with md64 and a path opens a named snapshot, then leaves the address bar', () => withApp({}, async ({ page }) => {
    await openLink(page, `path=docs/PLAN.md&md64=${b64(PLAN)}`);
    assert.deepEqual(await info(page), { name: 'PLAN.md', path: 'docs/PLAN.md', source: 'file', live: false, generalNote: '' });
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.doc.text), PLAN);
    assert.equal(await page.evaluate(() => location.hash), '', 'the text is not left in the address bar');
    await until(async () => (await toasts(page)).some((t) => t.startsWith('Opened PLAN.md as a snapshot')), { message: 'snapshot toast' });
    await addComment(page, 'be conservative', 'Why?');
    assert.match(await page.evaluate(() => window.markdownAnnotator.review()), /^Review of `docs\/PLAN\.md`: 1 comment\./);
  }));

  test('md= (percent-encoded, "+" kept), a name, and no name at all', () => withApp({}, async ({ page }) => {
    const text = '# Plus plan\n\nUse a+b and 50% of c & d.\n';
    await openLink(page, `name=plus.md&md=${encodeURIComponent(text)}`);
    assert.equal((await info(page)).name, 'plus.md');
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.doc.text), text);
    await openLink(page, `md64=${b64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`);
    const d = await info(page);
    assert.equal(d.source, 'paste', 'without a name or path the text counts as pasted');
    assert.equal(d.name, 'Plus plan');
  }));

  test('a broken link says why and opens nothing', () => withApp({}, async ({ page }) => {
    const cases = [
      ['path=x.md&md64=%%%not-base64', 'use md64='],
      ['path=x.md&md64=!!!!', 'use md64='],
      ['path=x.md&md64=/w==', 'use md64='], // valid base64, invalid UTF-8
      ['name=%E0%A4%A&md=hello', 'not valid percent-encoding'],
      ['md=', 'the document is empty'],
      ['path=x.md&md64=', 'the document is empty'],
    ];
    for (const [hash, why] of cases) {
      await openLink(page, hash);
      await until(async () => (await toasts(page)).some((t) => t.includes("couldn't be opened") && t.includes(why)), { message: `error toast for ${hash}` });
      assert.equal(await info(page), null, hash);
    }
  }));

  test('a raw "+" in md= stays a plus', () => withApp({}, async ({ page }) => {
    await openLink(page, 'name=plus.md&md=a+b%20c');
    assert.equal(await page.evaluate(() => window.markdownAnnotator.markdown()), 'a+b c');
  }));

  test('a name alone never joins a path\'s document', () => withApp({}, async ({ page }) => {
    await openLink(page, `path=docs/PLAN.md&md64=${b64(PLAN)}`);
    await addComment(page, 'be conservative', 'Why?');
    // { name } with no path opens its own document, not docs/PLAN.md's.
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, name: 'PLAN.md' }), 'Something else entirely.\n');
    assert.equal((await info(page)).path, '');
    assert.equal((await comments(page)).length, 0);
    await page.evaluate((h) => { location.hash = h; }, `path=docs/PLAN.md&md64=${b64(PLAN)}`);
    await until(async () => (await info(page)).path === 'docs/PLAN.md', { message: 'back to the path' });
    assert.equal(await page.evaluate(() => window.markdownAnnotator.markdown()), PLAN, 'the path\'s document was not overwritten');
    assert.equal((await comments(page)).length, 1);
  }));

  test('served over http, a link never replaces a saved document: it opens a separate copy', async () => {
    const html = readFileSync(new URL('../markdown-annotator.html', import.meta.url));
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/markdown-annotator.html`;
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${base}#path=docs/PLAN.md&md64=${b64(PLAN)}`);
      await page.evaluate(() => window.markdownAnnotator.ready);
      await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'Why?' }));
      const firstKey = await page.evaluate(() => window.__markdownAnnotator.state.doc.key);
      // What another web page could do: send the tab to a link with different text for the same path.
      await page.evaluate((h) => { location.hash = h; }, `path=docs/PLAN.md&md64=${b64('# Forged\n\nNot the plan.\n')}`);
      await until(async () => (await toasts(page)).some((t) => t.includes('as a separate copy')), { message: 'separate-copy toast' });
      assert.notEqual(await page.evaluate(() => window.__markdownAnnotator.state.doc.key), firstKey);
      const saved = await page.evaluate(async (k) => { await new Promise((r) => setTimeout(r, 300)); return new Promise((res) => { const q = indexedDB.open('markdown-annotator.v1'); q.onsuccess = () => { const g = q.result.transaction('docs').objectStore('docs').get(k); g.onsuccess = () => res(g.result && { text: g.result.text, n: g.result.comments.length }); }; }); }, firstKey);
      assert.equal(saved.text, PLAN, 'the saved document keeps its text');
      assert.equal(saved.n, 1, 'and its comment');
      // The same text again is not a replacement: it opens the saved document as usual.
      await page.evaluate((h) => { location.hash = h; }, `path=docs/PLAN.md&md64=${b64(PLAN)}`);
      await until(async () => (await page.evaluate(() => window.__markdownAnnotator.state.doc.key)) === firstKey, { message: 'back to the saved one' });
    } finally {
      await ctx.close();
      server.close();
    }
  });

  test('served over http, forged links can neither overwrite pasted text nor push saved reviews out', async () => {
    const html = readFileSync(new URL('../markdown-annotator.html', import.meta.url));
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/markdown-annotator.html`;
    const ctx = await browser.newContext();
    const records = (page) => page.evaluate(() => new Promise((res) => { const q = indexedDB.open('markdown-annotator.v1'); q.onsuccess = () => { const g = q.result.transaction('docs').objectStore('docs').getAll(); g.onsuccess = () => res(g.result.map((r) => ({ key: r.key, name: r.name, copy: !!r.copy, text: r.text, n: r.comments.length }))); }; }));
    const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(250); };
    try {
      const page = await ctx.newPage();
      await page.goto(base);
      await page.evaluate(() => window.markdownAnnotator.ready);
      // Pasted text (no name): a similar-looking link opens beside it instead of replacing it.
      await go(page, `md=${encodeURIComponent('# Pasted plan\n\nFirst version of the text here.\n')}`);
      await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'First version', comment: 'Keep me.' }));
      const pastedKey = await page.evaluate(() => window.__markdownAnnotator.state.doc.key);
      await go(page, `md=${encodeURIComponent('# Pasted plan\n\nFirst version of the text here, changed.\n')}`);
      assert.notEqual(await page.evaluate(() => window.__markdownAnnotator.state.doc.key), pastedKey);
      const pasted = (await records(page)).find((r) => r.key === pastedKey);
      assert.equal(pasted.n, 1, 'the pasted document keeps its comment');
      // A saved review, then a flood of forged versions for the same path.
      await go(page, `path=docs/PLAN.md&md64=${b64(PLAN)}`);
      await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'Why?' }));
      const planKey = await page.evaluate(() => window.__markdownAnnotator.state.doc.key);
      for (let i = 0; i < 3; i++) { await go(page, `path=docs/PLAN.md&md64=${b64('# A\n\nForged A.\n')}`); await go(page, `path=docs/PLAN.md&md64=${b64('# B\n\nForged B.\n')}`); }
      let all = await records(page);
      assert.equal(all.filter((r) => r.copy && r.name === 'PLAN.md').length, 2, 'repeating the same two texts reuses their copies');
      for (let i = 0; i < 8; i++) await go(page, `path=docs/PLAN.md&md64=${b64(`# Forged ${i}\n\nText ${i}.\n`)}`);
      await page.waitForTimeout(300);
      all = await records(page);
      assert.ok(all.filter((r) => r.copy).length <= 6, `copies are capped (${all.filter((r) => r.copy).length})`);
      const plan = all.find((r) => r.key === planKey);
      assert.ok(plan && plan.text === PLAN && plan.n === 1, 'the saved review survives untouched');
    } finally {
      await ctx.close();
      server.close();
    }
  });

  // The page served from a local http address, which any web page can send links to.
  async function served(fn, init = null) {
    const html = readFileSync(new URL('../markdown-annotator.html', import.meta.url));
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const ctx = await browser.newContext();
    if (init) await ctx.addInitScript(init);
    try {
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/markdown-annotator.html`);
      await page.evaluate(() => window.markdownAnnotator.ready);
      const records = () => page.evaluate(async () => (await window.__markdownAnnotator.records()).map((r) => ({ key: r.key, name: r.name, path: r.path || '', copy: !!r.copy, text: r.text, n: r.comments.length })));
      // Send the tab to a link, as another page could, and wait until its text is showing.
      const link = async (hash, text) => {
        await page.evaluate((h) => { location.hash = h; }, hash);
        await until(() => page.evaluate((t) => window.markdownAnnotator.markdown() === t, text), { message: `link ${hash.slice(0, 40)}` });
      };
      const key = () => page.evaluate(() => window.__markdownAnnotator.state.doc.key);
      const settle = () => page.waitForTimeout(400);
      await fn({ page, records, link, key, settle });
    } finally {
      await ctx.close();
      server.close();
    }
  }

  test('served over http, links with new names or no name are copies that never push saved reviews out', () => served(async ({ page, records, link, key, settle }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'Why?' }));
    const planKey = await key();
    for (let i = 0; i < 32; i++) { const t = `# N${i}\n\nNew name ${i}.\n`; await link(`name=N${i}.md&md64=${b64(t)}`, t); }
    for (let i = 0; i < 32; i++) { const t = `# U${i}\n\nNo name ${i}.\n`; await link(`md=${encodeURIComponent(t)}`, t); }
    await settle();
    const all = await records();
    assert.ok(all.filter((r) => r.copy).length <= 6, `copies are capped (${all.filter((r) => r.copy).length})`);
    assert.equal(all.filter((r) => !r.copy).length, 1, 'no link made an ordinary record');
    const plan = all.find((r) => r.key === planKey);
    assert.ok(plan && plan.text === PLAN && plan.n === 1, 'the saved review survives');
  }));

  test('served over http, a copy becomes a saved review once it holds a comment or a general note', () => served(async ({ page, records, link, key, settle }) => {
    const a = '# Alpha\n\nAlpha text to review.\n';
    await link(`path=docs/ALPHA.md&md64=${b64(a)}`, a);
    const alphaKey = await key();
    await settle();
    assert.equal((await records()).find((r) => r.key === alphaKey).copy, true, 'a new link opens a copy');
    await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'Alpha text', comment: 'Keep this.' }));
    const g = '# Gamma\n\nGamma text.\n';
    await link(`name=GAMMA.md&md64=${b64(g)}`, g);
    const gammaKey = await key();
    await page.evaluate(() => window.markdownAnnotator.setGeneralNote('A note on Gamma.'));
    for (let i = 0; i < 8; i++) { const t = `# F${i}\n\nLater ${i}.\n`; await link(`name=F${i}.md&md64=${b64(t)}`, t); }
    await settle();
    const all = await records();
    const alpha = all.find((r) => r.key === alphaKey);
    assert.ok(alpha && !alpha.copy && alpha.n === 1, 'the commented copy became a saved review and survived');
    const gamma = all.find((r) => r.key === gammaKey);
    assert.ok(gamma && !gamma.copy, 'so did the one with a general note');
    // The same text again reopens it rather than making another copy.
    await link(`path=docs/ALPHA.md&md64=${b64(a)}`, a);
    assert.equal(await key(), alphaKey);
  }));

  test('served over http, a commented copy saved by an earlier version is kept like a saved review', () => served(async ({ page, records, link, settle }) => {
    // Earlier versions kept `copy: true` on a copy after it got comments.
    await page.evaluate(() => new Promise((res) => {
      const q = indexedDB.open('markdown-annotator.v1');
      q.onsuccess = () => {
        const tx = q.result.transaction('docs', 'readwrite');
        tx.objectStore('docs').put({ key: 'file:OLD.md:legacy', name: 'OLD.md', source: 'file', text: '# Old\n\nOld review.\n', path: 'docs/OLD.md', copy: true,
          comments: [{ id: 'c1', quote: 'Old review', comment: 'Kept.', created: 1, updated: 1 }], deleted: {}, general: '', updatedAt: 1 });
        tx.oncomplete = () => res();
      };
    }));
    for (let i = 0; i < 8; i++) { const t = `# L${i}\n\nLater ${i}.\n`; await link(`name=L${i}.md&md64=${b64(t)}`, t); }
    await settle();
    const old = (await records()).find((r) => r.key === 'file:OLD.md:legacy');
    assert.ok(old && old.n === 1, 'the commented copy survives the flood');
  }));

  test('served over http, an unnamed link never overwrites a revised paste', () => served(async ({ page, records, link, key, settle }) => {
    const first = '# Notes\n\nThe first draft of these notes.\n';
    const revised = '# Notes\n\nThe revised draft, quite different now.\n';
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t }), first);
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t }), revised);
    const notesKey = await key();
    await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'revised draft', comment: 'Good.' }));
    // A link with the first version's text: its key is the revised document's, but its text isn't.
    await link(`md=${encodeURIComponent(first)}`, first);
    assert.notEqual(await key(), notesKey);
    await settle();
    const notes = (await records()).find((r) => r.key === notesKey);
    assert.ok(notes && notes.text === revised && notes.n === 1, 'the revised paste keeps its text and comment');
  }));

  test('served over http, a link with a path never files it on a document that has none', () => served(async ({ page, records, link, key, settle }) => {
    const t = '# Notes\n\nSame text either way.\n';
    await page.evaluate((x) => window.markdownAnnotator.open({ text: x, name: 'NOTES.md' }), t);
    const plainKey = await key();
    await link(`path=docs/NOTES.md&md64=${b64(t)}`, t);
    assert.notEqual(await key(), plainKey);
    await settle();
    assert.equal((await records()).find((r) => r.key === plainKey).path, '', 'the plain record keeps no path');
  }));

  test('served over http, a link for a followed file that can\'t be read opens beside it', () => served(async ({ page, records, link, key, settle }) => {
    // A file followed live under a path. The stand-in handle can't be stored, so records stay in memory.
    await page.evaluate(async (t) => {
      window.__diskText = t;
      await window.__markdownAnnotator.openHandle(window.__fakeHandle);
      const el = document.querySelector('#path');
      el.value = 'docs/PLAN.md';
      el.dispatchEvent(new Event('input'));
    }, PLAN);
    await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'Why?' }));
    const liveKey = await key();
    // The same text brings the followed document up.
    const other = '# Other\n\nSomething else.\n';
    await link(`name=OTHER.md&md64=${b64(other)}`, other);
    await link(`path=docs/PLAN.md&md64=${b64(PLAN)}`, PLAN);
    assert.equal(await key(), liveKey);
    // The file is gone: the link's different text opens as a copy, and the followed document is untouched.
    await page.evaluate(() => { window.__diskMissing = true; });
    await link(`name=OTHER.md&md64=${b64(other)}`, other);
    await link(`path=docs/PLAN.md&md64=${b64(PLAN_SHIFTED)}`, PLAN_SHIFTED);
    assert.notEqual(await key(), liveKey);
    assert.ok((await toasts(page)).some((x) => x.includes('opened as a separate copy beside your saved PLAN.md')), (await toasts(page)).join(' | '));
    await settle();
    const live = (await records()).find((r) => r.key === liveKey);
    assert.ok(live && live.text === PLAN && live.n === 1, 'the followed document keeps its text and comment');
  }, () => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    const fake = {
      kind: 'file',
      name: 'PLAN.md',
      getFile: async () => {
        if (window.__diskMissing) throw new DOMException('A requested file could not be found.', 'NotFoundError');
        return new File([window.__diskText], 'PLAN.md', { lastModified: 1000 });
      },
      isSameEntry: async (o) => o === fake,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    };
    window.__fakeHandle = fake;
  }));

  test('a quote across many <br> line breaks is found without re-walking the page', () => withApp({}, async ({ page }) => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('<br>');
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, name: 'br.md' }), lines + '\n');
    const c = await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'line 398 line 399', comment: 'x' }));
    assert.equal(c.lineStart, 1);
    await assert.rejects(page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'li ne 398', comment: 'x' })), /is not in the rendered text/);
  }));

  test('on a file:// page, a link with new text for the same path updates it in place', () => withApp({}, async ({ page }) => {
    await openLink(page, `path=docs/PLAN.md&md64=${b64(PLAN)}`);
    await addComment(page, 'be conservative', 'Why?');
    const key = await page.evaluate(() => window.__markdownAnnotator.state.doc.key);
    await page.evaluate((h) => { location.hash = h; }, `path=docs/PLAN.md&md64=${b64(PLAN_SHIFTED)}`);
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro paragraph')), { message: 'replaced' });
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.doc.key), key);
    assert.equal((await comments(page)).length, 1, 'the comment carried over');
  }));

  test('open() throws when nothing opens, and leaves the current document alone', () => withApp({}, async ({ page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    await assert.rejects(page.evaluate(() => window.markdownAnnotator.open({ text: '   ' })), /markdownAnnotator\.open: the document is empty/);
    await assert.rejects(page.evaluate(() => window.markdownAnnotator.open(null)), /text must be a string/);
    assert.equal((await info(page)).path, 'docs/PLAN.md');
  }));

  test('a comment edited and deleted in the same tick stays deleted', () => withApp({}, async ({ page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    const left = await page.evaluate(async () => {
      const api = window.markdownAnnotator;
      for (let i = 0; i < 30; i++) {
        const c = api.addComment({ quote: 'be conservative', comment: `Note ${i}` });
        api.editComment(c.id, `Edited ${i}`);
        api.deleteComment(c.id);
      }
      await new Promise((r) => setTimeout(r, 600));
      return api.comments().length;
    });
    assert.equal(left, 0);
  }));

  test('addComment finds a quote across a <br> line break', () => withApp({}, async ({ page }) => {
    await page.evaluate(() => window.markdownAnnotator.open({ text: 'First line<br>Second line here.\n', name: 'br.md' }));
    const c = await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'First line Second line', comment: 'x' }));
    assert.equal(c.lineStart, 1);
    // A missing space only counts at a real line break: "foo bar" never matches "foobar".
    await page.evaluate(() => window.markdownAnnotator.open({ text: 'The foobar is here.\n', name: 'nb.md' }));
    await assert.rejects(page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'foo bar', comment: 'x' })), /is not in the rendered text/);
  }));

  test('a link that arrives while a comment is being typed keeps the draft and says so', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await selectText(page, 'be conservative');
    await page.keyboard.press('c');
    await page.waitForSelector('#composer:not([hidden])');
    await page.keyboard.type('Half-written thought');
    await page.evaluate((h) => { location.hash = h; }, `path=docs/OTHER.md&md64=${b64('# Other\n\nText.\n')}`);
    await until(async () => (await info(page)).name === 'OTHER.md', { message: 'switched' });
    const ts = await toasts(page);
    assert.ok(ts.some((t) => t.includes('Saved your unfinished comment on PLAN.md')), ts.join(' | '));
    assert.ok(ts.some((t) => t.startsWith('Opened OTHER.md')), ts.join(' | '));
  }));

  test('opening the same path again updates in place; another folder is another document', () => withApp({}, async ({ page }) => {
    await openLink(page, `path=docs/PLAN.md&md64=${b64(PLAN)}`);
    await addComment(page, 'be conservative', 'Why?');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await comments(page)).every((c) => c.sent), { message: 'sent' });
    // A later link for the same path, while the page is open (hashchange).
    await page.evaluate((h) => { location.hash = h; }, `path=docs/PLAN.md&md64=${b64(PLAN_SHIFTED)}`);
    await until(() => page.evaluate(() => window.__markdownAnnotator.state.doc.text.includes('A new intro paragraph')), { message: 'updated' });
    assert.ok((await page.evaluate(() => window.__markdownAnnotator.state.changes.length)) > 0, 'changes are marked');
    assert.ok((await comments(page)).every((c) => c.archived), 'the sent comment moved to Earlier rounds');
    // Same name, different folder: a separate document without those comments.
    await page.evaluate((h) => { location.hash = h; }, `path=other/PLAN.md&md64=${b64(PLAN)}`);
    await until(async () => (await info(page)).path === 'other/PLAN.md', { message: 'other path' });
    assert.equal((await comments(page)).length, 0);
  }));

  test('the scripting interface: open, review, comments, document; reading marks nothing sent', () => withApp({}, async ({ page }) => {
    const d = await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    assert.equal(d.name, 'PLAN.md');
    assert.equal(await page.evaluate(() => window.markdownAnnotator.review()), '');
    await addComment(page, 'be conservative', 'Why?');
    await page.evaluate(() => { window.__markdownAnnotator.state.general = 'Tighten the intro.'; });
    const review = await page.evaluate(() => window.markdownAnnotator.review());
    assert.equal(review, await output(page), 'review() is what Copy would copy');
    const list = await page.evaluate(() => window.markdownAnnotator.comments());
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['comment', 'detached', 'id', 'lineEnd', 'lineStart', 'n', 'quote', 'section', 'sent']);
    assert.equal(list[0].comment, 'Why?');
    assert.equal(list[0].quote, 'be conservative');
    assert.equal(list[0].sent, false);
    assert.equal((await info(page)).generalNote, 'Tighten the intro.');
    assert.equal((await comments(page))[0].sent, false, 'reading did not mark it sent');
    assert.equal(await page.evaluate(() => Object.isFrozen(window.markdownAnnotator) && typeof window.markdownAnnotator.version), 'string');
    await assert.rejects(page.evaluate(() => window.markdownAnnotator.open({})), /text must be a string/);
  }));

  test('a script can read the Markdown and add, edit and delete comments and the general note', () => withApp({}, async ({ page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    assert.equal(await page.evaluate(() => window.markdownAnnotator.markdown()), PLAN);
    const api = (fn, ...args) => page.evaluate(([f, a]) => window.markdownAnnotator[f](...a), [fn, args]);
    // Add: the quote is matched in the rendered text, whitespace-tolerant, and lands like a typed comment.
    const c1 = await api('addComment', { quote: 'be conservative', comment: 'Why conservative?' });
    assert.equal(c1.n, 1);
    assert.equal(c1.quote, 'be conservative');
    assert.ok(c1.lineStart > 0 && c1.id);
    assert.equal((await comments(page)).length, 1);
    assert.match(await output(page), /## Comment 1 \(line \d+, table under "Design > Step 6[^)]*\)\n> be conservative\n\nWhy conservative\?/);
    await until(async () => (await page.$$('#doc .note')).length === 1, { message: 'the note shows' });
    // Errors that tell the agent what to do.
    await assert.rejects(api('addComment', { quote: 'no such passage anywhere', comment: 'x' }), /is not in the rendered text/);
    await assert.rejects(api('addComment', { quote: 'be conservative', comment: '' }), /comment must be a non-empty string/);
    const dup = await page.evaluate(() => { const t = window.__markdownAnnotator.state.index.text; const m = t.match(/\b(\w{4,})\b[\s\S]*\b\1\b/); return m ? m[1] : null; });
    await assert.rejects(api('addComment', { quote: dup, comment: 'x' }), /appears \d+ times; pass occurrence/);
    const c2 = await api('addComment', { quote: dup, comment: 'Second.', occurrence: 2 });
    assert.equal((await comments(page)).length, 2);
    // Edit by id or by the shown number; delete with the person's Undo.
    const edited = await api('editComment', c1.id, 'Explain the risk.');
    assert.equal(edited.comment, 'Explain the risk.');
    const byNum = (await page.evaluate(() => window.markdownAnnotator.comments())).find((c) => c.id === c2.id).n;
    await api('editComment', byNum, 'Second, edited.');
    assert.ok((await comments(page)).some((c) => c.body === 'Second, edited.'));
    await assert.rejects(api('editComment', 'nope', 'x'), /no current comment/);
    assert.equal(await api('deleteComment', c1.id), true);
    assert.equal((await comments(page)).length, 1);
    await until(async () => (await toasts(page)).some((t) => t.includes('Comment deleted.')), { message: 'undo toast' });
    await page.click('#toasts .toast button');
    await until(async () => (await comments(page)).length === 2, { message: 'Undo brings it back' });
    // The general note.
    const d = await api('setGeneralNote', 'Tighten the intro.');
    assert.equal(d.generalNote, 'Tighten the intro.');
    assert.equal(await page.inputValue('#general'), 'Tighten the intro.');
    assert.ok((await output(page)).endsWith('## General note\nTighten the intro.\n'));
  }));

  test('deleting a comment from its editor also clears its highlight', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Why?');
    await page.click('#doc .note');
    await page.waitForSelector('#composer:not([hidden])');
    assert.equal(await page.evaluate(() => CSS.highlights.get('cr-active').size), 1, 'the comment being edited is highlighted');
    await page.click('#cmp-delete');
    await until(async () => (await comments(page)).length === 0, { message: 'deleted' });
    assert.equal(await page.evaluate(() => CSS.highlights.get('cr-active').size), 0, 'no highlight is left behind');
    assert.equal(await page.evaluate(() => CSS.highlights.get('cr-note').size), 0);
  }));

  test('without scripts, the page itself carries each comment with its line and quote, and the general note', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    await addComment(page, 'be conservative', 'Why?');
    await page.evaluate(() => { const g = document.querySelector('#general'); g.value = 'Tighten the intro.'; g.dispatchEvent(new Event('input')); });
    const label = await page.getAttribute('#doc .note', 'aria-label');
    assert.match(label, /^Comment 1, line \d+, on "be conservative": Why\? Enter to edit\.$/);
    const mainText = await page.evaluate(() => document.querySelector('main').innerText);
    assert.ok(mainText.includes('Tighten the intro.'), 'the general note is in the page text');
    assert.equal(await page.getAttribute('#doc-end .general-note', 'aria-label'), 'General note: Tighten the intro. Enter to edit.');
  }));

  test('a page loaded as a data: URL explains how to keep comments', () => withApp({}, async ({ ctx }) => {
    const html = readFileSync(new URL('../markdown-annotator.html', import.meta.url));
    const page = await ctx.newPage();
    await page.goto(`data:text/html;base64,${html.toString('base64')}`);
    await until(() => page.evaluate(() => (document.querySelector('#toasts') || {}).textContent || ''), { message: 'storage toast' });
    const t = await page.evaluate(() => document.querySelector('#toasts').textContent);
    assert.ok(t.includes("isn't letting the page save") && t.includes('http://localhost'), t);
    await page.close();
  }));

  test('a launcher page opens a document too big for a Windows command line', () => withApp({}, async ({ page }) => {
    const big = Array.from({ length: 15 }, (_, i) => `## Section ${i + 1}\n\n${PLAN}`).join('\n\n');
    assert.ok(big.length > 25000);
    const out = new URL('./out/', import.meta.url);
    mkdirSync(out, { recursive: true });
    const launcher = new URL('./launch-big.html', out);
    writeFileSync(launcher, `<meta http-equiv="refresh" content="0;url=${appUrl}#path=docs/BIG.md&md64=${b64(big)}">`);
    await page.goto(launcher.href);
    // The meta refresh replaces the page, so poll with waitForFunction, which survives the navigation.
    await page.waitForFunction(() => !!(window.markdownAnnotator && window.markdownAnnotator.document()));
    assert.equal((await info(page)).path, 'docs/BIG.md');
    assert.equal(await page.evaluate(() => window.__markdownAnnotator.state.doc.text.length), big.length);
  }));
});

// ---------------------------------------------------------------------------
describe('theme', () => {
  const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  test('System (the default) follows the OS; Light and Dark override it and persist', () => withApp({}, async ({ page }) => {
    await openText(page, 'PLAN.md', PLAN);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'system');
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await bg(page), 'rgb(14, 16, 19)');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await bg(page), 'rgb(255, 255, 255)');
    await page.click('#btn-menu');
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    await page.click('#set-theme button[data-v="dark"]');
    assert.equal(await bg(page), 'rgb(14, 16, 19)', 'Dark wins over a light OS');
    assert.equal(await page.getAttribute('#set-theme button[data-v="dark"]', 'aria-pressed'), 'true');
    await page.reload();
    await page.evaluate(() => window.__markdownAnnotator.ready);
    assert.equal(await bg(page), 'rgb(14, 16, 19)', 'the choice persists');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => { window.__markdownAnnotator.settings.theme = 'light'; document.documentElement.dataset.theme = 'light'; });
    assert.equal(await bg(page), 'rgb(255, 255, 255)', 'Light wins over a dark OS');
  }));
});

// Chrome 153 and 154 crash the whole browser when a tab closes while an IndexedDB write holding a file handle
// is in flight, so records never hold one (see the store in src/app.js). These tests use real files on disk
// in an ordinary Chrome profile, the setup where that crash shows up.
describe('several tabs on a file followed on disk', () => {
  async function withDisk(fn, { reads } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ma-disk-'));
    const file = join(dir, 'PLAN.md');
    writeFileSync(file, PLAN);
    mkdirSync(join(dir, 'other'));
    const otherFile = join(dir, 'other', 'PLAN.md');
    writeFileSync(otherFile, '# Plan\n\nAnother project\'s plan.\n');
    const app = await launchProfile();
    try {
      if (typeof reads === 'boolean') await app.ctx.addInitScript((v) => { window.__markdownAnnotatorHandleReads = v; }, reads);
      const open = async () => {
        const page = await app.ctx.newPage();
        page.setDefaultTimeout(8000);
        await page.goto(appUrl);
        await page.evaluate(() => window.markdownAnnotator.ready);
        return page;
      };
      const live = async (page) => {
        await dropFile(page, file);
        await until(() => page.evaluate(() => window.__markdownAnnotator.state.liveMode === 'on'), { message: 'following the file' });
      };
      await fn({ ...app, file, otherFile, open, live });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const docKey = (page) => page.evaluate(() => window.__markdownAnnotator.state.doc && window.__markdownAnnotator.state.doc.key);

  test('closing tabs on a followed file never takes Chrome down, and every comment survives', () => withDisk(async ({ crashed, open, live }) => {
    let a = await open();
    await live(a);
    for (let i = 0; i < 12; i++) {
      const b = await open();
      await until(() => docKey(b), { message: 'the new tab restored the document' });
      // A change just before closing, so the tab leaves with a save in flight: the worst case.
      await a.evaluate((n) => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: `Round ${n}` }), i);
      await a.close();
      await sleep(1000);
      assert.ok(!crashed(), `Chrome crashed after closing tab ${i + 1}`);
      a = b;
      if (!(await a.evaluate(() => !!window.__markdownAnnotator.state.doc.handle))) {
        await a.evaluate(() => window.__markdownAnnotator.armReconnect()); // Reconnect, then the file picker
        await live(a);
      }
    }
    await until(async () => (await comments(a)).length === 12, { message: 'all 12 comments in the last tab' });
  }));

  test('no saved record holds a file handle; one saved by 1.0.0 is moved out on the next start', () => withDisk(async ({ open, live }) => {
    const a = await open();
    await live(a);
    await a.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'Why?' }));
    const key = await docKey(a);
    await sleep(300);
    const recs = await idbRecord(a);
    assert.ok(recs.length && recs.every((r) => r.handle === null), 'no record holds a handle');
    assert.equal(recs.find((r) => r.key === key).live, true);
    assert.ok((await a.evaluate(() => window.__markdownAnnotator.metaKeys())).includes(`handle:${key}`));
    // What 1.0.0 stored: the handle inside the record, and no separate entry.
    await a.evaluate((k) => new Promise((res) => {
      const h = window.__markdownAnnotator.state.doc.handle;
      const q = indexedDB.open('markdown-annotator.v1');
      q.onsuccess = () => {
        const tx = q.result.transaction(['docs', 'meta'], 'readwrite');
        const docs = tx.objectStore('docs');
        const g = docs.get(k);
        g.onsuccess = () => { const r = g.result; delete r.live; r.handle = h; docs.put(r); tx.objectStore('meta').delete(`handle:${k}`); tx.objectStore('meta').delete('handlesMoved'); };
        tx.oncomplete = () => { q.result.close(); res(); };
      };
    }), key);
    await a.reload();
    await a.evaluate(() => window.markdownAnnotator.ready);
    const rec = await idbRecord(a, key);
    assert.equal(rec.handle, null, 'moved out of the record');
    assert.equal(rec.live, true);
    assert.ok((await a.evaluate(() => window.__markdownAnnotator.metaKeys())).includes(`handle:${key}`));
    assert.equal((await comments(a)).length, 1);
  }));

  test('where Chrome can read handles back, a second tab follows the file too', () => withDisk(async ({ open, live }) => {
    const a = await open();
    await live(a);
    const b = await open();
    await until(() => b.evaluate(() => window.__markdownAnnotator.state.liveMode === 'on'), { message: 'the second tab follows the file' });
    assert.equal(await docKey(b), await docKey(a));
  }, { reads: true }));

  test('where it can\'t, a second tab offers Reconnect, which rejoins the document; a plain drop opens on its own', () => withDisk(async ({ file, open, live }) => {
    const a = await open();
    await live(a);
    await a.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'Why?' }));
    const key = await docKey(a);
    const b = await open();
    await until(() => b.evaluate(() => window.__markdownAnnotator.state.liveMode === 'perm'), { message: 'Reconnect offered' });
    assert.equal(await b.evaluate(() => !!window.__markdownAnnotator.state.doc.handle), false);
    assert.ok(await visible(b, '#btn-reconnect'));
    await b.evaluate(() => window.__markdownAnnotator.armReconnect()); // Reconnect, then the file picker
    await live(b);
    assert.equal(await docKey(b), key, 'the same document, not a new one');
    assert.equal((await comments(b)).length, 1);
    // The same file dropped without Reconnect may be any copy: it opens on its own and says how to rejoin.
    const c = await open();
    await until(() => c.evaluate(() => window.__markdownAnnotator.state.liveMode === 'perm'), { message: 'Reconnect offered again' });
    await dropFile(c, file);
    await until(async () => (await docKey(c)) !== key, { message: 'a document of its own' });
    assert.ok((await toasts(c)).some((t) => t.includes('choose Reconnect')), (await toasts(c)).join(' | '));
  }, { reads: false }));

  test('where it can\'t, another project\'s file with the same name never joins the document', () => withDisk(async ({ open, live, otherFile }) => {
    const a = await open();
    await live(a);
    await a.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'Why?' }));
    const key = await docKey(a);
    const b = await open();
    await until(() => b.evaluate(() => window.__markdownAnnotator.state.liveMode === 'perm'), { message: 'Reconnect offered' });
    await dropFile(b, otherFile);
    await until(async () => (await docKey(b)) !== key, { message: 'the other file opened' });
    assert.equal((await comments(b)).length, 0, 'none of the first document\'s comments');
    assert.equal((await idbRecord(b, key)).text, PLAN, 'the first document keeps its text');
  }, { reads: false }));

  test('a handle entry outlives its record while Forget can still be undone, then goes', () => withDisk(async ({ open, live }) => {
    const a = await open();
    await live(a);
    const key = await docKey(a);
    // Forget, as the start screen does: the record goes, and the time is noted.
    const forget = (at) => a.evaluate(({ k, t }) => new Promise((res) => {
      const q = indexedDB.open('markdown-annotator.v1');
      q.onsuccess = () => {
        const tx = q.result.transaction(['docs', 'meta'], 'readwrite');
        tx.objectStore('docs').delete(k);
        tx.objectStore('meta').put({ k: 'forgotAt', v: t });
        tx.oncomplete = () => { q.result.close(); res(); };
      };
    }), { k: key, t: at });
    await forget(Date.now());
    const b = await open(); // its start tidies handle entries
    assert.ok((await b.evaluate(() => window.__markdownAnnotator.metaKeys())).includes(`handle:${key}`), 'kept for Undo');
    await forget(Date.now() - 120000);
    const c = await open();
    await until(async () => !(await c.evaluate(() => window.__markdownAnnotator.metaKeys())).includes(`handle:${key}`), { message: 'removed later' });
  }));
});

describe('leaving a page', () => {
  const setPath = (page, v) => page.evaluate((x) => { const el = document.querySelector('#path'); el.value = x; el.dispatchEvent(new Event('input')); }, v);
  const journals = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('.journal.')).length);

  test('pagehide starts no IndexedDB work, and a hidden page saves only what changed', () => withApp({}, async ({ page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    await sleep(400);
    await page.evaluate(() => {
      window.__tx = 0;
      const orig = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...a) { window.__tx++; return orig.apply(this, a); };
    });
    const tx = () => page.evaluate(() => window.__tx);
    const show = (v) => page.evaluate((s) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s }); document.dispatchEvent(new Event('visibilitychange')); }, v);
    await show('hidden');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await sleep(200);
    assert.equal(await tx(), 0, 'nothing changed, nothing written');
    assert.equal(await journals(page), 0);
    await show('visible');
    // An unsaved change (the path field saves after a pause), then pagehide alone: only the journal.
    await setPath(page, 'docs/OTHER.md');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(await tx(), 0, 'pagehide only journals');
    assert.equal(await journals(page), 1);
    await show('hidden');
    await until(async () => (await tx()) > 0, { message: 'the hidden page saved' });
    await until(async () => (await journals(page)) === 0, { message: 'the journal cleared once saved' });
    await show('visible');
  }));

  test('a tab closed right after a change hands it to the other tab', () => withApp({}, async ({ ctx, page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    const b = await ctx.newPage();
    await b.goto(appUrl);
    await b.evaluate(() => window.markdownAnnotator.ready);
    await until(() => b.evaluate(() => window.__markdownAnnotator.state.path === 'docs/PLAN.md'), { message: 'the second tab shows it' });
    await setPath(page, 'docs/MOVED.md');
    await page.close({ runBeforeUnload: true });
    await until(() => b.evaluate(() => window.__markdownAnnotator.state.path === 'docs/MOVED.md'), { message: 'the change reached the other tab' });
    await until(async () => (await journals(b)) === 0, { message: 'no journal left behind' });
  }));
});

describe('more on several tabs', () => {
  const countWrites = (page) => page.evaluate(() => {
    window.__writes = 0;
    const orig = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names, mode) {
      if (mode === 'readwrite' && [].concat(names).includes('docs')) window.__writes++;
      return orig.call(this, names, mode);
    };
  });
  const hide = (page) => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });

  test('a journal another tab could merge only into memory is kept for a start that has IndexedDB', () => withApp({}, async ({ ctx, page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    const key = await page.evaluate(() => window.__markdownAnnotator.state.doc.key);
    const b = await ctx.newPage();
    await b.goto(appUrl);
    await b.evaluate(() => window.markdownAnnotator.ready);
    await until(() => b.evaluate((k) => window.__markdownAnnotator.state.doc && window.__markdownAnnotator.state.doc.key === k, key), { message: 'same document' });
    await b.evaluate(() => { IDBDatabase.prototype.transaction = function () { throw new DOMException('gone', 'UnknownError'); }; });
    const jk = `markdown-annotator.v1.journal.gone.${key}`;
    await page.evaluate(({ k, j }) => localStorage.setItem(j, JSON.stringify({
      key: k, at: Date.now(), seq: 1, comments: [], deleted: {}, general: 'From the journal.', generalAt: Date.now(), generalSent: false, generalSentAt: 0, path: '', pathAt: 0,
    })), { k: key, j: jk });
    await sleep(800);
    assert.ok(await page.evaluate((j) => localStorage.getItem(j) !== null, jk), 'the journal is still there');
  }));

  test('a tab whose storage fails partway keeps journaling, so closing it loses nothing', () => withApp({}, async ({ page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'Saved.' }));
    await sleep(300);
    await page.evaluate(() => { IDBDatabase.prototype.transaction = function () { throw new DOMException('gone', 'UnknownError'); }; });
    await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'Status survives', comment: 'Only in memory.' }));
    await sleep(300);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const j = await page.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.includes('.journal.')); return k && JSON.parse(localStorage.getItem(k)); });
    assert.ok(j && j.comments.some((c) => c.body === 'Only in memory.'), 'the journal holds the comment');
  }));

  test('rapid changes coalesce into a few saves, and every one of them lands', () => withApp({}, async ({ page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    const key = await page.evaluate(() => window.__markdownAnnotator.state.doc.key);
    await sleep(400);
    await countWrites(page);
    await page.evaluate(() => { for (let i = 0; i < 40; i++) window.markdownAnnotator.addComment({ quote: 'be conservative', comment: `n${i}` }); });
    await until(async () => (await idbRecord(page, key)).comments.length === 40, { message: 'all 40 saved' });
    const writes = await page.evaluate(() => window.__writes);
    assert.ok(writes <= 5, `40 changes, ${writes} saves`);
  }));

  test('a tab that only took in another tab\'s changes writes nothing when it hides', () => withApp({}, async ({ ctx, page }) => {
    await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
    const b = await ctx.newPage();
    await b.goto(appUrl);
    await b.evaluate(() => window.markdownAnnotator.ready);
    await until(() => b.evaluate(() => window.__markdownAnnotator.state.path === 'docs/PLAN.md'), { message: 'same document' });
    await page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'From A.' }));
    await until(async () => (await comments(b)).length === 1, { message: 'B took it in' });
    await sleep(300);
    await countWrites(b);
    await hide(b);
    await b.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await sleep(300);
    assert.equal(await b.evaluate(() => window.__writes), 0, 'no save');
    assert.equal(await b.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('.journal.')).length), 0, 'no journal');
  }));

  test('a journal left by a closing tab reaches the other tab at once', async () => {
    // A well-formed comment, made in a separate context so it never reaches this one by a save.
    const other = await openApp(browser);
    let made;
    try {
      await other.page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
      await other.page.evaluate(() => window.markdownAnnotator.addComment({ quote: 'be conservative', comment: 'From the journal.' }));
      made = await other.page.evaluate(() => window.__markdownAnnotator.state.comments.map((c) => ({ ...c, range: undefined }))[0]);
    } finally { await other.ctx.close(); }
    await withApp({}, async ({ ctx, page }) => {
      await page.evaluate((t) => window.markdownAnnotator.open({ text: t, path: 'docs/PLAN.md' }), PLAN);
      const key = await page.evaluate(() => window.__markdownAnnotator.state.doc.key);
      const b = await ctx.newPage();
      await b.goto(appUrl);
      await b.evaluate(() => window.markdownAnnotator.ready);
      await until(() => b.evaluate((k) => window.__markdownAnnotator.state.doc && window.__markdownAnnotator.state.doc.key === k, key), { message: 'same document' });
      // What a closing tab leaves when its last save didn't finish.
      await page.evaluate(({ k, c }) => localStorage.setItem(`markdown-annotator.v1.journal.gone.${k}`, JSON.stringify({
        key: k, at: Date.now(), seq: 1, comments: [c], deleted: {}, general: '', generalAt: 0, generalSent: false, generalSentAt: 0, path: '', pathAt: 0,
      })), { k: key, c: made });
      await until(async () => (await comments(b)).some((c) => c.body === 'From the journal.'), { message: 'merged into the other tab' });
      await until(() => b.evaluate(() => !Object.keys(localStorage).some((k) => k.includes('.journal.'))), { message: 'journal removed once merged' });
      assert.equal((await idbRecord(b, key)).comments.length, 1, 'and saved');
    });
  });

  test('the Chrome versions that can\'t read a file handle back are recognised', () => withApp({}, async ({ page }) => {
    const check = (v) => page.evaluate(async (ver) => {
      Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => ({ getHighEntropyValues: async () => ({ fullVersionList: [{ brand: 'Chromium', version: ver }] }) }) });
      await window.__markdownAnnotator.checkHandleReads();
      return window.__markdownAnnotator.handleReadsSafe;
    }, v);
    const cases = {
      '152.0.7977.0': true, '153.0.8010.53': false, '154.0.8037.57': false, '154.0.8037.95': true,
      '155.0.8050.0': false, '155.0.8059.11': false, '155.0.8059.12': true, '156.0.8100.0': true,
    };
    for (const [v, safe] of Object.entries(cases)) assert.equal(await check(v), safe, v);
    // Without the full version, only the major number: 154 counts as unsafe.
    const reduced = await page.evaluate(async () => {
      Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => undefined });
      Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36' });
      await window.__markdownAnnotator.checkHandleReads();
      return window.__markdownAnnotator.handleReadsSafe;
    });
    assert.equal(reduced, false);
    const reduced155 = await page.evaluate(async () => {
      Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36' });
      await window.__markdownAnnotator.checkHandleReads();
      return window.__markdownAnnotator.handleReadsSafe;
    });
    assert.equal(reduced155, true, 'a 155 stable build');
  }));
});
