// PreToolUse guardrails. Exit 2 blocks the tool call; every blocked path writes its reason to stderr.
import path from 'node:path';
import { isLocked, readCooldowns } from './_quota.mjs';
import {
  AVAILABILITY_FILE, COOLDOWN_FILE, MAX_PAYLOAD_BYTES, canonicalProvider, configDirOf, effectiveAllowlist,
  fastModeRequested, isBanned, isObject, isPlanRestricted, isSupportedSchema, loadConfig, matchRetired, modelKeys,
  normalizeModel, payloadProblem, prop, readAvailability, readPayload, resolveTarget, restrictedBy, str, warn,
} from './_shared.mjs';

// (?=\n?$) mirrors .NET's "$", which also matches before a trailing newline.
const SECRET_PATHS = [/(^|[\\/]|^[a-z]:)\.env((?=\n?$)|\.)/i, /\.(pem|key|p12|pfx)(?=\n?$)/i, /id_rsa|id_ed25519/i];

const SCAN_LIMIT = 5e7;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Removes an NTFS alternate data stream suffix (":stream" / "::$DATA") from the basename without breaking drive letters. */
function stripNtfsStream(file) {
  const match = file.match(/^(.*[/\\]|[a-z]:)([\s\S]*)$/i);
  const prefix = match ? match[1] : '';
  const base = match ? match[2] : file;
  return prefix + base.replace(/:[^\r\n]*/, '');
}

// Groups: redirection, command separator, word ($(...) stays in its word).
// The second pass ignores quotes, for a command inside bash -c "...".
const SHELL_TOKENS = [
  /(\d*(?:&>>?|>>?&?|<+))|(\\;|[\n;&|()`])|((?:"(?:\\.|[^"\\])*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|\$\(|[^\s;&|<>()`"']|["'])+)/g,
  /(\d*(?:&>>?|>>?&?|<+))|(\\;|[\n;&|()`])|((?:\$\((?:[^()]|\([^()]*\))*\)|\$\(|[^\s;&|<>()`])+)/g,
];

/** True when `arg` contains a closed brace-expansion list like `{a,b}`. */
function hasBraceList(arg) {
  const stack = [];
  for (const ch of arg) {
    if (ch === '{') stack.push(false);
    else if (ch === ',' && stack.length) stack[stack.length - 1] = true;
    else if (ch === '}' && stack.length && stack.pop()) return true;
  }
  return false;
}

const WHOLE_VAR = /^(?:\$(?:(?:env:)?[a-z_]\w*|\d+|[@*]|\{[^}]+\})|%[a-z_]\w*%)$/i;

/** Absolute, home, substituted, brace list, bare variable, current/parent dir, "*", dot-file glob, or .git. */
function isProtectedTarget(arg) {
  if (/^(?:[/\\~]|[a-z]:(?:[\\/]|$)|\$\{?(?:env:)?(?:home|userprofile)(?!\w)|%userprofile%)|\$\(|`/i.test(arg)) return true;
  if (hasBraceList(arg)) return true;
  const relative = arg.replace(/\\/g, '/').replace(/^(\.\/+)+/, '').replace(/\/+$/, '');
  return ['', '.'].includes(relative) || WHOLE_VAR.test(relative) || /^\*+$/.test(relative)
    || /^\.[^/]*[*?[{]/.test(relative) || /(^|\/)(\.\.|\.git)($|\/)/i.test(relative);
}

const GIT_GLOBAL_VALUE_OPTS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);
const GIT_PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/** True when any git invocation in the command runs force push (flags or +refspec) or reset --hard, even after global options. */
function isDestructiveGit(command) {
  const text = command.replace(/\\\r?\n/g, ' ');
  const calls = [...text.matchAll(/(?<![\w.-])git(?:\.exe)?["']?(?=[\s<>])/gi)];
  if (calls.length * text.length > SCAN_LIMIT) return true;
  return calls.some((hit) => {
    const rest = text.slice(hit.index + hit[0].length);
    return SHELL_TOKENS.some((tokens) => {
      let redirected = false;
      let skipNext = false;
      let sub = null;
      let options = true;
      for (const [, redirect, separator, word] of rest.matchAll(tokens)) {
        if (separator || word?.startsWith('#')) break;
        if (word && !redirected) {
          const arg = word.replace(/["']/g, '');
          if (skipNext) {
            skipNext = false;
          } else if (sub === null) {
            if (arg === '--') break;
            if (arg.startsWith('-')) {
              if (GIT_GLOBAL_VALUE_OPTS.has(arg.toLowerCase())) skipNext = true;
            } else {
              sub = arg.toLowerCase();
              if (sub !== 'push' && sub !== 'reset') break;
            }
          } else if (sub === 'reset') {
            if (options && arg === '--') options = false;
            else if (options && arg.toLowerCase() === '--hard') return true;
          } else if (sub === 'push') {
            if (options && arg === '--') options = false;
            else if (options && arg.startsWith('-')) {
              const lower = arg.toLowerCase();
              if (lower.startsWith('--force') || (!lower.startsWith('-o') && /^-[a-z0-9]*f/i.test(arg))) return true;
              if (GIT_PUSH_VALUE_OPTS.has(lower)) skipNext = true;
            } else if (/^\+\S/.test(arg)) {
              return true;
            }
          }
        }
        redirected = Boolean(redirect);
      }
      return false;
    });
  });
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

/** Why one requested model is refused, or null. The order of the checks decides which reason is reported. */
function modelBlock(model, { providers, config, availability, allowed, known, knownByProvider, allCanonical }) {
  const target = resolveTarget({ providers, model }, config);
  if (target.conflict) return `Blocked by allowlist hook: ${target.conflict}.`;
  const keys = [...modelKeys(model, config)];
  if ([model, ...keys].some((name) => matchRetired(name, config.retiredModels))) {
    return `Blocked by allowlist hook: model '${model}' is banned (retired).`;
  }
  if ([model, normalizeModel(model)].some((name) => isBanned(name, config.bannedModels, config))) {
    return `Blocked by allowlist hook: model '${model}' is banned.`;
  }
  if (isPlanRestricted(config.planRestrictedModels, target.provider, model, config)) {
    return `Blocked by plan hook: model '${model}' is plan-restricted on the configured subscription.`;
  }
  const restriction = restrictedBy(availability, target.provider, model, Date.now(), config);
  if (restriction) {
    const until = Date.parse(restriction.until);
    return `Blocked by availability hook: model '${model}' is ${restriction.status} on ${target.provider}`
      + `${Number.isNaN(until) ? '' : ` until ${new Date(until).toISOString()}`}.`;
  }
  const perProvider = isSupportedSchema(config) || target.crossHosted
    || providers.some((p) => canonicalProvider(p) !== null) || allCanonical;
  const pool = perProvider && target.provider ? (knownByProvider.get(target.provider) ?? new Set()) : known;
  if (!keys.some((key) => pool.has(key))) {
    return `Blocked by allowlist hook: model '${model}' is outside the ${allowed.length}-model allowlist.`;
  }
  return null;
}

function optionModels(ref) {
  const options = prop(ref, 'options');
  if (Array.isArray(options)) {
    return options
      .filter((entry) => typeof prop(entry, 'id') === 'string' && same(prop(entry, 'id'), 'model'))
      .map((entry) => str(prop(entry, 'value')))
      .filter(Boolean);
  }
  if (isObject(options)) {
    const value = str(prop(options, 'model'));
    return value ? [value] : [];
  }
  return [];
}

function blockReason(payload) {
  const problem = payloadProblem(payload);
  if (problem) return `Blocked by safety hook: ${problem}.`;
  const tool = str(prop(payload, 'tool_name'));
  // Fast path: no other tool is guarded, so none of them reads a file.
  if (!/^(edit|write|multiedit|bash)$|delegate_task/i.test(tool)) return null;
  const input = prop(payload, 'tool_input');

  if (['edit', 'write', 'multiedit'].includes(tool.toLowerCase())) {
    const file = str(prop(input, 'file_path'));
    const stripped = stripNtfsStream(file);
    const candidates = stripped === file ? [file] : [file, stripped];
    if (candidates.some((candidate) => SECRET_PATHS.some((pattern) => pattern.test(candidate)))) {
      return `Blocked by safety hook: modifying secret/credential file '${file}' is prohibited.`;
    }
  }

  if (same(tool, 'bash')) {
    const command = str(prop(input, 'command'));
    if (isDestructiveGit(command) || removesProtected(command)) {
      return `Blocked by safety hook: destructive command '${command}' is prohibited.`;
    }
  }

  if (/delegate_task/i.test(tool)) {
    const targetInput = prop(input, 'target');
    if (targetInput !== undefined && !isObject(targetInput)) {
      return `Blocked by safety hook: target of '${tool}' is not an object.`;
    }
    // Legacy top-level fields and T3's nested `target` are both checked, so neither can mask the other.
    // A call without a model is allowed (as the PowerShell script does); only provider cooldowns apply to it.
    const refs = [input, targetInput];
    const field = (name) => refs.map((ref) => str(prop(ref, name))).filter(Boolean);
    const models = [...new Set([...field('model'), ...refs.flatMap(optionModels)])];
    const providers = ['provider', 'providerInstanceId', 'driverKind'].flatMap(field);
    const configDir = configDirOf(import.meta.url);
    const config = loadConfig(configDir);
    if (!config.allowFastModes && fastModeRequested(input)) {
      return 'Blocked by fast-mode hook: fast/priority service modes are disabled (config "allowFastModes").';
    }
    if (!models.length && !providers.length) return null;
    if (models.length) {
      const groups = effectiveAllowlist(config);
      const allowed = groups.flatMap(([, names]) => names);
      const known = new Set(allowed.flatMap((name) => [...modelKeys(name)]));
      const knownByProvider = new Map();
      for (const [group, names] of groups) {
        const provider = canonicalProvider(group);
        if (!provider) continue;
        const set = knownByProvider.get(provider) ?? new Set();
        for (const name of names) for (const key of modelKeys(name)) set.add(key);
        knownByProvider.set(provider, set);
      }
      const allCanonical = groups.length > 0 && groups.every(([group]) => canonicalProvider(group) !== null);
      const { data: availability } = readAvailability(path.join(configDir, AVAILABILITY_FILE));
      for (const model of models) {
        const reason = modelBlock(model, { providers, config, availability, allowed, known, knownByProvider, allCanonical });
        if (reason) return reason;
      }
    }
    return cooldownBlock(configDir, models, providers, config);
  }
  return null;
}

try {
  let payload;
  try {
    payload = await readPayload({ throwOnLimit: true });
  } catch (error) {
    if (error?.code === 'EPAYLOAD_TOO_LARGE') {
      process.exitCode = 2;
      process.stderr.write(`Blocked by safety hook: hook input exceeded ${MAX_PAYLOAD_BYTES} bytes.\n`);
      payload = undefined;
    } else {
      throw error;
    }
  }
  if (payload !== undefined) {
    const reason = blockReason(payload);
    if (reason) {
      // exitCode (not process.exit) lets stderr flush before the process ends.
      process.exitCode = 2;
      process.stderr.write(`${reason}\n`);
    }
  }
} catch (error) {
  warn(`pre-tool-use failed (${error.message})`);
}
