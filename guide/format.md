# Document format

The PDF renderer turns markdown in `applications/` into A4 pages. It relies on the structure
below. Follow it exactly: the layout (name, section labels, role headings, bullets) comes from
this structure, not from styling in the file.

## File names

| Document | File name | Layout |
|---|---|---|
| Master CV | `CV_General.md` | CV |
| Tailored CV | `CV_<Company>.md` | CV |
| Cover letter (English) | `CoverLetter_<Company>.md` | Letter |
| Anschreiben (German) | `Anschreiben_<Company>.md` | Letter |

`<Company>` in CamelCase, letters and digits only: `CV_AcmePayments.md`.
The PDF is named after the person: `Jane_Doe_CV_AcmePayments.pdf`.

## CV

```markdown
# Jane Doe
Senior Product Manager · Payments and B2B platforms

**Email:**&nbsp;jane@example.com | **Phone:**&nbsp;+49 170 1234567 | **LinkedIn:**&nbsp;linkedin.com/in/janedoe | **Location:**&nbsp;Munich, Germany

---

## Profile

Two to four sentences: who you are professionally, what you are strongest at, what you want next.

---

## Skills

Product discovery • Pricing • SQL • Stakeholder management • German and English

---

## Experience

### Senior Product Manager | Acme Payments | Mar 2021–present
*B2B payment platform for European marketplaces*

- One idea per bullet: what you did, and what changed because of it.
- Numbers only with a confirmed source in profile/experience.md.

### Product Manager | Beta Bank | Jan 2017–Feb 2021
*Retail bank, 4 million customers*

- …

---

## Education

**MSc Computer Science** | TU München | 2014

---

## Languages

**German** (native) • **English** (C1)
```

What each part becomes:

- `# Name`: the name, large and centred.
- The line right after it: a subtitle under the name.
- The next paragraph: the contact block, small and centred. Write it on **one line** with ` | `
  between items; the renderer wraps it. (Two lines would be joined with a space and lose the
  separator.) `&nbsp;` keeps a label with its value.
- The first `---`: the rule under the title block. Later `---` lines separate sections.
- `## Section`: small spaced capitals in the accent colour.
- `### Title | Company | Dates`: the role heading.
- The italic line under a role: one line about the company.
- `- bullets`: listed with an accent dash. Never put a dash in the text yourself.

Several entries in one section (two qualifications, say) need a blank line between them;
lines directly below each other are joined into one.

Section names follow the document language: "Berufserfahrung", "Ausbildung", "Sprachen" in German.

## Letter

```markdown
---
to: |
  Acme Payments GmbH
  Personalabteilung
  Leopoldstraße 1
  80802 München
place: München
date: today
subject: Bewerbung als Senior Product Manager
---
# Jane Doe
jane@example.com | +49 170 1234567 | linkedin.com/in/janedoe

---

Sehr geehrte Frau Weber,

Each paragraph is one line in the file, however long.

Second paragraph.

Viele Grüße
Jane Doe
```

- The block between the first two `---` lines is optional. Every field is optional:
  - `to`: the recipient address. Write `to: |` and put each address line below it, indented
    two spaces, as above. Or keep it on one line with ` · ` between the parts.
  - `place`: the town before the date. Falls back to `place` in kit.config.json.
  - `date`: `today`, or a date like `2026-06-19`. Written out per language:
    "19. Juni 2026" in German, "19 June 2026" in English.
  - `subject`: shown in bold, without a "Betreff:" label.
  - `theme`: the layout for this one document, overriding `theme` in kit.config.json.
    Only installed layouts work (see "Layouts" below).
- After the name comes one contact line, then `---`.
- Letters keep line breaks exactly as written. Write each paragraph on one single line.
- End with a sign-off: the closing on one line, the name on the next. English closings take a
  comma ("Kind regards,"); German closings take none ("Viele Grüße").
- A letter must fit on one page. If it runs a little over, the renderer tightens the spacing
  automatically. If it runs well over, it warns: shorten the text.

## Characters

- No em dashes in prose. Date ranges use an en dash without spaces: `Mar 2021–present`.
- Avoid arrows, check marks, stars and emoji: the fonts can't draw them, so they would come out
  in a different font on every computer. The renderer warns about each one.
- Quotation marks are converted automatically: „German“ or “English”, matching the document.

## Layouts

**Classic** is built in: serif name, centred header with the mark, generous margins. It is
the default.

More layouts come as packs. Each layout is a folder in `themes/` (`themes/<name>/theme.css`
and `theme.json`). Choose one with `"theme": "<name>"` in kit.config.json, or per document
with a `theme:` line in the block at the top (a CV takes the block too, with just that line).
The markdown is the same in every layout; only the look changes. A layout that isn't
installed falls back to Classic with a warning in the report.

Page breaks follow the same rules in every layout: short sections (profile, skills,
education, languages) never split, and a role's last bullet never starts a page alone.
