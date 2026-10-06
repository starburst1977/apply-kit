# Quick start: steps 0 to 4

About 15 minutes. Ends with the user's first CV as a PDF.

## Step 0: Setup (no effort for the user)

On the very first run, send the welcome message (SKILL.md, step 2) **before** any of this.
The user's first impression should be a greeting, not a setup log.

Check for things with the file tools (Glob, Read), never with a shell command that is expected
to fail: the app shows every failing command as a red error, and a buyer will think something
broke. Only run commands that should succeed.

1. Run `node --version`, on its own.
   If it fails, stop and say:
   "To make PDFs, this kit needs a free program called Node.js. Please download the LTS
   version from nodejs.org, install it, then quit and reopen the Claude app and open this
   folder again. I'll carry on from here."
2. Check with Glob for `node_modules/playwright/package.json`. If it isn't there, say: "One-time setup: I'm installing the PDF engine.
   It downloads about 100 MB and takes a minute or two." Then run `npm install`.
   If it fails, show the last few lines of the error and say plainly what went wrong.
3. Tick step 0.

## Step 1: Import (about 3 minutes)

1. Check `profile/inbox/` for files other than `PUT-YOUR-FILES-HERE.txt`. If it holds none, ask:

   "First, your existing material. Please put these into the `profile/inbox` folder,
   which is inside this kit's folder:
   1. Your current CV, as a PDF.
   2. If you like: your LinkedIn profile as a PDF. On your profile page: More, then Save to PDF.
      Before you save it, open everything up: click every “see more” / “…mehr” under your
      roles and About, and “Show all experiences” / “Alle anzeigen” if roles are hidden.
      LinkedIn prints what is on screen, so anything still collapsed comes out cut off.
   3. Anything else with facts about your work: older CVs, cover letters, a portfolio PDF.

   A Word file? Open it and use File, then Save as PDF. Screenshots work too. No CV at all?
   Just paste what you have into this chat. Tell me when you're ready."

2. Read every file. Watch for text that was cut off in the export: a bullet or sentence that
   ends mid-thought or with “…”, a role with no bullets at all, or a suspiciously short About.
   Collect every one of those and ask before building the profile:

   “Four lines came through cut off, probably collapsed when the PDF was saved. Either paste
   the full text for these, or expand them on LinkedIn and save the PDF again:
   - Head of Technology: ‘As Head of Technology my responsibility was…’”

   Never guess the missing half and never write a shortened version into the profile.
   Build `profile/experience.md` from the template:
   - Contact details from the most recent source.
   - Every role, most recent first: title, company, dates, location, one line about the
     company, and its bullets under "From your files", close to how they were written.
   - Education, languages, skills.
   - Every number found, exactly as written, under its role's "Numbers", tagged `[unconfirmed]`.
   - Where two sources disagree, record both, name the files, and set Status to "needs check":
     `**Dates:** 2014–2016 (LinkedIn) / 2014–2018 (CV 2024)`
   - List each file under "Sources".
3. Report in one or two lines. Example:
   "I've read 3 files and found 9 roles from 2005 to today, 2 qualifications and 3 languages.
   4 things don't match up between your files; that's next."
4. Tick step 1. Under Notes, list the files read.

## Step 2: Timeline check (about 4 minutes)

1. Show the timeline compactly, most recent first:
   ```
   2021–today   Senior Product Manager, Acme Payments
   2017–2021    Product Manager, Beta Bank
   ```
2. Then list only what needs an answer, numbered:
   - Conflicts between sources: dates, titles, company names, counts.
   - Overlapping dates: "Beta Bank and Gamma Ltd overlap from 2014 to 2016. Were these in
     parallel, or is one of the dates off?"
   - Roles found in only one source: "Your LinkedIn lists Delta Labs (2016); your CV doesn't.
     Include it?"
   - Facts from a single file: nothing could contradict them, so they are the ones most likely
     to be wrong unnoticed. Mark them "(one source)" in the timeline and ask for a second look:
     "These dates come from only one of your files. Worth a quick double-check: …"
   - Gaps longer than six months, asked neutrally, once: "Nothing between March 2019 and
     October 2020. Anything to add, or leave it as it is?"
   If there is nothing to ask, say so and ask for a quick "looks right".
   Always end with one open question, because comparing files can only find problems between
   them, never something missing from all of them: "Anything missing? A role, a freelance
   project or a side business that isn't in any of these files?"
3. Apply the answers. Set each settled role to "confirmed". If the user doesn't know an exact
   date, write what they know ("around 2016") and don't invent the rest.
4. Tick step 2.

## Step 3: Targeting (about 3 minutes)

1. Ask in one message:

   "Now, what you're aiming for. Short answers are perfect:
   1. What role do you want next? Job title, and level if it matters.
   2. Which industries or kinds of company appeal to you, and any you'd rather avoid?
   3. Where: which city, remote, hybrid? Open to moving?
   4. Which languages will you apply in?
   5. Any dealbreakers?
   6. Salary expectation? Optional. It stays on this computer and only helps me judge fit."

2. Write `profile/targeting.md`. Tick step 3.

## Step 4: Letterhead and first PDF (about 5 minutes)

1. **Letterhead.** Show the contact details from `experience.md` and ask the user to confirm
   or correct them, and which to show: email, phone, LinkedIn, website, location. Ask for the
   town to put before the date on letters.
2. **Look.** Offer an accent colour and a mark:
   - Colour: 1 Terracotta `#B85C38` (default), 2 Deep blue `#2F5D8A`, 3 Forest `#3F6B4E`,
     4 Graphite `#4A4A4A`, 5 Plum `#7A4A6B`, or any hex code.
   - Mark above the name: their initials (default), other letters of their choice, their own
     logo as an SVG file placed in `profile/`, or none.
   - Layout: Classic is built in. If `themes/` has layout folders, list them from each
     `theme.json` (name and description, one line each) and let them pick; they can switch
     any time. If there are none, use Classic and don't ask.
   Write `kit.config.json`: `name`, `accent`, `mark` (`"monogram"`, `"none"` or a path such as
   `"profile/logo.svg"`), `monogram` (only for letters other than their initials, e.g. `"PL"`),
   `place`, `defaultLanguage` (`"de"` or `"en"`, from their main application language),
   `theme` (a folder name from `themes/`; leave it out for Classic).
3. **Master CV.** Write `applications/CV_General.md` following `guide/format.md`, in their main
   application language, angled at their main target from `targeting.md`:
   - Only facts from `experience.md`. Don't add a claim that isn't there.
   - Profile: two or three sentences built from those facts.
   - The last 10 to 15 years in detail; older roles condensed into a line each.
4. **Numbers check.** Before rendering, list every number the CV uses and ask:

   "Before I make the PDF: your CV contains these numbers. For each one, is it measured,
   your estimate, or are you not sure? If it's wrong, give me the right figure.
   1. '40% fewer support tickets' (Acme Payments)
   2. 'three product launches in 2019' (Beta Bank)"

   - Measured: keep it. Tag `[source: measured, per you]`.
   - Estimate: keep it, phrased as an estimate in the CV ("around 40%", "roughly 40%").
     Tag `[source: your estimate]`.
   - Not sure: take it out of the CV. It stays `[unconfirmed]` in `experience.md`.
   - A corrected figure: update both files, then ask the same question about the new figure.
   No numbers: skip this. A yes/no question invites a yes; the three answers are deliberate.
5. **Render** with `npm run pdf -- CV_General` and read the report:
   - Last page nearly empty: offer to tighten, and do it if they agree.
   - A character the font can't draw: replace it, render again.
6. Tell them where it is: "Your CV is ready: `output/Jane_Doe_CV_General.pdf`, 2 pages.
   Open it and have a look." Ask whether anything should change; apply it and re-render.
7. Tick step 4.

## Handover

"That's your setup done. From here:
- Paste a job ad, or a link to one, and I'll check how well it fits you, then write a CV and
  cover letter for it.
- When you have 20 minutes, say 'deepen my profile'. A short interview about your roles makes
  the letters noticeably better.
- Changed jobs, or picked up something new? Say 'update my profile'."
