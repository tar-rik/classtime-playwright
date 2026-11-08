# Classtime question importer

Command-line tool that reads a JSON file and creates the questions in
[Classtime](https://www.classtime.com/questions) by driving a real browser with Playwright.
No AI is involved: the same JSON always produces the same questions.

## For non-technical users

Give them `ІНСТРУКЦІЯ.txt` (Ukrainian). They drag a `.txt` file (questions numbered `1.`, options
`А.`/`Б.`/`В.` or `A.`/`B.`/`C.`, then an `Ключ відповідей:` line such as `1 – Б; 2 – А`, or `*`
before the correct option) onto `Створити тест.bat`. The file name becomes the test name. The tool
shows a preview with ✓ on correct answers, asks for Enter, and signs in on first use. No commands.
Text files may be UTF-8 or UTF-16 (Notepad "Unicode"). Word files are not read directly; paste into Notepad.
`--yes` skips the confirmation; the CLI commands below still work.

## Requirements

- Node.js 18 or newer
- Google Chrome installed (the tool falls back to Playwright's Chromium if Chrome is missing;
  run `npx playwright install chromium` in that case)

## Setup (once)

```
npm install
node classtime.mjs login
```

`login` opens a normal Chrome window (own profile in `.browser-profile/`, remote debugging
port 9222). Sign in to Classtime, wait until your library is visible, then press Enter in
the terminal; Chrome is closed and the session is saved. Repeat `login` if it expires.

Why not log in inside Playwright's own browser? Google blocks sign-in in automation-controlled
browsers ("This browser or app may not be secure"). The tool therefore starts plain Chrome
and attaches to it only after you are signed in. Close other windows that use the
`.browser-profile` folder before running. If Chrome is installed in a custom location, set
`CHROME_PATH` to `chrome.exe`.

## Usage

```
node classtime.mjs validate <file.json>        # check the JSON, no browser opened
node classtime.mjs create <file.json> [options]
```

| Option | Meaning |
|---|---|
| `--set-url <url>` | Add questions to an existing question set instead of creating a new one |
| `--start <n>` | Start from question number `n` (1-based). Use it to resume after an error |
| `--headless` | Run without a visible browser window |
| `--dry-run` | Validate and print the plan only; nothing is sent to Classtime |

Typical flow:

```
node classtime.mjs validate my-test.json
node classtime.mjs create my-test.json --dry-run
node classtime.mjs create my-test.json
```

npm shortcuts: `npm run login`, `npm run validate`.

## JSON format

```json
{
  "set": "Крайові шви",
  "questions": [
    {
      "text": "Яке основне призначення крайових швів?",
      "options": [
        "З'єднання двох деталей між собою",
        "Обробка країв деталей та зрізів",
        "Утворення складок"
      ],
      "correct": 1,
      "points": 1
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `set` | Yes, unless `--set-url` is used | Name of the new question set |
| `questions[].text` | Yes | Maximum 170 characters (Classtime limit) |
| `questions[].options` | Yes | At least 2 non-empty strings |
| `questions[].correct` | Yes | 0-based index of the correct option (`0` = first, `1` = second) |
| `questions[].points` | No | Positive integer, default 1 |

Tip: if you have an answer key like `1 – Б; 2 – А`, convert letters to indexes:
А = 0, Б = 1, В = 2.

A text-format sample is in `../Приклад - Крайові шви.txt`. JSON files work too (`.json` extension).

## Limitations

- Only single-answer (one correct option) questions are supported.
- No images, audio, video, explanations or standard tags.
- The tool finds buttons by their Ukrainian and English labels. If Classtime changes the
  interface, update the `LABEL` patterns and selectors at the top of `classtime.mjs`.
- It is browser automation, so it takes a few seconds per question.

## Troubleshooting

- **"Not signed in"**: run `node classtime.mjs login` again.
- **Google says "this browser or app may not be secure"**: you are using an old version of the
  tool that signs in inside Playwright. Use the current `login` (plain Chrome).
- **"Chrome did not start"**: another Chrome is using the same profile or port 9222. Close it
  (check Task Manager for `chrome.exe`) and retry.
- **Failure on a question**: the tool saves a screenshot to `errors/question-N.png` and prints
  a resume command. Open the set first and delete any half-created question, then run:
  `node classtime.mjs create <file.json> --set-url <set url> --start N`
- **Wrong or duplicate questions**: delete them in the Classtime UI; the tool does not
  check for existing questions.
- **Button not found**: the interface language may differ from Ukrainian or English. Add
  the label to `LABEL` in `classtime.mjs`.

## Files

| File | Purpose |
|---|---|
| `classtime.mjs` | The tool |
| `../Створити тест.bat` | Launcher for non-technical users (runs from the project root) |
| `../ІНСТРУКЦІЯ.txt`, `../Приклад - Крайові шви.txt` | Teacher instruction and sample |
| `.browser-profile/` | Saved browser session (private, git-ignored) |
| `errors/` | Failure screenshots (git-ignored) |
