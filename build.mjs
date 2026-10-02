// Inlines src/ and the vendored markdown-it bundle into one distributable file: markdown-annotator.html.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// LF only: an HTML parser turns CRLF into LF before hashing a script, so a CR would break the CSP hashes below.
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');

const mdPkg = require.resolve('markdown-it/package.json');
const mdVersion = JSON.parse(read(mdPkg)).version;
const vendor = read(join(dirname(mdPkg), 'dist', 'markdown-it.min.js'));
const css = read(join(root, 'src', 'styles.css'));
const sample = read(join(root, 'samples', 'showcase.md'));
const version = JSON.parse(read(join(root, 'package.json'))).version;
const app = read(join(root, 'src', 'app.js'))
  .replace("'__SAMPLE_MD__'", () => JSON.stringify(sample))
  .replace("'__VERSION__'", () => JSON.stringify(version));

// A literal "</script" inside inlined JS would end the element early; "<\/" means the same thing in JS.
const safeJs = (js) => js.replace(/<\/script/gi, '<\\/script');
const safeCss = (s) => s.replace(/<\/style/gi, '<\\/style');

let html = read(join(root, 'src', 'index.html'));
const put = (marker, content) => {
  if (!html.includes(marker)) throw new Error(`marker ${marker} missing from src/index.html`);
  html = html.replace(marker, () => content);
};
const vendorJs = `\n/* markdown-it ${mdVersion} (MIT) https://github.com/markdown-it/markdown-it */\n${safeJs(vendor)}\n`;
const appJs = `\n/* markdown-annotator.html ${version}: highlight and comment on Markdown, then copy one consolidated review. MIT, (c) 2026 GodHelpThisCoder, https://github.com/GodHelpThisCoder/markdown-annotator */\n${safeJs(app)}\n`;
put('<!--CSS-->', `<style>\n${safeCss(css)}\n</style>`);
put('<!--VENDOR-->', `<script>${vendorJs}</script>`);
put('<!--APP-->', `<script>${appJs}</script>`);

// Allow exactly these two inline scripts: no inline event handlers, no injected <script>.
const sha = (js) => `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`;
const placeholder = "script-src 'unsafe-inline'";
if (!html.includes(placeholder)) throw new Error('CSP script-src placeholder missing from src/index.html');
html = html.replace(placeholder, () => `script-src ${sha(vendorJs)} ${sha(appJs)}`);

// Bundled libraries' license notices travel with the single file.
const notices = read(join(root, 'THIRD-PARTY-NOTICES.md'));
if (notices.includes('-->')) throw new Error('THIRD-PARTY-NOTICES.md must not contain "-->"');
if (!notices.includes(`## markdown-it ${mdVersion} `)) throw new Error(`THIRD-PARTY-NOTICES.md is not for markdown-it ${mdVersion}: update it`);
html = html.replace(/<\/html>\s*$/, () => `<!--\n${notices.trim()}\n-->\n</html>\n`);

const out = join(root, 'markdown-annotator.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB, markdown-it ${mdVersion})`);
