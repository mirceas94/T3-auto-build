// PreToolUse guardrails. Exit 2 blocks the tool call; every blocked path writes its reason to stderr.
import fs from 'node:fs';
import path from 'node:path';
import {
  COOLDOWN_FILE, configDirOf, cooldownEntries, effectiveAllowlist, isBanned, loadConfig, normalizeName, prop, readJson,
  readPayload, str, warn,
} from './_shared.mjs';

// (?=\n?$) mirrors .NET's "$", which also matches before a trailing newline.
const SECRET_PATHS = [/(^|[\\/])\.env((?=\n?$)|\.)/i, /\.(pem|key|p12|pfx)(?=\n?$)/i, /id_rsa|id_ed25519/i];
const DESTRUCTIVE = [/git\s+push\s+.*(-f|--force)/i, /git\s+reset\s+--hard/i, /rm\s+-rf\s+[/\\~.]/i];

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// T3 provider ids to config provider keys. Custom instances (codex-2) resolve by driverKind or this prefix.
const PROVIDERS = new Map([['claudeagent', 'Claude'], ['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity']]);
const compact = (id) => id.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every normalized name a provider-wide cooldown may use for these ids. */
function providerNames(ids) {
  return new Set(ids.flatMap((id) => {
    const alias = [...PROVIDERS.keys()].find((prefix) => compact(id).startsWith(prefix));
    return [id, PROVIDERS.get(alias) ?? id].map(normalizeName);
  }));
}

function cooldownBlock(configDir, models, providers) {
  const file = path.join(configDir, COOLDOWN_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const now = Date.now();
    const modelNames = new Set(models.map(normalizeName));
    const names = providerNames(providers);
    for (const [key, value, until] of cooldownEntries(readJson(file))) {
      if (until <= now) continue;
      const scope = str(value.scope);
      // Only exact aliases apply to the key, so a "codex-2" cooldown does not block every Codex instance.
      if ((same(scope, 'model') && modelNames.has(normalizeName(key)))
        || (same(scope, 'provider') && names.has(normalizeName(PROVIDERS.get(compact(key)) ?? key)))) {
        return `Blocked by cooldown hook: '${key}' is on active cooldown until ${value.until_utc} (${str(value.reason)}).`;
      }
    }
  } catch (error) {
    warn(`ignoring ${COOLDOWN_FILE} (${error.name})`);
  }
  return null;
}

function blockReason(payload) {
  const tool = str(prop(payload, 'tool_name'));
  const input = prop(payload, 'tool_input');

  if (['edit', 'write', 'multiedit'].includes(tool.toLowerCase())) {
    const file = str(prop(input, 'file_path'));
    if (SECRET_PATHS.some((pattern) => pattern.test(file))) {
      return `Blocked by safety hook: modifying secret/credential file '${file}' is prohibited.`;
    }
  }

  if (same(tool, 'bash')) {
    const command = str(prop(input, 'command'));
    if (DESTRUCTIVE.some((pattern) => pattern.test(command))) {
      return `Blocked by safety hook: destructive command '${command}' is prohibited.`;
    }
  }

  if (/delegate_task/i.test(tool)) {
    // Legacy top-level fields and T3's nested `target` are both checked, so neither can mask the other.
    // A call without a model is allowed (as the PowerShell script does); only provider cooldowns apply to it.
    const refs = [input, prop(input, 'target')];
    const field = (name) => refs.map((ref) => str(prop(ref, name))).filter(Boolean);
    const models = field('model');
    const providers = ['provider', 'providerInstanceId', 'driverKind'].flatMap(field);
    if (!models.length && !providers.length) return null;
    const configDir = configDirOf(import.meta.url);
    if (models.length) {
      const config = loadConfig(configDir);
      const allowed = effectiveAllowlist(config).flatMap(([, names]) => names);
      for (const model of models) {
        if (isBanned(model, config.bannedModels)) {
          return `Blocked by allowlist hook: model '${model}' is banned.`;
        }
        if (!allowed.some((name) => normalizeName(name) === normalizeName(model))) {
          return `Blocked by allowlist hook: model '${model}' is outside the ${allowed.length}-model allowlist.`;
        }
      }
    }
    return cooldownBlock(configDir, models, providers);
  }
  return null;
}

try {
  const reason = blockReason(await readPayload());
  if (reason) {
    // exitCode (not process.exit) lets stderr flush before the process ends.
    process.exitCode = 2;
    process.stderr.write(`${reason}\n`);
  }
} catch (error) {
  warn(`pre-tool-use failed (${error.message})`);
}
