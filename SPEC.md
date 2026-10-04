# Markdown Annotator (`markdown-annotator.html`)

A single, self-contained HTML file for annotating Markdown, dark or light (Settings: System, the default, Light
or Dark). You open a Markdown file, highlight passages,
attach comments, and press one key. The page puts one consolidated review on the clipboard, ready to paste
wherever the feedback goes: an AI coding agent such as Claude Code (the main use), a chat, or a pull request.
The review loop is inspired by [Ch00k/claude-review](https://github.com/Ch00k/claude-review) (public domain, under the Unlicense), but
this page needs no daemon, no database and no slash commands.

Target: desktop Chrome (current stable) on macOS and Windows, opened from disk (`file://`) or any static host.
Primary layout: a narrow browser window split-screened beside an agent's terminal (roughly 360–900 px wide).

## Priorities (in order)

1. **Low friction.** Getting from opening a file to pasting the review takes the fewest possible steps. Every
   frequent action has a key. Nothing destructive happens without an Undo, and nothing asks for confirmation.
2. **Low distraction.** The document is the page. The chrome is quiet, opaque and static: no motion in peripheral
   vision, and no animation beyond a short toast fade (`prefers-reduced-motion` removes it). Colour is reserved
   for comments (amber). Change markers are a neutral green-grey.
3. **Readability of long, structured Markdown.** Headings form a clear hierarchy, nested lists have guides, code
   and tables never break the layout, and an outline is one key away.
4. **Narrow viewports.** Everything works at 360 px. Nothing depends on a side gutter.

## Distribution and build

- `src/index.html`, `src/styles.css` and `src/app.js` are inlined, with markdown-it 14 (MIT), into one file,
  `markdown-annotator.html`, by `node build.mjs`. There is no network access at runtime and there are no web fonts. A
  CSP blocks every fetch (`connect-src 'none'`) and every external script.
- No server. It works from `file://`, where Chrome treats the page as a secure context for the Clipboard and
  File System Access APIs. All `file://` pages share one storage origin, so every key is namespaced
  `markdown-annotator.v1`.

## Core loop

1. **Open.** Use drag-and-drop anywhere, `Mod+O`, the drop zone, or paste Markdown text on the start screen.
   When Chrome provides a `FileSystemFileHandle` (from `showOpenFilePicker`, or from a drop that calls
   `getAsFileSystemHandle` synchronously), the file is **watched**. While the page is visible it is polled every
   1 s, and also checked when the window regains focus. A change re-renders in place. Without a handle (an
   `<input type=file>` fallback, or a paste) the document is a snapshot.
2. **Comment.** Select text in the rendered document. A small "Comment C" pill appears next to the selection, on a
   spot with no text under it: the free end of the last line, else just below or above the selection, else the
   right margin of a wide window. Press `C` or `Enter`, or click the pill, to open the **composer**: a card
   placed in the page just under the passage, as wide as the text column. The passage stays painted (blue) while
   you type. `Enter` saves, `Shift+Enter` adds a newline, `Mod+Enter` saves and then copies, and `Esc` cancels.
   Cancelling discarded text shows an Undo toast that reopens the composer.
3. **Review.** Saved comments are painted with the CSS Custom Highlight API (amber underline plus tint). There is
   no DOM wrapping, so overlapping selections and selections spanning several blocks both work. A quiet
   **inline note** (number plus the first two lines) sits after the leaf block that holds the end of the
   passage. Clicking a note, or clicking a highlight (a real click, not the end of a drag), reopens the composer
   to edit or delete. `J`/`K` step through comments.
4. **Copy.** `Mod+Enter`, or the "Copy N" button, copies the review. Copied comments become **sent**: dimmed,
   marked with ✓, and left out of the next copy. When nothing is unsent, the button reads "Copy again" and
   re-copies the last batch. "Copy all, sent included" in the menu (`Shift+Mod+Enter`) copies everything that is
   not archived. A comment is marked sent only after the clipboard write succeeds, and only in the revision
   that was copied: an edit made while the write was pending stays unsent. If the write fails, the Review
   drawer opens with the preview text selected. Undo toasts belong to their document: switching documents
   removes them, and an Undo never acts on another document.
5. **Next round.** When the watched file changes, every comment that was sent *before the change was
   detected* is **archived**: it appears only under Review → Earlier rounds, with Restore. A comment open in
   the composer is never archived. Changed blocks get a quiet bar in the gutter, a deletion gets a dashed bar
   on the block that follows it, and `N`/`Shift+N` step through them. The marks are measured against the
   round's baseline (the document as it was before the first update since the last copy or Esc), so a reply
   made of several Edit calls keeps every mark. Unsent comments re-anchor.
   The change is held back while the user is mid-action: the composer is open, a pointer is down, the general
   note or path field is focused, or a selection made in the last 15 s exists in a focused window. A blue
   "Updated ↻" button applies it at once; otherwise it applies when the action ends or the window loses focus.
   A copy is a commit point: a held update is applied before the review is built, so line numbers always
   match the file. A change counts only once it is stable (the same size and mtime on two reads about 300 ms
   apart, and 2 s for an empty read), so a truncate-then-write save never flashes an empty document. The
   file's metadata (mtime, size) is committed together with the text it belongs to, never while the text
   is held back, and a restored document re-reads its file once, so a reload can never keep stale text.
   Scroll is restored by block content (up to six leaf blocks from the top of the viewport), not by pixel.

## Agents and scripts

- **Link:** `#md64=<base64 of UTF-8>` or `#md=<percent-encoded text>` (`md64` wins), with optional `name=` and
  `path=`, parsed by hand (a `+` stays a `+`). Read at start-up and on `hashchange`, then removed from the address
  bar with `history.replaceState`, so a reload restores the saved copy. With a name or path (name defaults to the
  path's last part) the text opens as a snapshot of that file (no handle, `source: 'file'`), and `path` fills
  "File path in the review". Without either it opens like pasted text. A link or script joins the record with
  the same name and path (one with the same text first; a live record with no path yet is adopted); without a
  path, only a record with neither a path nor a handle. Joining a record whose text differs updates it in place
  (changes marked, sent comments archived), except on an http(s) page, where any web page could send that link.
  There a link only joins a record with exactly its path and text, and anything else (a new name, a new path, an
  unnamed paste, or different text) opens as a separate copy (`copy: true`). Pruning keeps the five newest copies
  and deletes older ones before any ordinary record, so links can't push saved reviews out; a copy becomes an
  ordinary record once it holds a comment or a general note, or when the person opens or pastes it themselves. A
  record the person follows live is brought up as it is (it reads the file itself); if the file can't be read just
  then, the link's text comes in as an update, or on an http(s) page as a separate copy. An empty document, undecodable text, an invalid percent-encoded name or path, or over 20 MB is
  refused with a toast that says why. A comment being typed is saved first, with its own toast.
- **API:** `window.markdownAnnotator` (frozen): `version`, `ready`, `open({ text, name, path })` → the document
  info (it throws an Error saying why when nothing opens), `review({ all })` → what Copy would copy (`''` if nothing), `comments()` → `{ id, n, quote, comment,
  lineStart, lineEnd, section, sent, detached }`, `document()` → `{ name, path, source, live, generalNote }` or
  null, `markdown()` → the source text. Reading never marks anything sent.
  Writing: `addComment({ quote, comment, occurrence })` finds the quote in the rendered text (as given, then
  with any whitespace run matching any other), refuses a missing quote or an ambiguous one without a 1-based
  `occurrence`, and creates the comment exactly as the composer would (anchor, lines, quote). `editComment(ref,
  comment)` and `deleteComment(ref)` take an id or the number on the note, refuse a comment open in the
  composer, and go through the person's own paths (a delete shows Undo). `setGeneralNote(text)` sets the note.
  Errors are thrown with a message that says what to fix. `window.__markdownAnnotator` stays the test hook.
- **Readable without scripts:** each inline note's accessible name gives its line and quote ("Comment 1, line
  17, on "…": …"), and the general note shows at the end of the document, so page text and the accessibility
  tree carry every comment.
- **Instructions:** an HTML comment right after the doctype explains the link, the API, the Windows
  command-line limit (a launcher page with a meta refresh for bigger files) and `data:` previews.
- **`data:` pages** (app previews) have no storage; the storage warning there adds "open this file from a local
  web server (http://localhost) instead".

## Output format

The review starts with one paragraph of instructions. Left as the default, it is written for the review at hand
(below); edited in Settings, the person's text is used as written, with `{file}`, `{count}` and `{lines}` filled in.
A watched file, two comments and a general note:

```
Review of `PLAN.md`: 2 comments and a general note. For each comment and the general note: if it clearly asks for a change, edit the file; if it is a question, an opinion or unclear, answer in chat without editing. Quotes are rendered text with the Markdown syntax removed, so match them loosely. Line numbers matched the file on disk when I copied this. End with one line per comment and one for the general note, saying what you did.

## Comment 1 (line 35, under "Plan: Async Deploy Pipeline > Design")
> The combination of mutex (for in-process synchronization) and database queries

Why not advisory locks here?

## Comment 2 (line 52, code block under "Design > Step 6: Add Helper Function for Status…")
> return domain.ProjectStatusFailed

Use Unknown, not Failed.

## General note
Tighten the intro; it repeats the summary.
```

- The default header is built from sentences that each appear only when they are true for this review:
  1. `Review of {file}: {count}.`
  2. The rule, with a lead that matches the content: `For each comment[ and the general note]: if it clearly asks
     for a change, edit the file; if it is a question, an opinion or unclear, answer in chat without editing.`, or
     `If the comment …` (one comment, no note), or `If the note …` (a general note only). For pasted text, "edit
     the file" is "make it".
  3. Pasted text without a typed path: `Make changes in the file the document comes from if you can see it; if it
     exists only in this chat, reply with the whole revised document; if you can't find it, ask me.`
  4. With quotes: `Quotes are rendered text with the Markdown syntax removed, so match them loosely.` (singular for
     one quote).
  5. With line numbers: `{lines}`.
  6. With detached comments: `Comment N quotes text that is no longer in the file, so check whether it is already
     done before changing anything.` (or `Comments 2 and 4 quote …`; "document" instead of "file" for pasted text).
  7. The report: `End with one line saying what you did.` (one item), `… one line per comment …`, or `… one line
     per comment and one for the general note, saying what you did.`
  The old default header, saved by earlier versions, counts as the default.
- `{file}` is the optional per-document "File path in the review" (Review drawer) in backticks, otherwise the file
  name in backticks. A typed path makes pasted text count as that file. Pasted text without a path is described
  by its first block with text: `the document I copied, titled "<heading>"` when that is a heading (or front
  matter with a one-line `title:`, plain or quoted, an inline `# comment` dropped), otherwise `the document I
  copied, which starts "<lead>"`, where the lead is the block's text (a code block's first non-empty line, a table
  row's cells joined with ` | `) cut to its first sentence when that has at least three words and ends within 60
  characters (not at "e.g." or "Dr."), else to about 60 characters at a word, with `…`. Front matter without a
  usable title is skipped. The "Pasted Markdown" placeholder name is never used.
- `{count}` is "N comment(s)", "N comment(s) and a general note", or "a general note".
- `{lines}` is "Line numbers matched the file on disk when I copied this." when the watched file was read in the
  last 5 s, otherwise "Line numbers are from the copy I loaded at HH:MM and may have shifted, so go by the
  quotes."; for pasted text "Line numbers count from the first line I copied." (plus ", which may not be line 1 of
  the file, so go by the quotes" with a typed path). It is empty when no comment has a current line number (the
  old line of a detached comment does not count), and with detached comments present it starts `Line numbers
  (except those marked "was")`. In an edited header the placeholders are filled in one pass (a `{lines}` inside a
  typed path stays as typed), and an empty `{lines}` is removed together with the space beside it, or with its
  whole line when it stands alone; nothing else in the person's text changes.
- Comments are numbered 1..N in document order, and detached comments come last.
- Location: `line N` / `lines A-B` (1-based, ASCII hyphen), then the block kind (`code block`, `table`,
  `heading`, `front matter`), then `under "Parent > Heading"` (at most two levels, 40 characters each).
- A **fuzzy** re-anchor (the passage was edited, but its head and tail are still found close together) adds
  `; text edited since I commented` and quotes the current text. A unique exact match that shares little
  context with where the comment was, and sits far from it, adds `; the passage seems to have moved since I
  commented, so check it is the right one`. The flag is saved with the comment and stays until the comment is
  edited, because the new position is no evidence that the match is right. A **detached** comment reads `(was line N; the
  quoted text is no longer in the file, so it may already be changed)`.
- Quotes are the rendered text of the passage, read with innerText from the cloned range in an off-screen
  probe that is rendered, not hidden. Tight list items stay one per line, and tabs in code are kept. Only the
  separators between table cells become ` | `. Each line is capped at 240 code points: the first 160, then
  ` […] `, then the last 60. A quote of more than 10 lines keeps the first 6 and the last 2, with
  `[… N lines omitted …]` between them.
- No `---` separators. Files are read as UTF-8 (a warning shows if the file is not valid UTF-8), or as
  UTF-16 when the file starts with a byte-order mark. Lines in a comment body that would start a new `## Comment N` or `## General note`
  section are escaped with a backslash. The output never starts with `#`, `/`, `!` or `@`.

## Anchoring and line numbers

- markdown-it `token.map` (0-based, `[start, end)`) becomes `data-ls`/`data-le` (1-based, inclusive) on every
  rendered block. Tight-list paragraphs are un-hidden (`p.tight`, zero margin), so list-item text has its own
  leaf element. Fences carry `data-cl` (the source line of the first content line).
- The line of a point is its leaf block's `data-ls`, plus the newlines before the point within that block (soft
  breaks in paragraphs, lines in code). Source newlines that leave no text behind (inside a code span, an image,
  or a link destination) are recorded as `data-nl` on that element and added in. A code span also records
  where its newlines were (`data-nlpos`), so a point inside it gets its own line. The result is clamped to the
  block; for fences, it is clamped to the content lines (`data-cl`..`data-ce`), so an unterminated fence ends on
  its true last line.
- The text index is the concatenation of the document's text nodes, excluding `[data-ui]` (notes and missing
  image labels), plus a whitespace-collapsed view for matching. A comment stores `exact`, a 32-character
  `prefix` and `suffix`, `start`, `docLen`, `quote` and its lines.
- Re-anchoring finds every occurrence of `exact` in the collapsed view and scores each one by context match and
  by relative-position drift (prefix and suffix keep their boundary whitespace). If several copies of the
  text exist and the best one has little shared context and has moved far, it is treated as a twin, not the
  passage; as the only copy, it is accepted but flagged as moved. Then, if the passage is at least 24
  characters, a fuzzy match on a chunk near its start and one near its end is tried (the second chunk too,
  so an edit inside the first or last chunk still matches). Each end is then pulled onto the passage's own
  first or last characters if they are nearby, or else onto a word boundary. A fuzzy match needs a context
  score of at least 12 after an 8-point penalty. Anything else is **detached**. Unsent detached
  comments are summarised in one strip above the document ("N comments lost their text · Show"). If a forced
  update or an Undo removes the passage a draft was about, the draft is saved as a detached comment, never
  dropped.

## Layout and readability

- **Top bar** (42 px, opaque, sticky): outline button; the file name with a live-watch dot, and from 700 px the
  current section (updated on `scrollend`); "Updated ↻" or "Reconnect" when relevant; the comment-count chip
  (from 480 px; opens Review); the primary Copy button; the overflow menu.
- **Reading column:** `--measure` of 40rem (Narrow 34, Wide 52), gutters `clamp(16px, 4vw, 32px)`, body text 16 px
  (S/M/L = 15/16/18) with line height 1.65. Colours (dark): text #d4d8de on #0e1013; all text at least 5.1:1. Light: text #1f2328 on #ffffff; all
  text at least 4.6:1 on the page, its panels and hover fills. The theme is System (the default), Light or Dark.
- **Headings:** H1 and H2 carry a hairline rule; H3–H6 step down in size; H6 is uppercase.
- **Lists:** disc, circle, square; nested numbering is decimal, then lower-alpha, then lower-roman; a 1 px guide
  line runs down each nested level.
- **Code blocks:** wrap by default (Settings toggle), with wrapped continuations indented 4ch past the start of
  their source line. Box-drawing diagrams and directory trees never wrap.
- **Tables:** sit in a horizontal scroll container. Below 560 px a table is at least 14ch per column wide and
  short cells (18 characters or fewer) do not wrap, so it scrolls instead of stacking words.
- **Sideways scrolling** (tables, diagrams, code with wrapping off): the edge that has more fades out, and a
  "Scroll sideways for more →" label pinned under the visible part says so (a Settings checkbox hides the label;
  the fade stays).
- **Toasts** float at the bottom of the window; with a drawer open they sit inside it, between its body and its
  footer, and take room there instead of covering anything.
- **Front matter:** `---` at line 1, closed by `---` or `...`, renders as a dashed, muted block, but only if
  every line inside looks like YAML (`key: value`, indented, `- item` or `#`) and at least one key line is
  present. A document that opens with a `---` rule renders normally.
- **Outline drawer** (`O`): H1–H4, the current section marked, a count of unsent comments per section.
- **Review drawer** (`R`): To send, Sent (with Clear), Earlier rounds (collapsed), the general note, the file path
  to name, the copy preview (collapsible; its open state is remembered), and Copy.

## Keyboard (`Mod` is ⌘ on macOS and Ctrl elsewhere; labels adapt)

| Key | Action |
|---|---|
| `Mod+O` | Open a file (overrides Chrome's open dialog) |
| `C` or `Enter` with a selection | Comment on the selection |
| `Enter` / `Shift+Enter` / `Mod+Enter` / `Esc` (composer) | Save / newline / save and copy / cancel (Undo available) |
| `Mod+Enter` | Copy the review (`Shift` included: copy all open comments) |
| `J` / `K` | Next or previous comment (focus moves to its note; `Enter` edits it) |
| `N` / `Shift+N` | Next or previous changed block |
| `G` | General note |
| `R` | Review drawer |
| `O` | Outline |
| `?` | Shortcut help |
| `Esc` | Close the composer, drawer or menu; clear the selection; clear the change marks |
| `Mod+S` | Caught; shows "Comments save automatically" instead of Save Page As |

Bare keys fire only without Ctrl, ⌘ or Alt, never during IME composition (no shortcut does), and never in a
text field. `Enter` on a focused button keeps its normal meaning. Auto-repeat of the key that opened the
composer is ignored inside it. Settings, Help, Review and Outline are dialogs: everything behind them is
inert. The menu uses a roving focus, and Tab or focus leaving it closes it. When the composer closes, focus
returns to the comment's note.

## Persistence

- IndexedDB `markdown-annotator.v1`, with a `docs` store keyed by `file:<name>[:<id>]` or `paste:<hash>`. Each record
  holds the text, the comments (each with an `updated` time), tombstones for deleted comments, the general note
  and the path to name (each with its own timestamp), `live` when it follows a file on disk, `loadedAt`, and
  `updatedAt`. A record never holds the `FileSystemFileHandle`: Chrome 153 and 154 crash the whole browser when a
  tab closes while an IndexedDB write holding a handle is in flight. Each handle is kept in the `meta` store
  under `handle:<key>`, written when the file is opened or reconnected and read only when a tab restores or
  reopens that document (records saved by 1.0.0 are moved over on the next start). Files with the same name are
  told apart with `isSameEntry`. A file opened without a handle joins only a record that never had one.
  Settings and the per-document scroll position are kept in `localStorage`.
- Every save is a read-merge-write in one IndexedDB transaction. Comments merge by id: the newer `updated`
  wins, and a tombstone wins over anything older than itself. Two tabs therefore never overwrite each other.
  Discrete actions save at once. A page being hidden saves only when something changed since the last save,
  and `pagehide` starts no IndexedDB work at all: it writes a small synchronous `localStorage` journal (one per
  tab) when something is unsaved. Another open tab merges that journal at once (the `storage` event), or the
  next start does, so closing or reloading right after a change loses nothing.
- Each tab restores its own document after a reload (`sessionStorage`); a new tab opens the most recent one.
  Close document sticks. At most 30 documents are kept. Forget and **Forget all** (start screen) both offer
  Undo. If IndexedDB is unavailable, the page says so and keeps everything in memory for the tab.
- A refresh restores the last document immediately from the cached text. If Chrome still grants read
  permission, watching resumes; otherwise a "Reconnect" button asks for it.
- Chrome 153 and early 154 builds (before 154.0.8037.95) crash the whole browser when an Incognito or Guest
  window reads a file handle back from IndexedDB (crbug 562119515), and a page can't tell those windows apart.
  On those builds a document follows its file only in the tab that opened it; another tab or a reload shows
  the saved copy with Reconnect, and picking or dropping the same file there rejoins the same document.
- The start screen lists up to 8 recent documents, with their comment counts. Opening one asks for permission
  inside the click.
- Other tabs showing the same document merge its saved comments in through `BroadcastChannel`. A tab with its
  composer open waits until the composer closes. A start screen refreshes its list at most every 250 ms, and
  only while it is visible.

## Safety

- markdown-it runs with `html: false`, so raw HTML shows as text; prose like `<name>` must not vanish. The
  only exception is `<br>`, which generated Markdown often has inside table cells.
- The CSP allows exactly the two inline scripts, by SHA-256 hash, computed at build time. Inline event handlers
  and injected scripts cannot run. Remote Markdown images may load, with no referrer.
- Every `file://` page shares one storage origin, so another local HTML file opened in Chrome could read this
  page's storage. The start screen says so, storage is capped at 30 documents, and Forget all clears it.
  Fuzzy linkify is off (README.md and main.py are not links). Links open in a new tab with
  `rel="noopener noreferrer"`. Fragment links go to the prefixed heading ids.
- Images load with no referrer. A relative image that fails becomes an `[image: alt]` label.
- Dropping a file anywhere never navigates the tab away.
