# Apply Kit

This folder turns job ads into tailored CVs and cover letters, rendered as print-ready A4 PDFs.
You are working directly with the person using it. Many users are not programmers: run
every command yourself, never send them to a terminal, and explain things in a sentence.

## At the start of every session

Read `profile/onboarding.md`. If it is missing, or any box under "Quick start" is unchecked,
use the **onboarding** skill and continue from the first unchecked step, before anything else.
If the user asked for something else, say in one line that setup comes first, and why:
so that everything you write rests on their real facts.

Do not write or tailor any CV or letter until every Quick start box is checked.

## Applying for a job

When the user shares a job ad (text, link or file), names a company or role, or asks for a CV,
cover letter or Anschreiben, use the **tailoring** skill. It keeps a log of every application
in `applications/tracker.md`.

## Where things live

- `profile/experience.md`: the user's facts. The single source of truth for every document.
- `profile/targeting.md`, `profile/voice.md`: what they are aiming for, how they write.
- `profile/inbox/`: files the user drops in (old CVs, LinkedIn PDF, letters).
- `applications/ads/`: the job ads, saved as they were found.
- `applications/`: every CV and letter as markdown. `CV_<Company>.md`,
  `CoverLetter_<Company>.md` (English), `Anschreiben_<Company>.md` (German).
  The master CV is `CV_General.md`.
- `output/`: the PDFs. Generated, never edited by hand.
- `guide/format.md`: the markdown the PDF renderer expects. Follow it exactly.
- `examples/`: a fictional person's profile and documents, to show what the kit produces.
  Never mix them with the user's own data.
- `kit.config.json`: name, accent colour, mark (monogram, logo or none), custom monogram
  letters, place for letters, default language, layout (`theme`; see "Layouts" in
  `guide/format.md`). A `theme:` line in one document overrides it.
- `themes/`: installed layouts besides the built-in Classic, one folder each.

## Layout packs

When the user has a layout pack (a zip, usually named `apply-kit-layout-pack-*.zip`, in this
folder or in Downloads), install it: unzip it into this folder so its layouts land in
`themes/`, then list them from each `theme.json` and render one existing document in the
layout they pick, so they see it work. Never write or edit a pack's files yourself.

## Checking and making PDFs

`npm run check` compares every number in the documents with `profile/experience.md` and flags
any without a confirmed source; `npm run check -- <name>` checks matching files. Run it before
every render and resolve each flag. `npm run pdf` renders everything in `applications/`; `npm run pdf -- <part of a file name>`
renders matching files. Read the report and fix every warning before calling a document done:
a CV whose last page is nearly empty, a letter over one page, a character the font can't draw.

## Rules for every document

1. **Never invent a fact or a number.** Everything comes from `profile/experience.md`.
   A number may appear only if it carries a `[source: …]`. An estimate is always phrased as
   one ("around 40%"). Numbers marked `[unconfirmed]` never appear. If information is missing,
   ask.
2. **Consistent facts.** Dates, titles, company names and counts match `experience.md`
   exactly, in every document.
3. **The user's voice**, not a template's. Follow `profile/voice.md` if it exists.
   No em dashes in prose; use a comma, a colon or a full stop.
4. **A cover letter fits on one page** and ends with a sign-off: the closing, then the name
   on the next line. German closings take no comma ("Viele Grüße").
