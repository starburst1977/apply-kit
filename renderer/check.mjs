#!/usr/bin/env node
// Number check: every number in an application document must appear in
// profile/experience.md with a confirmed source.
//
//   npm run check                    check every document in applications/
//   npm run check -- Acme            only files whose name contains "Acme"
//   npm run check -- --profile <f>   use a different experience.md
//   npm run check -- --dir <folder>  check a different folder
//
// Catches digits ("40%", "200+", "4.5"), numbers written as words ("five",
// "fünf") and vague magnitudes ("millions of users", "Tausende"). Ignores
// years, contact details, and sentences about salary or start date: those are
// preferences, not claims about experience. A safety net, not proof: it can't tell whether
// the "5" in the CV is the same claim as a "5" in the profile. Claude reads
// the result and fixes, removes or asks.
//
// Always exits 0. Findings are for reading, not a build failure (a failing
// command shows up as a red error in the app).

import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function takeOption(flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}
const profilePath = resolve(takeOption('--profile', join(root, 'profile', 'experience.md')));
const docsDir = resolve(takeOption('--dir', join(root, 'applications')));
const filters = args;

const WORDS = {
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', twenty: '20', fifty: '50',
  zwei: '2', drei: '3', vier: '4', fünf: '5', sechs: '6', sieben: '7', acht: '8', neun: '9',
  zehn: '10', elf: '11', zwölf: '12', zwanzig: '20', fünfzig: '50',
  dozen: 'dozens', dozens: 'dozens', dutzend: 'dozens', dutzende: 'dozens',
  hundred: 'hundreds', hundreds: 'hundreds', hundert: 'hundreds', hunderte: 'hundreds',
  thousand: 'thousands', thousands: 'thousands', tausend: 'thousands', tausende: 'thousands',
  million: 'millions', millions: 'millions', millionen: 'millions', billion: 'billions', milliarden: 'billions',
};
const NUM = /(?<![\p{L}\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(\s?(?:%|\+|k|K|M|x|×))?(?![\p{L}\d])/gu;
const WORD = new RegExp(`(?<![\\p{L}])(${Object.keys(WORDS).join('|')})(?![\\p{L}])`, 'giu');
const CONTACT = /@|\+\d|linkedin|www\.|https?:/i;
const PREFERENCE = /gehalt|brutto|vergütung|salary|compensation|eintritt|kündigungsfrist|notice period|start date|earliest start|verfügbar|available from|availability/i;
// Split a line into sentences, but not after a number: "zum 1. Januar" is one sentence.
const sentences = (line) => line.split(/(?<=[^\d][.!?])\s+(?=\p{Lu})/u);

// Numbers in one line of text -> [{ key, shown }]
function numbersIn(line) {
  const found = [];
  for (const m of line.matchAll(NUM)) {
    let n = m[1];
    if (/^\d{1,3}([.,]\d{3})+$/.test(n)) n = n.replace(/[.,]/g, '');
    const suffix = (m[2] ?? '').trim().toLowerCase().replace('×', 'x');
    const isYear = !suffix && /^\d{4}$/.test(n) && +n >= 1950 && +n <= 2099;
    if (isYear) continue;
    found.push({ key: n + (['%', 'k', 'm', 'x'].includes(suffix) ? suffix : ''), shown: m[0].trim() });
  }
  for (const m of line.matchAll(WORD)) found.push({ key: WORDS[m[1].toLowerCase()], shown: m[1] });
  return found;
}

function stripFrontmatter(src) {
  if (!src.startsWith('---\n')) return src;
  const end = src.indexOf('\n---', 4);
  return end === -1 ? src : src.slice(end + 4);
}

// ---------- profile: best status per number ----------
const RANK = { sourced: 3, unconfirmed: 2, untagged: 1 };
const known = new Map();
let profile;
try {
  profile = (await readFile(profilePath, 'utf8')).replace(/\r\n/g, '\n');
} catch {
  console.log(`No profile found at ${profilePath}. Run the onboarding first.`);
  process.exit(0);
}
for (const line of profile.split('\n')) {
  const status = line.includes('[source:') ? 'sourced' : line.includes('[unconfirmed]') ? 'unconfirmed' : 'untagged';
  for (const { key } of numbersIn(line)) {
    if ((RANK[known.get(key)] ?? 0) < RANK[status]) known.set(key, status);
  }
}

// ---------- documents ----------
const DOC_NAME = /(^|_)(CV|CoverLetter|Letter|Anschreiben)_/i;
const files = (await readdir(docsDir))
  .filter((f) => f.endsWith('.md') && DOC_NAME.test(f))
  .filter((f) => !filters.length || filters.some((q) => f.toLowerCase().includes(q.toLowerCase())))
  .sort();

if (!files.length) {
  console.log(`No matching documents in ${docsDir}`);
  process.exit(0);
}

const MESSAGE = {
  unconfirmed: 'in your profile, but not confirmed',
  untagged: 'in your profile, but without a source',
  absent: 'not in your profile',
};
let flaggedTotal = 0;
for (const file of files) {
  const text = stripFrontmatter((await readFile(join(docsDir, file), 'utf8')).replace(/\r\n/g, '\n'));
  const flags = [];
  let ok = 0;
  for (const line of text.split('\n').flatMap(sentences)) {
    if (CONTACT.test(line) || PREFERENCE.test(line)) continue;
    for (const { key, shown } of numbersIn(line)) {
      const status = known.get(key) ?? 'absent';
      if (status === 'sourced') { ok++; continue; }
      const at = line.toLowerCase().indexOf(shown.toLowerCase());
      const context = line.slice(Math.max(0, at - 40), at + shown.length + 40).replace(/^[-*#\s]+/, '').trim();
      flags.push(`  ⚠ "${shown}": ${MESSAGE[status]}  …${context}…`);
    }
  }
  flaggedTotal += flags.length;
  console.log(flags.length
    ? `${basename(file)}: ${flags.length} to check, ${ok} confirmed`
    : `✓ ${basename(file)}: ${ok ? `all ${ok} numbers confirmed in your profile` : 'no numbers'}`);
  for (const f of flags) console.log(f);
}
if (flaggedTotal) {
  console.log('\nEach flagged number: remove it, or confirm it with the user and record it in profile/experience.md with its source.');
}
