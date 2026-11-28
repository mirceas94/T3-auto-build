import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AVAILABILITY_FILE, CONFIG_FILE, COOLDOWN_FILE, QUOTA_FILE, RETIRED_MODELS, RUNTIME_SNAPSHOT_FILE, isObject, isSupportedSchema, isV3,
  readAvailability, readJson, run, which,
} from '../hooks/_shared.mjs';
import { findCli } from './detect.mjs';
import { completeConfig, configProblem, moduleFiles, wantsAuto, writeManaged, writeRuntimeSnapshot } from './install.mjs';
import { HOOK_FILES, QUOTA_RULE, isQuota } from './install/plan.mjs';
import { renderInstalledSkill } from './install/write.mjs';
import { fileHash, hashOf, readManifest, writeManifest } from './manifest.mjs';
import { pathKey, resolveMirrorDirs, safeMirrorFile, syncMirrors } from './mirrors.mjs';
import { CATALOG, PROVIDERS } from './plans.mjs';
import { PACKAGE_ROOT, PACKAGE_VERSION, safePath } from './paths.mjs';
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

const STATE_FILE = '.claude/auto-build-state.json';

const optional = (value, valid) => value === undefined || valid(value);
const isBoolean = (value) => typeof value === 'boolean';
const isCount = (value) => Number.isInteger(value) && value >= 0;

// The optional v3 keys, with the same rules the hooks apply when they load them.
const V3_KEYS = [
  ['telemetry', (v) => isObject(v) && optional(v.enabled, isBoolean) && optional(v.maxBytes, isCount),
    'an object with a boolean "enabled" and a non-negative integer "maxBytes"'],
  ['preflight', (v) => isObject(v) && optional(v.ttl, isCount), 'an object with a non-negative integer "ttl"'],
  ['quota', isQuota, QUOTA_RULE],
  ['catalogOverrides', (v) => isBoolean(v) || isObject(v), 'a boolean or an object'],
];

function schemaProblem(config) {
  if (!isSupportedSchema(config)) return 'schemaVersion must be 2 or 3';
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
  const bad = isV3(config) && V3_KEYS.find(([key, valid]) => !optional(config[key], valid));
  return bad ? `${bad[0]} must be ${bad[2]}` : null;
}

/** The parsed config; throws, without quoting the file, when it is unusable. A v1 config has no schemaVersion. */
function validConfig(configPath) {
  let config;
  try {
    config = readJson(configPath);
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON`);
  }
  let problem = isObject(config) ? configProblem(completeConfig(config)) : 'not a JSON object';
  if (!problem && config.schemaVersion !== undefined) problem = schemaProblem(config);
  if (problem) throw new Error(`${CONFIG_FILE}: ${problem}`);
  return config;
}

// Each repair returns what is (or, without "apply", would be) fixed. Unsafe and non-file paths are left to the checks.
function repairHooks(target, manifest, apply, log) {
  const desired = new Map();
  for (const relative of HOOK_FILES) {
    const file = safePath(target, relative);
    if (!file || (fs.existsSync(file) && !fs.statSync(file).isFile())) continue;
    const content = fs.readFileSync(path.join(PACKAGE_ROOT, 'hooks', path.posix.basename(relative)));
    const hash = hashOf(content);
    if (!fs.existsSync(file) || fileHash(file) !== hash || manifest.files[relative] !== hash) desired.set(relative, content);
  }
  if (apply && desired.size) {
    const files = { ...manifest.files };
    writeManaged(target, desired, files, { force: true, log }); // force backs up a modified file first
    for (const [relative, content] of desired) files[relative] = hashOf(content);
    writeManifest(target, { ...manifest, files });
  }
  return [...desired.keys()];
}

/** Only broken mirrors are handed to syncMirrors, so it prunes nothing else. */
function repairMirrors(target, manifest, config, apply, log) {
  const skill = renderInstalledSkill(completeConfig(config), target);
  const wanted = hashOf(skill);
  const recorded = Object.entries(manifest.skillMirrors ?? {});
  const hashes = new Map(recorded.map(([file, hash]) => [pathKey(file), hash]));
  const matches = (file) => fs.existsSync(file) && fileHash(file) === wanted;
  const broken = resolveMirrorDirs(manifest.skillTargets ?? 'auto', { target }).flatMap((root) => {
    const file = safeMirrorFile(root);
    if (!file || (fs.existsSync(file) && !fs.statSync(file).isFile())) return [];
    // An identical mirror that is not recorded is the user's file: repairing it would claim it.
    const recorded = hashes.get(pathKey(file));
    return matches(file) && (recorded === undefined || recorded === wanted) ? [] : [{ root, file }];
  });
  if (apply && broken.length) {
    const keys = new Set(broken.map(({ file }) => pathKey(file)));
    const isBroken = ([file]) => keys.has(pathKey(file));
    const synced = syncMirrors(target, skill, {
      skillTargets: broken.map(({ root }) => root),
      existingMirrors: Object.fromEntries(recorded.filter(isBroken)),
      force: true,
      log,
    });
    const untouched = Object.fromEntries(recorded.filter((entry) => !isBroken(entry)));
    writeManifest(target, { ...manifest, skillMirrors: { ...untouched, ...synced } });
  }
  return broken.map(({ file }) => file).filter((file) => !apply || matches(file));
}

/** The snapshot is compared with one freshly built from the same config bytes, in a temporary directory. */
function repairSnapshot(target, config, apply) {
  const file = safePath(target, RUNTIME_SNAPSHOT_FILE);
  if (!isV3(config) || !file || (fs.existsSync(file) && !fs.statSync(file).isFile())) return [];
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 't3ab-snapshot-'));
  try {
    fs.copyFileSync(path.join(target, CONFIG_FILE), path.join(sandbox, CONFIG_FILE));
    const expected = fs.readFileSync(writeRuntimeSnapshot(sandbox, config));
    if (fs.existsSync(file) && fs.readFileSync(file).equals(expected)) return [];
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  if (apply) writeRuntimeSnapshot(target, config);
  return [RUNTIME_SNAPSHOT_FILE];
}

/** Adds the state file to .git/info/exclude when cwd is in a work tree that does not ignore it yet. */
function repairExclude(cwd, apply) {
  const git = which('git');
  if (!git) return [];
  const ask = (...args) => run(git, ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000 });
  const found = ask('rev-parse', '--show-prefix', '--git-path', 'info/exclude');
  // Exit 1 is "not ignored"; --no-index keeps a tracked state file from looking unignored forever.
  if (found?.status !== 0 || ask('check-ignore', '--quiet', '--no-index', STATE_FILE)?.status !== 1) return [];
  const [prefix, excludePath] = found.stdout.split(/\r?\n/);
  const file = path.resolve(cwd, excludePath);
  const line = `/${prefix.replace(/[*?[\]\\]/g, '\\$&')}${STATE_FILE}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // A .gitignore negation outranks info/exclude; never append the same line twice.
  if (current.split(/\r?\n/).includes(line)) return [];
  if (apply) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  return [`git exclude ${line}`];
}

/** settings.json, the config, core files and the primary SKILL.md are never rewritten here. */
function repair(target, { apply, cwd, log, attempt }) {
  const planned = [];
  const step = (label, action) => attempt(() => planned.push(...action().map((item) => `${label}${item}`)));
  // Read again for every step: the one before may have rewritten the manifest.
  const installed = () => {
    const manifest = readManifest(target);
    return manifest && wantsAuto(manifest.modules) ? manifest : null;
  };
  const config = () => {
    const file = safePath(target, CONFIG_FILE);
    return file && fs.existsSync(file) ? validConfig(file) : null;
  };
  if (attempt(installed)) {
    step('hook ', () => repairHooks(target, installed(), apply, log));
    const usable = attempt(config);
    if (usable) {
      step('skill mirror ', () => repairMirrors(target, installed(), usable, apply, log));
      step('', () => repairSnapshot(target, usable, apply));
    }
  }
  step('', () => repairExclude(cwd, apply));
  return planned;
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

/**
 * Returns the exit code: 1 when something installed is broken, 0 otherwise (warnings allowed). The second argument is a
 * log function or { fix, yes, cwd, log }. "fix" only reports the repairs unless "yes" is set; with both, it repairs
 * first and then checks the result.
 */
export function doctor(target, options) {
  const { fix = false, yes = false, cwd = process.cwd(), log = console.log } =
    typeof options === 'function' ? { log: options } : options ?? {};
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

  if (fix && yes) {
    const fixed = repair(target, { apply: true, cwd, log, attempt });
    log(fixed.length ? `fixed: ${fixed.join('; ')}` : 'nothing to fix');
  }

  const manifest = attempt(() => readManifest(target));
  if (manifest) {
    const installed = manifest.packageVersion;
    if (installed === PACKAGE_VERSION) report('ok', `installed version ${installed}`);
    else report('warn', `installed version ${installed ?? 'not recorded'}, this CLI is ${PACKAGE_VERSION}; run t3-auto-build init`);
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
        const config = validConfig(configPath);
        if (config.schemaVersion === undefined) {
          report('warn', `${CONFIG_FILE}: legacy v1 config — run \`t3-auto-build upgrade\``);
        } else {
          report('ok', `${CONFIG_FILE} v${config.schemaVersion} is valid`);
          for (const provider of PROVIDERS) {
            const tierId = config.subscriptions[provider];
            if (tierId === 'none') continue;
            const tier = CATALOG[provider][tierId];
            if (!tier.cliSupported) report('warn', `${provider} tier ${tierId} is not supported by its CLI`);
            else if (!findCli(provider, which)) report('warn', `${provider} tier ${tierId} is configured but its CLI binary is missing`);
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
      if (mirroredKeys.has(pathKey(expected))) continue;
      if (fs.existsSync(expected)) report('warn', `skill mirror not managed: ${expected}; init --force takes ownership`);
      else report('warn', `provider skill dir not mirrored: ${dir}; run t3-auto-build init`);
    }
  }

  for (const name of [COOLDOWN_FILE, QUOTA_FILE]) {
    const file = safePath(target, name);
    if (!file) {
      report('fail', `unsafe path or symlink: ${name}`);
    } else if (fs.existsSync(file)) {
      try {
        if (!isObject(readJson(file))) report('warn', `${name} is not a JSON object`);
      } catch {
        report('warn', `${name} is not valid JSON`);
      }
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
  if (fix && !yes) {
    const planned = repair(target, { apply: false, cwd, log, attempt });
    log(planned.length ? `would fix: ${planned.join('; ')}; re-run with --fix --yes to apply` : 'nothing to fix');
  }
  return failures ? 1 : 0;
}
