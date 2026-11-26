import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AVAILABILITY_FILE, CONFIG_FILE, COOLDOWN_FILE, RETIRED_MODELS, isObject, readAvailability, readJson, run, which } from '../hooks/_shared.mjs';
import { completeConfig, configProblem, moduleFiles, wantsAuto } from './install.mjs';
import { fileHash, readManifest } from './manifest.mjs';
import { pathKey, resolveMirrorDirs, safeMirrorFile } from './mirrors.mjs';
import { CATALOG, PROVIDERS } from './plans.mjs';
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

function v2Problem(config) {
  if (config.schemaVersion !== 2) return 'schemaVersion must be 2';
  if (!isObject(config.subscriptions) || PROVIDERS.some((provider) => !Object.hasOwn(CATALOG[provider], config.subscriptions[provider]))) {
    return 'subscriptions must name a known tier for claude, codex and antigravity';
  }
  if (!Array.isArray(config.models) || config.models.some((entry) => !isObject(entry)
    || !PROVIDERS.includes(entry.provider) || typeof entry.model !== 'string' || !entry.model.trim()
    || typeof entry.pool !== 'string' || typeof entry.scarceQuota !== 'boolean'
    || typeof entry.family !== 'string' || typeof entry.version !== 'string')) return 'models entries must include provider, model, pool, scarceQuota, family and version';
  if (!isObject(config.ladders) || Object.values(config.ladders).some((entries) => !Array.isArray(entries)
    || entries.some((entry) => typeof entry !== 'string' || !entry.trim()))) return 'ladders must map names to non-empty model reference lists';
  if (!Array.isArray(config.retiredModels) || RETIRED_MODELS.some((model) => !config.retiredModels.includes(model))) {
    return 'retiredModels must include every built-in retired model';
  }
  return null;
}

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
    const config = safePath(target, CONFIG_FILE);
    if (config && fs.existsSync(config) && fs.statSync(config).isFile()) fs.copyFileSync(config, path.join(sandbox, CONFIG_FILE));

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
      else attempt(() => {
        if (!fs.statSync(file).isFile()) throw new Error(`not a regular file: ${relative}`);
        if (manifest.files[relative] !== fileHash(file)) report('warn', `differs from the installed version: ${relative}`);
        else report('ok', relative);
      });
    }
  } else if (failures === 0) {
    report('fail', `not installed: no manifest in ${target}`);
  }

  const settings = attempt(() => readSettings(target));
  if (manifest && wantsAuto(manifest.modules)) {
    const configPath = safePath(target, CONFIG_FILE);
    if (configPath && fs.existsSync(configPath)) {
      attempt(() => {
        let config;
        try {
          config = readJson(configPath);
        } catch {
          throw new Error(`${CONFIG_FILE} is not valid JSON`);
        }
        const problem = isObject(config) ? configProblem(completeConfig(config)) : 'not a JSON object';
        if (problem) throw new Error(`${CONFIG_FILE}: ${problem}`);
        if (config.schemaVersion === undefined) {
          report('warn', `${CONFIG_FILE}: legacy v1 config — run \`t3-auto-build upgrade\``);
        } else {
          const v2 = v2Problem(config);
          if (v2) throw new Error(`${CONFIG_FILE}: ${v2}`);
          report('ok', `${CONFIG_FILE} v2 is valid`);
          for (const provider of PROVIDERS) {
            const tierId = config.subscriptions[provider];
            if (tierId === 'none') continue;
            const tier = CATALOG[provider][tierId];
            if (!tier.cliSupported) report('warn', `${provider} tier ${tierId} is not supported by its CLI`);
            else if (!which(provider)) report('warn', `${provider} tier ${tierId} is configured but its CLI binary is missing`);
          }
        }
      });
      const availabilityPath = safePath(target, AVAILABILITY_FILE);
      if (!availabilityPath) {
        report('fail', `unsafe path or symlink: ${AVAILABILITY_FILE}`);
      } else {
        const { data: availability, stale } = readAvailability(availabilityPath);
        if (!availability) report('warn', `${AVAILABILITY_FILE} ${fs.existsSync(availabilityPath) ? 'is malformed' : 'is missing'}; run t3-auto-build check-models`);
        else {
          const age = Math.max(0, Date.now() - Date.parse(availability.checkedAt));
          const ageText = Number.isFinite(age) ? ` (${(age / 3_600_000).toFixed(1)}h old)` : '';
          report(stale ? 'warn' : 'ok', `${AVAILABILITY_FILE} ${stale ? 'is stale' : 'is fresh'}${ageText}`);
          if ((availability.discoveredNew ?? []).length || (availability.missingConfigured ?? []).length) {
            report('warn', `model drift: ${(availability.discoveredNew ?? []).length} discovered, ${(availability.missingConfigured ?? []).length} missing configured`);
          }
        }
      }
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
    const mirrored = manifest.skillMirrors ?? {};
    const mirroredKeys = new Set(Object.keys(mirrored).map(pathKey));
    for (const [mirrorFile, expectedHash] of Object.entries(mirrored)) {
      const root = path.dirname(path.dirname(mirrorFile));
      const checked = safeMirrorFile(root);
      if (!checked || pathKey(checked) !== pathKey(mirrorFile)) {
        report('fail', `unsafe path or symlink: ${mirrorFile}`);
      } else if (!fs.existsSync(mirrorFile)) {
        report('warn', `missing skill mirror: ${mirrorFile}; run t3-auto-build init`);
      } else attempt(() => {
        if (!fs.statSync(mirrorFile).isFile()) throw new Error(`not a regular file: ${mirrorFile}`);
        if (fileHash(mirrorFile) !== expectedHash) report('warn', `skill mirror differs from the installed version: ${mirrorFile}`);
        else report('ok', `skill mirror: ${mirrorFile}`);
      });
    }
    for (const dir of resolveMirrorDirs(manifest.skillTargets ?? 'auto', { target })) {
      const expected = path.join(dir, 'auto-build', 'SKILL.md');
      if (!mirroredKeys.has(pathKey(expected))) report('warn', `provider skill dir not mirrored: ${dir}; run t3-auto-build init`);
    }
  }

  const cooldowns = safePath(target, COOLDOWN_FILE);
  if (!cooldowns) {
    report('fail', `unsafe path or symlink: ${COOLDOWN_FILE}`);
  } else if (fs.existsSync(cooldowns)) {
    try {
      if (!isObject(readJson(cooldowns))) report('warn', `${COOLDOWN_FILE} is not a JSON object`);
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
