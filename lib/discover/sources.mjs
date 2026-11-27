// CLI discovery adapters and model id parsing: zero inference. Node >=18, node:* only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RETIRED_MODELS, canonicalProvider, inferProvider, isObject, isStringList, matchRetired, modelKeys, normalizeModel,
  which as findOnPath,
} from '../../hooks/_shared.mjs';
import { MODELS, PROVIDERS, supersedes } from '../plans.mjs';

const MAX_OUTPUT = 1_000_000;
// Adapter output and the availability file are untrusted, and these ids can end up in the config and SKILL.md.
export const DISCOVERED_ID = /^(?=.*\d)[a-z0-9][a-z0-9._-]{0,79}$/;

/** { family, version } of a model id or display name, else null. */
export function parseFamily(id) {
  if (typeof id !== 'string') return null;
  const name = normalizeModel(id.trim().toLowerCase().replace(/\s+/g, '-'));
  if (Object.hasOwn(MODELS, name)) return { family: MODELS[name].family, version: MODELS[name].version };
  const other = name.match(/^(gpt|gemini)-(\d+(?:\.\d+)*)-([a-z]+(?:-[a-z]+)*)$/);
  if (other) return { family: `${other[1]}-${other[3]}`, version: other[2] };
  const claude = name.match(/^claude-([a-z]+)-(\d+(?:[.-]\d+)*)$/);
  return claude ? { family: `claude-${claude[1]}`, version: claude[2].replace(/-/g, '.') } : null;
}

export const sameModel = (a, b, config) => {
  const keys = modelKeys(a, config);
  return [...modelKeys(b, config)].some((key) => keys.has(key));
};

/** Usable config.models entries, with canonical provider keys. */
export const configuredModels = (config) => (Array.isArray(config?.models) ? config.models : [])
  .filter((entry) => isObject(entry) && typeof entry.model === 'string' && canonicalProvider(entry.provider))
  .map((entry) => ({ ...entry, provider: canonicalProvider(entry.provider) }));

export const list = (value) => (isStringList(value) ? value : []);
export const retiredPatterns = (config) => [...RETIRED_MODELS, ...list(config?.retiredModels)];
export const bannedTerms = (config) => [...list(config?.bannedModels), ...list(config?.userBannedModels)];

const failed = (code) => ({ status: null, stdout: '', stderr: '', error: { code } });

// A .cmd shim goes through run() in a node child, which keeps its quoting rules and leaves this process free to kill it.
const SHIM_RUNNER = `const { run } = await import(${JSON.stringify(new URL('../../hooks/_shared.mjs', import.meta.url).href)});
const [file, args] = JSON.parse(process.argv[1]);
process.exitCode = run(file, args, { stdio: ['ignore', 'inherit', 'ignore'] })?.status ?? 1;`;

export function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => child.kill()).unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // the child leads its own process group
  } catch {
    // already gone
  }
}

/** Async counterpart of probe.mjs createRunner: runs in an empty temp directory and kills the tree on timeout. */
export const asyncRunner = (which) => (cmd, args, { timeout }) => new Promise((resolve) => {
  const executable = path.isAbsolute(cmd) ? cmd : which(cmd);
  if (!executable) {
    resolve(failed('ENOENT'));
    return;
  }
  const [file, argv] = /\.(cmd|bat)$/i.test(executable)
    ? [process.execPath, ['--input-type=module', '-e', SHIM_RUNNER, JSON.stringify([executable, args])]]
    : [executable, args];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't3-discover-'));
  let timer;
  let stdout = '';
  const finish = (result) => {
    clearTimeout(timer);
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      // still held by a dying child; the OS temp cleanup takes it
    }
    resolve(result);
  };
  let child;
  try {
    child = spawn(file, argv, {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32',
    });
  } catch (error) {
    finish(failed(error.code));
    return;
  }
  const abort = (code) => {
    killTree(child);
    child.stdout.destroy();
    child.unref();
    finish(failed(code));
  };
  timer = setTimeout(() => abort('ETIMEDOUT'), timeout);
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > MAX_OUTPUT) abort('ENOBUFS');
  });
  child.on('error', (error) => finish(failed(error.code)));
  child.on('close', (status) => finish({ status, stdout, stderr: '' }));
});

/** Never rejects and never takes longer than timeoutMs, whatever the runner does. */
function bounded(work, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(failed('ETIMEDOUT')), timeoutMs); });
  const attempt = Promise.resolve().then(work).catch((error) => failed(error?.code));
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}

const succeeded = (result) => result?.status === 0 && !result.error;

const versionIn = (result) => (succeeded(result)
  ? String(result.stdout).slice(0, 500).match(/\d+(?:\.\d+)+(?:-[0-9A-Za-z.]{1,20})?/)?.[0] ?? null
  : null);

/** Model ids from a JSON array or one-per-line output; null when the adapter failed or listed nothing usable. */
function modelIdsIn(result) {
  if (!succeeded(result)) return null;
  const text = String(result.stdout).replace(/^\uFEFF/, '').trim();
  let items = text.split(/\r?\n/);
  if (text.startsWith('[')) {
    try {
      items = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const ids = [...new Set(items.filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => DISCOVERED_ID.test(item)))];
  return ids.length ? ids : null;
}

/** Binary checks and optional listing adapters, in parallel. Never runs inference. */
export async function discover({ config, runner, which = findOnPath, now = Date.now(), timeoutMs = 1500 } = {}) {
  const exec = runner ?? asyncRunner(which);
  const call = (cmd, args) => bounded(() => exec(cmd, args, { timeout: timeoutMs }), timeoutMs);
  // shortcut: no built-in listing adapters, as no CLI documents one; only config.discovery argv. Add one when a CLI does.
  const hosts = await Promise.all(PROVIDERS.map(async (provider) => {
    const found = Boolean(which(provider));
    const argv = config?.discovery?.[provider];
    const [version, listing] = await Promise.all([
      found ? call(provider, ['--version']) : null,
      isStringList(argv) && argv.length > 0 ? call(argv[0], argv.slice(1)) : null,
    ]);
    return { provider, found, version: versionIn(version), listed: modelIdsIn(listing) };
  }));

  const configured = configuredModels(config);
  const checkedAt = new Date(now).toISOString();
  const models = {};
  const discoveredNew = [];
  const missingConfigured = [];
  for (const { provider, listed } of hosts) {
    if (!listed) continue;
    const mine = configured.filter((entry) => entry.provider === provider);
    for (const id of listed) {
      const match = mine.find((entry) => sameModel(entry.model, id, config));
      if (match) {
        models[`${provider}:${match.model}`] = { status: 'available', source: 'discover', checkedAt };
        continue;
      }
      const parsed = parseFamily(id);
      const item = { provider, model: id, family: parsed?.family ?? null, version: parsed?.version ?? null };
      let newest = null;
      for (const entry of parsed ? mine : []) {
        const other = parseFamily(entry.model);
        if (other?.family === parsed.family && (!newest || supersedes(other, newest.parsed))) {
          newest = { model: entry.model, parsed: other };
        }
      }
      if (newest && supersedes(parsed, newest.parsed) && !matchRetired(id, retiredPatterns(config))) {
        item.supersedes = newest.model;
      }
      discoveredNew.push(item);
    }
    // Cross-hosted models are not expected in a provider's own listing.
    missingConfigured.push(...mine
      .filter((entry) => inferProvider(entry.model) === provider
        && !listed.some((id) => sameModel(entry.model, id, config)))
      .map((entry) => `${provider}:${entry.model}`));
  }
  return {
    binaries: Object.fromEntries(hosts.map(({ provider, found, version }) => [provider, { found, version }])),
    models,
    discoveredNew,
    missingConfigured,
  };
}
