// PreToolUse guardrails. Exit 2 blocks the tool call; every blocked path writes its reason to stderr.
import path from 'node:path';
import { isLocked, readCooldowns } from './_quota.mjs';
import {
  AVAILABILITY_FILE, COOLDOWN_FILE, canonicalProvider, configDirOf, effectiveAllowlist, fastModeRequested, isBanned,
  loadConfig, matchRetired, modelKeys, normalizeModel, payloadProblem, prop, readAvailability, readPayload, resolveTarget,
  restrictedBy, str, warn,
} from './_shared.mjs';

// (?=\n?$) mirrors .NET's "$", which also matches before a trailing newline.
const SECRET_PATHS = [/(^|[\\/])\.env((?=\n?$)|\.)/i, /\.(pem|key|p12|pfx)(?=\n?$)/i, /id_rsa|id_ed25519/i];
const DESTRUCTIVE = [/git\s+push\s+.*(-f|--force)/i, /git\s+reset\s+--hard/i];

const SCAN_LIMIT = 5e7;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// Groups: redirection, command separator, word ($(...) stays in its word).
// The second pass ignores quotes, for an rm inside bash -c "...".
const SHELL_TOKENS = [
  /(\d*(?:&>>?|>>?&?|<+))|(\\;|[\n;&|()`])|((?:"(?:\\.|[^"\\])*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|\$\(|[^\s;&|<>()`"']|["'])+)/g,
  /(\d*(?:&>>?|>>?&?|<+))|(\\;|[\n;&|()`])|((?:\$\((?:[^()]|\([^()]*\))*\)|\$\(|[^\s;&|<>()`])+)/g,
];

/** Absolute, home, substituted, current or parent directory, "*", a dot-file glob, or anything in .git. */
function isProtectedTarget(arg) {
  if (/^(?:[/\\~]|[a-z]:(?:[\\/]|$)|\$\{?(?:env:)?(?:home|userprofile)(?!\w)|%userprofile%)|\$\(|`/i.test(arg)) return true;
  const relative = arg.replace(/\\/g, '/').replace(/^(\.\/+)+/, '').replace(/\/+$/, '');
  return ['', '.'].includes(relative) || /^\*+$/.test(relative)
    || /^\.[^/]*[*?[{]/.test(relative) || /(^|\/)(\.\.|\.git)($|\/)/i.test(relative);
}

/** True when any recursive "rm" in the command has a protected target. */
function removesProtected(command) {
  const text = command.replace(/\\\r?\n/g, ' ');
  const removals = [...text.matchAll(/(?<![\w.-])rm(?:\.exe)?["']?(?=[\s<>])/gi)];
  // Each rm rescans the rest of the command, so one too costly to check before the hook times out is blocked.
  if (removals.length * text.length > SCAN_LIMIT) return true;
  return removals.some((rm) => {
    let rest = text.slice(rm.index + rm[0].length);
    // Unless the rm is itself inside backticks, a later backtick pair is a substituted argument.
    if (text.slice(0, rm.index).split('`').length % 2) rest = rest.replace(/`[^`]*`/g, '$()');
    return SHELL_TOKENS.some((tokens) => {
      let redirected = false;
      let options = true;
      let recursive = false;
      let dangerous = false;
      for (const [, redirect, separator, word] of rest.matchAll(tokens)) {
        if (separator || word?.startsWith('#')) break;
        if (word && !redirected) {
          const arg = word.replace(/["']/g, '');
          if (options && arg === '--') options = false;
          else if (options && /^-./.test(arg)) {
            recursive ||= /^-[a-z]*r/i.test(arg) || '--recursive'.startsWith(arg.toLowerCase());
          } else if (arg && isProtectedTarget(arg)) dangerous = true; // An empty argument ("") names nothing.
        }
        redirected = Boolean(redirect);
      }
      return recursive && dangerous;
    });
  });
}

function cooldownBlock(configDir, models, providers, config) {
  try {
    const data = readCooldowns(path.join(configDir, COOLDOWN_FILE));
    for (const model of models.length ? models : [undefined]) {
      const lock = isLocked(data, { providers, model, config });
      if (lock) {
        return `Blocked by cooldown hook: '${lock.key}' is on active cooldown until ${lock.until} `
          + `(scope: ${lock.scope}; window: ${lock.window}; reason: ${lock.reason}).`;
      }
    }
  } catch (error) {
    warn(`ignoring ${COOLDOWN_FILE} (${error.name})`);
  }
  return null;
}

/** "provider:model" restricts that hosting only; a bare model restricts every hosting. */
function planRestricted(refs, provider, keys, config) {
  return refs.some((ref) => {
    const [, host, name] = ref.match(/^([^:]+):(.+)$/) ?? [];
    const hosting = canonicalProvider(host);
    if (hosting && hosting !== provider) return false;
    return [...modelKeys(hosting ? name : ref, config)].some((key) => keys.includes(key));
  });
}

/** Why one requested model is refused, or null. The order of the checks decides which reason is reported. */
function modelBlock(model, { providers, config, availability, allowed, known }) {
  const target = resolveTarget({ providers, model }, config);
  if (target.conflict) return `Blocked by allowlist hook: ${target.conflict}.`;
  const keys = [...modelKeys(model, config)];
  if ([model, ...keys].some((name) => matchRetired(name, config.retiredModels))) {
    return `Blocked by allowlist hook: model '${model}' is banned (retired).`;
  }
  if ([model, normalizeModel(model)].some((name) => isBanned(name, config.bannedModels))) {
    return `Blocked by allowlist hook: model '${model}' is banned.`;
  }
  if (planRestricted(config.planRestrictedModels, target.provider, keys, config)) {
    return `Blocked by plan hook: model '${model}' is plan-restricted on the configured subscription.`;
  }
  const restriction = keys.map((key) => restrictedBy(availability, target.provider, key)).find(Boolean);
  if (restriction) {
    const until = Date.parse(restriction.until);
    return `Blocked by availability hook: model '${model}' is ${restriction.status} on ${target.provider}`
      + `${Number.isNaN(until) ? '' : ` until ${new Date(until).toISOString()}`}.`;
  }
  if (!keys.some((key) => known.has(key))) {
    return `Blocked by allowlist hook: model '${model}' is outside the ${allowed.length}-model allowlist.`;
  }
  return null;
}

function blockReason(payload) {
  const problem = payloadProblem(payload);
  if (problem) return `Blocked by safety hook: ${problem}.`;
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
    if (DESTRUCTIVE.some((pattern) => pattern.test(command)) || removesProtected(command)) {
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
    const configDir = configDirOf(import.meta.url);
    const config = loadConfig(configDir);
    if (!config.allowFastModes && fastModeRequested(input)) {
      return 'Blocked by fast-mode hook: fast/priority service modes are disabled (config "allowFastModes").';
    }
    if (!models.length && !providers.length) return null;
    if (models.length) {
      const allowed = effectiveAllowlist(config).flatMap(([, names]) => names);
      const known = new Set(allowed.flatMap((name) => [...modelKeys(name)]));
      const { data: availability } = readAvailability(path.join(configDir, AVAILABILITY_FILE));
      for (const model of models) {
        const reason = modelBlock(model, { providers, config, availability, allowed, known });
        if (reason) return reason;
      }
    }
    return cooldownBlock(configDir, models, providers, config);
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
