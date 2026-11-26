import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, COOLDOWN_FILE, isObject, readJson, run, which } from '../hooks/_shared.mjs';
import { completeConfig, configProblem, moduleFiles, wantsAuto } from './install.mjs';
import { fileHash, readManifest } from './manifest.mjs';
import { safePath } from './paths.mjs';
import { HOOKS, HOOKS_DIR, readSettings, taggedHooks } from './settings.mjs';

const TOOLS = [
  {
    name: 'rg',
    hint: 'winget install BurntSushi.ripgrep.MSVC | brew install ripgrep | apt install ripgrep',
  },
  {
    name: 'sg',
    // Linux ships an unrelated "sg" (newgrp), so the version text must name ast-grep.
    mustMention: /ast-grep/i,
    hint: 'winget install ast-grep.ast-grep | brew install ast-grep | npm i -g @ast-grep/cli',
  },
];

// Each hook runs with mock stdin from a temporary copy, so the real cooldown file is never touched.
function smokeTest(target, report) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 't3ab-doctor-'));
  try {
    const hooks = path.join(sandbox, ...HOOKS_DIR.split('/'));
    fs.mkdirSync(hooks, { recursive: true });
    const installed = path.join(target, ...HOOKS_DIR.split('/'));
    for (const name of fs.readdirSync(installed)) {
      if (name.endsWith('.mjs')) fs.copyFileSync(path.join(installed, name), path.join(hooks, name));
    }
    const config = path.join(target, CONFIG_FILE);
    if (fs.existsSync(config)) fs.copyFileSync(config, path.join(sandbox, CONFIG_FILE));

    const check = (script, label, payload, expected) => {
      const result = spawnSync(process.execPath, [path.join(hooks, script)], {
        input: JSON.stringify(payload),
        cwd: sandbox,
        encoding: 'utf8',
        timeout: 20_000,
      });
      const good = result.status === expected && (expected !== 2 || result.stderr.trim() !== '');
      report(good ? 'ok' : 'fail', `${script} ${label}: exit ${result.status}, expected ${expected}`);
    };
    check('session-start.mjs', 'benign', {}, 0);
    check('pre-compact.mjs', 'benign', { cwd: sandbox }, 0);
    check('pre-tool-use.mjs', 'benign', { tool_name: 'Bash', tool_input: { command: 'echo ok' } }, 0);
    check('pre-tool-use.mjs', 'secret path', { tool_name: 'Write', tool_input: { file_path: '.env' } }, 2);
    check('post-tool-use.mjs', 'benign', { tool_name: 'Write', tool_input: { file_path: path.join(sandbox, 'missing.txt') } }, 0);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Returns the exit code: 1 when something installed is broken, 0 otherwise (warnings allowed). */
export function doctor(target, log = console.log) {
  let failures = 0;
  const report = (level, message) => {
    if (level === 'fail') failures += 1;
    log(`${level.padEnd(4)} ${message}`);
  };
  const attempt = (action) => {
    try {
      return action();
    } catch (error) {
      report('fail', error.message);
      return null;
    }
  };

  const manifest = attempt(() => readManifest(target));
  if (manifest) {
    for (const relative of new Set([...moduleFiles(manifest.modules), ...Object.keys(manifest.files)])) {
      const file = safePath(target, relative);
      if (!file) report('fail', `unsafe path or symlink: ${relative}`);
      else if (!fs.existsSync(file)) report('fail', `missing: ${relative}`);
      else if (manifest.files[relative] !== fileHash(file)) report('warn', `differs from the installed version: ${relative}`);
      else report('ok', relative);
    }
  } else if (failures === 0) {
    report('fail', `not installed: no manifest in ${target}`);
  }

  const settings = attempt(() => readSettings(target));
  if (manifest && wantsAuto(manifest.modules)) {
    const configPath = path.join(target, CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      attempt(() => {
        let config;
        try {
          config = readJson(configPath);
        } catch {
          throw new Error(`${CONFIG_FILE} is not valid JSON`);
        }
        const problem = isObject(config) ? configProblem(completeConfig(config)) : 'not a JSON object';
        if (problem) throw new Error(`${CONFIG_FILE}: ${problem}`);
        report('ok', `${CONFIG_FILE} is valid`);
      });
    }
    if (settings) {
      const tagged = taggedHooks(settings.data);
      for (const { event, script } of HOOKS) {
        const entry = tagged.find((t) => t.event === event && t.hook.command.includes(`/${script}"`));
        const file = entry?.hook.command.match(/"([^"]+)"/)?.[1];
        if (!file) report('fail', `settings.json does not wire ${script} on ${event}`);
        else if (!fs.existsSync(file)) report('fail', `hook path does not exist: ${file}`);
        else report('ok', `${event} wired`);
      }
    }
    if (fs.existsSync(path.join(target, ...HOOKS_DIR.split('/')))) attempt(() => smokeTest(target, report));
  }

  const cooldowns = path.join(target, COOLDOWN_FILE);
  if (fs.existsSync(cooldowns)) {
    try {
      readJson(cooldowns);
    } catch {
      report('warn', `${COOLDOWN_FILE} is not valid JSON`);
    }
  }

  const commands = Object.values(settings?.data.hooks ?? {})
    .flat()
    .flatMap((group) => group?.hooks ?? [])
    .map((hook) => String(hook?.command));
  const legacy = ['safety-guard', 'post-format', 'pre-compact', 'session-start'].filter((name) =>
    commands.some((command) => command.toLowerCase().includes(`${name}.ps1`)),
  );
  if (legacy.length) report('warn', `old PowerShell hooks are still wired (${legacy.join(', ')}); remove them to avoid running both`);

  for (const { name, mustMention, hint } of TOOLS) {
    const executable = which(name);
    const result = executable && run(executable, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    const good = result?.status === 0 && (!mustMention || mustMention.test(`${result.stdout}${result.stderr}`));
    report(good ? 'ok' : 'warn', good ? `${name} available` : `${name} not found. Install: ${hint}`);
  }
  return failures ? 1 : 0;
}
