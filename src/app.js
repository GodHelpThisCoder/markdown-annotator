(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Platform and small helpers
  // ---------------------------------------------------------------------------
  const PLATFORM = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
  const IS_MAC = /mac|iphone|ipad/i.test(PLATFORM);
  const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';
  const SHIFT_MOD_LABEL = IS_MAC ? '⇧⌘' : 'Ctrl+Shift+';
  const TAB_ID = Math.random().toString(36).slice(2);

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  // Mod is ⌘ on macOS and Ctrl elsewhere.
  const isMod = (e) => (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const now = () => Date.now();
  const uid = () => now().toString(36) + Math.random().toString(36).slice(2, 8);
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const cssId = (id) => (window.CSS && CSS.escape ? CSS.escape(id) : id);

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
    return node;
  }
  // replaceChildren() stringifies null; drop empty slots first.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

  function debounce(fn, ms) {
    let t = 0;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    d.flush = (...args) => { clearTimeout(t); return fn(...args); };
    d.cancel = () => clearTimeout(t);
    return d;
  }

  function hash(str) {
    let x = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193); }
    return (x >>> 0).toString(36);
  }

  const isEditable = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  const isVisible = (el) => !!(el && el.isConnected && el.getClientRects().length);

  // Letter of a key press, layout-independent for non-Latin keyboards.
  function keyName(e) {
    const k = e.key || '';
    if (k.length === 1) {
      const l = k.toLowerCase();
      if (l >= 'a' && l <= 'z') return l;
      if (k === '?') return '?';
    }
    if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
    return k;
  }
  const SCROLL_KEYS = new Set(['PageDown', 'PageUp', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End']);

  function ago(ts) {
    if (!ts) return '';
    const s = Math.round((now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  const normalizeSource = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  const lsGet = (k, fallback) => { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const ssSet = (k, v) => { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* unavailable */ } };

  // ---------------------------------------------------------------------------
  // Settings (localStorage; every file:// page shares one origin, so keys are namespaced)
  // ---------------------------------------------------------------------------
  const NS = 'markdown-annotator.v1';
  // The showcase document (samples/showcase.md), inlined by build.mjs.
  const SAMPLE = '__SAMPLE_MD__';
  // The package version, filled in by build.mjs.
  const VERSION = '__VERSION__';
  // Left as this default (or an earlier default), the header is written for each review: see autoHeader().
  const DEFAULT_HEADER =
    'Review of {file}: {count}. For each comment: if it clearly asks for a change, edit the file; if it is a question, an opinion or unclear, answer in chat without editing. Quotes are rendered text with the Markdown syntax removed, so match them loosely. {lines} End with one line per comment saying what you did.';
  const OLD_DEFAULT_HEADERS = [
    'Review of {file}: {count}. For each comment: if it clearly asks for a change, edit {file}; if it is a question, an opinion or unclear, answer in chat and leave that part unedited. Quotes are rendered text with the Markdown syntax removed, so match them loosely. {lines} End with one line per comment saying what you did.',
  ];
  const isDefaultHeader = (s) => { const t = String(s || '').trim(); return t === DEFAULT_HEADER || OLD_DEFAULT_HEADERS.includes(t); };
  const settings = { header: DEFAULT_HEADER, theme: 'system', size: 'm', width: 'normal', wrap: true, notes: true, scrollHints: true, previewOpen: false };
  {
    const saved = lsGet(`${NS}.settings`, null);
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(settings)) if (typeof saved[k] === typeof settings[k]) settings[k] = saved[k];
    }
  }
  function applySettings() {
    requestAnimationFrame(() => markAllOverflow());
    const r = document.documentElement;
    r.dataset.theme = ['system', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
    const light = r.dataset.theme === 'light' || (r.dataset.theme === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = light ? '#ffffff' : '#0e1013';
    r.dataset.size = ['s', 'm', 'l'].includes(settings.size) ? settings.size : 'm';
    r.dataset.width = ['narrow', 'normal', 'wide'].includes(settings.width) ? settings.width : 'normal';
    r.dataset.wrap = settings.wrap ? '1' : '0';
    r.dataset.notes = settings.notes ? '1' : '0';
    r.dataset.scrollHints = settings.scrollHints ? '1' : '0';
  }
  const saveSettings = () => lsSet(`${NS}.settings`, settings);

  // ---------------------------------------------------------------------------
  // Markdown: markdown-it with source-line attributes on every rendered block
  // ---------------------------------------------------------------------------
  const md = window.markdownit({ html: false, linkify: true, typographer: false, breaks: false });
  // Without a scheme, linkify would turn README.md, main.py or setup.sh into links (they are ccTLDs).
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  const esc = md.utils.escapeHtml;
  const HEADING_PREFIX = 'h-';
  const slugify = (text) => text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const countNl = (s) => { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; };

  // YAML front matter on line 1 would otherwise render as an <hr> plus a setext heading. Only a block
  // whose every line looks like YAML counts, so a document that opens with a '---' rule renders normally.
  md.block.ruler.before('table', 'front_matter', (state, startLine, endLine, silent) => {
    if (startLine !== 0 || state.tShift[0] !== 0 || (state.parentType && state.parentType !== 'root')) return false;
    const lineText = (l) => state.src.slice(state.bMarks[l], state.eMarks[l]);
    if (lineText(0).trimEnd() !== '---') return false;
    let end = 1;
    for (; end < endLine; end++) {
      const t = lineText(end).trimEnd();
      if (t === '---' || t === '...') break;
    }
    if (end >= endLine) return false;
    let keys = 0;
    for (let l = 1; l < end; l++) {
      const t = lineText(l);
      if (!t.trim()) continue;
      if (/^[\w"'.-][\w"'. /-]*:(\s|$)/.test(t)) { keys++; continue; }
      if (/^\s+\S/.test(t) || /^-\s/.test(t) || /^#(\s|$)/.test(t)) continue;
      return false;
    }
    if (end > 1 && !keys) return false;
    if (silent) return true;
    const token = state.push('front_matter', 'pre', 0);
    token.block = true;
    token.map = [0, end + 1];
    token.content = end > 1 ? state.getLines(1, end, 0, true) : '';
    state.line = end + 1;
    return true;
  });
  md.renderer.rules.front_matter = (tokens, idx) => {
    const t = tokens[idx];
    return `<pre class="frontmatter nowrap" data-ls="1" data-le="${t.map[1]}" data-cl="2" data-ce="${t.map[1] - 1}"><code>${esc(t.content)}</code></pre>\n`;
  };

  // Generated Markdown often has a<br>b inside table cells. With raw HTML off, allow just this one tag.
  md.inline.ruler.before('html_inline', 'cr_br', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3c) return false;
    const m = /^<br\s*\/?>/i.exec(state.src.slice(state.pos, state.pos + 8));
    if (!m) return false;
    if (!silent) state.push('cr_br', 'br', 0);
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.cr_br = () => '<br>';

  // Source newlines that disappear from the rendered text (inside a code span, an image, or a link
  // destination) are recorded as data-nl, so line numbers after them stay exact.
  function wrapInline(name, before, after) {
    const ruler = md.inline.ruler;
    const orig = ruler.__rules__[ruler.__find__(name)].fn;
    ruler.at(name, (state, silent) => {
      const start = state.pos;
      const n = state.tokens.length;
      const pre = before ? before(state) : null;
      const ok = orig(state, silent);
      if (ok && !silent) after(state, start, n, pre);
      return ok;
    });
  }
  wrapInline('backticks', null, (state, start) => {
    const t = state.tokens[state.tokens.length - 1];
    if (!t || t.type !== 'code_inline') return;
    // markdown-it turns each newline in a code span into a space, then may strip one space at each end.
    // Keep where the newlines were, so a point inside the span gets its exact source line.
    const raw = state.src.slice(start + t.markup.length, state.pos - t.markup.length);
    const at = [];
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) at.push(i);
    if (!at.length) return;
    const shift = /^ (.+) $/.test(raw.replace(/\n/g, ' ')) ? 1 : 0;
    t.attrSet('data-nl', String(at.length));
    t.attrSet('data-nlpos', at.map((i) => i - shift).join(','));
  });
  // Text before the link or image is flushed as a token first, so look for the rule's own token.
  const firstOfType = (state, n, type) => { for (let i = n; i < state.tokens.length; i++) if (state.tokens[i].type === type) return state.tokens[i]; return null; };
  wrapInline('image', null, (state, start, n) => {
    const t = firstOfType(state, n, 'image');
    const nl = countNl(state.src.slice(start, state.pos));
    if (nl && t) t.attrSet('data-nl', String(nl));
  });
  wrapInline('link', (state) => (state.src.charCodeAt(state.pos) === 0x5b ? md.helpers.parseLinkLabel(state, state.pos, true) : -1), (state, start, n, labelEnd) => {
    const t = firstOfType(state, n, 'link_open');
    if (labelEnd < 0 || !t) return;
    const nl = countNl(state.src.slice(labelEnd, state.pos));
    if (nl) t.attrSet('data-nl', String(nl));
  });

  // Task list items: "- [ ] x" and "- [x] x".
  md.core.ruler.after('inline', 'cr_tasks', (state) => {
    const toks = state.tokens;
    for (let i = 2; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'inline' || toks[i - 1].type !== 'paragraph_open' || toks[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX])\][ \t]+/.exec(t.content);
      const first = t.children && t.children[0];
      if (!m || !first || first.type !== 'text' || !first.content.startsWith(m[0])) continue;
      first.content = first.content.slice(m[0].length);
      const done = m[1] !== ' ';
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" disabled${done ? ' checked' : ''} aria-label="${done ? 'Done' : 'Not done'}">`;
      t.children.unshift(box);
      toks[i - 2].attrJoin('class', 'task');
    }
  });

  // Line attributes (1-based, inclusive), visible tight-list paragraphs, unique GitHub-style heading ids.
  md.core.ruler.push('cr_lines', (state) => {
    const used = new Set();
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'paragraph_open' && t.hidden) {
        // Give list-item text its own element so line numbers come from the item's text, not its sub-lists.
        t.hidden = false;
        toks[i + 2].hidden = false;
        t.attrJoin('class', 'tight');
      }
      if (t.map && t.nesting >= 0 && t.type !== 'inline') {
        t.attrSet('data-ls', String(t.map[0] + 1));
        t.attrSet('data-le', String(Math.max(t.map[0] + 1, t.map[1])));
      }
      if (t.type === 'heading_open') {
        const inline = toks[i + 1];
        const text = (inline.children || []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
        const base = slugify(text) || 'section';
        let slug = base;
        for (let k = 1; used.has(slug); k++) slug = `${base}-${k}`;
        used.add(slug);
        t.attrSet('id', HEADING_PREFIX + slug);
      }
    }
  });

  // Box-drawing diagrams and directory trees are unreadable when wrapped.
  const isDiagram = (s) => /[─-╿]/.test(s) || /^\s*(├|└|│|\+--|\|--|`--)/m.test(s);
  function renderCode(t, env, contentFirstLine) {
    const info = t.info ? md.utils.unescapeAll(t.info).trim() : '';
    const lang = info.split(/\s+/)[0] || '';
    const cls = lang ? ` class="language-${esc(lang)}"` : '';
    const nowrap = isDiagram(t.content) ? ' class="nowrap"' : '';
    // The last content line: a closed fence ends one line before its closing marker.
    let last = t.map[1];
    if (t.type === 'fence' && env && env.lines) {
      const closing = (env.lines[t.map[1] - 1] || '').trim();
      if (t.map[1] - 1 > t.map[0] && closing.startsWith(t.markup) && /^[`~]+$/.test(closing)) last = t.map[1] - 1;
    }
    return `<pre${nowrap} data-ls="${t.map[0] + 1}" data-le="${Math.max(t.map[0] + 1, t.map[1])}" data-cl="${contentFirstLine}" data-ce="${last}"><code${cls}>${esc(t.content)}</code></pre>\n`;
  }
  md.renderer.rules.fence = (tokens, idx, opts, env) => renderCode(tokens[idx], env, tokens[idx].map[0] + 2);
  md.renderer.rules.code_block = (tokens, idx, opts, env) => renderCode(tokens[idx], env, tokens[idx].map[0] + 1);
  // The column count sets a minimum table width in narrow windows (CSS), where the table then scrolls sideways.
  md.renderer.rules.table_open = (tokens, idx, opts, env, slf) => {
    let cols = 0;
    for (let i = idx + 1; i < tokens.length && tokens[i].type !== 'tr_close'; i++) if (tokens[i].type === 'th_open' || tokens[i].type === 'td_open') cols++;
    tokens[idx].attrSet('style', `--cols:${cols}`);
    return '<div class="table-wrap">' + slf.renderToken(tokens, idx, opts);
  };
  md.renderer.rules.table_close = (tokens, idx, opts, env, slf) => slf.renderToken(tokens, idx, opts) + '</div>\n';
  // Short cells ("good for prose") stay on one line in narrow windows (CSS); the table scrolls instead.
  const cellOpen = (tokens, idx, opts, env, slf) => {
    const inline = tokens[idx + 1];
    if (inline && inline.type === 'inline' && inline.content.length <= 18) tokens[idx].attrJoin('class', 'short');
    return slf.renderToken(tokens, idx, opts);
  };
  md.renderer.rules.th_open = cellOpen;
  md.renderer.rules.td_open = cellOpen;
  md.renderer.rules.link_open = (tokens, idx, opts, env, slf) => {
    const t = tokens[idx];
    const href = t.attrGet('href') || '';
    if (href.startsWith('#')) {
      let frag = href.slice(1);
      try { frag = decodeURIComponent(frag); } catch { /* keep as is */ }
      t.attrSet('href', '#' + HEADING_PREFIX + (slugify(frag) || frag));
    } else {
      t.attrSet('target', '_blank');
      t.attrSet('rel', 'noopener noreferrer');
    }
    return slf.renderToken(tokens, idx, opts);
  };
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, slf) => {
    const t = tokens[idx];
    t.attrSet('loading', 'lazy');
    t.attrSet('decoding', 'async');
    t.attrSet('referrerpolicy', 'no-referrer');
    return defaultImage(tokens, idx, opts, env, slf);
  };
  const renderMd = (text) => md.render(text, { lines: text.split('\n') });

  // ---------------------------------------------------------------------------
  // Storage: IndexedDB (text, comments, file handle), falling back to memory
  // ---------------------------------------------------------------------------
  let onStorageLost = () => {};
  const store = (() => {
    let dbp = null;
    const mem = { docs: new Map(), meta: new Map() };
    let memOnly = typeof indexedDB === 'undefined';
    function open() {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          let req;
          try { req = indexedDB.open(NS, 1); } catch (e) { reject(e); return; }
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'key' });
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
          };
          req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
          req.onerror = () => reject(req.error);
        });
      }
      return dbp;
    }
    async function run(name, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(name, mode);
        let out;
        const req = fn(tx.objectStore(name));
        if (req) req.onsuccess = () => { out = req.result; };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    // Read, transform and write one record inside a single transaction, so two tabs cannot interleave.
    async function update(key, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('docs', 'readwrite');
        const s = tx.objectStore('docs');
        let out = null;
        let failure = null;
        const get = s.get(key);
        get.onsuccess = () => {
          try {
            out = fn(get.result || null);
            if (out) s.put(out);
          } catch (e) { failure = e; tx.abort(); }
        };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(failure || tx.error);
        tx.onabort = () => reject(failure || tx.error || new Error('aborted'));
      });
    }
    async function delIf(key, ok) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('docs', 'readwrite');
        const s = tx.objectStore('docs');
        const get = s.get(key);
        get.onsuccess = () => { if (get.result && ok(get.result)) s.delete(key); };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    async function attempt(dbFn, memFn) {
      if (memOnly) return memFn();
      try { return await dbFn(); } catch (e) {
        if (e && e.name === 'DataCloneError') throw e;
        console.warn('[markdown-annotator] IndexedDB unavailable; keeping data in memory for this tab', e);
        memOnly = true;
        onStorageLost();
        return memFn();
      }
    }
    return {
      get: (key) => attempt(() => run('docs', 'readonly', (s) => s.get(key)), () => mem.docs.get(key)),
      put: (rec) => { mem.docs.set(rec.key, rec); return attempt(() => run('docs', 'readwrite', (s) => s.put(rec)), () => null); },
      update: (key, fn) => attempt(() => update(key, fn), () => { const out = fn(mem.docs.get(key) || null); if (out) mem.docs.set(key, out); return out; }),
      del: (key) => { mem.docs.delete(key); return attempt(() => run('docs', 'readwrite', (s) => s.delete(key)), () => null); },
      delIf: (key, ok) => { const m = mem.docs.get(key); if (m && ok(m)) mem.docs.delete(key); return attempt(() => delIf(key, ok), () => null); },
      all: () => attempt(() => run('docs', 'readonly', (s) => s.getAll()).then((r) => r || []), () => [...mem.docs.values()]),
      getMeta: (k) => attempt(() => run('meta', 'readonly', (s) => s.get(k)).then((r) => r && r.v), () => mem.meta.get(k)),
      setMeta: (k, v) => { mem.meta.set(k, v); return attempt(() => run('meta', 'readwrite', (s) => s.put({ k, v })), () => null); },
      clear: () => { mem.docs.clear(); return attempt(() => run('docs', 'readwrite', (s) => s.clear()), () => null); },
    };
  })();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(NS) : null;
  const KEEP_RECORDS = 30;
  const KEEP_COPIES = 5;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    doc: null, // { key, name, source: 'file'|'paste', text, handle, lastModified, size }
    comments: [], // persisted fields + runtime: range, detached, fuzzy, num
    deleted: {}, // id -> deletion time (tombstones, so a delete survives a merge with another tab)
    general: '',
    generalAt: 0,
    generalSent: false,
    path: '',
    pathAt: 0,
    lastBatch: null, // { ids: [], general: bool }
    loadedAt: 0, // when the text was last read from disk (or pasted)
    lastRead: 0, // last successful read of the watched file
    liveMode: 'none',
    pendingText: null, // a disk update held back while the user is mid-action
    pendingAt: 0,
    index: null,
    heads: [],
    changes: [],
    baseSeq: null, // leaf signatures at the start of the current round, for change marks
    detachedOpen: false,
    syncPending: false,
  };
  const PERSISTED = ['id', 'body', 'exact', 'prefix', 'suffix', 'start', 'end', 'docLen', 'quote', 'lineStart', 'lineEnd', 'sent', 'sentAt', 'sentNum', 'archived', 'moved', 'created', 'updated'];
  const active = () => state.comments.filter((c) => !c.archived);
  const touch = (c) => { c.updated = Math.max(now(), (c.updated || 0) + 1); };
  // A deletion must not be older than the comment's last edit, which touch() can stamp a millisecond ahead.
  const tombstone = (c) => Math.max(now(), c.updated || 0);

  const dom = {
    bar: $('#bar'), crumb: $('#crumb'), main: $('#main'), empty: $('#empty'), doc: $('#doc'), docEnd: $('#doc-end'), detached: $('#detached'),
    crumbFile: $('#crumb-file'), crumbSec: $('#crumb-sec'), live: $('#live'), reconnect: $('#btn-reconnect'), pending: $('#btn-pending'),
    chip: $('#btn-review'), chipCount: $('#chip-count'), copy: $('#btn-copy'), copyLabel: $('#copy-label'),
    menuBtn: $('#btn-menu'), menu: $('#menu'), pill: $('#pill'),
    composer: $('#composer'), cmpTitle: $('#cmp-title'), cmpFlag: $('#cmp-flag'), cmpQuote: $('#cmp-quote'), cmpText: $('#cmp-text'),
    cmpDelete: $('#cmp-delete'), cmpSave: $('#cmp-save'), cmpCancel: $('#cmp-cancel'),
    outline: $('#outline'), outlineList: $('#outline-list'), outlineBtn: $('#btn-outline'),
    review: $('#review'), reviewList: $('#review-list'), general: $('#general'), path: $('#path'),
    previewBox: $('#preview-box'), preview: $('#preview'), copy2: $('#btn-copy-2'), footSummary: $('#foot-summary'),
    scrim: $('#scrim'), settings: $('#settings'), help: $('#help'), dropzone: $('#dropzone'), toasts: $('#toasts'),
    fileInput: $('#file-input'), drop: $('#drop'), recent: $('#recent'), recentList: $('#recent-list'), fine: $('#fine'), forgetAll: $('#forget-all'),
  };
  const docEl = dom.doc;

  // ---------------------------------------------------------------------------
  // Persistence: every save merges with what is stored, so tabs never overwrite each other
  // ---------------------------------------------------------------------------
  const persistedComment = (c) => Object.fromEntries(PERSISTED.map((k) => [k, c[k]]));
  // A copy from a web link becomes an ordinary saved review once it holds comments or a general note,
  // whatever its stored flag says (a record saved by an older version may still carry it).
  const reviewed = () => state.comments.length > 0 || !!state.general.trim();
  const provisional = (r) => !!(r && r.copy) && !(r.comments || []).length && !(r.general || '').trim();
  function serialize() {
    const d = state.doc;
    if (d.copy && reviewed()) d.copy = false;
    return {
      key: d.key,
      name: d.name,
      source: d.source,
      text: d.text,
      handle: d.handle || null,
      lastModified: d.lastModified || 0,
      size: d.size || 0,
      loadedAt: state.loadedAt,
      path: state.path,
      pathAt: state.pathAt,
      copy: !!d.copy,
      comments: state.comments.map(persistedComment),
      deleted: state.deleted,
      general: state.general,
      generalAt: state.generalAt,
      generalSent: state.generalSent,
      generalSentAt: state.generalSentAt || 0,
      lastBatch: state.lastBatch,
      updatedAt: now(),
    };
  }

  function mergeRecords(local, stored) {
    if (!stored) return local;
    const deleted = { ...(stored.deleted || {}) };
    for (const [id, t] of Object.entries(local.deleted || {})) deleted[id] = Math.max(t, deleted[id] || 0);
    const cutoff = now() - 30 * 86400000;
    for (const id of Object.keys(deleted)) if (deleted[id] < cutoff) delete deleted[id];
    const map = new Map();
    for (const c of stored.comments || []) map.set(c.id, c);
    for (const c of local.comments || []) {
      const o = map.get(c.id);
      if (!o || (c.updated || 0) >= (o.updated || 0)) map.set(c.id, c);
    }
    const comments = [...map.values()].filter((c) => !(deleted[c.id] >= (c.updated || 0)));
    const g = (local.generalAt || 0) >= (stored.generalAt || 0) ? local : stored;
    const p = (local.pathAt || 0) >= (stored.pathAt || 0) ? local : stored;
    const t = (local.loadedAt || 0) >= (stored.loadedAt || 0) ? local : stored;
    return {
      ...local,
      handle: local.handle || stored.handle || null,
      text: t.text, loadedAt: t.loadedAt || 0, lastModified: t.lastModified || 0, size: t.size || 0,
      comments, deleted,
      general: g.general || '', generalAt: g.generalAt || 0, generalSent: !!g.generalSent, generalSentAt: g.generalSentAt || 0,
      path: p.path || '', pathAt: p.pathAt || 0,
      copy: !!(local.copy && stored.copy) && !comments.length && !(g.general || '').trim(),
    };
  }

  // Take what another tab (or an earlier save) knows into this tab's state.
  function adoptMerged(m) {
    if (!m || !state.doc || m.key !== state.doc.key) return;
    let changed = false;
    const deleted = { ...(m.deleted || {}) };
    for (const [id, t] of Object.entries(state.deleted)) deleted[id] = Math.max(t, deleted[id] || 0);
    const local = new Map(state.comments.map((c) => [c.id, c]));
    const incoming = new Set();
    const next = [];
    for (const c of m.comments) {
      incoming.add(c.id);
      const l = local.get(c.id);
      if (l && (l.updated || 0) >= (c.updated || 0)) next.push(l);
      else { const copy = { ...c }; if (state.index) anchor(copy); next.push(copy); changed = true; }
    }
    // A local comment the merge has not seen yet (a save still in flight) stays unless it was deleted.
    for (const c of state.comments) if (!incoming.has(c.id) && !(deleted[c.id] >= (c.updated || 0))) next.push(c);
    if (next.length !== state.comments.length) changed = true;
    state.comments = next;
    state.deleted = deleted;
    if ((m.generalAt || 0) > state.generalAt) {
      state.general = m.general; state.generalAt = m.generalAt; state.generalSent = m.generalSent; state.generalSentAt = m.generalSentAt || 0;
      if (document.activeElement !== dom.general) dom.general.value = state.general;
      changed = true;
    }
    if ((m.pathAt || 0) > state.pathAt) {
      state.path = m.path; state.pathAt = m.pathAt;
      if (document.activeElement !== dom.path) dom.path.value = state.path;
      changed = true;
    }
    if (changed) paint();
    // Newer text that another tab read from disk goes through the normal update path, so it is held
    // while this tab is mid-action and archives and marks changes like any other update.
    if (m.text !== state.doc.text && m.text !== state.pendingText && (m.loadedAt || 0) > state.loadedAt) {
      // The other tab took the change in at m.loadedAt; anything sent after that stays current here too.
      applyUpdate(m.text, m.loadedAt || now(), { lastModified: m.lastModified || 0, size: m.size || 0 });
    }
  }

  let saving = Promise.resolve();
  let closing = false;
  function saveNow() {
    if (!state.doc) return saving;
    const doc = state.doc;
    const local = serialize();
    saving = saving.then(async () => {
      let merged = null;
      try {
        merged = await store.update(local.key, (stored) => mergeRecords(local, stored));
      } catch {
        local.handle = null; // a handle that cannot be stored must not cost the comments
        try { merged = await store.update(local.key, (stored) => mergeRecords(local, stored)); } catch { /* memory copy kept */ }
      }
      if (merged && state.doc === doc) adoptMerged(merged);
      if (state.doc && state.doc.key === local.key && !closing) {
        store.setMeta('last', local.key);
        ssSet(`${NS}.tab`, local.key);
      }
      if (channel) channel.postMessage({ type: 'saved', key: local.key, tab: TAB_ID });
    }).catch((e) => console.warn('[markdown-annotator] save failed', e));
    return saving;
  }
  const saveSoon = debounce(saveNow, 300);
  const scrollKey = (key) => `${NS}.scroll.${key}`;
  const saveScroll = debounce(() => { if (state.doc && !docEl.hidden) lsSet(scrollKey(state.doc.key), captureScroll()); }, 400);
  // An IndexedDB write started during unload may never commit; a synchronous journal covers that gap.
  function writeJournal() {
    if (!state.doc) return;
    lsSet(`${NS}.journal.${state.doc.key}`, {
      key: state.doc.key, at: now(), comments: state.comments.map(persistedComment), deleted: state.deleted,
      general: state.general, generalAt: state.generalAt, generalSent: state.generalSent, generalSentAt: state.generalSentAt || 0,
      path: state.path, pathAt: state.pathAt,
    });
  }
  async function replayJournals() {
    let keys = [];
    try { keys = Object.keys(localStorage).filter((k) => k.startsWith(`${NS}.journal.`)); } catch { return; }
    for (const k of keys) {
      const j = lsGet(k, null);
      lsSet(k, null);
      if (!j || !j.key || !Array.isArray(j.comments)) continue;
      try {
        await store.update(j.key, (stored) => (stored ? mergeRecords({ ...stored, ...j, text: stored.text, loadedAt: stored.loadedAt, lastModified: stored.lastModified, size: stored.size, handle: stored.handle }, stored) : null));
      } catch { /* ignore */ }
    }
  }
  function flushAll() { writeJournal(); saveSoon.cancel(); saveNow(); saveScroll.flush(); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
  window.addEventListener('pagehide', flushAll);

  async function syncFromStore() {
    if (!state.doc) return;
    if (!dom.composer.hidden) { state.syncPending = true; return; }
    state.syncPending = false;
    const rec = await store.get(state.doc.key);
    if (rec && state.doc && rec.key === state.doc.key) adoptMerged(mergeRecords(serialize(), rec));
  }
  if (channel) {
    channel.onmessage = ({ data }) => {
      if (!data || data.tab === TAB_ID) return;
      if (!state.doc) { if (!dom.empty.hidden) showEmpty(); return; }
      if (data.key === state.doc.key) syncFromStore();
    };
  }

  // ---------------------------------------------------------------------------
  // Text index: concatenated text nodes of the rendered document, minus UI
  // ---------------------------------------------------------------------------
  const isWs = (code) => code === 32 || code === 10 || code === 9 || code === 13 || code === 12 || code === 11 || code === 160;
  // Collapse whitespace runs to one space and drop leading space (for exact text).
  function normalizeWs(s) {
    let out = '';
    let space = false;
    for (let i = 0; i < s.length; i++) {
      if (isWs(s.charCodeAt(i))) space = true;
      else { if (space && out) out += ' '; space = false; out += s[i]; }
    }
    if (space && out) out += ' ';
    return out;
  }
  // Collapse whitespace runs but keep a leading or trailing space (for prefix and suffix context).
  const normalizeCtx = (s) => s.replace(/[\s ]+/g, ' ');

  function buildIndex() {
    const nodes = [];
    const starts = [];
    const pos = new WeakMap();
    const parts = [];
    let len = 0;
    // Text offsets of every <br>, which leaves no character in the text (see findQuote).
    const breaks = new Set();
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if (n.nodeName === 'BR' && !n.closest('[data-ui]')) breaks.add(len);
        continue;
      }
      if (n.parentElement.closest('[data-ui]')) continue;
      pos.set(n, nodes.length);
      nodes.push(n);
      starts.push(len);
      parts.push(n.data);
      len += n.data.length;
    }
    const text = parts.join('');
    // Whitespace-collapsed view, so anchors survive reflowed paragraphs and tight/loose list changes.
    const normChars = [];
    const map = new Int32Array(text.length + 1);
    let n = 0;
    let space = false;
    for (let i = 0; i < text.length; i++) {
      if (isWs(text.charCodeAt(i))) { space = true; continue; }
      if (space && n) { normChars.push(' '); map[n++] = i - 1; }
      space = false;
      normChars.push(text[i]);
      map[n++] = i;
    }
    map[n] = text.length;
    state.index = { text, nodes, starts, pos, norm: normChars.join(''), map, breaks };
  }

  // DOM point to offset in index.text. Points outside indexed text snap to the next indexed character.
  function pointToOffset(node, offset) {
    const ix = state.index;
    if (node.nodeType === 3) {
      const i = ix.pos.get(node);
      if (i !== undefined) return ix.starts[i] + Math.min(offset, node.data.length);
    }
    const r = document.createRange();
    try { r.setStart(node, offset); } catch { return null; }
    r.collapse(true);
    let lo = 0;
    let hi = ix.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r.comparePoint(ix.nodes[mid], 0) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo < ix.nodes.length ? ix.starts[lo] : ix.text.length;
  }
  const endOffsetOf = (el) => pointToOffset(el.parentNode, Array.prototype.indexOf.call(el.parentNode.childNodes, el) + 1);

  // Offset to [textNode, offsetInNode]. End points prefer the end of the previous node.
  function offsetToPoint(o, isEnd) {
    const { nodes, starts } = state.index;
    if (!nodes.length) return [docEl, 0];
    let lo = 0;
    let hi = nodes.length - 1;
    let i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= o) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (isEnd) while (i > 0 && starts[i] === o) i--;
    return [nodes[i], clamp(o - starts[i], 0, nodes[i].data.length)];
  }

  function makeRange(s, e) {
    const r = document.createRange();
    r.setStart(...offsetToPoint(s, false));
    r.setEnd(...offsetToPoint(e, true));
    return r;
  }

  const hostOf = (o) => {
    const [node] = offsetToPoint(clamp(o, 0, Math.max(0, state.index.text.length - 1)), false);
    return node.nodeType === 3 ? node.parentElement : node;
  };
  const LEAF_SEL = 'p, h1, h2, h3, h4, h5, h6, pre, tr, dt, dd';
  const leafAt = (o) => hostOf(o).closest(LEAF_SEL + ', li');

  // Source line (1-based) of the character at offset o.
  function lineOf(o) {
    const ix = state.index;
    const host = hostOf(o);
    const blk = host && host.closest('[data-ls]');
    if (!blk || !docEl.contains(blk)) return null;
    const ls = +blk.dataset.ls;
    const le = +blk.dataset.le;
    if (blk.tagName === 'PRE') {
      const code = blk.querySelector('code') || blk;
      const cl = +blk.dataset.cl;
      const ce = +(blk.dataset.ce || le);
      if (ce < cl) return ls;
      return clamp(cl + countNewlines(ix.text, pointToOffset(code, 0), o), cl, ce);
    }
    let line = ls;
    if (/^(P|LI|H[1-6]|DT|DD)$/.test(blk.tagName)) {
      line = ls + countNewlines(ix.text, pointToOffset(blk, 0), o);
      for (const el of blk.querySelectorAll('[data-nl]')) {
        if (endOffsetOf(el) <= o) { line += +el.dataset.nl || 0; continue; }
        // A point inside a code span that crossed source lines: count the line breaks before it.
        const st = el.dataset.nlpos ? pointToOffset(el, 0) : null;
        if (st != null && st <= o) for (const p of el.dataset.nlpos.split(',')) if (+p < o - st) line++;
      }
    }
    return clamp(line, ls, le);
  }
  function countNewlines(text, from, to) {
    let n = 0;
    for (let i = Math.max(0, from); i < to && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }

  // Rendered text of a range, keeping block structure (code, lists, tables). innerText only applies
  // layout rules to rendered elements, so the clone goes into an off-screen (not hidden) probe.
  const TAB_MARK = '\u0001';
  function quoteOf(range) {
    const frag = range.cloneContents();
    for (const n of frag.querySelectorAll('[data-ui]')) n.remove();
    let wrapped = frag;
    let anc = range.commonAncestorContainer;
    if (anc.nodeType !== 1) anc = anc.parentElement;
    for (let a = anc; a && a !== docEl && docEl.contains(a); a = a.parentElement) {
      const shallow = a.cloneNode(false);
      shallow.removeAttribute('id');
      shallow.append(wrapped);
      wrapped = shallow;
    }
    const probe = h('div', { class: 'md quote-probe', 'aria-hidden': 'true' });
    probe.append(wrapped);
    // innerText puts a blank line around every <p>; tight list items should stay one per line.
    for (const p of probe.querySelectorAll('p.tight')) { const s = document.createElement('span'); s.append(...p.childNodes); p.replaceWith(s); }
    // innerText separates table cells with tabs; mark real tabs in code first so they survive.
    const w = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes('\t') && n.parentElement.closest('pre')) n.data = n.data.replace(/\t/g, TAB_MARK);
    document.body.append(probe);
    const text = probe.innerText;
    probe.remove();
    return text
      .replace(/ /g, ' ')
      .replace(/\t/g, ' | ')
      .replace(/\u0001/g, '\t')
      .replace(/[ ]+\n/g, '\n')
      .replace(/^\n+|\s+$/g, '');
  }

  // ---------------------------------------------------------------------------
  // Anchoring: exact quote + prefix/suffix context + relative position, with a fuzzy fallback
  // ---------------------------------------------------------------------------
  function commonSuffix(a, b) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
  function commonPrefix(a, b) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

  function alignStart(norm, s, ex) {
    const lead = ex.slice(0, Math.min(6, ex.length));
    let best = -1;
    for (let p = norm.indexOf(lead, Math.max(0, s - 24)); p !== -1 && p <= s + 24; p = norm.indexOf(lead, p + 1)) if (best < 0 || Math.abs(p - s) < Math.abs(best - s)) best = p;
    if (best >= 0) return best;
    let p = s;
    while (p > 0 && s - p < 16 && norm[p - 1] !== ' ') p--;
    return p;
  }
  function alignEnd(norm, e, ex) {
    const trail = ex.slice(-Math.min(6, ex.length));
    let best = -1;
    for (let p = norm.indexOf(trail, Math.max(0, e - 24 - trail.length)); p !== -1 && p + trail.length <= e + 24; p = norm.indexOf(trail, p + 1)) {
      const end = p + trail.length;
      if (best < 0 || Math.abs(end - e) < Math.abs(best - e)) best = end;
    }
    if (best >= 0) return best;
    let p = e;
    while (p < norm.length && p - e < 16 && norm[p] !== ' ') p++;
    return p;
  }

  function locate(c) {
    const { norm, map, text } = state.index;
    const ex = normalizeWs(c.exact || '').trim();
    if (!ex) return null;
    const pre = normalizeCtx(c.prefix || '');
    const suf = normalizeCtx(c.suffix || '');
    const relOld = c.docLen ? (c.start || 0) / c.docLen : 0;
    const ctxOf = (s, e) => commonSuffix(norm.slice(Math.max(0, s - pre.length), s), pre) + commonPrefix(norm.slice(e, e + suf.length), suf);
    const driftOf = (s) => Math.abs(map[s] / (text.length || 1) - relOld);
    let best = null;
    let hits = 0;
    for (let i = norm.indexOf(ex); i !== -1 && hits < 200000; i = norm.indexOf(ex, i + 1)) {
      hits++;
      const ctx = ctxOf(i, i + ex.length);
      const drift = driftOf(i);
      const sc = ctx - 40 * drift;
      if (!best || sc > best.sc) best = { s: i, e: i + ex.length, sc, ctx, drift, fuzzy: false };
    }
    // The same text with little shared context, far from where the comment was, is suspect. With other
    // copies around it is a twin, not the passage: leave it to the fuzzy search, or detach. As the only copy
    // it is probably the passage moved, but flag it so the output tells the reader to check.
    let moved = false;
    if (best && best.ctx < 8 && best.drift > 0.05) {
      if (hits > 1) best = null;
      else moved = true;
    }
    if (!best && ex.length >= 24) {
      // The passage was edited: find a chunk near its start and one near its end, close together. Trying
      // the second chunk as well survives an edit inside the first or last chunk.
      const k = Math.min(32, Math.floor(ex.length / 3));
      const heads = [0, k].filter((o) => o + k <= ex.length - k);
      const tails = [0, k].filter((o) => ex.length - o - k >= k);
      for (const ho of heads) {
        const head = ex.slice(ho, ho + k);
        for (const to of tails) {
          const tail = ex.slice(ex.length - to - k, ex.length - to);
          for (let i = norm.indexOf(head), n = 0; i !== -1 && n < 5000; i = norm.indexOf(head, i + 1), n++) {
            const j = norm.indexOf(tail, i + k);
            if (j === -1) continue;
            // Measured from an inner chunk, the ends are estimates: pull them onto the passage's own first
            // and last characters if they are nearby, else onto a word boundary.
            const s = ho ? alignStart(norm, Math.max(0, i - ho), ex) : i;
            const e = to ? alignEnd(norm, Math.min(norm.length, j + k + to), ex) : j + k;
            const len = e - s;
            if (len < ex.length * 0.5 || len > ex.length * 1.5 + 40) continue;
            const sc = ctxOf(s, e) - 40 * driftOf(s) - 8 - (ho || to ? 4 : 0);
            if (!best || sc > best.sc) best = { s, e, sc, fuzzy: true };
          }
        }
      }
      if (best && best.sc < 12) best = null; // a fuzzy match needs real context around it
    }
    return best ? { s: map[best.s], e: map[best.e - 1] + 1, fuzzy: best.fuzzy, moved } : null;
  }

  function anchor(c) {
    // Once a comment has jumped to a look-alike passage, its new position is no evidence that it is right:
    // the warning stays until the user edits the comment.
    const wasMoved = !!c.moved;
    c.range = null;
    c.detached = false;
    c.fuzzy = false;
    c.moved = wasMoved;
    c._rects = null;
    if (c.archived) return;
    const hit = locate(c);
    if (!hit || hit.e <= hit.s) { c.detached = true; return; }
    c.start = hit.s;
    c.end = hit.e;
    c.docLen = state.index.text.length;
    c.fuzzy = hit.fuzzy;
    c.moved = wasMoved || !!hit.moved;
    c.range = makeRange(hit.s, hit.e);
    const ls = lineOf(hit.s);
    const le = lineOf(hit.e - 1);
    if (ls != null) { c.lineStart = ls; c.lineEnd = Math.max(ls, le == null ? ls : le); }
  }

  // Output order: anchored comments by position, then detached ones by creation time.
  function ordered(list = active()) {
    const a = list.filter((c) => c.range).sort((x, y) => x.start - y.start || x.end - y.end);
    const d = list.filter((c) => !c.range).sort((x, y) => x.created - y.created);
    return a.concat(d);
  }
  const byId = (id) => state.comments.find((c) => c.id === id);

  // ---------------------------------------------------------------------------
  // Highlights (CSS Custom Highlight API) and inline notes
  // ---------------------------------------------------------------------------
  const HL = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
  const hl = {};
  if (HL) {
    for (const [name, prio] of [['sent', 0], ['note', 1], ['active', 3], ['pending', 4]]) {
      hl[name] = new Highlight();
      hl[name].priority = prio;
      CSS.highlights.set('cr-' + name, hl[name]);
    }
  }
  const hlClear = (name) => { if (HL) hl[name].clear(); };
  const hlAdd = (name, range) => { if (HL && range) hl[name].add(range); };

  function paint() {
    if (HL) {
      hl.note.clear();
      hl.sent.clear();
      for (const c of active()) if (c.range) hl[c.sent ? 'sent' : 'note'].add(c.range);
    }
    // A deleted (or archived) comment loses its active highlight too.
    if (activeId) { const c = byId(activeId); if (!c || c.archived || !c.range) setActive(null); }
    let n = 0;
    for (const c of ordered()) { c.num = c.sent ? null : ++n; c._rects = null; }
    renderNotes();
    renderDetached();
    updateBar();
    renderOutline();
    if (!dom.review.hidden) renderReview();
    if (!dom.composer.hidden) placeComposer();
  }

  function noteSpot(c) {
    const host = hostOf(Math.max(c.start, c.end - 1));
    const wrap = host.closest('.table-wrap');
    if (wrap) return { ref: wrap, mode: 'after' };
    const pre = host.closest('pre');
    if (pre) return { ref: pre, mode: 'after' };
    const blk = host.closest('p, h1, h2, h3, h4, h5, h6, dt, dd, li, blockquote, hr');
    if (!blk || !docEl.contains(blk)) {
      let top = host;
      while (top.parentElement && top.parentElement !== docEl) top = top.parentElement;
      return { ref: top === docEl ? null : top, mode: 'after' };
    }
    if (blk.tagName === 'LI') {
      const sub = Array.from(blk.children).find((ch) => /^(UL|OL|PRE|BLOCKQUOTE|DIV|P|TABLE)$/.test(ch.tagName) && !ch.classList.contains('notes'));
      return sub ? { ref: sub, mode: 'before' } : { ref: blk, mode: 'append' };
    }
    return { ref: blk, mode: 'after' };
  }

  // Text as a sentence for an accessible name: a final period unless it already ends in . ? or !
  const sentence = (t) => (/[.?!]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
  function noteButton(c, withQuote) {
    const label = c.sent ? `Sent comment${c.sentNum ? ' ' + c.sentNum : ''}` : `Comment ${c.num}`;
    const where = c.lineStart == null ? '' : c.lineStart === c.lineEnd ? `, line ${c.lineStart}` : `, lines ${c.lineStart}-${c.lineEnd}`;
    const quote = normalizeWs(c.quote || c.exact || '').trim();
    const on = quote ? `, on "${trunc(quote, 80)}"` : '';
    return h('button', { type: 'button', class: 'note' + (c.sent ? ' sent' : ''), 'data-id': c.id, 'aria-label': `${label}${where}${on}: ${sentence(c.body)} Enter to edit.` },
      h('span', { class: 'n', 'aria-hidden': 'true' }, c.sent ? `✓${c.sentNum || ''}` : String(c.num)),
      h('span', { class: 'b' }, c.body),
      withQuote ? h('span', { class: 'q' }, `“${(c.quote || c.exact || '').split('\n')[0]}”`) : null);
  }

  function renderNotes() {
    for (const n of $$('.notes', docEl)) n.remove();
    const groups = new Map();
    for (const c of ordered()) {
      if (!c.range) continue;
      const spot = noteSpot(c);
      if (!spot.ref) continue;
      if (!groups.has(spot.ref)) groups.set(spot.ref, { spot, items: [] });
      groups.get(spot.ref).items.push(c);
    }
    const boxes = [];
    for (const { spot, items } of groups.values()) {
      const box = h('div', { class: 'notes', 'data-ui': '' }, items.map((c) => noteButton(c)));
      if (spot.mode === 'after') spot.ref.after(box);
      else if (spot.mode === 'before') spot.ref.before(box);
      else spot.ref.append(box);
      boxes.push([box, items]);
    }
    // A note for a passage that starts in an earlier block, or far above (a long code block or table),
    // says where the passage starts.
    if (settings.notes) {
      for (const [box, items] of boxes) {
        const boxTop = box.getBoundingClientRect().top;
        items.forEach((c, i) => {
          if (c.lineStart == null) return;
          const multi = leafAt(c.start) !== leafAt(c.end - 1);
          const far = boxTop - c.range.getBoundingClientRect().bottom > window.innerHeight * 0.75;
          if (multi || far) box.children[i].append(h('span', { class: 'jump', 'aria-hidden': 'true' }, `↑ L${c.lineStart}`));
        });
      }
    }
    if (!dom.composer.hidden && cmp.mode === 'edit') {
      const n = docEl.querySelector(`.note[data-id="${cssId(cmp.id)}"]`);
      if (n) n.classList.add('editing');
    }
  }

  function renderDetached() {
    const list = ordered().filter((c) => !c.range && !c.sent);
    if (!list.length || !state.doc) { dom.detached.hidden = true; dom.detached.replaceChildren(); return; }
    dom.detached.hidden = false;
    const n = list.length;
    fill(dom.detached,
      h('div', { class: 'detached-bar' },
        h('span', null, `${plural(n, 'comment')} lost ${n === 1 ? 'its' : 'their'} text in this version. ${n === 1 ? 'It is' : 'They are'} still in the review.`),
        h('button', { type: 'button', class: 'link-btn', 'aria-expanded': String(!!state.detachedOpen), onclick: () => { state.detachedOpen = !state.detachedOpen; renderDetached(); } }, state.detachedOpen ? 'Hide' : 'Show')),
      state.detachedOpen ? h('div', { class: 'detached-list' }, list.map((c) => noteButton(c, true))) : null);
  }

  let activeId = null;
  function setActive(id) {
    hlClear('active');
    for (const n of $$('.note.active')) n.classList.remove('active');
    activeId = id || null;
    if (!id) return;
    const c = byId(id);
    if (c && c.range) hlAdd('active', c.range);
    const note = document.querySelector(`.note[data-id="${cssId(id)}"]`);
    if (note) note.classList.add('active');
  }

  // Rects of the text a comment covers (not the boxes of whole blocks inside it), in page coordinates.
  function textRects(c) {
    if (c._rects) return c._rects;
    const range = c.range;
    const out = [];
    const sx = window.scrollX;
    const sy = window.scrollY;
    const push = (r) => { for (const x of r.getClientRects()) if (x.width > 0 && x.height > 0) out.push({ l: x.left + sx, r: x.right + sx, t: x.top + sy, b: x.bottom + sy }); };
    const root = range.commonAncestorContainer;
    if (root.nodeType === 3) push(range);
    else {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const sub = document.createRange();
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!range.intersectsNode(n) || !n.data.trim() || n.parentElement.closest('[data-ui]')) continue;
        sub.setStart(n, n === range.startContainer ? range.startOffset : 0);
        sub.setEnd(n, n === range.endContainer ? range.endOffset : n.data.length);
        push(sub);
      }
    }
    c._rects = out;
    return out;
  }
  const invalidateRects = () => { for (const c of state.comments) c._rects = null; };

  function commentAtPoint(x, y) {
    const px = x + window.scrollX;
    const py = y + window.scrollY;
    let best = null;
    for (const c of active()) {
      if (!c.range) continue;
      for (const r of textRects(c)) {
        if (px >= r.l - 1 && px <= r.r + 1 && py >= r.t - 1 && py <= r.b + 1) {
          if (!best || c.end - c.start < best.end - best.start) best = c;
          break;
        }
      }
    }
    return best;
  }

  const landingY = () => dom.bar.offsetHeight + (window.innerHeight - dom.bar.offsetHeight) * 0.3;
  function scrollToY(rectTop, rectHeight) {
    const barH = dom.bar.offsetHeight;
    const avail = window.innerHeight - barH;
    const target = window.scrollY + rectTop - barH - Math.max(16, Math.min(avail * 0.3, (avail - rectHeight) / 2));
    window.scrollTo({ top: Math.max(0, target), behavior: 'instant' });
  }

  let navActiveId = null;
  function focusNote(id) {
    const note = document.querySelector(`.note[data-id="${cssId(id)}"]`);
    if (note && isVisible(note)) note.focus({ preventScroll: true });
  }
  function scrollToComment(c, { persist = false, focus = false } = {}) {
    if (!c) return;
    if (c.range) {
      const rect = c.range.getBoundingClientRect();
      scrollToY(rect.top, rect.height);
      setActive(c.id);
      if (persist) navActiveId = c.id;
      else setTimeout(() => { if (navActiveId !== c.id) setActive(null); }, 1200);
    } else {
      state.detachedOpen = true;
      renderDetached();
      const note = dom.detached.querySelector(`.note[data-id="${cssId(c.id)}"]`);
      if (note) note.scrollIntoView({ block: 'center' });
    }
    if (focus) focusNote(c.id);
  }

  // ---------------------------------------------------------------------------
  // Rendering, change marks and scroll anchoring
  // ---------------------------------------------------------------------------
  // A block's signature is its own text, without UI inside it (a failed image's "[image: …]" label appears
  // asynchronously and must not make the block look changed).
  function leafSig(el) {
    if (!el.querySelector('[data-ui]')) return el.tagName + '|' + normalizeWs(el.textContent).trim();
    let t = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement.closest('[data-ui]')) t += n.data;
    return el.tagName + '|' + normalizeWs(t).trim();
  }
  const leavesOf = (root) => $$(LEAF_SEL, root).filter((el) => !el.closest('[data-ui]'));
  const seqOf = (root) => leavesOf(root).map(leafSig);

  // Mark the blocks that differ from the round's baseline: inserted or changed blocks get a bar, and the
  // block after a deletion gets a dashed bar, so N can visit every edit made to the file.
  let changePos = -1;
  function markChanges(oldSeq) {
    for (const el of state.changes) el.classList.remove('chg', 'chg-del', 'chg-del-end');
    const leaves = leavesOf(docEl);
    const neu = leaves.map(leafSig);
    let a = 0;
    while (a < oldSeq.length && a < neu.length && oldSeq[a] === neu[a]) a++;
    let b = 0;
    while (b < oldSeq.length - a && b < neu.length - a && oldSeq[oldSeq.length - 1 - b] === neu[neu.length - 1 - b]) b++;
    const O = oldSeq.slice(a, oldSeq.length - b);
    const N = neu.slice(a, neu.length - b);
    const changed = new Set();
    const delAt = new Set();
    if (O.length && N.length && O.length * N.length <= 4e6) {
      const w = N.length + 1;
      const dp = new Uint32Array((O.length + 1) * w);
      for (let i = O.length - 1; i >= 0; i--) {
        for (let j = N.length - 1; j >= 0; j--) {
          dp[i * w + j] = O[i] === N[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < O.length && j < N.length) {
        if (O[i] === N[j]) { i++; j++; } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { delAt.add(a + j); i++; } else { changed.add(a + j); j++; }
      }
      for (; j < N.length; j++) changed.add(a + j);
      if (i < O.length) delAt.add(a + N.length);
    } else if (N.length) {
      const m = new Map();
      for (const s of O) m.set(s, (m.get(s) || 0) + 1);
      N.forEach((s, k) => { const n = m.get(s) || 0; if (n > 0) m.set(s, n - 1); else changed.add(a + k); });
    } else if (O.length) {
      delAt.add(a);
    }
    for (const k of changed) if (neu[k].length > 3) leaves[k].classList.add('chg');
    for (const k of delAt) {
      // A deletion is marked on the block after it, or on the last block's bottom edge at the very end.
      const el = leaves[k] || leaves[leaves.length - 1];
      if (el && !el.classList.contains('chg')) el.classList.add(leaves[k] ? 'chg-del' : 'chg-del-end');
    }
    state.changes = leaves.filter((el) => el.classList.contains('chg') || el.classList.contains('chg-del') || el.classList.contains('chg-del-end'));
    changePos = -1;
    return state.changes.length;
  }
  function clearChanges() {
    for (const el of state.changes) el.classList.remove('chg', 'chg-del', 'chg-del-end', 'chg-current');
    state.changes = [];
    state.baseSeq = null;
    changePos = -1;
  }
  function navChanges(dir) {
    const list = state.changes.filter((el) => el.isConnected);
    if (!list.length) { toast('No changes are marked. Blocks are marked when the file changes on disk.', { id: 'nav' }); return; }
    let i;
    if (changePos >= 0 && changePos < list.length) i = changePos + dir;
    else {
      const land = landingY();
      const tops = list.map((el) => el.getBoundingClientRect().top);
      if (dir > 0) i = tops.findIndex((t) => t > land + 8);
      else { i = -1; for (let j = tops.length - 1; j >= 0; j--) if (tops[j] < land - 8) { i = j; break; } }
      if (i < 0) i = dir > 0 ? 0 : list.length - 1;
    }
    changePos = (i + list.length) % list.length;
    for (const el of list) el.classList.remove('chg-current');
    list[changePos].classList.add('chg-current');
    const r = list[changePos].getBoundingClientRect();
    scrollToY(r.top, r.height);
  }

  function render(text, { keepScroll = false, scroll = null } = {}) {
    const anchorPos = keepScroll ? captureScroll() : scroll;
    hideSelectionPill();
    state.changes = [];
    docEl.innerHTML = text.trim() ? renderMd(text) : '<p class="empty-doc" data-ui="">This file is empty.</p>';
    for (const img of $$('img', docEl)) {
      img.addEventListener('error', () => {
        const alt = img.getAttribute('alt') || img.getAttribute('src') || 'image';
        img.replaceWith(h('span', { class: 'img-missing', 'data-ui': '', 'data-nl': img.getAttribute('data-nl'), title: img.getAttribute('src') || '' }, `[image: ${alt}]`));
      }, { once: true });
    }
    buildIndex();
    for (const c of state.comments) anchor(c);
    state.heads = $$('h1, h2, h3, h4', docEl).map((el) => ({ el, level: +el.tagName[1], text: normalizeWs(el.textContent).trim(), off: pointToOffset(el, 0) }));
    paint();
    let restored = false;
    if (anchorPos) { try { restored = restoreScroll(anchorPos); } catch { restored = false; } }
    if (!restored && !keepScroll) window.scrollTo(0, 0);
    updateCurrentSection();
    markAllOverflow();
  }

  // Tables and code that scroll sideways fade out at the edge that has more, so clipped content reads as "scroll".
  function markOverflow(el) {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('more-r', max > 1 && el.scrollLeft < max - 1);
    el.classList.toggle('more-l', max > 1 && el.scrollLeft > 1);
  }
  function markAllOverflow() { for (const el of $$('.table-wrap, pre', docEl)) markOverflow(el); }
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t instanceof Element && docEl.contains(t) && t.matches('.table-wrap, pre')) markOverflow(t);
  }, { capture: true, passive: true });

  // Scroll anchoring by block: remember the first few blocks at the top of the viewport by content.
  function captureScroll() {
    const leaves = leavesOf(docEl);
    if (!leaves.length) return null;
    const y = dom.bar.offsetHeight + 4;
    let lo = 0;
    let hi = leaves.length - 1;
    let found = leaves.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (leaves[mid].getBoundingClientRect().bottom > y) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    const items = leaves.slice(found, found + 6).map((el) => {
      const blk = el.closest('[data-ls]');
      return { tag: el.tagName, sig: leafSig(el), ls: blk ? +blk.dataset.ls : 0, top: el.getBoundingClientRect().top };
    });
    return { items, y: window.scrollY };
  }
  function restoreScroll(a) {
    if (!a || typeof a !== 'object') return false;
    const items = Array.isArray(a.items) ? a.items : a.tag ? [a] : [];
    const lsOf = (el) => { const b = el.closest('[data-ls]'); return b ? +b.dataset.ls : 0; };
    for (const it of items) {
      if (!it || typeof it.tag !== 'string' || !/^[A-Z][A-Z0-9]*$/i.test(it.tag) || typeof it.sig !== 'string') continue;
      const same = $$(it.tag, docEl).filter((el) => !el.closest('[data-ui]') && leafSig(el) === it.sig);
      if (!same.length) continue;
      const target = same.reduce((b, el) => (Math.abs(lsOf(el) - it.ls) < Math.abs(lsOf(b) - it.ls) ? el : b), same[0]);
      window.scrollBy({ top: target.getBoundingClientRect().top - (+it.top || 0), behavior: 'instant' });
      return true;
    }
    if (typeof a.y === 'number' && isFinite(a.y)) { window.scrollTo({ top: a.y, behavior: 'instant' }); return true; }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Opening, switching and updating documents
  // ---------------------------------------------------------------------------
  function loadRecordState(rec) {
    state.comments = (rec && rec.comments ? rec.comments : []).map((c) => ({ ...c }));
    state.deleted = (rec && rec.deleted) || {};
    state.general = (rec && rec.general) || '';
    state.generalAt = (rec && rec.generalAt) || 0;
    state.generalSent = !!(rec && rec.generalSent);
    state.generalSentAt = (rec && rec.generalSentAt) || 0;
    state.path = (rec && rec.path) || '';
    state.pathAt = (rec && rec.pathAt) || 0;
    state.lastBatch = (rec && rec.lastBatch) || null;
    state.loadedAt = (rec && rec.loadedAt) || now();
    state.baseSeq = null;
    navActiveId = null;
  }

  async function findRecord(name, handle, path = '', shared = false, text = null) {
    const all = (await store.all()).filter((r) => r.source !== 'paste' && r.name === name).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!all.length) return { rec: null, taken: false };
    if (handle) {
      for (const r of all) {
        if (!r.handle) continue;
        try { if (await r.handle.isSameEntry(handle)) return { rec: r, taken: true }; } catch { /* stale handle */ }
      }
    }
    // A link or a script names the file by its path: it joins the record for that path, even one the
    // person follows live; without a path, only a record that has neither a path nor a live file.
    const plain = (r) => !r.handle && !r.path;
    // A file the person opened themselves has no path until one is typed: a link with a path adopts it.
    // For one path: a document the person follows live first, then the same text (a repeat never makes a
    // new copy), then the original over separate copies. Without a path, only plain records count.
    if (shared) {
      const pool = path ? all.filter((r) => (r.path || '') === path) : all.filter(plain);
      const rec = (path && pool.find((r) => r.handle)) || pool.find((r) => r.text === text) || pool.find((r) => !provisional(r)) || pool[0]
        || (path ? all.find((r) => r.handle && !r.path) || all.find(plain) : null) || null;
      return { rec, taken: true };
    }
    // Without a matching handle, join only a record that never had one: another project's
    // handle-backed PLAN.md must not absorb this file.
    return { rec: all.find((r) => !r.handle && !provisional(r)) || all.find((r) => !r.handle) || null, taken: true };
  }

  // Sent comments were handed over. Once the file changes after they were sent, they belong to an
  // earlier round. Comments sent after the change was detected, and one open in the composer, stay.
  function archiveSent(detectedAt = now()) {
    let n = 0;
    const keep = !dom.composer.hidden && cmp.mode === 'edit' ? cmp.id : null;
    for (const c of state.comments) {
      if (c.sent && !c.archived && c.id !== keep && (c.sentAt || 0) <= detectedAt) { c.archived = true; c.range = null; touch(c); n++; }
    }
    if (state.generalSent && (state.generalSentAt || 0) <= detectedAt) { state.general = ''; state.generalSent = false; state.generalAt = now(); dom.general.value = ''; }
    if (n) state.lastBatch = null;
    return n;
  }

  function looksLikeSameDoc(a, b) {
    const head = (t) => { const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(t); return m ? m[1].trim().toLowerCase() : ''; };
    if (head(a) && head(a) === head(b)) return true;
    const linesA = new Set(a.split('\n').map((l) => l.trim()).filter((l) => l.length > 3));
    const linesB = b.split('\n').map((l) => l.trim()).filter((l) => l.length > 3);
    if (!linesB.length || !linesA.size) return false;
    return linesB.filter((l) => linesA.has(l)).length / linesB.length >= 0.5;
  }
  function htmlRoot(text) { const tmp = document.createElement('div'); tmp.innerHTML = renderMd(text); return tmp; }

  // `copy`: the text came from a link on a web address. It joins an existing record only with the same text,
  // and a record it creates is a separate copy (see pruneRecords). Anything else the person or a local agent
  // opens makes a copy an ordinary saved document.
  async function openDocument({ name, text, handle = null, lastModified = 0, size = 0, source = 'file', path = '', shared = false, fresh = false, copy = false }) {
    dropDocToasts();
    if (state.doc) {
      keepDraftBeforeLeaving();
      saveScroll.flush();
      saveSoon.cancel();
      await saveNow();
    }
    stopWatch();
    closeComposer(true);
    closeSurfaces(false);
    let rec;
    let key;
    let sameVersion = false;
    if (source === 'paste') {
      const cur = state.doc && state.doc.source === 'paste' ? state.doc : null;
      if (cur && !copy && looksLikeSameDoc(cur.text, text)) { key = cur.key; rec = serialize(); sameVersion = true; }
      else if (copy) {
        // A pasted document keeps its first key through revisions, so look for the same text, not the key.
        rec = (await store.all()).find((r) => r.source === 'paste' && r.text === text) || null;
        key = rec ? rec.key : 'paste:' + hash(text) + ':' + uid();
      } else { key = 'paste:' + hash(text); rec = await store.get(key); }
    } else if (fresh) {
      rec = null;
      key = 'file:' + name + ':' + uid();
    } else {
      const found = await findRecord(name, handle, path, shared, text);
      rec = found.rec;
      key = rec ? rec.key : 'file:' + name + (found.taken ? ':' + uid() : '');
    }
    const changed = !!(rec && rec.text !== text);
    loadRecordState(rec);
    if (path && path !== state.path) { state.path = path; state.pathAt = now(); }
    state.loadedAt = now();
    state.lastRead = handle ? now() : 0;
    state.pendingText = null;
    state.pendingAt = 0;
    dom.pending.hidden = true;
    state.doc = { key, name, source, text, handle, lastModified, size, copy: copy && (!rec || provisional(rec)) };
    state.pendingMeta = null;
    watch.seen = handle ? `${lastModified}:${size}` : null;
    ssSet(`${NS}.tab`, key);
    let archived = 0;
    if (changed) archived = archiveSent();
    showDocument();
    render(text, { scroll: changed ? null : lsGet(scrollKey(key), null) });
    let marked = 0;
    if (changed) { state.baseSeq = seqOf(htmlRoot(rec.text)); marked = markChanges(state.baseSeq); }
    const live = active();
    if (rec && (live.length || archived || changed)) {
      const lost = live.filter((c) => !c.range && !c.sent).length;
      const parts = [changed ? (sameVersion ? `New version of "${name}"` : `${name} changed since you last had it open`) : `Reopened ${name}`];
      if (changed && marked) parts.push(`${plural(marked, 'change')} marked`);
      if (live.length && !changed) parts.push(plural(live.length, 'comment'));
      if (archived) parts.push(`${archived} sent ${archived === 1 ? 'comment' : 'comments'} moved to Earlier rounds`);
      if (lost) parts.push(`${lost} lost ${lost === 1 ? 'its' : 'their'} text`);
      toast(parts.join(' · '), { id: 'open', action: marked ? 'Next change' : null, actionClass: 'chg', onAction: () => navChanges(1) });
    }
    if (handle) startWatch();
    else setLive(source === 'paste' ? 'none' : 'snapshot');
    await saveNow();
    pruneRecords();
  }

  // Hold disk updates while the user is mid-action: typing a comment, dragging, editing a field, or
  // holding a selection they just made in a focused window.
  let selActive = false;
  let selAt = 0;
  function renderLocked() {
    if (!dom.composer.hidden || pointerDown) return true;
    if (!document.hasFocus()) return false;
    const ae = document.activeElement;
    if (ae === dom.general || ae === dom.path) return true;
    return selActive && now() - selAt < 15000;
  }
  // meta is the { lastModified, size } of the file the text was read from. It is committed together with
  // the text, so a reload while an update is held never pairs the old text with the new file's metadata.
  function applyUpdate(text, detectedAt = now(), meta = null) {
    if (!state.doc) return;
    if (text === state.doc.text) {
      if (meta) Object.assign(state.doc, meta);
      state.pendingText = null; state.pendingAt = 0; state.pendingMeta = null; dom.pending.hidden = true;
      return;
    }
    if (renderLocked()) {
      state.pendingText = text;
      state.pendingMeta = meta;
      if (!state.pendingAt) state.pendingAt = detectedAt;
      dom.pending.hidden = false;
      return;
    }
    // A newer version supersedes anything still held back: drop the older one before showing this.
    const at = state.pendingAt || detectedAt;
    state.pendingText = null; state.pendingAt = 0; state.pendingMeta = null; dom.pending.hidden = true;
    doApplyUpdate(text, at, meta);
  }
  function tryApplyPending(force = false) {
    if (state.pendingText == null || !state.doc) return false;
    if (!force && renderLocked()) return false;
    const t = state.pendingText;
    const at = state.pendingAt || now();
    const meta = state.pendingMeta;
    state.pendingText = null;
    state.pendingAt = 0;
    state.pendingMeta = null;
    dom.pending.hidden = true;
    doApplyUpdate(t, at, meta);
    return true;
  }
  function doApplyUpdate(text, detectedAt = now(), meta = null) {
    if (!state.baseSeq) state.baseSeq = seqOf(docEl);
    const draft = composerDraft();
    const before = new Set(active().filter((c) => c.range).map((c) => c.id));
    const archived = archiveSent(detectedAt);
    state.doc.text = text;
    if (meta) Object.assign(state.doc, meta);
    state.loadedAt = now();
    render(text, { keepScroll: true });
    const marked = markChanges(state.baseSeq);
    restoreComposerDraft(draft);
    const lost = active().filter((c) => before.has(c.id) && !c.range).length;
    const parts = [`${state.doc.name} updated`];
    if (marked) parts.push(plural(marked, 'change'));
    if (archived) parts.push(`${archived} sent → Earlier rounds`);
    if (lost) parts.push(`${lost} lost ${lost === 1 ? 'its' : 'their'} text`);
    // Each part wraps as a unit, never in the middle of "Earlier rounds".
    toast(parts.flatMap((p, i) => [i ? ' · ' : '', h('span', { class: 'nw' }, p)]), { id: 'reload', ms: 6000, action: marked ? 'Next change' : null, actionClass: 'chg', onAction: () => navChanges(1) });
    saveNow();
  }

  // Decode as UTF-8, rejecting binary files and flagging anything that is not valid UTF-8.
  async function readText(file) {
    const buf = await file.arrayBuffer();
    // UTF-16 with a byte-order mark (what Windows PowerShell's > writes) is text, not binary.
    const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 2));
    if (head.length === 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
      const enc = head[0] === 0xff ? 'utf-16le' : 'utf-16be';
      try { return { text: new TextDecoder(enc, { fatal: true }).decode(buf), lossy: false }; } catch { return { text: new TextDecoder(enc).decode(buf), lossy: true }; }
    }
    const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 8192));
    let ctrl = 0;
    for (const b of bytes) { if (b === 0) return { binary: true }; if (b < 9 || (b > 13 && b < 32)) ctrl++; }
    if (bytes.length && ctrl / bytes.length > 0.05) return { binary: true };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), lossy: false }; } catch { return { text: new TextDecoder('utf-8').decode(buf), lossy: true }; }
  }

  async function openFile(file, handle = null) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is over 20 MB, too large to review here.`, { kind: 'err' }); return; }
    let r;
    try { r = await readText(file); } catch (e) { toast(`Couldn't read ${file.name}: ${e.message || e.name}`, { kind: 'err' }); return; }
    if (r.binary) { toast(`${file.name} doesn't look like a text file.`, { kind: 'err' }); return; }
    await openDocument({ name: file.name, text: normalizeSource(r.text), handle, lastModified: file.lastModified, size: file.size, source: 'file' });
    if (r.lossy) toast(`Some characters in ${file.name} couldn't be decoded and show as �. Quotes containing them won't match the file.`, { kind: 'err', ms: 7000 });
  }

  async function openHandle(handle) {
    let file;
    try { file = await handle.getFile(); } catch (e) { toast(`Couldn't read ${handle.name}: ${e.message || e.name}`, { kind: 'err' }); return; }
    await openFile(file, handle);
  }

  function openPasted(raw, { copy = false } = {}) {
    const text = normalizeSource(raw);
    if (!text.trim()) return null;
    if (text.length > 20 * 1024 * 1024) { toast('That text is over 20 MB, too large to review here.', { kind: 'err' }); return null; }
    const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
    const name = m ? trunc(m[1].trim(), 60) : 'Pasted Markdown';
    return openDocument({ name, text, source: 'paste', copy });
  }

  const PICKER = typeof window.showOpenFilePicker === 'function' && window.isSecureContext;
  async function pickFile() {
    if (!PICKER) { dom.fileInput.click(); return; }
    const opts = {
      id: 'markdown-annotator',
      multiple: false,
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx'], 'text/plain': ['.txt'] } }],
    };
    if (state.doc && state.doc.handle) opts.startIn = state.doc.handle;
    let handles;
    try {
      handles = await window.showOpenFilePicker(opts);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (opts.startIn && e.name === 'TypeError') { delete opts.startIn; try { handles = await window.showOpenFilePicker(opts); } catch { return; } }
      else { console.warn(e); dom.fileInput.click(); return; }
    }
    if (handles && handles[0]) await openHandle(handles[0]);
  }

  async function pasteFromClipboard() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { toast(`Chrome blocked clipboard access. Close the document and press ${MOD_LABEL}V on the start screen instead.`, { kind: 'err', ms: 6000 }); return; }
    if (!text.trim()) { toast('The clipboard has no text.'); return; }
    await openPasted(text);
  }

  // Leaving a document never drops a comment that is being typed: it is saved first.
  function keepDraftBeforeLeaving() {
    if (dom.composer.hidden || !composerDirty() || !state.doc) return;
    const name = state.doc.name;
    if (saveComposer()) toast(`Saved your unfinished comment on ${name}.`, { id: 'draft', keep: true });
  }

  async function closeDocument() {
    keepDraftBeforeLeaving();
    closeComposer(true);
    closeSurfaces(false);
    stopWatch();
    saveScroll.flush();
    saveSoon.cancel();
    const key = state.doc ? state.doc.key : null;
    // Forget "the open document" first, so a reload during the final save shows the start screen.
    closing = true;
    ssSet(`${NS}.tab`, null);
    const cleared = store.setMeta('last', null);
    await saveNow();
    await cleared;
    closing = false;
    if (key) lsSet(`${NS}.journal.${key}`, null);
    state.doc = null;
    state.comments = [];
    state.deleted = {};
    state.general = '';
    state.generalSent = false;
    state.lastBatch = null;
    state.pendingText = null;
    state.changes = [];
    state.baseSeq = null;
    for (const t of $$('.toast', dom.toasts)) t.remove();
    showEmpty();
  }

  function showDocument() {
    dom.empty.hidden = true;
    dom.bar.hidden = false;
    docEl.hidden = false;
    dom.docEnd.hidden = false;
    dom.crumbFile.textContent = state.doc.name;
    dom.crumb.title = `${state.doc.name} · Outline (O)`;
    document.title = `${state.doc.name} · Markdown Annotator`;
    dom.general.value = state.general;
    dom.path.value = state.path;
    dom.path.placeholder = state.doc.source === 'paste' ? 'e.g. docs/PLAN.md' : state.doc.name;
  }

  const firstHeading = (text) => { const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text || ''); return m ? trunc(m[1].trim(), 40) : ''; };
  async function showEmpty() {
    dom.bar.hidden = true;
    docEl.hidden = true;
    docEl.innerHTML = '';
    dom.docEnd.hidden = true;
    dom.detached.hidden = true;
    dom.empty.hidden = false;
    dom.pending.hidden = true;
    document.title = 'Markdown Annotator';
    hideSelectionPill();
    hlClear('note');
    hlClear('sent');
    const recs = (await store.all()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
    if (state.doc) return; // a document opened while the list was loading
    const names = new Map();
    for (const r of recs) names.set(r.name, (names.get(r.name) || 0) + 1);
    fill(dom.recentList, recs.map((rec) => {
      const live = (rec.comments || []).filter((c) => !c.archived);
      const earlier = (rec.comments || []).length - live.length;
      const unsent = live.filter((c) => !c.sent).length;
      const count = live.length ? (unsent === live.length ? plural(live.length, 'comment') : `${unsent} of ${live.length} unsent`) : earlier ? `${earlier} in earlier rounds` : 'no comments';
      const meta = [count, ago(rec.updatedAt)].join(' · ');
      const hint = names.get(rec.name) > 1 ? rec.path || firstHeading(rec.text) || `opened ${new Date(rec.updatedAt).toLocaleDateString()}` : '';
      return h('li', null,
        h('button', { type: 'button', class: 'open', title: rec.path || (rec.source === 'paste' ? 'Pasted Markdown' : rec.name), onclick: () => reopen(rec.key) },
          h('span', { class: 'nm' }, rec.name), hint ? h('span', { class: 'hint' }, hint) : null, h('span', { class: 'meta' }, meta)),
        h('button', { type: 'button', class: 'icon-btn small forget', 'aria-label': `Forget ${rec.name}`, title: 'Forget', onclick: () => forget(rec) },
          h('span', { 'aria-hidden': 'true' }, '×')));
    }));
    dom.recent.hidden = !recs.length;
    if (dom.forgetAll) dom.forgetAll.hidden = !recs.length;
  }

  async function forget(rec) {
    const full = (await store.get(rec.key)) || rec;
    await store.del(rec.key);
    showEmpty();
    toast(`Forgot ${rec.name}.`, { action: 'Undo', ms: 6000, onAction: async () => { await store.put(full); showEmpty(); } });
  }
  async function forgetAll() {
    const all = await store.all();
    if (!all.length) return;
    await store.clear();
    showEmpty();
    toast(`Forgot ${plural(all.length, 'document')} and their comments.`, {
      action: 'Undo', ms: 8000,
      onAction: async () => { for (const r of all) await store.put(r); showEmpty(); },
    });
  }
  // Keep storage bounded: every file:// page shares this origin, so nothing is kept forever.
  // Keep the newest records. Separate copies from web links (any a link made that hold no comments yet) are
  // capped and go first, so a page that sends many links can never push a saved review out.
  async function pruneRecords() {
    const all = (await store.all()).sort((a, b) => b.updatedAt - a.updatedAt);
    // Only a record no tab has saved since this read is deleted, and a copy only while it is still one, so a
    // copy commented meanwhile stays even when that save fell in the same millisecond.
    const drop = (r) => { if (!state.doc || r.key !== state.doc.key) store.delIf(r.key, (x) => x.updatedAt === r.updatedAt && provisional(x) === provisional(r)); };
    const copies = all.filter(provisional);
    copies.slice(KEEP_COPIES).forEach(drop);
    const rest = all.filter((r) => !provisional(r) || copies.indexOf(r) < KEEP_COPIES);
    rest.sort((a, b) => (provisional(a) === provisional(b) ? b.updatedAt - a.updatedAt : provisional(a) ? 1 : -1));
    rest.slice(KEEP_RECORDS).forEach(drop);
  }

  // True when the document came from the file on disk, false when the saved copy is shown instead.
  async function reopen(key) {
    const rec = await store.get(key);
    if (!rec) { showEmpty(); return false; }
    if (rec.handle) {
      let granted = false;
      try { granted = (await rec.handle.requestPermission({ mode: 'read' })) === 'granted'; } catch { granted = false; }
      if (granted) {
        try {
          const file = await rec.handle.getFile();
          const r = await readText(file);
          if (!r.binary) {
            await openDocument({ name: rec.name, text: normalizeSource(r.text), handle: rec.handle, lastModified: file.lastModified, size: file.size, source: 'file' });
            return true;
          }
        } catch { /* moved or deleted: fall back to the saved copy */ }
      }
    }
    await restoreRecord(rec);
    return false;
  }

  async function restoreRecord(rec) {
    loadRecordState(rec);
    state.doc = { key: rec.key, name: rec.name, source: rec.source || 'file', text: rec.text, handle: rec.handle || null, lastModified: rec.lastModified || 0, size: rec.size || 0, copy: provisional(rec) };
    state.lastRead = 0;
    state.pendingMeta = null;
    watch.seen = null; // read the file once even if its metadata matches the cache
    ssSet(`${NS}.tab`, rec.key);
    showDocument();
    render(rec.text, { scroll: lsGet(scrollKey(rec.key), null) });
    if (rec.handle) {
      let perm = 'prompt';
      try { perm = await rec.handle.queryPermission({ mode: 'read' }); } catch { /* unsupported */ }
      if (perm === 'granted') { startWatch(); checkFile(); } else setLive('perm');
    } else {
      setLive(rec.source === 'paste' ? 'none' : 'snapshot');
    }
    store.setMeta('last', rec.key);
  }

  // ---------------------------------------------------------------------------
  // Watching the file on disk through its File System Access handle
  // ---------------------------------------------------------------------------
  const watch = { timer: 0, busy: false, cand: null, recheck: 0, seen: null };
  function startWatch() {
    stopWatch();
    setLive('on');
    watch.timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      checkFile();
      tryApplyPending();
    }, 1000);
  }
  function stopWatch() { clearInterval(watch.timer); clearTimeout(watch.recheck); watch.timer = 0; watch.cand = null; }
  const recheckIn = (ms) => { clearTimeout(watch.recheck); watch.recheck = setTimeout(() => checkFile(), ms); };
  async function checkFile(force = false) {
    const d = state.doc;
    if (!d || !d.handle || watch.busy || (state.liveMode === 'perm' && !force)) return;
    watch.busy = true;
    try {
      const f = await d.handle.getFile();
      if (state.doc !== d) return;
      state.lastRead = now();
      const sig = `${f.lastModified}:${f.size}`;
      // Unchanged since the last version this page took in (shown, or held back): nothing to read.
      if (!force && sig === watch.seen) { watch.cand = null; setLive('on'); return; }
      const r = await readText(f);
      if (state.doc !== d) return;
      const text = r.binary ? d.text : normalizeSource(r.text);
      // Apply a change only once it is stable: some writers truncate the file first and fill it after.
      if (!force) {
        if (!watch.cand || watch.cand.sig !== sig) { watch.cand = { sig, at: now(), detected: (watch.cand && watch.cand.detected) || now() }; recheckIn(350); setLive('on'); return; }
        const age = now() - watch.cand.at;
        if (age < 300) { recheckIn(320 - age); return; }
        if (!text.trim() && d.text.trim() && age < 2000) { recheckIn(500); return; }
      }
      const detected = watch.cand ? watch.cand.detected : now();
      watch.cand = null;
      watch.seen = sig;
      const meta = { lastModified: f.lastModified, size: f.size };
      if (text === state.pendingText) state.pendingMeta = meta;
      else applyUpdate(text, detected, meta);
      if (force && text === d.text) toast(`${d.name} is up to date.`, { id: 'reload', ms: 1800 });
      setLive('on');
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) setLive('perm');
      else if (e && e.name === 'NotFoundError') setLive('missing');
      else setLive('off');
    } finally {
      watch.busy = false;
    }
  }
  window.addEventListener('focus', () => checkFile());
  window.addEventListener('blur', () => setTimeout(() => tryApplyPending(), 0));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkFile(); });

  async function reconnect() {
    const d = state.doc;
    if (!d) return;
    if (state.liveMode === 'missing' || !d.handle) { pickFile(); return; }
    let perm = 'denied';
    try { perm = await d.handle.requestPermission({ mode: 'read' }); } catch { /* ignore */ }
    if (perm === 'granted') { setLive('on'); startWatch(); await checkFile(true); }
    else toast('Chrome did not grant access. Open the file again to watch it.', { kind: 'err' });
  }

  function setLive(mode) {
    const name = state.doc ? state.doc.name : '';
    const prev = state.liveMode;
    state.liveMode = mode;
    const warn = mode === 'perm' || mode === 'missing';
    dom.reconnect.hidden = !warn;
    dom.reconnect.textContent = mode === 'missing' ? 'File missing' : 'Reconnect';
    dom.reconnect.title = mode === 'missing'
      ? `${name} was moved or deleted. Showing the last copy; click to open it again.`
      : `Showing the copy loaded at ${hhmm(state.loadedAt || now())}. Click to let Chrome re-read ${name} and reload it when it changes.`;
    dom.live.hidden = !(mode === 'on' || mode === 'off');
    dom.live.classList.toggle('off', mode !== 'on');
    dom.live.title = mode === 'on' ? `Watching ${name}; it reloads when the file changes` : `Can't read ${name} right now`;
    if (prev === mode) return;
    const old = dom.toasts.querySelector('[data-tid="watch"]');
    if (old) old.remove();
    if (prev === 'on' && mode === 'missing') toast(`${name} was moved or deleted. You're reviewing the last copy.`, { kind: 'err', id: 'watch', ms: 7000, action: 'Open…', onAction: pickFile });
    else if (prev === 'on' && mode === 'perm') toast(`Chrome needs permission to keep reading ${name}.`, { kind: 'err', id: 'watch', ms: 7000, action: 'Reconnect', onAction: reconnect });
  }

  // ---------------------------------------------------------------------------
  // Selection pill and composer
  // ---------------------------------------------------------------------------
  let pointerDown = false;
  let overshoot = null;
  let down = { x: 0, y: 0, t: 0 };

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && p.offsetNode ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    return null;
  }
  // First and last document offsets visible in the viewport. A drag that overshoots onto the top bar
  // or past the bottom selects to there, not to the start or end of the whole document.
  function visibleEdge(top) {
    const col = docEl.getBoundingClientRect();
    const cs = getComputedStyle(docEl);
    const left = col.left + (parseFloat(cs.paddingLeft) || 0) + 1;
    const right = col.right - (parseFloat(cs.paddingRight) || 0) - 1;
    const barBottom = dom.bar.getBoundingClientRect().bottom;
    const ys = top ? [barBottom + 3, barBottom + 20] : [window.innerHeight - 3, window.innerHeight - 20];
    for (const y of ys) {
      const p = caretAt(top ? left : right, y);
      if (p && docEl.contains(p.node)) { const o = pointToOffset(p.node, p.offset); if (o != null) return o; }
    }
    return top ? 0 : state.index.text.length;
  }

  let hugeNoticeAt = 0;
  function selectionInfo() {
    if (!state.doc || !state.index || docEl.hidden) return null;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!r.intersectsNode(docEl)) return null;
    const inUi = (n) => { const e = n.nodeType === 3 ? n.parentElement : n; return !!(e && e.closest && e.closest('[data-ui]')); };
    if (inUi(r.startContainer) && inUi(r.endContainer) && r.startContainer === r.endContainer) return null;
    const startsBefore = !docEl.contains(r.startContainer) && r.comparePoint(docEl, 0) >= 0;
    const endsAfter = !docEl.contains(r.endContainer);
    let s = startsBefore ? visibleEdge(true) : pointToOffset(r.startContainer, r.startOffset);
    let e = endsAfter ? visibleEdge(false) : pointToOffset(r.endContainer, r.endOffset);
    if (s == null || e == null) return null;
    let clamped = startsBefore || endsAfter;
    if (overshoot === 'top') { const v = visibleEdge(true); if (s < v) { s = v; clamped = true; } }
    if (overshoot === 'bottom') { const v = visibleEdge(false); if (e > v) { e = v; clamped = true; } }
    const t = state.index.text;
    while (s < e && isWs(t.charCodeAt(s))) s++;
    while (e > s && isWs(t.charCodeAt(e - 1))) e--;
    if (e <= s) return null;
    if (e - s > 50000) {
      if (now() - hugeNoticeAt > 4000) { hugeNoticeAt = now(); toast('That selection is too long to comment on. Select a smaller passage, or use the general note (G).', { id: 'sel' }); }
      return null;
    }
    return { s, e, clamped };
  }

  const visibleRects = (range) => Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0);

  function updateSelectionPill() {
    if (pointerDown || !dom.composer.hidden) return;
    const info = selectionInfo();
    if (!info) { hideSelectionPill(); return; }
    const sel = window.getSelection();
    let backward = false;
    if (sel.anchorNode && sel.focusNode) {
      if (sel.anchorNode === sel.focusNode) backward = sel.focusOffset < sel.anchorOffset;
      else backward = !!(sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
    }
    // Show exactly what will be commented on when the drag ran onto the top bar or past the page.
    if (info.clamped) {
      const [sn, so] = offsetToPoint(info.s, false);
      const [en, eo] = offsetToPoint(info.e, true);
      if (backward) sel.setBaseAndExtent(en, eo, sn, so); else sel.setBaseAndExtent(sn, so, en, eo);
    }
    // The clamp is now part of the native selection; later reads must not clamp again to a scrolled view.
    overshoot = null;
    const rects = visibleRects(makeRange(info.s, info.e));
    if (!rects.length) { hideSelectionPill(); return; }
    const pill = dom.pill;
    pill.style.visibility = 'hidden';
    pill.hidden = false;
    const pw = pill.offsetWidth;
    const ph = pill.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const minTop = dom.bar.offsetHeight + 4;
    const maxTop = window.innerHeight - ph - 6;
    const first = rects[0];
    const last = rects[rects.length - 1];
    const col = docEl.getBoundingClientRect();
    const textRight = col.right - (parseFloat(getComputedStyle(docEl).paddingRight) || 0);
    const end = backward ? first : last;
    // Sit next to the selection on a spot with no text under it: the free end of the last line, then just
    // below or above the selection. The empty right margin of a wide window comes after those, and when
    // every spot covers something, the one covering least wins.
    const spots = [
      [last.right + 8, last.top + (last.height - ph) / 2],
      [last.right - pw, last.bottom + 6],
      [last.left - 4, last.bottom + 6],
      [first.left - 4, first.top - ph - 6],
      [first.right - pw, first.top - ph - 6],
    ];
    const fits = ([l, t]) => t >= minTop && t <= maxTop && l >= 8 && l + pw <= vw - 8;
    const onSelection = ([l, t]) => rects.some((r) => l < r.right && l + pw > r.left && t < r.bottom && t + ph > r.top);
    let pick = null;
    let fewest = Infinity;
    for (const spot of spots) {
      if (!fits(spot) || onSelection(spot)) continue;
      const n = textUnder(spot[0], spot[1], pw, ph);
      if (n < fewest) { fewest = n; pick = spot; }
      if (n === 0) break;
    }
    if (fewest > 0 && vw - textRight >= pw + 20) pick = [textRight + 10, clamp(end.top + (end.height - ph) / 2, minTop, maxTop)];
    let left;
    let top;
    if (pick) [left, top] = pick;
    else {
      // Nothing fits (a selection taller than the window): sit beside the visible end of the line.
      top = clamp(end.top + (end.height - ph) / 2, minTop, maxTop);
      left = end.right + 6;
      if (left + pw > vw - 8) left = end.left - pw - 6;
    }
    left = clamp(left, 8, vw - pw - 8);
    pill.style.left = `${left + window.scrollX}px`;
    pill.style.top = `${top + window.scrollY}px`;
    pill.style.visibility = '';
  }
  // How many sample points of a box (viewport coordinates) land on a visible character in the document.
  function textUnder(left, top, w, h) {
    let n = 0;
    const probe = document.createRange();
    for (const fy of [0.2, 0.5, 0.8]) {
      for (const fx of [0.04, 0.35, 0.65, 0.96]) {
        const x = left + w * fx;
        const y = top + h * fy;
        const p = caretAt(x, y);
        if (!p || p.node.nodeType !== 3 || !docEl.contains(p.node)) continue;
        const data = p.node.data;
        for (const o of [p.offset - 1, p.offset]) {
          if (o < 0 || o >= data.length || isWs(data.charCodeAt(o))) continue;
          probe.setStart(p.node, o);
          probe.setEnd(p.node, o + 1);
          const hit = Array.from(probe.getClientRects()).some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 2 && y <= r.bottom + 2);
          if (hit) { n++; break; }
        }
      }
    }
    return n;
  }
  function hideSelectionPill() { dom.pill.hidden = true; }
  const pillSoon = debounce(() => { updateSelectionPill(); tryApplyPending(); }, 120);

  const cmp = { mode: null, id: null, s: 0, e: 0, range: null, quote: '', lineStart: null, lineEnd: null, original: '', anchorEl: null, keyHeld: false, returnId: null };

  function autoGrow() {
    const ta = dom.cmpText;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.4))}px`;
  }

  function linesWord(a, b) {
    if (a == null) return '';
    return a === b || b == null ? `line ${a}` : `lines ${a}–${b}`;
  }

  // The composer is a card in the page, just under the passage it is about, as wide as the text column.
  function placeComposer() {
    if (dom.composer.hidden) return;
    const col = docEl.getBoundingClientRect();
    const cs = getComputedStyle(docEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const vw = document.documentElement.clientWidth;
    const left = Math.max(6, col.left + padL - 10);
    const width = Math.min(col.width - padL - padR + 20, vw - left - 6);
    dom.composer.style.left = `${left + window.scrollX}px`;
    dom.composer.style.width = `${width}px`;
    if (cmpSpacer && cmpSpacer.isConnected) {
      cmpSpacer.style.height = `${dom.composer.offsetHeight + 10}px`;
      dom.composer.style.top = `${cmpSpacer.getBoundingClientRect().top + window.scrollY + 2}px`;
      return;
    }
    cmpSpacer = null;
    let bottom = col.top + 40;
    const rects = cmp.range ? visibleRects(cmp.range) : [];
    if (rects.length) bottom = rects[rects.length - 1].bottom;
    else if (cmp.anchorEl && cmp.anchorEl.isConnected) bottom = cmp.anchorEl.getBoundingClientRect().bottom;
    else if (!dom.detached.hidden) bottom = dom.detached.getBoundingClientRect().bottom;
    dom.composer.style.top = `${bottom + 8 + window.scrollY}px`;
  }
  function revealComposer() {
    const r = dom.composer.getBoundingClientRect();
    const barH = dom.bar.offsetHeight;
    const rects = cmp.range ? visibleRects(cmp.range) : [];
    const anchorTop = rects.length ? rects[rects.length - 1].top : r.top - 24;
    let dy = 0;
    if (r.bottom > window.innerHeight - 10) dy = Math.min(r.bottom - (window.innerHeight - 10), Math.max(0, anchorTop - barH - 12));
    if (anchorTop < barH + 8) dy = anchorTop - barH - Math.min(120, window.innerHeight * 0.25);
    if (dy) window.scrollBy({ top: dy, behavior: 'instant' });
  }

  let cmpSpacer = null;
  function removeSpacer() { if (cmpSpacer) { cmpSpacer.remove(); cmpSpacer = null; } }
  // Reserve room for the composer right after the block that holds the passage (after its notes), so the
  // card pushes the following text down instead of covering it. A passage deep inside a long block (a big
  // code block) keeps the card right under the passage instead.
  function ensureSpacer() {
    removeSpacer();
    if (!cmp.range || !state.index) return;
    const end = cmp.mode === 'new' ? cmp.e : (byId(cmp.id) || {}).end;
    if (end == null) return;
    const spot = noteSpot({ start: end - 1, end });
    if (!spot.ref) return;
    const sp = h('div', { class: 'cmp-spacer', 'data-ui': '', 'aria-hidden': 'true' });
    if (spot.mode === 'after') {
      let a = spot.ref;
      while (a.nextElementSibling && a.nextElementSibling.classList.contains('notes')) a = a.nextElementSibling;
      a.after(sp);
    } else if (spot.mode === 'before') spot.ref.before(sp);
    else spot.ref.append(sp);
    const rects = visibleRects(cmp.range);
    const last = rects[rects.length - 1];
    if (!last || sp.getBoundingClientRect().top - last.bottom > window.innerHeight * 0.4) { sp.remove(); return; }
    cmpSpacer = sp;
  }

  function showComposer() {
    closeSurfaces(false);
    hideSelectionPill();
    dom.composer.hidden = false;
    document.documentElement.classList.add('composing');
    dom.cmpFlag.hidden = true;
    renderNotes();
    ensureSpacer();
    placeComposer();
    autoGrow();
    dom.cmpText.focus({ preventScroll: true });
    const len = dom.cmpText.value.length;
    dom.cmpText.setSelectionRange(len, len);
    revealComposer();
  }

  function openComposerNew(info, text = '', { byKey = false } = {}) {
    const range = makeRange(info.s, info.e);
    // Paint the passage before focus moves to the textarea and clears the native selection.
    hlClear('pending');
    hlAdd('pending', range);
    window.getSelection().removeAllRanges();
    selActive = false;
    Object.assign(cmp, {
      mode: 'new', id: null, s: info.s, e: info.e, range, anchorEl: null,
      quote: quoteOf(range), lineStart: lineOf(info.s), lineEnd: lineOf(info.e - 1), original: '',
      keyHeld: byKey, returnId: byKey ? '__new__' : null,
    });
    dom.cmpTitle.textContent = `New comment · ${linesWord(cmp.lineStart, cmp.lineEnd) || 'selection'}`;
    dom.cmpQuote.hidden = true;
    dom.cmpText.value = text;
    dom.cmpDelete.hidden = true;
    showComposer();
  }

  function openComposerEdit(c, text = null) {
    const note = document.querySelector(`.note[data-id="${cssId(c.id)}"]`);
    Object.assign(cmp, { mode: 'edit', id: c.id, range: c.range, anchorEl: c.range ? null : note, quote: c.quote, lineStart: c.lineStart, lineEnd: c.lineEnd, original: c.body, keyHeld: false, returnId: c.id });
    hlClear('pending');
    hlAdd('pending', c.range);
    window.getSelection().removeAllRanges();
    const where = linesWord(c.lineStart, c.lineEnd);
    dom.cmpTitle.textContent = `${c.sent ? `Sent comment${c.sentNum ? ' ' + c.sentNum : ''}` : `Comment ${c.num}`}${where ? ` · ${c.range ? '' : 'was '}${where}` : ''}`;
    dom.cmpQuote.textContent = c.quote || c.exact || '';
    dom.cmpQuote.hidden = !!c.range || !dom.cmpQuote.textContent;
    dom.cmpText.value = text == null ? c.body : text;
    dom.cmpDelete.hidden = false;
    showComposer();
    if (!c.range) { dom.cmpFlag.textContent = 'Text not in this version'; dom.cmpFlag.hidden = false; }
    else if (c.moved) { dom.cmpFlag.textContent = 'Passage may have moved'; dom.cmpFlag.hidden = false; }
    else if (c.sent) { dom.cmpFlag.textContent = 'Editing makes it unsent'; dom.cmpFlag.hidden = false; }
  }

  function composerDirty() { return !dom.composer.hidden && dom.cmpText.value.trim() !== (cmp.original || '').trim(); }

  function closeComposer(discard = false) {
    if (dom.composer.hidden) return;
    // Chrome keeps focus in a just-hidden textarea until its next focus fix-up; fast keys would land there.
    if (dom.composer.contains(document.activeElement)) document.activeElement.blur();
    dom.composer.hidden = true;
    document.documentElement.classList.remove('composing');
    removeSpacer();
    hlClear('pending');
    const returnId = cmp.returnId;
    cmp.mode = null;
    cmp.range = null;
    cmp.keyHeld = false;
    cmp.returnId = null;
    for (const n of $$('.note.editing')) n.classList.remove('editing');
    const focusId = !discard && returnId && returnId !== '__new__' ? returnId : null;
    // Keyboard users continue from the comment they were on (callers that repaint focus it again after).
    if (focusId) focusNote(focusId);
    setTimeout(() => {
      if (focusId && dom.composer.hidden && document.activeElement === document.body) focusNote(focusId);
      if (!pointerDown) tryApplyPending();
      if (state.syncPending) syncFromStore();
    }, 0);
    return focusId;
  }

  // Esc never silently drops typed text: it closes, and the toast can bring the text back.
  function cancelComposer() {
    if (dom.composer.hidden) return;
    if (!composerDirty()) { closeComposer(); return; }
    const t = state.index.text;
    const docKey = state.doc && state.doc.key;
    const snap = cmp.mode === 'new'
      ? { mode: 'new', exact: t.slice(cmp.s, cmp.e), prefix: t.slice(Math.max(0, cmp.s - 32), cmp.s), suffix: t.slice(cmp.e, cmp.e + 32), start: cmp.s, docLen: t.length, text: dom.cmpText.value, quote: cmp.quote, lineStart: cmp.lineStart, lineEnd: cmp.lineEnd }
      : { mode: 'edit', id: cmp.id, text: dom.cmpText.value };
    closeComposer();
    toast(snap.mode === 'new' ? 'Comment discarded.' : 'Edit discarded.', {
      id: 'discard',
      action: 'Undo',
      ms: 6000,
      onAction: () => {
        if (!state.doc || state.doc.key !== docKey) { toast('That comment belonged to another document.', { kind: 'err' }); return; }
        if (snap.mode === 'edit') { const c = byId(snap.id); if (c) openComposerEdit(c, snap.text); return; }
        const hit = locate(snap);
        if (hit) openComposerNew({ s: hit.s, e: hit.e }, snap.text);
        else saveDetachedDraft(snap);
      },
    });
  }

  // Keep an open composer attached to its passage across a forced re-render.
  function composerDraft() {
    if (dom.composer.hidden || !state.index) return null;
    const t = state.index.text;
    if (cmp.mode === 'new') return { mode: 'new', exact: t.slice(cmp.s, cmp.e), prefix: t.slice(Math.max(0, cmp.s - 32), cmp.s), suffix: t.slice(cmp.e, cmp.e + 32), start: cmp.s, docLen: t.length, text: dom.cmpText.value, quote: cmp.quote, lineStart: cmp.lineStart, lineEnd: cmp.lineEnd };
    return { mode: 'edit', id: cmp.id, text: dom.cmpText.value };
  }
  function restoreComposerDraft(d) {
    if (!d) return;
    dom.composer.hidden = true;
    document.documentElement.classList.remove('composing');
    removeSpacer();
    if (d.mode === 'edit') {
      const c = byId(d.id);
      if (c) { if (c.archived) { c.archived = false; anchor(c); paint(); } openComposerEdit(c, d.text); }
      return;
    }
    const hit = locate(d);
    if (hit) openComposerNew({ s: hit.s, e: hit.e }, d.text);
    else if (d.text.trim()) saveDetachedDraft(d);
  }
  // The passage is gone, but the words are not: keep them as a comment that lost its text, and reopen it.
  function saveDetachedDraft(d) {
    const c = {
      id: uid(), body: d.text.trim(), exact: d.exact, prefix: d.prefix, suffix: d.suffix, start: d.start, end: d.start + (d.exact || '').length,
      docLen: d.docLen, quote: d.quote || d.exact, lineStart: d.lineStart == null ? null : d.lineStart, lineEnd: d.lineEnd == null ? null : d.lineEnd,
      sent: false, archived: false, created: now(), updated: now(), range: null, detached: true, fuzzy: false,
    };
    state.comments.push(c);
    state.detachedOpen = true;
    paint();
    saveNow();
    openComposerEdit(c);
    toast('The passage changed, so your comment was kept as one that lost its text.', { id: 'draft' });
  }

  function saveComposer() {
    if (dom.composer.hidden) return false;
    const body = dom.cmpText.value.trim();
    if (cmp.mode === 'new') {
      if (!body) { closeComposer(); return false; }
      const t = state.index.text;
      const c = {
        id: uid(), body,
        exact: t.slice(cmp.s, cmp.e), prefix: t.slice(Math.max(0, cmp.s - 32), cmp.s), suffix: t.slice(cmp.e, cmp.e + 32),
        start: cmp.s, end: cmp.e, docLen: t.length, quote: cmp.quote, lineStart: cmp.lineStart, lineEnd: cmp.lineEnd,
        sent: false, archived: false, created: now(), updated: now(),
        range: cmp.range, detached: false, fuzzy: false,
      };
      state.comments.push(c);
      if (cmp.returnId === '__new__') cmp.returnId = c.id;
      const focusId = closeComposer();
      paint();
      if (focusId) focusNote(focusId);
      saveNow();
      return true;
    }
    const c = byId(cmp.id);
    if (!c) { closeComposer(); return false; }
    if (!body) { cmp.returnId = null; closeComposer(); deleteComment(c.id); return false; }
    if (body !== c.body) { c.body = body; c.sent = false; c.archived = false; c.sentNum = null; c.moved = false; touch(c); if (!c.range && state.index) anchor(c); }
    const focusId = closeComposer();
    paint();
    if (focusId) focusNote(focusId);
    saveNow();
    return true;
  }

  // Undo toasts belong to the document they were raised in.
  const sameDoc = (docKey) => {
    if (state.doc && state.doc.key === docKey) return true;
    toast('That change belonged to another document, so Undo did nothing.', { kind: 'err', id: 'undo' });
    return false;
  };
  function dropDocToasts() { for (const t of $$('.toast', dom.toasts)) if (t.querySelector('button')) t.remove(); }

  function deleteComment(id) {
    const i = state.comments.findIndex((c) => c.id === id);
    if (i < 0) return;
    const docKey = state.doc.key;
    const [removed] = state.comments.splice(i, 1);
    state.deleted[id] = tombstone(removed);
    paint();
    saveNow();
    toast('Comment deleted.', {
      action: 'Undo',
      onAction: () => {
        if (!sameDoc(docKey)) return;
        delete state.deleted[id];
        touch(removed);
        state.comments.splice(Math.min(i, state.comments.length), 0, removed);
        if (state.index) anchor(removed);
        paint();
        saveNow();
        focusNote(removed.id);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Output and clipboard
  // ---------------------------------------------------------------------------
  function capLine(l) {
    if (l.length <= 240) return l;
    const cps = Array.from(l);
    return cps.length <= 240 ? l : `${cps.slice(0, 160).join('')} […] ${cps.slice(-60).join('')}`;
  }
  function quoteBlock(q) {
    if (!q) return '';
    let lines = q.split('\n').map((l) => capLine(l.trimEnd()));
    if (lines.length > 10) lines = [...lines.slice(0, 6), `[… ${lines.length - 8} lines omitted …]`, ...lines.slice(-2)];
    return lines.map((l) => (l ? `> ${l}` : '>')).join('\n');
  }
  // A comment body must not be able to start a new "## Comment" section of its own.
  const escapeBody = (b) => b.split('\n').map((l) => (/^\s*#{1,6}\s+(comment\s+\d+|general note)\b/i.test(l) ? '\\' + l.trimStart() : l.trimEnd())).join('\n').trim();

  function sectionContext(c) {
    const heads = state.heads;
    let owner = -1;
    for (let i = 0; i < heads.length && heads[i].off <= c.start; i++) owner = i;
    const host = hostOf(c.start);
    if (host.closest('h1, h2, h3, h4, h5, h6')) return 'heading';
    const kind = host.closest('pre') ? (host.closest('pre.frontmatter') ? 'front matter' : 'code block') : host.closest('table') ? 'table' : '';
    let path = '';
    if (owner >= 0) {
      const o = heads[owner];
      let parent = null;
      for (let i = owner - 1; i >= 0; i--) if (heads[i].level < o.level) { parent = heads[i]; break; }
      path = [parent && parent.text, o.text].filter(Boolean).map((t) => trunc(t, 40)).join(' > ');
    }
    return [kind, path ? `under "${path}"` : ''].filter(Boolean).join(' ');
  }

  // What the review is about. A typed path or a file is named in backticks. Pasted text has no file name,
  // so it is described by its first block: a heading (or a front matter title) is its title, anything else
  // gives its first words. The "Pasted Markdown" placeholder is never used.
  function reviewTarget() {
    const p = state.path.trim();
    if (p) return { kind: 'path', label: p.includes('`') ? `\`\` ${p} \`\`` : `\`${p}\`` };
    if (state.doc.source !== 'paste') return { kind: 'file', label: `\`${state.doc.name}\`` };
    const clean = (s) => normalizeWs(s).trim().replace(/"/g, "'");
    const textOf = (el) => { const c = el.cloneNode(true); for (const u of $$('[data-ui]', c)) u.remove(); return c.textContent; };
    const titled = (t) => ({ kind: 'paste', label: `the document I copied, titled "${trunc(t, 60)}"` });
    for (const el of leavesOf(docEl)) {
      if (/^H[1-6]$/.test(el.tagName)) { const t = clean(textOf(el)); if (t) return titled(t); continue; }
      let t;
      if (el.matches('pre.frontmatter')) {
        // Metadata says little about the document, unless it names a title.
        const title = frontMatterTitle(textOf(el));
        if (title) return titled(clean(title));
        continue;
      }
      if (el.tagName === 'PRE') t = clean(textOf(el).split('\n').find((l) => l.trim()) || '');
      else if (el.tagName === 'TR') t = Array.from(el.cells, (c) => clean(textOf(c))).filter(Boolean).join(' | ');
      else t = clean(textOf(el));
      if (t) return { kind: 'paste', label: `the document I copied, which starts "${leadOf(t)}"` };
    }
    return { kind: 'paste', label: 'the document I copied' };
  }
  // A one-line YAML `title:` (plain, or in single or double quotes); anything fancier is ignored: block and
  // multi-line values, escapes other than \" and \\, null, anchors, tags and flow collections.
  function frontMatterTitle(yaml) {
    const lines = yaml.split('\n');
    const i = lines.findIndex((l) => /^title:/.test(l));
    if (i < 0) return '';
    // A continuation (an indented line, even after blank lines) makes it a multi-line value.
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (next && /^[ \t]/.test(next)) return '';
    const v = lines[i].replace(/^title:[ \t]*/, '').trim();
    if (v[0] === '"') { const q = /^"((?:[^"\\]|\\["\\])*)"/.exec(v); return q ? q[1].replace(/\\(["\\])/g, '$1') : ''; }
    if (v[0] === "'") { const q = /^'((?:[^']|'')*)'/.exec(v); return q ? q[1].replace(/''/g, "'") : ''; }
    const plain = v.replace(/[ \t]+#.*$/, '');
    if (!plain || /^(~|null)$/i.test(plain) || /^[>|&*!%@`[{#]/.test(plain)) return '';
    return plain;
  }
  // The first sentence when it is short (not cut at "Dr." or "e.g."), otherwise about 60 characters.
  function leadOf(t) {
    const end = /[.?!](?=\s|$)/g;
    for (let m = end.exec(t); m && m.index < 60; m = end.exec(t)) {
      const head = t.slice(0, m.index + 1);
      if (head.split(/\s+/).length >= 3 && !/\b(?:e\.g|i\.e|etc|vs|cf|Dr|Mr|Mrs|Ms|St|No)\.$/i.test(head)) return head.replace(/\.$/, '');
    }
    return t.length <= 60 ? t : `${t.slice(0, 60).replace(/\s+\S*$/, '') || t.slice(0, 59)}…`;
  }
  // How far the line numbers can be trusted: '' when no comment has a current one. A detached comment's
  // "was line N" is history, so with some of those present the sentence says it does not cover them.
  function linesNote(kind, items) {
    if (!items.some((c) => c.range && c.lineStart != null)) return '';
    const quotes = items.filter((c) => (c.quote || c.exact || '').trim()).length;
    const go = `so go by the ${quotes === 1 ? 'quote' : 'quotes'}`;
    const subject = items.some((c) => !c.range && c.lineStart != null) ? 'Line numbers (except those marked "was")' : 'Line numbers';
    const d = state.doc;
    if (d.source === 'paste') return `${subject} count from the first line I copied${kind === 'path' ? `, which may not be line 1 of the file, ${go}` : ''}.`;
    if (d.handle && state.liveMode === 'on' && state.pendingText == null && !watch.cand && now() - state.lastRead < 5000) return `${subject} matched the file on disk when I copied this.`;
    const at = state.loadedAt || now();
    const sameDay = new Date(at).toDateString() === new Date().toDateString();
    return `${subject} are from the copy I loaded ${sameDay ? '' : `on ${new Date(at).toLocaleDateString()} `}at ${hhmm(at)} and may have shifted, ${go}.`;
  }
  // The default header, written for this review: each sentence appears only when it is true here.
  function autoHeader(target, items, general, count) {
    const n = items.length;
    const paste = target.kind === 'paste';
    const out = [`Review of ${target.label}: ${count}.`];
    const rule = `clearly asks for a change, ${paste ? 'make it' : 'edit the file'}; if it is a question, an opinion or unclear, answer in chat without editing.`;
    if (!n) out.push(`If the note ${rule}`);
    else if (n === 1 && !general) out.push(`If the comment ${rule}`);
    else out.push(`For each comment${general ? ' and the general note' : ''}: if it ${rule}`);
    // Pasted text has no file name: say where requested changes go.
    if (paste) out.push("Make changes in the file the document comes from if you can see it; if it exists only in this chat, reply with the whole revised document; if you can't find it, ask me.");
    const quoted = items.filter((c) => (c.quote || c.exact || '').trim()).length;
    if (quoted) out.push(quoted === 1 ? 'The quote is rendered text with the Markdown syntax removed, so match it loosely.' : 'Quotes are rendered text with the Markdown syntax removed, so match them loosely.');
    const lines = linesNote(target.kind, items);
    if (lines) out.push(lines);
    const gone = items.map((c, i) => (c.range ? 0 : i + 1)).filter(Boolean);
    if (gone.length) {
      const nums = gone.length === 1 ? String(gone[0]) : `${gone.slice(0, -1).join(', ')} and ${gone[gone.length - 1]}`;
      out.push(`${gone.length === 1 ? `Comment ${nums} quotes` : `Comments ${nums} quote`} text that is no longer in the ${paste ? 'document' : 'file'}, so check whether ${gone.length === 1 ? 'it is' : 'they are'} already done before changing anything.`);
    }
    if (n + (general ? 1 : 0) === 1) out.push('End with one line saying what you did.');
    else if (!general) out.push('End with one line per comment saying what you did.');
    else out.push(`End with one line ${n === 1 ? 'for the comment' : 'per comment'} and one for the general note, saying what you did.`);
    return out.join(' ');
  }

  function buildOutput({ items, general }) {
    const target = reviewTarget();
    const count = items.length && general ? `${plural(items.length, 'comment')} and a general note` : items.length ? plural(items.length, 'comment') : 'a general note';
    let header = (settings.header || '').trim();
    if (isDefaultHeader(header)) header = autoHeader(target, items, general, count);
    else if (header) {
      // An edited header is used as written. An empty {lines} goes with the space beside it (or its whole
      // line, when it stands alone), and nothing else in the person's text changes.
      const lines = linesNote(target.kind, items);
      if (!lines) {
        header = header.replace(/^[ \t]*\{lines\}[ \t]*(?:\n|$)/gm, '');
        const gap = /[ \t]*\{lines\}[ \t]*/;
        for (let m = gap.exec(header); m; m = gap.exec(header)) {
          const before = header.slice(0, m.index);
          const after = header.slice(m.index + m[0].length);
          header = before + (!before || before.endsWith('\n') || /^($|[\n.,;:!?)])/.test(after) ? '' : ' ') + after;
        }
        header = header.trim();
      }
      // One pass, so a placeholder inside a file name or heading is not filled in again.
      const values = { file: target.label, count, lines };
      header = header.replace(/\{(file|count|lines)\}/g, (_, k) => values[k]);
    }
    if (!header) header = `Review of ${target.label}:`;
    if (/^[#/!@]/.test(header)) header = `Review: ${header}`;
    const sections = items.map((c, i) => {
      const lw = c.lineStart == null ? '' : c.lineStart === c.lineEnd ? `line ${c.lineStart}` : `lines ${c.lineStart}-${c.lineEnd}`;
      let loc;
      if (!c.range) {
        loc = `${lw ? `was ${lw}; ` : ''}the quoted text is no longer in the ${target.kind === 'paste' ? 'document' : 'file'}, so it may already be changed`;
      } else {
        loc = [lw, sectionContext(c)].filter(Boolean).join(', ');
        if (c.fuzzy) loc += '; text edited since I commented';
        else if (c.moved) loc += '; the passage seems to have moved since I commented, so check it is the right one';
      }
      const quote = quoteBlock(c.range && c.fuzzy ? quoteOf(c.range) : c.quote || c.exact);
      return `## Comment ${i + 1}${loc ? ` (${loc})` : ''}\n${quote ? quote + '\n\n' : ''}${escapeBody(c.body)}`;
    });
    if (general) sections.push(`## General note\n${escapeBody(general)}`);
    return `${header}\n\n${sections.join('\n\n')}\n`.replace(/[ \t]+\n/g, '\n');
  }

  function currentBatch(all = false) {
    const list = ordered();
    const items = all ? list : list.filter((c) => !c.sent);
    const general = state.general.trim() && (all || !state.generalSent) ? state.general.trim() : '';
    if (items.length || general) return { items, general, again: false };
    const lb = state.lastBatch;
    if (lb) {
      const ids = new Set(lb.ids);
      const again = list.filter((c) => ids.has(c.id));
      const g = lb.general ? state.general.trim() : '';
      if (again.length || g) return { items: again, general: g, again: true };
    }
    return { items: [], general: '', again: false };
  }

  // Clipboard API first; then a copy-event fallback that moves neither focus nor the selection.
  function execCopy(text) {
    let ok = false;
    const onCopy = (e) => { e.clipboardData.setData('text/plain', text); e.preventDefault(); ok = true; };
    document.addEventListener('copy', onCopy, true);
    try { document.execCommand('copy'); } catch { ok = false; }
    document.removeEventListener('copy', onCopy, true);
    return ok;
  }
  async function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    return execCopy(text);
  }

  function markSent(batch) {
    if (batch.again || !state.doc || state.doc.key !== batch.docKey) return;
    const at = now();
    // Mark only what is on the clipboard: a comment edited while the write was pending stays unsent.
    const copied = [];
    batch.items.forEach((c, i) => {
      const live = byId(c.id);
      if (!live || (live.updated || 0) !== batch.rev.get(c.id)) return;
      live.sent = true; live.sentAt = at; live.sentNum = i + 1; touch(live);
      copied.push(live.id);
    });
    const general = batch.general && state.generalAt === batch.generalAt;
    if (general) { state.generalSent = true; state.generalSentAt = at; state.generalAt = at; }
    state.lastBatch = { ids: copied, general: !!general };
    clearChanges();
    paint();
    saveNow();
  }
  function copiedToast(batch) {
    const n = batch.items.length;
    const what = [n ? plural(n, 'comment') : '', batch.general ? (n ? 'general note' : 'the general note') : ''].filter(Boolean).join(' + ');
    toast(`Copied ${what}, ready to paste.`, { kind: 'ok', id: 'copy', ms: 2500 });
  }

  let copying = false;
  let manualCopyOff = null;
  function copyReview({ all = false } = {}) {
    if (!state.doc || copying) return;
    if (manualCopyOff) manualCopyOff();
    if (!dom.composer.hidden) {
      if (cmp.mode && dom.cmpText.value.trim()) saveComposer();
      else closeComposer();
    }
    // A copy is a commit point: take in any disk change being held, so line numbers match the file.
    if (state.pendingText != null) { window.getSelection().removeAllRanges(); selActive = false; tryApplyPending(true); }
    const batch = currentBatch(all);
    if (!batch.items.length && !batch.general) {
      toast('Nothing to copy yet. Select text and press C to comment.', { id: 'copy' });
      return;
    }
    const text = buildOutput(batch);
    batch.docKey = state.doc.key;
    batch.rev = new Map(batch.items.map((c) => [c.id, c.updated || 0]));
    batch.generalAt = state.generalAt;
    copying = true;
    writeClipboard(text).then((ok) => {
      copying = false;
      if (!ok) {
        openReview();
        dom.previewBox.open = true;
        dom.preview.textContent = text;
        const r = document.createRange();
        r.selectNodeContents(dom.preview);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        // If the user copies the whole selected preview by hand, count it as sent. A partial copy, or a
        // preview that has changed since, does not count.
        const flat = (x) => x.replace(/\s+/g, ' ').trim();
        const onCopy = () => {
          const s = window.getSelection();
          if (!s.rangeCount || !dom.preview.contains(s.anchorNode)) return;
          if (dom.preview.textContent !== text || flat(s.toString()) !== flat(text)) return;
          off();
          markSent(batch);
          copiedToast(batch);
        };
        const off = () => { document.removeEventListener('copy', onCopy); manualCopyOff = null; };
        document.addEventListener('copy', onCopy);
        manualCopyOff = off;
        toast(`Couldn't reach the clipboard. The review is selected in the preview; press ${MOD_LABEL}C.`, { kind: 'err', id: 'copy', ms: 8000 });
        return;
      }
      markSent(batch);
      copiedToast(batch);
    });
  }

  // Undo puts back only what a clear removed; edits and deletions made since then stay.
  function restoreRemoved(gone, extra) {
    const have = new Set(state.comments.map((c) => c.id));
    for (const c of gone) {
      if (have.has(c.id)) continue;
      delete state.deleted[c.id];
      touch(c);
      if (state.index) anchor(c);
      state.comments.push(c);
    }
    if (extra) {
      if (!state.general.trim()) { state.general = extra.general; state.generalSent = extra.generalSent; state.generalAt = now(); dom.general.value = state.general; }
      if (!state.lastBatch) state.lastBatch = extra.lastBatch;
    }
    paint();
    saveNow();
  }
  function clearWhere(pred, label) {
    const gone = state.comments.filter(pred);
    if (!gone.length) return;
    const lastBatch = state.lastBatch;
    for (const c of gone) state.deleted[c.id] = tombstone(c);
    state.comments = state.comments.filter((c) => !pred(c));
    state.lastBatch = null;
    paint();
    saveNow();
    const docKey = state.doc.key;
    toast(`Cleared ${plural(gone.length, label)}.`, { action: 'Undo', onAction: () => { if (sameDoc(docKey)) restoreRemoved(gone, { general: '', generalSent: false, lastBatch }); } });
  }
  const clearSent = () => clearWhere((c) => c.sent && !c.archived, 'sent comment');
  const clearArchived = () => clearWhere((c) => c.archived, 'earlier comment');
  function clearAll() {
    if (!state.comments.length && !state.general) return;
    const gone = state.comments.slice();
    const extra = { general: state.general, generalSent: state.generalSent, lastBatch: state.lastBatch };
    const n = state.comments.length;
    for (const c of state.comments) state.deleted[c.id] = tombstone(c);
    state.comments = [];
    state.general = '';
    state.generalAt = now();
    state.generalSent = false;
    state.lastBatch = null;
    dom.general.value = '';
    paint();
    saveNow();
    const docKey = state.doc.key;
    toast(`Cleared ${plural(n, 'comment')}.`, { action: 'Undo', onAction: () => { if (sameDoc(docKey)) restoreRemoved(gone, extra); } });
  }
  function restoreArchived(id) {
    const c = byId(id);
    if (!c) return;
    c.archived = false;
    c.sent = false;
    c.sentNum = null;
    touch(c);
    anchor(c);
    paint();
    saveNow();
  }

  // ---------------------------------------------------------------------------
  // Top bar, outline, review drawer
  // ---------------------------------------------------------------------------
  // What Copy will send, in one label used by the top bar, the end of the document and the Review drawer.
  // The count is comments only; the general note shows as "+ note".
  function copyLabel(batch) {
    const n = batch.items.length;
    if (batch.again) return 'Copy again';
    if (n && batch.general) return `Copy ${n} + note`;
    if (n) return `Copy ${n}`;
    return batch.general ? 'Copy note' : 'Copy';
  }
  function updateBar() {
    const live = active();
    const batch = currentBatch();
    dom.chipCount.textContent = String(live.length);
    dom.chip.setAttribute('aria-label', `${plural(live.length, 'comment')}. Review (R)`);
    const has = batch.items.length + (batch.general ? 1 : 0);
    dom.copyLabel.textContent = copyLabel(batch);
    dom.copy.classList.toggle('quiet', batch.again);
    dom.copy.classList.toggle('idle', !has);
    dom.copy.title = `${batch.again ? 'Copy the last review again' : has ? 'Copy the review to the clipboard' : 'Nothing to copy yet'} (${MOD_LABEL}Enter)`;
    renderDocEnd(batch, has);
  }

  function renderDocEnd(batch, has) {
    if (!state.doc) return;
    const general = state.general.trim();
    fill(dom.docEnd,
      general
        ? h('button', { type: 'button', class: 'note general-note' + (state.generalSent ? ' sent' : ''), 'aria-label': `General note: ${sentence(general)} Enter to edit.`, onclick: () => openReview({ focusGeneral: true }) },
          h('span', { class: 'n', 'aria-hidden': 'true' }, 'Note'), h('span', { class: 'b' }, general))
        : h('button', { type: 'button', class: 'text-btn', onclick: () => openReview({ focusGeneral: true }) }, '+ General note', ' ', h('kbd', null, 'G')),
      has || batch.again ? h('button', { type: 'button', class: 'primary-btn small' + (batch.again ? ' quiet' : ''), onclick: () => copyReview() }, copyLabel(batch), h('kbd', null, `${MOD_LABEL}Enter`)) : null);
  }

  function renderOutline() {
    const heads = state.heads;
    if (!heads.length) {
      fill(dom.outlineList, h('p', { class: 'outline-empty' }, 'This document has no headings.'));
      return;
    }
    const counts = new Map();
    for (const c of active()) {
      if (!c.range || c.sent) continue;
      let owner = null;
      for (const hd of heads) { if (hd.off <= c.start) owner = hd; else break; }
      if (owner) counts.set(owner, (counts.get(owner) || 0) + 1);
    }
    fill(dom.outlineList, heads.map((hd) => h('a', {
      href: '#' + hd.el.id,
      'data-l': hd.level,
      onclick: (e) => {
        e.preventDefault();
        closeSurfaces(false);
        hd.el.scrollIntoView({ block: 'start', behavior: 'instant' });
        hd.el.setAttribute('tabindex', '-1');
        hd.el.focus({ preventScroll: true });
        updateCurrentSection();
      },
    }, h('span', { class: 't' }, hd.text || '(untitled)'), counts.get(hd) ? h('span', { class: 'c', title: plural(counts.get(hd), 'unsent comment') }, String(counts.get(hd))) : null)));
    currentHead = undefined;
    if (!dom.outline.hidden) updateCurrentSection();
  }

  let currentHead;
  function updateCurrentSection() {
    if (!state.doc) return;
    const heads = state.heads;
    const barH = dom.bar.offsetHeight;
    const y = barH + Math.min(160, (window.innerHeight - barH) * 0.25);
    let lo = 0;
    let hi = heads.length - 1;
    let cur = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (heads[mid].el.getBoundingClientRect().top <= y) { cur = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const hd = cur >= 0 ? heads[cur] : null;
    if (hd === currentHead) return;
    currentHead = hd;
    dom.crumbSec.textContent = hd ? hd.text : '';
    dom.outlineList.querySelectorAll('a').forEach((a, i) => a.classList.toggle('current', i === cur));
  }
  // The section label changes only when scrolling stops, so it is not moving in the corner of your eye.
  const onScrollEnd = () => { updateCurrentSection(); saveScroll(); };
  if ('onscrollend' in window) window.addEventListener('scrollend', onScrollEnd);
  else window.addEventListener('scroll', debounce(onScrollEnd, 150), { passive: true });

  function reviewItem(c) {
    const meta = h('div', { class: 'top' },
      c.archived ? null : c.sent ? h('span', null, `✓ sent${c.sentNum ? ' #' + c.sentNum : ''}`) : h('span', { class: 'n' }, `#${c.num}`),
      h('span', null, linesWord(c.lineStart, c.lineEnd)),
      !c.archived && !c.range ? h('span', { class: 'warn' }, 'text not found') : !c.archived && c.fuzzy ? h('span', { class: 'warn' }, 'text edited') : null);
    const body = [h('div', { class: 'q' }, `“${(c.quote || c.exact || '').split('\n')[0]}”`), h('div', { class: 'b' }, c.body)];
    if (c.archived) {
      meta.append(h('button', {
        type: 'button',
        class: 'act link-btn',
        onclick: () => {
          restoreArchived(c.id);
          const next = dom.reviewList.querySelector('details[open] .act') || dom.reviewList.querySelector('details summary') || dom.review.querySelector('[data-close]');
          if (next) next.focus({ preventScroll: true });
        },
      }, 'Restore'));
      return h('div', { class: 'review-item archived' }, meta, body);
    }
    return h('button', {
      type: 'button',
      class: 'review-item' + (c.sent ? ' sent' : ''),
      onclick: () => { closeSurfaces(false); scrollToComment(c, { focus: true }); },
    }, meta, body);
  }

  function renderReview() {
    const list = ordered();
    const unsent = list.filter((c) => !c.sent);
    const sent = list.filter((c) => c.sent);
    const archived = state.comments.filter((c) => c.archived).sort((a, b) => (a.lineStart || 0) - (b.lineStart || 0));
    const groups = [];
    if (unsent.length) groups.push(h('div', { class: 'review-group' }, h('h3', null, `To send · ${unsent.length}`), unsent.map(reviewItem)));
    if (sent.length) {
      groups.push(h('div', { class: 'review-group' },
        h('h3', null, h('span', null, `Sent · ${sent.length}`), h('button', { type: 'button', class: 'link-btn', onclick: clearSent }, 'Clear')),
        sent.map(reviewItem)));
    }
    if (archived.length) {
      groups.push(h('details', { class: 'review-group', open: state.earlierOpen || null, ontoggle: (e) => { state.earlierOpen = e.currentTarget.open; } },
        h('summary', null, h('span', null, `Earlier rounds · ${archived.length}`), h('button', { type: 'button', class: 'link-btn', onclick: (e) => { e.preventDefault(); clearArchived(); } }, 'Clear')),
        archived.map(reviewItem)));
    }
    if (!unsent.length && !sent.length) groups.unshift(h('p', { class: 'review-empty' }, 'No open comments. Select text in the document and press ', h('kbd', null, 'C'), '.'));
    fill(dom.reviewList, groups);
    if (document.activeElement !== dom.general) dom.general.value = state.general;
    if (document.activeElement !== dom.path) dom.path.value = state.path;
    renderPreview();
  }
  function renderPreview() {
    const batch = currentBatch();
    const has = batch.items.length || batch.general;
    dom.preview.textContent = has ? buildOutput(batch) : 'Nothing to copy yet.';
    dom.copy2.textContent = copyLabel(batch);
    dom.copy2.disabled = !has;
    dom.copy2.classList.toggle('quiet', batch.again);
    const what = [batch.items.length ? plural(batch.items.length, 'comment') : '', batch.general ? 'general note' : ''].filter(Boolean).join(' + ');
    dom.footSummary.textContent = !has ? 'Nothing to send yet' : batch.again ? `Last copy: ${what}` : `Ready: ${what}`;
  }

  // ---------------------------------------------------------------------------
  // Surfaces: drawers, menu, modals
  // ---------------------------------------------------------------------------
  let lastFocus = null;
  const surfaces = () => [dom.menu, dom.outline, dom.review, dom.settings, dom.help];
  const backdrop = () => [dom.bar, dom.main, dom.pill, dom.composer];

  function openSurface(el, opener) {
    closeSurfaces(false);
    const ae = document.activeElement;
    const usable = (el) => el && el !== document.body && el !== document.documentElement && isVisible(el);
    lastFocus = usable(opener) ? opener : usable(ae) ? ae : null;
    el.hidden = false;
    if (el === dom.outline || el === dom.review) {
      dom.scrim.hidden = false;
      el.insertBefore(dom.toasts, el.querySelector('.drawer-foot'));
    }
    document.documentElement.classList.toggle('drawer-right-open', el === dom.review);
    document.documentElement.classList.toggle('drawer-left-open', el === dom.outline);
    // Dialogs and drawers keep focus to themselves: everything behind them is inert.
    if (el !== dom.menu) for (const b of backdrop()) b.inert = true;
    dom.outlineBtn.setAttribute('aria-expanded', String(el === dom.outline));
    dom.chip.setAttribute('aria-expanded', String(el === dom.review));
    dom.menuBtn.setAttribute('aria-expanded', String(el === dom.menu));
  }
  function closeSurfaces(restore = true) {
    let closed = false;
    for (const s of surfaces()) if (!s.hidden) { s.hidden = true; closed = true; }
    dom.scrim.hidden = true;
    if (dom.toasts.parentElement !== document.body) document.body.append(dom.toasts);
    document.documentElement.classList.remove('drawer-right-open', 'drawer-left-open');
    for (const b of backdrop()) b.inert = false;
    dom.outlineBtn.setAttribute('aria-expanded', 'false');
    dom.chip.setAttribute('aria-expanded', 'false');
    dom.menuBtn.setAttribute('aria-expanded', 'false');
    if (closed && restore) {
      if (lastFocus && isVisible(lastFocus)) lastFocus.focus({ preventScroll: true });
      else if (document.activeElement && document.activeElement !== document.body && !isVisible(document.activeElement)) document.activeElement.blur();
    }
    if (closed) setTimeout(() => tryApplyPending(), 0);
    return closed;
  }

  function toggleOutline() {
    if (!state.doc) return;
    if (!dom.outline.hidden) { closeSurfaces(); return; }
    closeComposerIfClean();
    openSurface(dom.outline, dom.outlineBtn);
    currentHead = undefined;
    updateCurrentSection();
    const cur = dom.outlineList.querySelector('a.current') || dom.outlineList.querySelector('a');
    if (cur) { cur.scrollIntoView({ block: 'nearest' }); cur.focus({ preventScroll: true }); }
  }

  function openReview({ focusGeneral = false, opener = dom.chip } = {}) {
    if (!state.doc) return;
    closeComposerIfClean();
    renderReview();
    dom.previewBox.open = !!settings.previewOpen;
    openSurface(dom.review, opener);
    if (focusGeneral) { dom.general.focus(); dom.general.setSelectionRange(dom.general.value.length, dom.general.value.length); }
    else dom.review.querySelector('[data-close]').focus({ preventScroll: true });
  }
  const toggleReview = (opener) => { if (!dom.review.hidden) closeSurfaces(); else openReview({ opener }); };
  function closeComposerIfClean() { if (!dom.composer.hidden && !composerDirty()) closeComposer(); }

  function openMenu() {
    if (!dom.menu.hidden) { closeSurfaces(); return; }
    const hasHandle = !!(state.doc && state.doc.handle);
    const anySent = active().some((c) => c.sent);
    const item = (label, key, fn, opts = {}) => h('button', { type: 'button', role: 'menuitem', tabindex: '-1', class: opts.danger ? 'danger' : null, disabled: opts.disabled || null, onclick: () => { closeSurfaces(false); fn(); } },
      h('span', null, label), key ? h('span', { class: 'k' }, key) : null);
    fill(dom.menu,
      item('Open file…', `${MOD_LABEL}O`, pickFile),
      item('Reload from disk', '', () => (state.liveMode === 'perm' || state.liveMode === 'missing' ? reconnect() : checkFile(true)), { disabled: !hasHandle }),
      item('Open Markdown from clipboard', '', pasteFromClipboard),
      h('hr'),
      item(`Review (${active().length})`, 'R', () => openReview()),
      item('Copy review', `${MOD_LABEL}Enter`, () => copyReview(), { disabled: !active().length && !state.general.trim() }),
      item('Copy all, sent included', `${SHIFT_MOD_LABEL}Enter`, () => copyReview({ all: true }), { disabled: !active().length && !state.general.trim() }),
      item('Outline', 'O', toggleOutline),
      item('Next changed block', 'N', () => navChanges(1), { disabled: !state.changes.length }),
      item(settings.notes ? 'Hide inline comments' : 'Show inline comments', '', () => { settings.notes = !settings.notes; applySettings(); saveSettings(); paint(); }),
      item('Settings…', '', () => openSettings(dom.menuBtn)),
      item('Keyboard shortcuts', '?', () => openHelp(dom.menuBtn)),
      h('hr'),
      item('Clear sent comments', '', clearSent, { disabled: !anySent }),
      item('Clear all comments', '', clearAll, { danger: true, disabled: !state.comments.length && !state.general }),
      item('Close document', '', closeDocument));
    openSurface(dom.menu, dom.menuBtn);
    placeMenu();
    const first = dom.menu.querySelector('button:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }
  // The menu hangs from its button, wherever the top bar puts it.
  function placeMenu() {
    if (dom.menu.hidden) return;
    // Measure from where right: 8px actually lands; the viewport's reserved scrollbar gutter varies.
    dom.menu.style.right = '8px';
    const shift = dom.menu.getBoundingClientRect().right - dom.menuBtn.getBoundingClientRect().right;
    dom.menu.style.right = `${Math.max(8, 8 + shift)}px`;
  }
  dom.menu.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); closeSurfaces(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = $$('button:not([disabled])', dom.menu);
    const i = items.indexOf(document.activeElement);
    let j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
    j = (j + items.length) % items.length;
    items[j].focus();
  });
  dom.menu.addEventListener('focusout', (e) => {
    if (dom.menu.hidden) return;
    const to = e.relatedTarget;
    if (to && !dom.menu.contains(to) && !dom.menuBtn.contains(to)) closeSurfaces(false);
  });

  function setSeg(id, value) { for (const b of $$('button', $(id))) b.setAttribute('aria-pressed', String(b.dataset.v === value)); }
  function openSettings(opener) {
    $('#set-header').value = settings.header;
    $('#set-wrap').checked = !!settings.wrap;
    $('#set-notes').checked = !!settings.notes;
    $('#set-hints').checked = !!settings.scrollHints;
    setSeg('#set-theme', settings.theme);
    setSeg('#set-size', settings.size);
    setSeg('#set-width', settings.width);
    openSurface(dom.settings, opener || dom.menuBtn);
    ($('#set-size button[aria-pressed="true"]') || $('#set-size button')).focus({ preventScroll: true });
  }

  function openHelp(opener) {
    openSurface(dom.help, opener);
    dom.help.querySelector('[data-close]').focus({ preventScroll: true });
  }

  function buildKeys() {
    const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join('');
    const rows = [
      [`${k('C')} or ${k('Enter')}`, 'Comment on the selected text'],
      [k('Enter'), 'Save the comment'],
      [k('Shift') + k('Enter'), 'New line in a comment'],
      [k(`${MOD_LABEL}Enter`), 'Copy the review (in a comment: save, then copy)'],
      [k('Shift') + k(`${MOD_LABEL}Enter`), 'Copy all of this round, sent comments included'],
      [k('Esc'), 'Close, or cancel the comment (Undo brings it back)'],
      [`${k('J')} ${k('K')}`, 'Next or previous comment (Enter edits it)'],
      [`${k('N')} ${k('Shift') + k('N')}`, 'Next or previous change after the file changes on disk'],
      [k('G'), 'General note'],
      [k('R'), 'Review: all comments, file path, copy preview'],
      [k('O'), 'Outline of headings'],
      [k(`${MOD_LABEL}O`), 'Open a Markdown file'],
      [k('?'), 'This list'],
    ];
    $('#keys').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
    for (const kb of $$('kbd[data-mod]')) kb.textContent = MOD_LABEL + kb.textContent;
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------
  const toastTimers = new Map();
  function toast(msg, { kind = '', action = null, actionClass = null, onAction = null, ms = 3800, id = null, keep = false } = {}) {
    if (id) {
      const old = dom.toasts.querySelector(`[data-tid="${id}"]`);
      if (old) { clearTimeout(toastTimers.get(old)); old.remove(); }
    }
    const node = h('div', { class: `toast ${kind}`, 'data-tid': id, 'data-keep': keep || null }, h('span', { class: 'msg' }, msg));
    const dismiss = () => {
      clearTimeout(toastTimers.get(node));
      toastTimers.delete(node);
      const hadFocus = node.contains(document.activeElement);
      node.remove();
      if (hadFocus && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    };
    if (action && onAction) node.append(h('button', { type: 'button', class: actionClass, onclick: () => { dismiss(); onAction(); } }, action));
    const arm = () => { clearTimeout(toastTimers.get(node)); toastTimers.set(node, setTimeout(dismiss, ms)); };
    const pause = () => clearTimeout(toastTimers.get(node));
    // A toast never disappears while the pointer or keyboard focus is on it.
    node.addEventListener('mouseenter', pause);
    node.addEventListener('mouseleave', () => { if (!node.contains(document.activeElement)) arm(); });
    node.addEventListener('focusin', pause);
    node.addEventListener('focusout', (e) => { if (!node.contains(e.relatedTarget)) arm(); });
    // Plain notices give way to a newer one; toasts with an action (Undo, Next change) stay their time.
    for (const t of $$('.toast', dom.toasts)) if (t !== node && !t.querySelector('button') && !t.hasAttribute('data-keep') && !t.contains(document.activeElement)) t.remove();
    dom.toasts.append(node);
    while (dom.toasts.children.length > 3) dom.toasts.firstElementChild.remove();
    arm();
    return node;
  }
  onStorageLost = () => {
    const how = location.protocol === 'data:' ? ' To keep them, open this file from a local web server (http://localhost) instead.' : '';
    toast(`This browser isn't letting the page save. Comments last only while this tab is open.${how}`, { kind: 'err', ms: 12000, id: 'storage' });
    if (dom.fine) dom.fine.textContent = `This browser isn't saving: documents and comments last only while this tab is open.${how}`;
  };

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (navActiveId) { navActiveId = null; setActive(null); }
    if (dom.pill.contains(e.target) || dom.composer.contains(e.target)) return;
    pointerDown = true;
    overshoot = null;
    // While dragging out a selection, toasts must not catch the pointer.
    if (docEl.contains(e.target)) document.documentElement.classList.add('dragging');
    down = { x: e.clientX, y: e.clientY, t: now() };
    if (!dom.composer.hidden && !composerDirty() && !dom.bar.contains(e.target)) closeComposer(true);
  }, true);
  document.addEventListener('pointerup', (e) => {
    document.documentElement.classList.remove('dragging');
    if (!pointerDown) return;
    pointerDown = false;
    // A drag released over the top bar (or below the window) means "up to what I can see".
    const barBottom = dom.bar.hidden ? 0 : dom.bar.getBoundingClientRect().bottom;
    overshoot = e.clientY <= barBottom ? 'top' : e.clientY >= window.innerHeight - 1 ? 'bottom' : null;
    setTimeout(() => { updateSelectionPill(); tryApplyPending(); }, 0);
  }, true);
  document.addEventListener('pointercancel', () => { pointerDown = false; document.documentElement.classList.remove('dragging'); }, true);
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const on = !!(sel && sel.rangeCount && !sel.isCollapsed && sel.getRangeAt(0).intersectsNode(docEl));
    if (on && !selActive) selAt = now();
    selActive = on;
    if (!pointerDown) pillSoon();
  });
  window.addEventListener('resize', () => { hideSelectionPill(); invalidateRects(); placeComposer(); placeMenu(); markAllOverflow(); pillSoon(); });
  new ResizeObserver(() => { invalidateRects(); if (!dom.composer.hidden) placeComposer(); }).observe(docEl);

  dom.pill.addEventListener('pointerdown', (e) => e.preventDefault());
  dom.pill.addEventListener('mousedown', (e) => e.preventDefault());
  dom.pill.addEventListener('click', () => { const info = selectionInfo(); if (info) openComposerNew(info); });

  function onNoteClick(e) {
    const note = e.target.closest('.note');
    if (!note) return false;
    const c = byId(note.dataset.id);
    if (c) openComposerEdit(c);
    return true;
  }
  dom.detached.addEventListener('click', onNoteClick);
  let clickTimer = 0;
  docEl.addEventListener('click', (e) => {
    if (onNoteClick(e)) return;
    // The second click of a double-click selects a word; it must not open an editor.
    if (e.detail > 1) { clearTimeout(clickTimer); return; }
    if (e.button !== 0 || e.target.closest('a, button, input, summary')) return;
    if (!window.getSelection().isCollapsed) return;
    // A click, not the end of a drag or a slow press.
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || now() - down.t > 600) return;
    const c = commentAtPoint(e.clientX, e.clientY);
    if (!c) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { if (window.getSelection().isCollapsed && byId(c.id) && dom.composer.hidden) openComposerEdit(c); }, 230);
  });
  let hoverRaf = 0;
  let hoverId = null;
  docEl.addEventListener('mousemove', (e) => {
    if (hoverRaf) return;
    const { clientX: x, clientY: y, target } = e;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (pointerDown || navActiveId) return;
      const note = target.closest && target.closest('.note');
      const c = note ? byId(note.dataset.id) : commentAtPoint(x, y);
      docEl.style.cursor = c && !note ? 'pointer' : '';
      const id = c ? c.id : null;
      if (id !== hoverId) { hoverId = id; if (dom.composer.hidden) setActive(id); }
    });
  });
  docEl.addEventListener('mouseleave', () => { hoverId = null; docEl.style.cursor = ''; if (dom.composer.hidden && !navActiveId) setActive(null); });
  docEl.addEventListener('focusin', (e) => { const note = e.target.closest('.note'); if (note && dom.composer.hidden) setActive(note.dataset.id); });
  docEl.addEventListener('focusout', (e) => { if (e.target.closest('.note') && dom.composer.hidden && !navActiveId) setActive(null); });

  dom.cmpText.addEventListener('input', () => {
    autoGrow();
    placeComposer();
    // Keep the card on screen as it grows.
    const r = dom.composer.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 10) window.scrollBy({ top: r.bottom - window.innerHeight + 10, behavior: 'instant' });
  });
  dom.cmpText.addEventListener('keydown', (e) => {
    if (dom.composer.hidden || e.isComposing || e.keyCode === 229) return;
    // Auto-repeat of the key that opened the composer must neither type into it nor save it.
    if (e.repeat && cmp.keyHeld) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelComposer(); return; }
    if (e.key !== 'Enter') return;
    const modEnter = isMod(e) || (IS_MAC && e.ctrlKey);
    if (modEnter) {
      e.preventDefault();
      e.stopPropagation();
      saveComposer();
      copyReview({ all: e.shiftKey });
    } else if (!e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      saveComposer();
    }
  });
  document.addEventListener('keyup', () => { cmp.keyHeld = false; });
  dom.cmpSave.addEventListener('click', saveComposer);
  dom.cmpCancel.addEventListener('click', cancelComposer);
  dom.cmpDelete.addEventListener('click', () => { const id = cmp.id; cmp.returnId = null; closeComposer(); deleteComment(id); });

  dom.copy.addEventListener('click', () => copyReview());
  dom.copy2.addEventListener('click', () => copyReview());
  dom.chip.addEventListener('click', () => toggleReview(dom.chip));
  dom.outlineBtn.addEventListener('click', toggleOutline);
  dom.crumb.addEventListener('click', toggleOutline);
  dom.menuBtn.addEventListener('click', openMenu);
  dom.reconnect.addEventListener('click', reconnect);
  dom.pending.addEventListener('click', () => { window.getSelection().removeAllRanges(); selActive = false; tryApplyPending(true); });
  dom.scrim.addEventListener('click', () => closeSurfaces());
  for (const b of $$('[data-close]')) b.addEventListener('click', () => closeSurfaces());
  for (const m of [dom.settings, dom.help]) m.addEventListener('click', (e) => { if (e.target === m) closeSurfaces(); });
  dom.previewBox.addEventListener('toggle', () => { settings.previewOpen = dom.previewBox.open; saveSettings(); });
  if (dom.forgetAll) dom.forgetAll.addEventListener('click', forgetAll);

  function setGeneral(text) {
    state.general = text;
    state.generalAt = now();
    state.generalSent = false;
    if (dom.general.value !== text) dom.general.value = text;
    saveSoon();
    updateBar();
    renderPreview();
  }
  dom.general.addEventListener('input', () => setGeneral(dom.general.value));
  dom.path.addEventListener('input', () => { state.path = dom.path.value; state.pathAt = now(); saveSoon(); renderPreview(); });
  for (const f of [dom.general, dom.path]) f.addEventListener('blur', () => { saveSoon.flush(); setTimeout(() => tryApplyPending(), 0); });

  $('#set-header').addEventListener('input', (e) => { settings.header = e.target.value; saveSettings(); });
  $('#set-header-reset').addEventListener('click', () => { settings.header = DEFAULT_HEADER; $('#set-header').value = DEFAULT_HEADER; saveSettings(); if (state.doc) renderPreview(); });
  $('#set-wrap').addEventListener('change', (e) => { settings.wrap = e.target.checked; applySettings(); saveSettings(); });
  $('#set-notes').addEventListener('change', (e) => { settings.notes = e.target.checked; applySettings(); saveSettings(); paint(); });
  $('#set-hints').addEventListener('change', (e) => { settings.scrollHints = e.target.checked; applySettings(); saveSettings(); });
  // The system theme can change while the page is open (the browser's colour is the only thing CSS can't follow).
  if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applySettings());
  for (const [id, key] of [['#set-theme', 'theme'], ['#set-size', 'size'], ['#set-width', 'width']]) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[key] = b.dataset.v;
      setSeg(id, settings[key]);
      applySettings();
      saveSettings();
    });
  }

  dom.drop.addEventListener('click', pickFile);
  $('#try-sample').addEventListener('click', () => openDocument({ name: 'showcase.md', text: normalizeSource(SAMPLE), source: 'file' }));
  dom.fileInput.addEventListener('change', async () => {
    const f = dom.fileInput.files && dom.fileInput.files[0];
    dom.fileInput.value = '';
    if (f) await openFile(f);
  });

  // Drag and drop: never let the browser navigate away to a dropped file or link.
  let dragTimer = 0;
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  window.addEventListener('dragover', (e) => {
    if (isEditable(e.target) && !hasFiles(e)) return;
    e.preventDefault();
    if (!hasFiles(e)) { e.dataTransfer.dropEffect = 'none'; return; }
    e.dataTransfer.dropEffect = 'copy';
    dom.dropzone.hidden = false;
    dom.drop.classList.add('over');
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => { dom.dropzone.hidden = true; dom.drop.classList.remove('over'); }, 160);
  }, true);
  window.addEventListener('drop', (e) => {
    if (isEditable(e.target) && !hasFiles(e)) return;
    e.preventDefault();
    dom.dropzone.hidden = true;
    dom.drop.classList.remove('over');
    // DataTransfer items are only readable synchronously, inside this handler.
    const item = Array.from(e.dataTransfer.items || []).find((i) => i.kind === 'file');
    if (!item) return;
    const handlePromise = typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null;
    const file = item.getAsFile();
    (async () => {
      let handle = null;
      if (handlePromise) { try { handle = await handlePromise; } catch { handle = null; } }
      if (handle && handle.kind !== 'file') { toast('Drop a single Markdown file, not a folder.', { kind: 'err' }); return; }
      if (handle) await openHandle(handle);
      else await openFile(file);
    })();
  }, true);

  document.addEventListener('paste', (e) => {
    if (isEditable(e.target) || state.doc) return;
    const file = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
    if (file) { e.preventDefault(); openFile(file); return; }
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (text && text.trim()) { e.preventDefault(); openPasted(text); }
  });

  function navComments(dir) {
    const list = ordered().filter((c) => c.range);
    if (!list.length) {
      const earlier = state.comments.filter((c) => c.archived).length;
      toast(earlier ? `No open comments. ${earlier} ${earlier === 1 ? 'is' : 'are'} in Earlier rounds (R).` : 'No comments in this document yet.', { id: 'nav' });
      return;
    }
    let i;
    const cur = navActiveId ? list.findIndex((c) => c.id === navActiveId) : -1;
    if (cur >= 0) i = cur + dir;
    else {
      const land = landingY();
      const tops = list.map((c) => c.range.getBoundingClientRect().top);
      if (dir > 0) i = tops.findIndex((t) => t > land + 8);
      else { i = -1; for (let j = tops.length - 1; j >= 0; j--) if (tops[j] < land - 8) { i = j; break; } }
      if (i < 0) i = dir > 0 ? 0 : list.length - 1;
    }
    i = (i + list.length) % list.length;
    scrollToComment(list[i], { persist: true, focus: true });
  }
  window.addEventListener('wheel', () => { changePos = -1; }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    const key = e.key;
    const name = keyName(e);
    if (navActiveId && !['j', 'k', 'Enter', 'Shift'].includes(name)) { navActiveId = null; setActive(null); }
    if (SCROLL_KEYS.has(key)) changePos = -1;
    if (isMod(e) && !e.altKey && !e.shiftKey && name === 'o') { e.preventDefault(); pickFile(); return; }
    if (isMod(e) && !e.altKey && !e.shiftKey && name === 's') { e.preventDefault(); toast('Comments save automatically in this browser.', { id: 'save' }); return; }
    if (key === 'Enter' && !e.altKey && (isMod(e) || (IS_MAC && e.ctrlKey && !e.metaKey))) {
      if (dom.composer.contains(e.target)) return;
      e.preventDefault();
      copyReview({ all: e.shiftKey });
      return;
    }
    if (key === 'Escape') {
      if (closeSurfaces()) { e.preventDefault(); return; }
      if (!dom.composer.hidden) { e.preventDefault(); cancelComposer(); return; }
      if (!dom.pill.hidden || selActive) { window.getSelection().removeAllRanges(); hideSelectionPill(); e.preventDefault(); return; }
      if (state.changes.length) { clearChanges(); e.preventDefault(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return;
    if (!dom.settings.hidden || !dom.help.hidden) return;
    if (name === '?') { e.preventDefault(); openHelp(document.activeElement); return; }
    if (!state.doc) return;
    if (name === 'c' || key === 'Enter') {
      if (e.repeat) return;
      const onControl = e.target.closest && e.target.closest('button, a, summary, [role="button"]');
      const info = dom.composer.hidden ? selectionInfo() : null;
      if (info && !(key === 'Enter' && onControl)) { e.preventDefault(); openComposerNew(info, '', { byKey: true }); return; }
      // Enter on the comment J/K landed on edits it.
      if (key === 'Enter' && !onControl && navActiveId) { const c = byId(navActiveId); if (c) { e.preventDefault(); openComposerEdit(c); } }
      return;
    }
    if (!dom.menu.hidden || !dom.review.hidden || !dom.outline.hidden) {
      if ((name === 'r' && !dom.review.hidden) || (name === 'o' && !dom.outline.hidden)) { e.preventDefault(); closeSurfaces(); }
      return;
    }
    switch (name) {
      case 'j': e.preventDefault(); navComments(1); break;
      case 'k': e.preventDefault(); navComments(-1); break;
      case 'n': e.preventDefault(); navChanges(e.shiftKey ? -1 : 1); break;
      case 'g': e.preventDefault(); openReview({ focusGeneral: true, opener: document.activeElement }); break;
      case 'r': e.preventDefault(); toggleReview(document.activeElement); break;
      case 'o': e.preventDefault(); toggleOutline(); break;
      default: break;
    }
  });

  // ---------------------------------------------------------------------------
  // Opening a document from a link or a script (README, "For agents")
  // ---------------------------------------------------------------------------
  // #name=PLAN.md&path=docs/PLAN.md&md64=<base64 of the UTF-8 file>, or md=<percent-encoded text>.
  // Parsed by hand: URLSearchParams would turn the "+" of base64 into spaces.
  function linkParams(hash) {
    const out = {};
    for (const part of hash.replace(/^#/, '').split('&')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      const key = part.slice(0, eq);
      try { out[key] = decodeURIComponent(part.slice(eq + 1)); } catch { out[key] = null; }
    }
    return out;
  }
  function decodeBase64Text(s) {
    let t = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    t += '='.repeat((4 - (t.length % 4)) % 4);
    const bin = atob(t);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  async function openFromLink() {
    const p = linkParams(location.hash);
    if (!('md' in p) && !('md64' in p)) return false;
    // The text leaves the address bar, so a reload restores the saved copy rather than the link's.
    try { history.replaceState(null, '', location.href.split('#')[0]); } catch { /* a data: page */ }
    let text = null;
    try {
      const raw = 'md64' in p ? p.md64 : p.md;
      if (raw != null) text = 'md64' in p ? decodeBase64Text(raw) : raw;
    } catch { text = null; }
    const fail = (why) => { toast(`The link's document couldn't be opened: ${why}.`, { kind: 'err', ms: 10000, id: 'link' }); return false; };
    if (text == null) return fail('use md64= (base64 of the UTF-8 file) or md= (percent-encoded text)');
    if (p.name === null || p.path === null) return fail('its name or path is not valid percent-encoding');
    try { await openShared({ text, name: p.name, path: p.path, fromLink: true }); } catch (e) { return fail(e.message); }
    return true;
  }
  // A document handed over as text: a snapshot of a named file when a name or path comes with it,
  // otherwise like pasted text. The same name and path again later updates that document in place.
  // Throws an Error that says why when nothing can be opened.
  async function openShared({ text, name, path, fromLink = false } = {}) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const p = typeof path === 'string' ? path.trim() : '';
    const n = (typeof name === 'string' && name.trim()) || (p ? p.split(/[\\/]/).pop() : '');
    const body = normalizeSource(text);
    if (!body.trim()) throw new Error('the document is empty');
    if (body.length > 20 * 1024 * 1024) throw new Error('the document is over 20 MB');
    const web = fromLink && /^https?:$/.test(location.protocol);
    // Any web page can send a tab to a link on an http(s) address, so there a link only reopens a record with
    // exactly its path and text. Anything else opens as a separate copy: a few are kept, and one becomes an
    // ordinary saved document once it holds a comment. (Pages can't link to file://, and scripts are same-page.)
    if (!n) { await openPasted(body, { copy: web }); return; }
    let { rec } = await findRecord(n, null, p, true, body);
    const other = !!(web && rec && (rec.path || '') !== p);
    if (other) rec = null;
    if (rec && rec.handle) {
      // The person follows this file live: show that document, which reads the file itself. If the file
      // can't be read just now, the link's text is newer than the saved copy, so it comes in as an update.
      await leaveCurrent();
      const read = await reopen(rec.key);
      if (!web) {
        if (p && !state.path) { state.path = p; state.pathAt = now(); saveSoon(); }
        if (!read && state.doc && state.doc.text !== body) applyUpdate(body);
      } else if (!read && state.doc && state.doc.text !== body) {
        await openDocument({ name: n, text: body, source: 'file', path: p, fresh: true, copy: true });
        toast(`Couldn't read ${n} from disk, so the link's text opened as a separate copy beside your saved ${n}.`, { id: 'link', ms: 12000 });
        return;
      }
      toast(`Showing ${n}, which this page follows on disk.`, { id: 'link', ms: 8000 });
      return;
    }
    const follow = PICKER ? ` To follow the file, open it with ${MOD_LABEL}O.` : '';
    if (web && (other || (rec && rec.text !== body))) {
      await openDocument({ name: n, text: body, source: 'file', path: p, fresh: true, copy: true });
      toast(`Opened ${n} from a link as a separate copy: on a web address, a link can't replace your saved ${n}.`, { id: 'link', ms: 12000 });
      return;
    }
    await openDocument({ name: n, text: body, source: 'file', path: p, shared: true, fresh: web && !rec, copy: web });
    toast(`Opened ${n} as a snapshot: it won't follow changes on disk.${follow}`, { id: 'link', ms: 9000 });
  }
  // What opening another document does first: keep the draft, save, stop watching, close panels.
  async function leaveCurrent() {
    dropDocToasts();
    if (state.doc) {
      keepDraftBeforeLeaving();
      saveScroll.flush();
      saveSoon.cancel();
      await saveNow();
    }
    stopWatch();
    closeComposer(true);
    closeSurfaces(false);
  }
  function docInfo() {
    if (!state.doc) return null;
    return { name: state.doc.name, path: state.path || '', source: state.doc.source === 'paste' ? 'paste' : 'file', live: state.liveMode === 'on', generalNote: state.general.trim() };
  }
  function commentInfo(c) {
    return {
      id: c.id,
      n: c.sent ? null : c.num ?? null,
      quote: c.quote || c.exact || '',
      comment: c.body,
      lineStart: c.lineStart ?? null,
      lineEnd: c.lineEnd ?? null,
      section: c.range ? sectionContext(c) : '',
      sent: !!c.sent,
      detached: !c.range,
    };
  }
  // Comments made, changed or deleted by a script go through the same paths as the person's own, so they
  // look, save, sync to other tabs and undo the same way.
  function apiDoc(fn) {
    if (!state.doc || !state.index) throw new Error(`markdownAnnotator.${fn}: no document is open`);
  }
  function apiBody(fn, comment) {
    const body = typeof comment === 'string' ? comment.trim() : '';
    if (!body) throw new TypeError(`markdownAnnotator.${fn}: comment must be a non-empty string`);
    return body;
  }
  // Where a quote is in the rendered text, in document order: each whitespace run in the quote matches any
  // whitespace, or nothing at a line break (<br>), which leaves no space in the page's text.
  function findQuote(quote) {
    const t = state.index.text;
    const q = typeof quote === 'string' ? quote.trim() : '';
    if (!q) return [];
    const words = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const { breaks } = state.index;
    const re = new RegExp(words.join('(\\s*)'), 'gd');
    const hits = [];
    for (let m = re.exec(t); m; m = re.exec(t)) {
      // A gap with no whitespace must sit on a <br>: "now here" never matches "nowhere".
      if (m[0] && m.indices.slice(1).every(([a, b]) => b > a || breaks.has(a))) hits.push([m.index, m.index + m[0].length]);
      re.lastIndex = m.index + 1;
    }
    return hits;
  }
  function apiAdd({ quote, comment, occurrence } = {}) {
    apiDoc('addComment');
    const body = apiBody('addComment', comment);
    const hits = findQuote(quote);
    const shown = JSON.stringify(trunc(String(quote ?? ''), 80));
    if (!hits.length) throw new Error(`markdownAnnotator.addComment: ${shown} is not in the rendered text (quote what the page shows, without Markdown syntax)`);
    if (hits.length > 1 && occurrence == null) throw new Error(`markdownAnnotator.addComment: ${shown} appears ${hits.length} times; pass occurrence: 1 to ${hits.length}`);
    const k = occurrence == null ? 1 : occurrence;
    if (!Number.isInteger(k) || k < 1 || k > hits.length) throw new RangeError(`markdownAnnotator.addComment: occurrence must be a whole number from 1 to ${hits.length}`);
    const [s, e] = hits[k - 1];
    const t = state.index.text;
    const range = makeRange(s, e);
    const ls = lineOf(s);
    const le = lineOf(e - 1);
    const c = {
      id: uid(), body,
      exact: t.slice(s, e), prefix: t.slice(Math.max(0, s - 32), s), suffix: t.slice(e, e + 32),
      start: s, end: e, docLen: t.length, quote: quoteOf(range), lineStart: ls, lineEnd: ls == null ? null : Math.max(ls, le ?? ls),
      sent: false, archived: false, created: now(), updated: now(),
      range, detached: false, fuzzy: false,
    };
    state.comments.push(c);
    paint();
    saveNow();
    return commentInfo(c);
  }
  // A comment by its id, or by the number shown on its note.
  function apiFind(fn, ref) {
    const c = typeof ref === 'string' ? byId(ref) : Number.isInteger(ref) ? active().find((x) => x.num === ref) : null;
    if (!c || c.archived) throw new Error(`markdownAnnotator.${fn}: no current comment ${JSON.stringify(ref)} (use an id or the number from comments())`);
    if (!dom.composer.hidden && cmp.mode === 'edit' && cmp.id === c.id) throw new Error(`markdownAnnotator.${fn}: comment ${JSON.stringify(ref)} is open in the editor right now`);
    return c;
  }
  function apiEdit(ref, comment) {
    apiDoc('editComment');
    const c = apiFind('editComment', ref);
    const body = apiBody('editComment', comment);
    if (body !== c.body) { c.body = body; c.sent = false; c.archived = false; c.sentNum = null; c.moved = false; touch(c); if (!c.range && state.index) anchor(c); }
    paint();
    saveNow();
    return commentInfo(c);
  }
  function apiDelete(ref) {
    apiDoc('deleteComment');
    const c = apiFind('deleteComment', ref);
    deleteComment(c.id);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------
  async function init() {
    applySettings();
    buildKeys();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await replayJournals();
    window.addEventListener('hashchange', () => { openFromLink(); });
    if (await openFromLink()) return;
    let restored = false;
    try {
      // This tab's own document survives a reload; a new tab opens the last document saved anywhere.
      const last = ssGet(`${NS}.tab`) || (await store.getMeta('last'));
      if (last) {
        const rec = await store.get(last);
        if (rec && typeof rec.text === 'string' && !state.doc) { await restoreRecord(rec); restored = true; }
      }
    } catch (e) {
      console.warn('[markdown-annotator] could not restore the last document', e);
    }
    if (!restored && !state.doc) await showEmpty();
  }

  const readyPromise = init();

  // The scripting interface for agents and automation (README, "For agents"). Reading never marks
  // anything as sent.
  window.markdownAnnotator = Object.freeze({
    version: VERSION,
    ready: readyPromise.then(() => undefined),
    async open(opts) {
      const { text, name, path } = opts ?? {};
      await readyPromise;
      try { await openShared({ text, name, path }); } catch (e) { throw new (e instanceof TypeError ? TypeError : Error)(`markdownAnnotator.open: ${e.message}`); }
      return docInfo();
    },
    // What Copy would copy now ('' when there is nothing).
    review({ all = false } = {}) {
      if (!state.doc) return '';
      const b = currentBatch(!!all);
      return b.items.length || b.general ? buildOutput(b) : '';
    },
    comments() { return state.doc ? ordered().map(commentInfo) : []; },
    document: docInfo,
    // The document's Markdown source as it is now ('' when none is open).
    markdown() { return state.doc ? state.doc.text : ''; },
    addComment: (opts) => apiAdd(opts),
    editComment: (ref, comment) => apiEdit(ref, comment),
    deleteComment: (ref) => apiDelete(ref),
    setGeneralNote(text) {
      apiDoc('setGeneralNote');
      if (typeof text !== 'string') throw new TypeError('markdownAnnotator.setGeneralNote: text must be a string');
      setGeneral(text);
      paint();
      return docInfo();
    },
  });

  // A small, stable hook for automated tests and for inspecting state from DevTools.
  window.__markdownAnnotator = {
    state,
    settings,
    output: (all = false) => { const b = currentBatch(all); return b.items.length || b.general ? buildOutput(b) : ''; },
    openText: (name, text, source = 'file') => openDocument({ name, text: normalizeSource(text), source }),
    openHandle: (handle) => openHandle(handle),
    records: () => store.all(),
    applyUpdate: (text) => applyUpdate(normalizeSource(text)),
    copy: (opts) => copyReview(opts),
    selectText(exact, nth = 0) {
      const t = state.index.text;
      let i = -1;
      for (let k = 0; k <= nth; k++) { i = t.indexOf(exact, i + 1); if (i < 0) return false; }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(makeRange(i, i + exact.length));
      updateSelectionPill();
      return true;
    },
    ready: readyPromise,
  };
})();
