# New project wizard — design

Date: 2026-11-13. Branch: `project-wizard` (on top of `ask-only-critical`).

## Why

Adding a project is one long form that only works for a folder that already holds a git repository. The owner
wants a wizard with two ways in — a project **from scratch** and a project that **already has code** — that asks
only for what is essential in each case (folder, GitHub repository, tests, what to build, which model each step
uses). It must be easy for a person who does not program.

## What the owner decided (from the sketches he approved)

- "New project" opens a wizard. First screen: two large cards, **Start from scratch** and **I already have code**.
- From scratch asks: what to build (tiles with the real logo of each technology, front end and back end), the
  folder, the GitHub repository (optional), and a switch **Add tests**.
- A **Models** screen in both ways: three presets on top (Fast, Balanced, Best quality) and under them each step
  with its own model.
- Already has code: the person only points at the folder; the app reads it and shows what it found to confirm,
  and asks only for what is missing. Optional: folders to ask about before changing.
- A last screen that sums up the choices before creating.

## My calls (not the owner's words)

- **Steps.** From scratch: Start → What to build → Where → Models → Review. Already has code: Start → Folder →
  What I found → Models → Review. Back and Next on every screen; Escape closes.
- **Models screen shows Plan, Build and Review**, not Tests: the Tests step runs the project's test command, not a
  model. The screen says so in one line. Choices per step: Default, Haiku, Sonnet, Opus, stored as the step's
  existing `config.model` (`haiku` / `sonnet` / `opus`; Default stores nothing).
  Presets: Fast = haiku / sonnet / sonnet; Balanced = Default for all three (today's behaviour, preselected);
  Best quality = opus / opus / opus. Changing a row by hand leaves no preset marked.
- **From scratch creates only the start of a project**: the folder (new or empty), `git init` on `main`, a
  `README.md` and one first commit — because the app can only take a folder that is a repository with a commit.
  The agents build the project itself as the **first task**, whose text the wizard writes from the choices and
  leaves in the task box for the person to read and start. Nothing runs on its own.
- **GitHub from scratch**: the address is only remembered as `origin`. The app does not create the repository on
  GitHub and sends nothing; the screen says the repository must already exist there. Only a github.com address
  is accepted.
- **Add tests** is on by default (without tests the app never passes a change on its own). When on, the first
  task asks for tests and the project gets a standing rule, "Every change comes with tests.". The test command
  stays empty until the tests exist; the app already offers the command once the main branch has one.
- **What was chosen to build** is also kept as a standing rule ("This project is built with Next.js and Prisma."),
  so later tasks know it. "Let the agents choose" stores no such rule.
- **Already has code** reuses what the current screen reads (name, framework, GitHub, tests, extra checks, main
  branch) and adds folder suggestions for "ask me before changing": the sensitive folders that exist in the
  project (sign-in, payments, database). The ones ticked become core areas when the project is created.
  Not included: connecting a GitHub repository to an existing project from the wizard (the canvas already has
  that), and the "unsaved work" line of the sketch.
- **When to ask** stays a choice on the Review screen, preset to "only about what matters".
- Logos come from the `simple-icons` package (one new dependency), drawn inline.
- All wording in `strings`, in plain words.

## Not goals

- No project templates or generators run by the app (`create-next-app` and the like): the agents do it.
- No GitHub repository creation, no push.
- No change to how tasks run.

## Parts

- `src/domain/stack.ts` — the technologies offered, the sentence for the rule, the first task's text.
- `src/domain/models.ts` — model choices and presets.
- `src/engine/scratch.ts` — `startFromScratch`: checks the folder, creates the repository start, sets `origin`.
- `src/engine/projects.ts` — `createProject` also takes `models`, `coreAreas`, `rules`.
- `src/engine/project-setup.ts` — the analysis also lists sensitive folders found.
- `POST /api/projects` — accepts the new fields; `POST /api/projects/scratch` — from scratch.
- `src/ui/canvas/AddProjectDialog.tsx` — becomes the wizard (same name and props, so its caller is unchanged);
  screens in `src/ui/canvas/wizard/`.
- The first task's text travels to the canvas in `sessionStorage` and is put in the task box once.

## Failure cases a person can meet

- Folder for a new project already has files → refused, with a sentence saying to choose an empty or new folder.
- Folder path not absolute, or its parent does not exist → refused with a sentence.
- GitHub address that is not github.com → refused before anything is created.
- The folder is already a project → the existing refusal.
- Anything fails after the folder was created → the sentence says the folder was created and can be added as
  "I already have code".
