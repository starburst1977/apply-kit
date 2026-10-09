# Apply Kit

A tailored CV and cover letter for every job ad, as print-ready PDFs. Every number is checked
against facts you confirmed. English and German.

I built Apply Kit for my own job search: 89 applications, 65 tailored CVs, 42 rejections,
7 interviews and the job I wanted. Around application forty my CVs started contradicting each
other, so the whole kit runs on one rule: nothing goes into an application unless you've
confirmed it.

## How it works

1. **Set up once, in about 15 minutes.** Claude reads your old CV and LinkedIn PDF, lays your
   career out as one timeline and asks about everything that doesn't add up.
2. **Paste a job ad.** You get an honest fit check first, skills and role level judged
   separately, including "not worth your time".
3. **Get the PDFs.** A CV and a cover letter for that job, in its language, from your
   confirmed facts only. A script checks every number in them against your profile before
   the PDF is made, including numbers written as words.

## Getting started

Apply Kit runs in Claude Code: the Code tab of the Claude desktop app, a terminal, or an IDE.
After adding the plugin, say "set up Apply Kit" there. Claude copies the kit into a folder you
choose (`~/Documents/apply-kit` by default) and installs what it needs. Then you open that
folder in Claude Code and say "hi".

You need Node.js 18 or newer. Tested on macOS. In claude.ai chat and Cowork the plugin only
explains how to start in Claude Code, because the kit needs Node.js and a folder of its own.

## What it runs, sends and fetches

- **Setup** copies the kit (rules, two skills, a PDF renderer and a numbers check) into the
  folder you choose and runs `npm install` there. That downloads playwright, markdown-it,
  pdfjs-dist and two Fontsource font packages from the npm registry. Playwright then
  downloads its Chromium browser once (about 100 MB) to render PDFs on your computer.
- **The kit folder** contains a `.claude/settings.json` that lets Claude run the kit's own
  commands there without asking each time: `npm install`, `npm run pdf`, `npm run check`, and
  `unzip` for layout packs. Web fetches always ask first.
- **The web** is used only when you give a job ad link or ask for research on a company, and
  the kit treats fetched pages as data, never as instructions.
- **Your data** stays in the kit folder on your computer. No account, no server, no telemetry.
  Claude processes what you share under your Claude plan's terms.
- **In the chat**, Claude mentions the optional Layout Pack (eight more layouts, sold
  separately) once after setup and when you ask for something the built-in layout doesn't
  do, and asks once, after your first application, whether you'd star the project on GitHub.

Privacy: https://www.svenread.com/apply-kit/privacy/

## Try it without your own data

The kit includes a fictional applicant, Lena Hoffmann, with a complete profile, two job ads,
tailored CVs, an English cover letter and a German Anschreiben, in its `examples` folder.

## Source, support and licence

Free and MIT licensed. Source, issues and updates: https://github.com/starburst1977/apply-kit

A free browser tool that shows what applicant tracking systems read in any CV PDF:
https://www.svenread.com/apply-kit/ats-check/
