#!/usr/bin/env node
// Apply Kit renderer: markdown -> HTML (cv.css) -> A4 PDF via headless Chromium.
//
//   npm run pdf                      render every .md in applications/
//   npm run pdf -- Acme              only files whose name contains "Acme"
//   npm run pdf -- --dir <folder>    render a different folder
//   npm run pdf -- --config <file>   use a different kit.config.json
//   npm run pdf -- --out <folder>    write PDFs somewhere other than output/
//
// Why headless Chromium and not a "html2pdf" JS library: those rasterise the
// page into an image, so an applicant tracking system reads zero words.
// Chromium's page.pdf() writes real, selectable text with embedded fonts.

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import { chromium } from 'playwright';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// ---------- arguments ----------
const args = process.argv.slice(2);
function takeOption(flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}
const configPath = resolve(takeOption('--config', join(root, 'kit.config.json')));
const docsDir = resolve(takeOption('--dir', join(root, 'applications')));
const outDir = resolve(takeOption('--out', join(root, 'output')));
const filters = args; // anything left is a name filter
// Intermediate HTML lives next to the PDFs, so personal content never lands in the kit itself.
// Open output/.build/<name>.html in a browser for a quick preview.
const buildDir = join(outDir, '.build');


// ---------- config ----------
const config = JSON.parse(await readFile(configPath, 'utf8'));
const configDir = dirname(configPath);
if (!config.name) throw new Error(`"name" is missing in ${configPath}`);

// ---------- helpers ----------
const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Optional frontmatter. Supports "key: value" and multi-line "key: |" blocks.
// Values may contain colons. A document that merely starts with a --- rule is
// left alone: anything that doesn't parse as frontmatter stays content.
function splitFrontmatter(src) {
  if (!src.startsWith('---\n')) return [{}, src];
  const end = src.indexOf('\n---', 4);
  if (end === -1) return [{}, src];
  const data = {};
  let block = null;
  for (const line of src.slice(4, end).split('\n')) {
    if (!line.trim()) continue;
    const kv = !/^\s/.test(line) && line.match(/^(\w+):\s?(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      if (value.trim() === '|' || value.trim() === '>') { data[key] = ''; block = key; }
      else { data[key] = value.trim().replace(/^(['"])(.*)\1$/, '$2'); block = null; }
    } else if (block) {
      data[block] += (data[block] ? '\n' : '') + line.trim();
    } else {
      return [{}, src];
    }
  }
  if (!Object.keys(data).length) return [{}, src];
  return [data, src.slice(end + 4).replace(/^\n/, '')];
}

// Letters vs CVs, by filename. Works for "CV_Acme.md" and "Jane_Doe_CV_Acme.md".
function docType(name) {
  if (/(CoverLetter|Letter|Anschreiben)_/i.test(name)) return 'letter';
  return 'cv';
}

// German or English, for quotes and the lang attribute. Frontmatter wins,
// then "Anschreiben" in the filename, then a word count, then the config.
function detectLang(text, name, fm) {
  if (fm.lang) return fm.lang;
  if (/Anschreiben/i.test(name)) return 'de';
  const t = ` ${text.toLowerCase()} `;
  const count = (words) => words.reduce((n, w) => n + t.split(` ${w} `).length - 1, 0);
  const de = count(['und', 'der', 'die', 'das', 'mit', 'für', 'nicht', 'ich', 'eine', 'zu', 'von']);
  const en = count(['and', 'the', 'with', 'for', 'not', 'of', 'to', 'my', 'an', 'from']);
  if (de > en) return 'de';
  if (en > de) return 'en';
  return config.defaultLanguage ?? 'en';
}

// "2026-06-19" or "today" -> "19. Juni 2026" / "19 June 2026". Free text is kept as written.
function formatDate(value, lang) {
  if (!value) return '';
  let d = null;
  if (/^today$/i.test(value)) d = new Date();
  else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, day] = value.split('-').map(Number);
    d = new Date(y, m - 1, day);
  }
  if (!d) return value;
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
}

// Formal letter elements, all optional: recipient, place + date, subject.
// Loosely DIN 5008. These letters are uploaded as PDFs, not posted, so this
// is not window-envelope exact.
function letterMeta(fm, lang) {
  const to = (fm.to ?? '').split(/\s*·\s*|\s*\|\s*|\n/).map((l) => l.trim()).filter(Boolean);
  const date = formatDate(fm.date, lang);
  // "Ort, Datum" is a German convention; English letters carry the date alone,
  // unless the letter sets a place itself.
  const place = fm.place ?? (lang === 'de' ? config.place : undefined);
  const dateLine = date ? (place ? `${place}, ${date}` : date) : '';
  if (!to.length && !dateLine && !fm.subject) return '';
  return [
    '<div class="letter-meta">',
    to.length ? `<address class="letter-to">${to.map(escapeHtml).join('<br>')}</address>` : '',
    dateLine ? `<p class="letter-date">${escapeHtml(dateLine)}</p>` : '',
    fm.subject ? `<p class="letter-subject">${escapeHtml(fm.subject)}</p>` : '',
    '</div>',
  ].join('\n');
}

// Find where the sign-off starts and tag it, so it can never be separated from
// the letter body. Recognised by wording, not position. The sign-off starts at
// the first of the final paragraphs that is either a closing phrase on its own
// line ("Best regards", "Viele Grüße", with or without the name after it) or
// just the writer's name. Everything after it (portfolio line, P.S.) follows it.
// Full-line matches only: "Thank you for your time." is body text, not a closing.
const SIGNOFF = /^(?:(?:with\s+)?(?:best|kind|warm(?:est)?|many)?\s*regards|best wishes|warm wishes|all the best|best|sincerely|yours(?:\s+(?:sincerely|faithfully|truly))?|(?:many\s+)?thanks(?:\s+again)?|thank you|cheers|respectfully|take care|mit\s+(?:freundlichen|besten|herzlichen)\s+gr(?:ü|ue)(?:ß|ss)en|(?:freundliche|viele|beste|herzliche|liebe|schöne)\s+gr(?:ü|ue)(?:ß|ss)e|(?:vielen\s+)?dank|danke|hochachtungsvoll)[,.!]?$/i;
function markSignoff(html) {
  const plain = (h) => h.replace(/<[^>]+>/g, '').trim();
  const isName = (h) => plain(h).toLowerCase() === config.name.trim().toLowerCase();
  const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)];
  for (const m of paras.slice(-4)) {
    const firstLine = plain(m[1].split(/<br\s*\/?>/)[0]);
    if (SIGNOFF.test(firstLine) || isName(m[1])) {
      return html.slice(0, m.index) + `<p class="letter-signoff">${m[1]}</p>` + html.slice(m.index + m[0].length);
    }
  }
  return html;
}

async function markHtml() {
  const mark = config.mark ?? 'monogram';
  if (mark === 'none') return '';
  if (mark === 'monogram') {
    // Initials by default; "monogram": "PL" in the config sets other letters.
    const initials = config.name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('');
    const letters = (config.monogram ?? '').trim() || initials;
    return `<span class="cv-monogram">${escapeHtml(letters)}</span>`;
  }
  const svg = (await readFile(resolve(configDir, mark), 'utf8')).replace(/<\?xml[^>]*\?>\s*/, '');
  return svg.replace(/<svg\b/, '<svg class="cv-logo"');
}

function outputName(base) {
  const person = config.name.trim().replace(/\s+/g, '_');
  return /^(CV|CoverLetter|Letter|Anschreiben)_/i.test(base) ? `${person}_${base}` : base;
}

// ---------- fonts: copy into .build so the HTML is self-contained ----------
// Characters outside these ranges cannot be drawn by the CV fonts. Chromium then
// borrows a glyph from the operating system, which looks different per machine.
const coveredRanges = [];
const isCovered = (cp) => cp <= 0x7f || coveredRanges.some(([lo, hi]) => cp >= lo && cp <= hi);
function uncoveredChars(text) {
  const found = new Map();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (/\s/.test(ch) || isCovered(cp)) continue;
    found.set(ch, (found.get(ch) ?? 0) + 1);
  }
  return [...found.entries()];
}
async function prepareFonts() {
  const fontDir = join(buildDir, 'fonts');
  await mkdir(fontDir, { recursive: true });
  const css = [];
  for (const pkg of ['@fontsource-variable/source-serif-4', '@fontsource-variable/source-sans-3']) {
    const pkgDir = dirname(fileURLToPath(import.meta.resolve(`${pkg}/package.json`)));
    // Upright and true italic. Without the italic file, browsers fake italics by
    // slanting the upright letters, which is what the original CVs shipped with.
    let face = (await readFile(join(pkgDir, 'index.css'), 'utf8'))
      + (await readFile(join(pkgDir, 'wght-italic.css'), 'utf8'));
    // Keep only latin + latin-ext (covers German, French, Central European names).
    face = face.split('/*').filter((b) => /latin(-ext)?-wght-(normal|italic)|^\s*$/.test(b) && !/cyrillic|greek|vietnamese/.test(b)).join('/*');
    for (const file of face.match(/[\w.-]+\.woff2/g) ?? []) {
      await copyFile(join(pkgDir, 'files', file), join(fontDir, file));
    }
    css.push(face.replace(/url\(\.\/files\//g, 'url(./fonts/'));
    for (const [, list] of face.matchAll(/unicode-range:\s*([^;]+);/g)) {
      for (const part of list.split(',')) {
        const [lo, hi = lo] = part.trim().replace(/^U\+/i, '').split('-');
        coveredRanges.push([parseInt(lo, 16), parseInt(hi, 16)]);
      }
    }
  }
  await writeFile(join(buildDir, 'fonts.css'), css.join('\n'));
  await copyFile(join(here, 'cv.css'), join(buildDir, 'cv.css'));
  await mkdir(join(buildDir, 'themes'), { recursive: true });
  for (const [name, t] of Object.entries(THEMES)) {
    if (t.css) await copyFile(t.css, join(buildDir, 'themes', `${name}.css`));
  }
}

// ---------- themes ----------
const themeWarnings = new Set();
// Classic is built in (cv.css). Further layouts are installed as folders in themes/ at the
// kit root: themes/<name>/theme.css, layered over cv.css, plus theme.json with the page
// margins. cv.css keeps every break, fit and sign-off rule, so no theme can undo them.
// The same margin numbers set the page and drive the page analysis.
// Margins in cm: top, right, bottom, left.
const themesDir = join(root, 'themes');
const THEMES = {
  classic: { name: 'Classic', cv: [2.4, 3.6, 2.4, 3.6], letter: [2.4, 3.6, 2.4, 3.6], letterhead: false, css: null },
};
if (existsSync(themesDir)) {
  for (const entry of await readdir(themesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(themesDir, entry.name);
    const key = entry.name.toLowerCase().replace(/[\s-]/g, '');
    if (key === 'classic' || !existsSync(join(dir, 'theme.css')) || !existsSync(join(dir, 'theme.json'))) continue;
    try {
      const meta = JSON.parse(await readFile(join(dir, 'theme.json'), 'utf8'));
      const m = meta.margins_cm ?? {};
      if (!Array.isArray(m.cv) || !Array.isArray(m.letter)) throw new Error('margins_cm.cv and margins_cm.letter are required');
      THEMES[key] = { name: meta.name ?? entry.name, cv: m.cv, letter: m.letter, letterhead: !!meta.letterhead, css: join(dir, 'theme.css') };
    } catch (err) {
      themeWarnings.add(`theme "${entry.name}" skipped: ${err.message}`);
    }
  }
}
function resolveTheme(fm) {
  const wanted = String(fm.theme ?? config.theme ?? 'classic').trim().toLowerCase().replace(/[\s-]/g, '');
  if (THEMES[wanted]) return wanted;
  themeWarnings.add(`theme "${fm.theme ?? config.theme}" is not installed, used classic. Installed: ${Object.keys(THEMES).join(', ')}. Layouts go in themes/.`);
  return 'classic';
}

// ---------- page analysis: page count and how full the last page is ----------
const PAGE_H = 841.89;  // A4 height in pt
const CM = 28.3465;     // pt per cm
async function analyse(pdfPath, [top, , bottom]) {
  const data = new Uint8Array(await readFile(pdfPath));
  const task = getDocument({ data, verbosity: 0 });
  const doc = await task.promise;
  const pages = doc.numPages;
  const linesPerPage = [];
  let lowest = PAGE_H;
  for (let n = 1; n <= pages; n++) {
    const { items } = await (await doc.getPage(n)).getTextContent();
    const baselines = items.filter((i) => i.str.trim()).map((i) => i.transform[5]);
    linesPerPage.push(new Set(baselines.map((y) => Math.round(y))).size);
    if (n === pages && baselines.length) lowest = Math.min(...baselines);
  }
  const fill = (PAGE_H - top * CM - lowest) / (PAGE_H - (top + bottom) * CM);
  await task.destroy();
  return {
    pages,
    lastLines: linesPerPage[pages - 1],
    overflowLines: linesPerPage.slice(1).reduce((a, b) => a + b, 0),
    lastFill: Math.max(0, Math.min(1, fill)),
  };
}

// ---------- main ----------
// Only application documents: CV_, CoverLetter_, Letter_, Anschreiben_ (anywhere in the
// name, so "Jane_Doe_CV_Acme.md" works too). A tracker or notes file in the same
// folder is left alone.
const DOC_NAME = /(^|_)(CV|CoverLetter|Letter|Anschreiben)_/i;
const files = (await readdir(docsDir))
  .filter((f) => f.endsWith('.md') && DOC_NAME.test(f))
  .filter((f) => !filters.length || filters.some((q) => f.toLowerCase().includes(q.toLowerCase())))
  .sort();

if (!files.length) {
  console.log(`No matching .md files in ${docsDir}`);
  process.exit(0);
}

await mkdir(buildDir, { recursive: true });
await mkdir(outDir, { recursive: true });
await prepareFonts();
const mark = await markHtml();
const browser = await chromium.launch();
const page = await browser.newPage();
const report = [];

for (const file of files) {
  const base = basename(file, '.md');
  const source = (await readFile(join(docsDir, file), 'utf8')).replace(/\r\n/g, '\n');
  const [fm, body] = splitFrontmatter(source);
  const lang = detectLang(body, base, fm);
  const type = fm.type ?? docType(base);
  const theme = resolveTheme(fm);
  const margins = THEMES[theme][type === 'letter' ? 'letter' : 'cv'];
  // Letters are written line by line (address, date, sign-off, name), so a single
  // line break is kept. CVs keep standard markdown joining, which their contact
  // blocks rely on.
  const md = new MarkdownIt({
    html: true,
    typographer: true,
    breaks: type === 'letter',
    quotes: lang === 'de' ? '„“‚‘' : '“”‘’',
  });

  // Typography, applied to the source before markdown:
  // - a number never parts from its unit: "30 %", "95.000 €" get a no-break space
  // - contact lines break only between items, never inside an address or URL
  const typeset = body
    .replace(/(\d) (%|€|\$|Prozent|percent)/g, '$1\u00A0$2')
    .split('\n')
    .map((line) => (/@|linkedin|www\./i.test(line) && line.includes(' | ')
      ? line.split(' | ').map((item) => `<span class="nowrap">${item}</span>`).join(' | ')
      : line))
    .join('\n');

  // The letterhead ends at the first rule; formal elements go right after it.
  let content = md.render(typeset);
  if (type === 'letter') content = markSignoff(content);
  // CVs: wrap each section (h2 up to the next rule or h2). Sections without role
  // headings (profile, skills, education, languages) are short and never split
  // across a page; experience still breaks between roles and bullets.
  if (type === 'cv') {
    content = content.replace(/<h2[\s>][\s\S]*?(?=<hr|<h2[\s>]|$)/g, (section) =>
      `<section class="cv-section${/<h3[\s>]/.test(section) ? '' : ' cv-section-short'}">${section}</section>`);
  }
  // Themes that position the letter precisely (theme.json "letterhead": true) need name and
  // contact line as one block they can give a fixed height.
  if (type === 'letter' && THEMES[theme].letterhead) {
    content = content.replace(/^\s*(<h1>[\s\S]*?<\/h1>\s*(?:<p>[\s\S]*?<\/p>)?)/, '<header class="letterhead">$1</header>');
  }
  const meta = type === 'letter' ? letterMeta(fm, lang) : '';
  if (meta) {
    if (/<hr\s*\/?>/.test(content)) content = content.replace(/<hr\s*\/?>/, (hr) => hr + meta);
    else if (/<\/h1>\s*<p>[\s\S]*?<\/p>/.test(content)) content = content.replace(/(<\/h1>\s*<p>[\s\S]*?<\/p>)/, `$1${meta}`);
    else content = meta + content;
  }

  const header = mark
    ? `<span class="cv-mark-line"></span>${mark}<span class="cv-mark-line"></span>`
    : `<span class="cv-mark-line"></span>`;
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(`${config.name} · ${type === 'cv' ? 'CV' : 'Letter'} · ${base.replace(/^.*?(CV|CoverLetter|Letter|Anschreiben)_/i, '')}`)}</title>
<link rel="stylesheet" href="fonts.css">
<link rel="stylesheet" href="cv.css">
${theme === 'classic' ? '' : `<link rel="stylesheet" href="themes/${theme}.css">`}
<style>:root { --accent: ${config.accent ?? '#B85C38'}; }
@page { margin: ${margins.map((m) => `${m}cm`).join(' ')}; }</style>
</head>
<body class="cv-body cv-variant-${type} theme-${theme}">
<main class="cv-page">
<header class="cv-header"><div class="cv-mark">${header}</div></header>
<article class="cv-content">
${content}
</article>
</main>
</body>
</html>`;

  const htmlPath = join(buildDir, `${base}.html`);
  await writeFile(htmlPath, html);
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const pdfPath = join(outDir, `${outputName(base)}.pdf`);
  const pdfOptions = { path: pdfPath, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false };
  await page.pdf(pdfOptions);
  let result = await analyse(pdfPath, margins);

  // A letter a few lines over one page: tighten spacing in small steps until it
  // fits. Type size never changes. If it still won't fit, render at normal
  // spacing again so the warning matches the file on disk.
  let tightened = 0;
  if (type === 'letter' && result.pages > 1) {
    for (const fit of [0.97, 0.94, 0.92]) {
      await page.evaluate((f) => document.documentElement.style.setProperty('--fit', String(f)), fit);
      await page.pdf(pdfOptions);
      const attempt = await analyse(pdfPath, margins);
      if (attempt.pages === 1) {
        result = attempt;
        tightened = Math.round((1 - fit) * 100);
        break;
      }
    }
    if (!tightened) {
      await page.evaluate(() => document.documentElement.style.removeProperty('--fit'));
      await page.pdf(pdfOptions);
      result = await analyse(pdfPath, margins);
    }
  }

  report.push({ file, pdfPath, lang, type, theme, tightened, missing: uncoveredChars(body + ' ' + Object.values(fm).join(' ')), ...result });
}

await browser.close();

// ---------- report ----------
for (const w of themeWarnings) console.log(`⚠ ${w}`);
for (const r of report) {
  const pages = `${r.pages} page${r.pages === 1 ? '' : 's'}`;
  const plural = (n) => `${n} line${n === 1 ? '' : 's'}`;
  let note = '';
  if (r.type === 'letter' && r.pages > 1) {
    // A cover letter has one job: fit on one page.
    note = `  ⚠ a cover letter should fit on one page; ${plural(r.overflowLines)} ran onto page 2. Ask Claude to cut it down.`;
  } else if (r.type === 'cv' && r.pages > 1 && (r.lastLines <= 4 || r.lastFill < 0.12)) {
    note = `  ⚠ last page holds only ${plural(r.lastLines)}: trim a little, or ask Claude to tighten it`;
  }
  const fitted = r.tightened ? `, spacing ${r.tightened}% tighter to fit one page` : '';
  const themeNote = r.theme === 'classic' ? '' : `, ${r.theme}`;
  console.log(`✓ ${basename(r.pdfPath)}  (${pages}, ${r.type}, ${r.lang}${themeNote}${fitted})${note}`);
  if (r.missing.length) {
    const list = r.missing.map(([c, n]) => `"${c}" (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}${n > 1 ? `, ${n}x` : ''})`).join(', ');
    console.log(`  ⚠ not in the CV font, drawn in a system font that differs per computer: ${list}. Replace with a word or a plain character.`);
  }
}
