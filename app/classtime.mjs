#!/usr/bin/env node
// Classtime question importer: reads a JSON file and creates the questions
// in classtime.com by driving a real browser with Playwright. No AI involved.

import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, '.browser-profile'); // saved login lives here
const ERROR_DIR = path.join(ROOT, 'errors');
const BASE = 'https://www.classtime.com';
const MAX_QUESTION_LEN = 170; // Classtime limit shown in the form (0/170)

// UI labels (Ukrainian + English) so the tool works in either UI language.
const LABEL = {
  newSet: /Нова Група питань|New Question Set|Create Question Set/i,
  save: /^(Зберегти|Save)$/i,
  newQuestion: /Нове Питання|New Question/i,
  addOption: /Додати варіант відповіді|Add (an )?(answer )?option/i,
  createQuestion: /Створити питання|Create question/i,
};

// ---------- args ----------
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && ['set-url', 'start'].includes(key)) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node classtime.mjs login                      Open browser, sign in once (session is saved)
  node classtime.mjs validate <file.json>       Check the JSON without opening a browser
  node classtime.mjs create <file.json> [opts]  Create the question set and questions

Options for create:
  --set-url <url>   Add to an existing question set instead of creating a new one
  --start <n>       Start from question number n (1-based), to resume after an error
  --headless        Run without a visible browser window
  --dry-run         Validate and print the plan, do not touch Classtime
`);
}

// ---------- validation ----------
export function validate(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['Root must be an object'];
  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    errors.push('"questions" must be a non-empty array');
    return errors;
  }
  if (data.set !== undefined && (typeof data.set !== 'string' || !data.set.trim())) {
    errors.push('"set" must be a non-empty string');
  }
  data.questions.forEach((q, i) => {
    const n = `Question ${i + 1}`;
    if (typeof q.text !== 'string' || !q.text.trim()) errors.push(`${n}: "text" is required`);
    else if (q.text.length > MAX_QUESTION_LEN)
      errors.push(`${n}: text is ${q.text.length} chars, max ${MAX_QUESTION_LEN}`);
    if (!Array.isArray(q.options) || q.options.length < 2)
      errors.push(`${n}: "options" needs at least 2 items`);
    else if (q.options.some((o) => typeof o !== 'string' || !o.trim()))
      errors.push(`${n}: every option must be a non-empty string`);
    if (!Number.isInteger(q.correct) || !Array.isArray(q.options) || q.correct < 0 || q.correct >= q.options.length)
      errors.push(`${n}: "correct" must be the 0-based index of an option`);
    if (q.points !== undefined && (!Number.isInteger(q.points) || q.points < 1))
      errors.push(`${n}: "points" must be a positive integer`);
  });
  return errors;
}

// ---------- plain-text input ----------
// Format (what a teacher normally has in a document):
//   1. Question text
//   A. option
//   Б. option
//   ...
//   Ключ відповідей:
//   1 – Б; 2 – А; ...
// Alternative to the key: put * before the correct option, e.g. "*Б. option".
const LETTER = '[A-Za-zА-ЯІЇЄҐа-яіїєґ]';
const LATIN_ORDER = 'ABCDEFGH';
const CYR_ORDER = 'АБВГДЕЖЗ';

function letterIndex(ch) {
  const c = ch.toUpperCase();
  if (c === 'С') return 2; // Cyrillic "Es" looks like Latin C
  const lat = LATIN_ORDER.indexOf(c);
  if (lat >= 0) return lat;
  const cyr = CYR_ORDER.indexOf(c);
  return cyr; // -1 when unknown
}

export function parseText(raw, setName) {
  const lines = raw.split(/\r?\n/);
  const questions = [];
  const keyLines = [];
  const problems = [];
  let cur = null;
  let lastTarget = null; // where wrapped lines are appended: 'q' or option index
  let inKey = false;

  lines.forEach((line0, idx) => {
    const line = line0.trim();
    if (!line) return;
    if (/^(ключ|відповіді|правильні відповіді|answers?|key)(?![A-Za-zА-ЯІЇЄҐа-яіїєґ])/i.test(line)) {
      inKey = true;
      keyLines.push(line.replace(/^[^:]*:?/, ''));
      return;
    }
    if (inKey) {
      keyLines.push(line);
      return;
    }
    const qm = line.match(/^(\d+)\s*[.)]\s*(.+)$/);
    if (qm) {
      cur = { num: Number(qm[1]), text: qm[2].trim(), options: [], correct: undefined, line: idx + 1 };
      questions.push(cur);
      lastTarget = 'q';
      return;
    }
    const om = line.match(new RegExp(`^(\\*?)\\s*(${LETTER})\\s*[.)]\\s*(.+)$`));
    if (om && cur) {
      let text = om[3].trim();
      let marked = om[1] === '*';
      if (/[✓✔]\s*$/.test(text)) {
        marked = true;
        text = text.replace(/\s*[✓✔]\s*$/, '');
      }
      cur.options.push(text);
      if (marked) cur.correct = cur.options.length - 1;
      lastTarget = cur.options.length - 1;
      return;
    }
    if (cur) {
      // continuation of a wrapped line
      if (lastTarget === 'q') cur.text += ' ' + line;
      else if (lastTarget !== null) cur.options[lastTarget] += ' ' + line;
    } else {
      problems.push(`Рядок ${idx + 1}: не зрозуміло, до чого це належить: "${line}"`);
    }
  });

  // answer key: pairs like "1 – Б", "2-А", "3) В", "4: Г"
  const key = new Map();
  const pair = new RegExp(`(\\d+)\\s*[–—\\-:=.)]*\\s*(${LETTER})(?![A-Za-zА-ЯІЇЄҐа-яіїєґ])`, 'g');
  for (const m of keyLines.join(' ').matchAll(pair)) key.set(Number(m[1]), letterIndex(m[2]));

  questions.forEach((q) => {
    const label = `Питання ${q.num}`;
    if (q.correct === undefined && key.has(q.num)) {
      q.correct = key.get(q.num);
      if (q.correct < 0) problems.push(`${label}: невідома літера в ключі відповідей`);
    }
    if (q.options.length < 2) problems.push(`${label}: потрібно щонайменше 2 варіанти відповіді`);
    if (q.correct === undefined) problems.push(`${label}: немає правильної відповіді (ні в ключі, ні позначки *)`);
    else if (q.correct >= q.options.length)
      problems.push(`${label}: правильна відповідь вказує на неіснуючий варіант`);
  });
  if (questions.length === 0) problems.push('Не знайдено жодного питання. Питання мають починатись з "1." , "2." ...');
  if (problems.length) throw new Error('Проблеми у файлі:\n - ' + problems.join('\n - '));

  return { set: setName, questions: questions.map(({ text, options, correct }) => ({ text, options, correct })) };
}

async function readTextFile(full) {
  const buf = await readFile(full);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^﻿/, '');
  return buf.toString('utf8').replace(/^﻿/, '');
}

async function loadFile(file) {
  if (!file) throw new Error('Не вказано файл з питаннями');
  const full = path.resolve(file);
  if (!existsSync(full)) throw new Error(`Файл не знайдено: ${full}`);
  const raw = await readTextFile(full);
  const ext = path.extname(full).toLowerCase();
  if (ext === '.json') {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`Файл JSON містить помилку: ${e.message}`);
    }
  }
  // Plain text: the file name becomes the name of the test.
  return parseText(raw, path.basename(full, path.extname(full)));
}

// ---------- browser ----------
// Google refuses sign-in inside browsers started by automation ("this browser or app may
// not be secure"). So we start a NORMAL Chrome ourselves (own profile folder, remote
// debugging port) and only attach Playwright to it afterwards.
const DEBUG_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${DEBUG_PORT}`;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found. Install it or set CHROME_PATH to chrome.exe');
  return found;
}

async function cdpReady() {
  try {
    return (await fetch(`${CDP_URL}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function startChrome({ headless = false, url = `${BASE}/questions` } = {}) {
  if (await cdpReady()) return; // already running with the debugging port
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
  ];
  if (headless) args.push('--headless=new');
  args.push(url);
  spawn(findChrome(), args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpReady()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Chrome did not start (is another Chrome using the same profile?)');
}

// Attach Playwright to the running Chrome. close() shuts Chrome down gracefully so the
// session cookies are written to disk.
async function launch(headless) {
  await startChrome({ headless });
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return {
    pages: () => context.pages(),
    newPage: () => context.newPage(),
    close: async () => {
      try {
        const s = await browser.newBrowserCDPSession();
        await s.send('Browser.close');
      } catch {
        await browser.close().catch(() => {});
      }
    },
  };
}

async function isSignedIn(page) {
  try {
    // The top nav link to the library only exists once signed in.
    await page.locator('a[href="/questions"]').first().waitFor({ timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// If the saved session is missing/expired, let the person sign in right in the open window.
async function ensureLoggedIn(page) {
  await page.goto(`${BASE}/questions`, { waitUntil: 'domcontentloaded' });
  if (await isSignedIn(page)) return;
  console.log('\nПотрібно увійти в Classtime. У вікні Chrome, що відкрилося, увійдіть у свій акаунт.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Коли побачите свою бібліотеку — натисніть Enter тут... ');
  rl.close();
  await page.goto(`${BASE}/questions`, { waitUntil: 'domcontentloaded' });
  if (!(await isSignedIn(page))) throw new Error('Вхід не виконано. Спробуйте ще раз.');
}

async function login() {
  // Plain Chrome, no automation attached, so Google allows the sign-in.
  await startChrome({ headless: false });
  console.log('Sign in to Classtime in the Chrome window that just opened.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('When you can see your library, press Enter here... ');
  rl.close();
  const ctx = await launch(false);
  await ctx.close(); // closes Chrome gracefully and saves the session
  console.log('Session saved.');
}

async function createSet(page, name) {
  await page.getByRole('button', { name: LABEL.newSet }).click();
  const input = page.locator('input[type="text"]:visible').last();
  await input.fill(name);
  await page.getByRole('button', { name: LABEL.save }).click();
  await page.waitForURL(/\/questions\/question-sets\/[0-9a-f-]+/, { timeout: 20000 });
  return page.url();
}

async function addQuestion(page, q) {
  await page.getByRole('button', { name: LABEL.newQuestion }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });

  // Question text: first plain text input in the dialog.
  const textInput = dialog.locator('input[type="text"]').first();
  await textInput.click();
  await textInput.fill(q.text);

  // Make sure there are enough answer rows.
  const radios = dialog.locator('input[type="radio"]');
  while ((await radios.count()) < q.options.length) {
    const before = await radios.count();
    await dialog.getByRole('button', { name: LABEL.addOption }).click();
    await page.waitForFunction(
      ([n]) => document.querySelectorAll('[role="dialog"] input[type="radio"]').length > n,
      [before],
      { timeout: 5000 },
    );
  }

  // Fill each option: the editor that follows each radio button.
  for (let i = 0; i < q.options.length; i++) {
    const editor = radios.nth(i).locator('xpath=following::div[@contenteditable="true"][1]');
    await editor.click();
    await page.keyboard.type(q.options[i]);
  }

  // Mark the correct answer (click the visible wrapper of the hidden radio input).
  await radios.nth(q.correct).locator('xpath=..').click();

  if (q.points && q.points !== 1) {
    const points = dialog.locator('input[placeholder="1"]');
    await points.fill(String(q.points));
  }

  const submit = dialog.getByRole('button', { name: LABEL.createQuestion });
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) =>
        /Створити питання|Create question/i.test(x.textContent || ''),
      );
      return b && !b.disabled;
    },
    null,
    { timeout: 10000 },
  );
  await submit.click();
  await dialog.waitFor({ state: 'hidden', timeout: 20000 });
  await page.waitForTimeout(800); // let the list refresh before the next question
}

async function create(file, flags) {
  const data = await loadFile(file);
  const errors = validate(data);
  if (errors.length) {
    console.error('Validation failed:\n - ' + errors.join('\n - '));
    process.exit(1);
  }
  const start = Math.max(1, parseInt(flags.start ?? '1', 10)) - 1;
  const setUrl = flags['set-url'];
  if (!setUrl && !data.set) {
    console.error('Provide "set" in the JSON (new set name) or pass --set-url.');
    process.exit(1);
  }
  console.log(`\nТест: "${data.set}" — питань: ${data.questions.length}\n`);
  data.questions.slice(start).forEach((q, i) => {
    console.log(`${start + i + 1}. ${q.text}`);
    q.options.forEach((o, k) => console.log(`   ${k === q.correct ? '✓' : ' '} ${o}`));
  });
  if (flags['dry-run']) return;
  if (!flags.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question('\n✓ — правильна відповідь. Усе вірно? Натисніть Enter, щоб створити тест (або закрийте вікно): ');
    rl.close();
    void ans;
  }

  const ctx = await launch(Boolean(flags.headless));
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let current = start;
  try {
    await ensureLoggedIn(page);
    if (setUrl) {
      await page.goto(setUrl, { waitUntil: 'domcontentloaded' });
    } else {
      await createSet(page, data.set);
      console.log(`\nСтворено тест "${data.set}"`);
    }
    for (; current < data.questions.length; current++) {
      const q = data.questions[current];
      await addQuestion(page, q);
      console.log(`  [${current + 1}/${data.questions.length}] ${q.text}`);
    }
    console.log('\nГотово! Усі питання створені. Тест знаходиться у вашій бібліотеці Classtime.');
  } catch (e) {
    await mkdir(ERROR_DIR, { recursive: true });
    const shot = path.join(ERROR_DIR, `question-${current + 1}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    console.error(`\nНе вдалося створити питання ${current + 1}: ${e.message}`);
    console.error(`Знімок екрана: ${shot}`);
    console.error(`Відкрийте тест у Classtime, видаліть недороблене питання (якщо є) і зверніться по допомогу.`);
    console.error(`Для технічної особи: --start ${current + 1} --set-url ${page.url()}`);
    process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

// ---------- main ----------
const { _: pos, flags } = parseArgs(process.argv.slice(2));
let [cmd, file] = pos;
try {
  // Non-technical mode: `node classtime.mjs "questions.txt"` (or no argument: ask for the file).
  if (cmd !== undefined && !['login', 'validate', 'create'].includes(cmd)) {
    file = cmd;
    cmd = 'create';
  } else if (cmd === undefined && !flags.help) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Перетягніть сюди файл з питаннями (.txt) і натисніть Enter: ');
    rl.close();
    file = answer.trim().replace(/^["']|["']$/g, '');
    cmd = 'create';
  }
  if (cmd === 'login') await login();
  else if (cmd === 'validate') {
    const errs = validate(await loadFile(file));
    if (errs.length) {
      console.error('Invalid:\n - ' + errs.join('\n - '));
      process.exit(1);
    }
    console.log('OK');
  } else if (cmd === 'create') await create(file, flags);
  else usage();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
