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
import { readFile, writeFile, mkdir, readdir, copyFile, cp, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import { chromium } from 'playwright';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const KIT_VERSION = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
// "1.10.0" is newer than "1.9.2": compare part by part as numbers
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

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

// "Title | Company | Dates" -> one span per part (cv-role-title, cv-role-company,
// cv-role-dates) with an empty span.cv-sep between them; cv.css draws the " | ".
// Two parts are title + company, or title + dates
// when the second part has a digit. Parts between company and dates are cv-role-detail.
function splitRoleHeading(inner) {
  const parts = inner.split(' | ');
  if (parts.length < 2) return inner;
  const names = parts.map((p, i) => {
    if (i === 0) return 'title';
    if (i === parts.length - 1 && /\d/.test(p.replace(/<[^>]+>/g, ''))) return 'dates';
    return i === 1 ? 'company' : 'detail';
  });
  return parts.map((p, i) => `<span class="cv-role-${names[i]}">${p}</span>`).join('<span class="cv-sep"></span>');
}

// CV sections after the intro, arranged for the layout. Works on structure only, never on
// heading words, so it behaves the same in any language:
// - list sections (a heading and one list: skills, tools, languages) are gathered under
//   one label when the layout sets "group_lists" ({"en": "Knowledge", "de": "Kenntnisse"});
//   the group sits where the first list section was
// - consecutive short sections after the first one share a div.cv-run, so a layout can
//   place them side by side
// - "columns": 2 puts the first section and every section with roles in div.cv-main, the
//   other short sections in aside.cv-aside; "aside: Skills, Languages" in a document's
//   frontmatter names the side column's sections instead. Main comes first in the HTML,
//   so an applicant tracking system reads the experience before the side column.
// A document with anything unexpected between its sections is left as it is.
function arrangeSections(html, t, fm, lang, hasPhoto) {
  const start = html.indexOf('</header>');
  if (start === -1) return html;
  // The contact block (the intro paragraph whose items the renderer kept together)
  const head = html.slice(0, start + 9).replace(/<p>[\s\S]*?<\/p>/g, (p) =>
    p.includes('class="nowrap"') ? p.replace('<p>', '<p class="cv-contact">') : p);
  const rest = html.slice(start + 9);
  const tokens = [...rest.matchAll(/<section[\s\S]*?<\/section>|<hr\s*\/?>/g)];
  if (rest.replace(/<section[\s\S]*?<\/section>|<hr\s*\/?>/g, '').trim()) return html;
  const lead = tokens[0]?.[0].startsWith('<hr') ? tokens.shift()[0] : '';
  let sections = tokens.filter((m) => m[0].startsWith('<section')).map((m, i) => {
    const inner = m[0].replace(/^<section[^>]*>|<\/section>$/g, '');
    const title = (inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
    const short = m[0].includes('cv-section-short');
    const list = short && /^\s*<ul>[\s\S]*<\/ul>\s*$/.test(inner.replace(/<h2[^>]*>[\s\S]*?<\/h2>/, ''));
    // Classes a layout can style without knowing the heading words
    const extra = `${i === 0 ? ' cv-section-first' : ''}${list ? ' cv-section-list' : ''}`;
    const html = m[0].replace(/^<section class="([^"]*)"/, `<section class="$1${extra}"`);
    return { html, inner, title, short, list };
  });
  if (!sections.length) return html;

  const label = t.groupLists && (t.groupLists[lang] ?? t.groupLists.en ?? Object.values(t.groupLists)[0]);
  const lists = sections.filter((s, i) => i > 0 && s.list);
  if (label && lists.length >= 2) {
    // A list named like the group itself ("Kenntnisse" under "Kenntnisse") keeps its row
    // but not its name, so the word doesn't print twice.
    const same = (s) => s.title.toLowerCase() === label.toLowerCase();
    const items = lists.map((s) => `<div class="cv-group-item${same(s) ? ' cv-group-item-same' : ''}">${s.inner}</div>`).join('\n');
    const group = {
      html: `<section class="cv-section cv-section-short cv-group"><h2 class="cv-group-label">${escapeHtml(label)}</h2>\n${items}</section>`,
      title: label, members: lists.map((s) => s.title.toLowerCase()), short: true, list: false,
    };
    const at = sections.indexOf(lists[0]);
    sections = sections.filter((s) => !lists.includes(s));
    sections.splice(at, 0, group);
  }

  const join = (list) => {
    const out = [];
    for (let i = 0; i < list.length;) {
      let j = i;
      if (i > 0 && list[i].short) while (j + 1 < list.length && list[j + 1].short) j++;
      out.push(j > i ? `<div class="cv-run">${list.slice(i, j + 1).map((s) => s.html).join('<hr>')}</div>` : list[i].html);
      i = j + 1;
    }
    return out.join('<hr>');
  };

  if (t.columns !== 2) return `${head}\n${lead}${join(sections)}`;
  const named = (fm.aside ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  const inAside = named.length
    ? (s) => named.includes(s.title.toLowerCase()) || (s.members ?? []).some((m) => named.includes(m))
    : (s, i) => i > 0 && s.short;
  const main = sections.filter((s, i) => !inAside(s, i));
  const aside = sections.filter((s, i) => inAside(s, i));
  let mainHtml = main.map((s) => s.html).join('<hr>');
  let asideHtml = aside.map((s) => s.html).join('<hr>');

  // Where the intro goes in a two-column layout: above both columns (default), "split"
  // (name and title on top of the main column, photo and contact on top of the side
  // column), or "aside" (all of it on top of the side column, which then comes first in
  // the HTML, so the name and contact are still read first). "photo_intro" in theme.json
  // sets the mode for CVs with a photo.
  const mode = (hasPhoto && t.photoIntro) || t.intro || 'full';
  if (mode === 'full') {
    return `${head}\n${lead}<div class="cv-columns"><div class="cv-main">${mainHtml}</div>`
      + `<aside class="cv-aside">${asideHtml}</aside></div>`;
  }
  const open = head.indexOf('<header class="cv-intro">');
  const parts = [...head.slice(open).matchAll(/<figure[\s\S]*?<\/figure>|<h1[\s\S]*?<\/h1>|<p[\s\S]*?<\/p>/g)].map((m) => m[0]);
  const side = mode === 'aside' ? parts : parts.filter((p) => p.startsWith('<figure') || p.includes('cv-contact'));
  const top = parts.filter((p) => !side.includes(p));
  if (top.length) mainHtml = `<header class="cv-intro cv-intro-main">${top.join('\n')}</header>${mainHtml}`;
  asideHtml = `<header class="cv-intro cv-intro-aside">${side.join('\n')}</header>${asideHtml}`;
  const columns = mode === 'aside'
    ? `<aside class="cv-aside">${asideHtml}</aside><div class="cv-main">${mainHtml}</div>`
    : `<div class="cv-main">${mainHtml}</div><aside class="cv-aside">${asideHtml}</aside>`;
  return `${head.slice(0, open)}<div class="cv-columns cv-columns-${mode}">${columns}</div>`;
}

// Photo: off unless kit.config.json sets "photo" (a file next to the config, for example
// "profile/photo.jpg"). CVs only, and only in layouts with a photo slot ("photo": true in
// theme.json). "photo: false" in a document's frontmatter leaves it out of that document,
// "photo: other.jpg" uses another file. Copied into .build, so the HTML stays self-contained.
const PHOTO_TYPES = ['.jpg', '.jpeg', '.png', '.webp'];
async function photoHtml(fm, theme, type) {
  const wanted = String(fm.photo ?? config.photo ?? '').trim();
  if (type !== 'cv' || !wanted || /^(false|no|off|none)$/i.test(wanted)) return '';
  if (!THEMES[theme].photo) {
    const withPhoto = Object.values(THEMES).filter((t) => t.photo).map((t) => t.name);
    themeWarnings.add(`the ${THEMES[theme].name} layout has no space for a photo, so it is left out. ${withPhoto.length ? `Layouts with a photo: ${withPhoto.join(', ')}.` : 'None of the installed layouts has one.'}`);
    return '';
  }
  const src = resolve(configDir, wanted);
  if (!existsSync(src) || !PHOTO_TYPES.includes(extname(src).toLowerCase())) {
    themeWarnings.add(`photo "${wanted}" not found or not a JPG, PNG or WebP file; CVs are rendered without it.`);
    return '';
  }
  const size = (await stat(src)).size;
  if (size > 1.5 * 1024 * 1024) {
    themeWarnings.add(`photo "${wanted}" is ${(size / 1024 / 1024).toFixed(1)} MB and goes into every CV as is. A JPG of about 600 × 750 px is plenty and keeps the PDF small.`);
  }
  const file = `photo-${basename(src).replace(/[^\w.-]/g, '_')}`;
  await copyFile(src, join(buildDir, file));
  return `<figure class="cv-photo"><img src="${file}" alt="${escapeHtml(config.name)}"></figure>`;
}

// The italic company line under a role also carries the role's dates as data-dates, so a
// layout can run them into one free-flowing line ("Mar 2021–present · Digital freight ...")
// with ::before { content: attr(data-dates) } and hide the separate dates.
function withDates(role) {
  const dates = role.match(/<span class="cv-role-dates">([\s\S]*?)<\/span>/)?.[1];
  if (!dates) return role;
  const plain = escapeHtml(dates.replace(/<[^>]+>/g, '').trim());
  return role.replace(/(<\/h3>\s*)<p>(?=<em>)/, `$1<p data-dates="${plain}">`);
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
  const found = {};
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (/\s/.test(ch) || isCovered(cp)) continue;
    found[ch] = (found[ch] ?? 0) + 1;
  }
  return Object.entries(found);
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
    addCoverage(face);
  }
  await writeFile(join(buildDir, 'fonts.css'), css.join('\n'));
  await copyFile(join(here, 'cv.css'), join(buildDir, 'cv.css'));
  await mkdir(join(buildDir, 'themes'), { recursive: true });
  for (const [name, t] of Object.entries(THEMES)) {
    if (t.css) await copyFile(t.css, join(buildDir, 'themes', `${name}.css`));
    // Layout fonts go to themes/<name>/, so fonts.css finds its files at ./fonts/
    if (t.fonts) {
      const dest = join(buildDir, 'themes', name);
      await mkdir(dest, { recursive: true });
      await copyFile(join(t.fonts, 'fonts.css'), join(dest, 'fonts.css'));
      if (existsSync(join(t.fonts, 'fonts'))) await cp(join(t.fonts, 'fonts'), join(dest, 'fonts'), { recursive: true });
      addCoverage(await readFile(join(t.fonts, 'fonts.css'), 'utf8'));
    }
  }
}
function addCoverage(face) {
  for (const [, list] of face.matchAll(/unicode-range:\s*([^;]+);/g)) {
    for (const part of list.split(',')) {
      const [lo, hi = lo] = part.trim().replace(/^U\+/i, '').split('-');
      coveredRanges.push([parseInt(lo, 16), parseInt(hi, 16)]);
    }
  }
}

// ---------- themes ----------
const themeWarnings = new Set();
// Classic is built in (cv.css). Further layouts are installed as folders in themes/ at the
// kit root: themes/<name>/theme.css, layered over cv.css, plus theme.json with the page
// margins. cv.css keeps every break, fit and sign-off rule, so no theme can undo them.
// The same margin numbers define the page and drive the page analysis.
// Margins in cm: top, right, bottom, left.
const themesDir = join(root, 'themes');
const THEMES = {
  classic: { name: 'Classic', cv: [2.4, 3.6, 2.4, 3.6], letter: [2.4, 3.6, 2.4, 3.6], letterhead: false, css: null, columns: 1, pages: null, groupLists: null, photo: false },
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
      // "requires": "1.1.0" – the kit version this layout was made for. An older kit would
      // render it wrongly, so it is skipped with a note instead.
      if (meta.requires && newer(meta.requires, KIT_VERSION)) {
        throw new Error(`needs Apply Kit ${meta.requires} or newer (this is ${KIT_VERSION}). Update the kit, then render again`);
      }
      // A layout with its own typefaces ships them as fonts.css plus a fonts/ folder.
      const fonts = existsSync(join(dir, 'fonts.css')) ? dir : null;
      // Optional: "columns": 2 (main + side column), "pages": 1 (a CV that must fit one page),
      // "group_lists": {"en": "Knowledge", "de": "Kenntnisse"} (list sections under one label),
      // "photo": true (a photo slot), "intro" / "photo_intro": "split" or "aside" (two columns).
      THEMES[key] = {
        name: meta.name ?? entry.name, cv: m.cv, letter: m.letter, letterhead: !!meta.letterhead,
        css: join(dir, 'theme.css'), fonts,
        columns: meta.columns === 2 ? 2 : 1, pages: meta.pages === 1 ? 1 : null, groupLists: meta.group_lists ?? null,
        photo: meta.photo === true,
        intro: ['split', 'aside'].includes(meta.intro) ? meta.intro : null,
        photoIntro: ['split', 'aside'].includes(meta.photo_intro) ? meta.photo_intro : null,
      };
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
      ? line.split(' | ')
        // "**Email:**&nbsp;" becomes a label a layout can hide without leaving a space behind
        .map((item) => item.replace(/^(\*\*[^*]+\*\*(?:&nbsp;| | ))/, '<span class="cv-contact-label">$1</span>'))
        .map((item) => `<span class="nowrap">${item}</span>`).join('<span class="cv-sep"></span>')
      : line))
    .join('\n');

  // The letterhead ends at the first rule; formal elements go right after it.
  let content = md.render(typeset);
  if (type === 'letter') content = markSignoff(content);
  // CVs: wrap each section (h2 up to the next rule or h2). Sections without role
  // headings (profile, skills, education, languages) are short and never split
  // across a page; experience still breaks between roles and bullets.
  let hasPhoto = false;
  if (type === 'cv') {
    content = content.replace(/<h2[\s>][\s\S]*?(?=<hr|<h2[\s>]|$)/g, (section) =>
      `<section class="cv-section${/<h3[\s>]/.test(section) ? '' : ' cv-section-short'}">${section}</section>`);
    // Role headings: "Title | Company | Dates" gets one span per part, so a layout can
    // arrange them (dates on the right, company on its own line). Words and order stay as
    // written, so an applicant tracking system reads the same role.
    content = content.replace(/<h3>([\s\S]*?)<\/h3>/g, (h, inner) => `<h3>${splitRoleHeading(inner)}</h3>`);
    // Each role (heading, company line, bullets) becomes one block a layout can arrange.
    content = content.replace(/(<section class="cv-section">)([\s\S]*?)(<\/section>)/g, (s, open, inner, close) =>
      open + inner.replace(/<h3[\s>][\s\S]*?(?=<h3[\s>]|$)/g, (role) => `<div class="cv-role">${withDates(role)}</div>`) + close);
    // Name, subtitle and contact block: everything before the first rule.
    content = /<hr\s*\/?>/.test(content)
      ? content.replace(/^\s*(<h1>[\s\S]*?)(?=<hr\s*\/?>)/, '<header class="cv-intro">$1</header>\n')
      : content.replace(/^\s*(<h1>[\s\S]*?<\/h1>(?:\s*<p>[\s\S]*?<\/p>){0,2})/, '<header class="cv-intro">$1</header>');
    // The photo goes into the intro first, so the arrangement can move it with the contact
    const photo = await photoHtml(fm, theme, type);
    if (photo) content = content.replace('<header class="cv-intro">', `<header class="cv-intro">${photo}`);
    content = arrangeSections(content, THEMES[theme], fm, lang, !!photo);
    hasPhoto = !!photo;
  }
  // Letters: name and contact line as one block. Themes that position the letter precisely
  // (theme.json "letterhead": true) give it a fixed height through the letterhead class.
  if (type === 'letter') {
    const cls = THEMES[theme].letterhead ? 'cv-intro letterhead' : 'cv-intro';
    content = content.replace(/^\s*(<h1>[\s\S]*?<\/h1>\s*(?:<p>[\s\S]*?<\/p>)?)/, `<header class="${cls}">$1</header>`);
  }
  const meta = type === 'letter' ? letterMeta(fm, lang) : '';
  if (meta) {
    if (/<hr\s*\/?>/.test(content)) content = content.replace(/<hr\s*\/?>/, (hr) => hr + meta);
    else if (content.includes('</header>')) content = content.replace('</header>', `</header>${meta}`);
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
${THEMES[theme].fonts ? `<link rel="stylesheet" href="themes/${theme}/fonts.css">\n` : ''}${theme === 'classic' ? '' : `<link rel="stylesheet" href="themes/${theme}.css">`}
<style>:root { --accent: ${config.accent ?? '#B85C38'}; }
@page { margin: ${margins.map((m) => `${m}cm`).join(' ')}; }</style>
</head>
<body class="cv-body cv-variant-${type} theme-${theme}${hasPhoto ? ' has-photo' : ''}">
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

  // A letter, or a CV in a one-page layout ("pages": 1), a few lines over one page:
  // tighten spacing in small steps until it fits. Type size never changes. If it still
  // won't fit, render at normal spacing again so the warning matches the file on disk.
  let tightened = 0;
  const onePage = type === 'letter' || THEMES[theme].pages === 1;
  if (onePage && result.pages > 1) {
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

  report.push({ file, pdfPath, lang, type, theme, onePage, tightened, missing: uncoveredChars(body + ' ' + Object.values(fm).join(' ')), ...result });
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
  } else if (r.type === 'cv' && r.onePage && r.pages > 1) {
    // Two-column layouts are built for one page: a second page would leave the side column empty.
    note = `  ⚠ the ${THEMES[r.theme].name} layout fits one page; ${plural(r.overflowLines)} ran onto page 2. Ask Claude to cut it down, or pick a layout that runs to two pages.`;
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
