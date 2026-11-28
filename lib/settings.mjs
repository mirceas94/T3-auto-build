import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isObject, parseJson } from '../hooks/_shared.mjs';
import { CliError } from './paths.mjs';
import { PARENTS } from './plans.mjs';

export const ENV_NAME = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
export const HOOKS_DIR = 'hooks/t3-auto-build';
const TAG = '--managed-by=t3-auto-build';

export const HOOKS = [
  { event: 'SessionStart', script: 'session-start.mjs' },
  { event: 'PreCompact', script: 'pre-compact.mjs' },
  { event: 'PreToolUse', script: 'pre-tool-use.mjs', matcher: 'Edit|Write|MultiEdit|Bash|delegate_task|mcp__.*__delegate_task' },
  { event: 'PostToolUse', script: 'post-tool-use.mjs', matcher: 'Edit|Write|MultiEdit' },
];

export const isTagged = (hook) => typeof hook?.command === 'string' && /(^|\s)--managed-by=t3-auto-build(\s|$)/.test(hook.command);

export function hookCommand(target, script) {
  let file = path.join(target, ...HOOKS_DIR.split('/'), script);
  if (process.platform === 'win32') file = file.replace(/\\/g, '/');
  // These stay special inside double quotes in sh, cmd or PowerShell.
  if (/["$`%\\\r\n“-„]/.test(file)) {
    throw new CliError(`the target path contains a character that is unsafe in a hook command: ${target}`);
  }
  return `node "${file}" ${TAG}`;
}

/**
 * First of <file>.bak, .bak.1, ... that is free or already holds this content, so no backup is lost.
 * Symlinked names are skipped and a new backup is created exclusively, so nothing is written through a link.
 * A backup that did not exist before is added to "created".
 */
export function backUp(file, created) {
  const content = fs.readFileSync(file);
  const mode = fs.statSync(file).mode & 0o777;
  for (let i = 0; ; i += 1) {
    const backup = `${file}.bak${i ? `.${i}` : ''}`;
    const stat = fs.lstatSync(backup, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isFile() && fs.readFileSync(backup).equals(content)) return backup;
      continue;
    }
    const fd = fs.openSync(backup, 'wx', mode);
    created?.push(backup);
    try {
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return backup;
  }
}

/** { file, raw, data }. Throws, before anything is written, on content we cannot merge safely. */
export function readSettings(target) {
  let file = path.join(target, 'settings.json');
  let raw = null;
  try {
    file = fs.realpathSync(file); // keep a symlinked settings.json a symlink
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new CliError(`cannot read ${file}: ${error.code}`);
  }
  if (raw === null) return { file, raw, data: {} };
  let data;
  try {
    data = parseJson(raw);
  } catch {
    // The parse error is not echoed: it can quote file content, which may hold secrets.
    throw new CliError(`${file} is not valid JSON; nothing was changed`);
  }
  const mergeable =
    isObject(data) &&
    (data.env === undefined || isObject(data.env)) &&
    (data.hooks === undefined || (isObject(data.hooks) && HOOKS.every(({ event }) => data.hooks[event] === undefined || Array.isArray(data.hooks[event]))));
  if (!mergeable) throw new CliError(`${file} has an unexpected structure (settings, env, hooks); nothing was changed`);
  return { file, raw, data };
}

/** Every tagged hook entry as { event, matcher, hook }. */
export function taggedHooks(data) {
  return Object.entries(isObject(data.hooks) ? data.hooks : {}).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).filter(isTagged).map((hook) => ({ event, matcher: group.matcher, hook })),
    ),
  );
}

function removeTagged(data) {
  if (taggedHooks(data).length === 0) return;
  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) continue;
    let removed = false;
    const kept = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isTagged)) return [group];
      removed = true;
      const hooks = group.hooks.filter((hook) => !isTagged(hook));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!removed) continue;
    if (kept.length) data.hooks[event] = kept;
    else delete data.hooks[event];
  }
  if (Object.keys(data.hooks).length === 0) delete data.hooks;
}

const desiredEntries = (target) =>
  HOOKS.map(({ event, matcher, script }) => ({ event, matcher, hook: { type: 'command', command: hookCommand(target, script) } }));

/** Returns { data, env }: new settings plus the manifest record needed to undo the env change. */
const restoreManagedSettings = (data, records = {}) => {
  for (const [key, record] of Object.entries(records)) {
    if (!record || data[key] !== record.installed) continue;
    if (record.had) data[key] = record.prior;
    else delete data[key];
  }
};

function mergeParentSettings(data, parent, previous = {}) {
  const priorRecords = previous.settings ?? {};
  if (!parent) {
    restoreManagedSettings(data, priorRecords);
    return {};
  }
  const desired = { model: PARENTS[parent.model], effortLevel: parent.effort };
  const records = {};
  for (const [key, value] of Object.entries(desired)) {
    if (typeof value !== 'string') continue;
    const prior = priorRecords[key];
    const had = Object.prototype.hasOwnProperty.call(data, key);
    const current = data[key];
    if (!had || (prior && current === prior.installed)) {
      records[key] = prior
        ? { ...prior, installed: value }
        : { had: false, prior: null, installed: value };
      data[key] = value;
    } else if (prior) {
      // Preserve the original record so uninstall still recognizes ownership if the value is restored.
      records[key] = prior;
    }
  }
  return records;
}

/** Returns { data, env }: manifest env stores both the prior env value and managed parent setting values. */
export function mergeSettings(current, target, percent, previous, parent) {
  const data = structuredClone(current);
  const desired = desiredEntries(target);
  const present = taggedHooks(data);
  const correct = present.length === desired.length && desired.every((want) => present.some((have) => isDeepStrictEqual(have, want)));
  if (!correct) {
    removeTagged(data);
    data.hooks ??= {};
    for (const { event, matcher, hook } of desired) {
      data.hooks[event] = [...(data.hooks[event] ?? []), { ...(matcher && { matcher }), hooks: [hook] }];
    }
  }
  const installed = String(percent);
  const had = Object.prototype.hasOwnProperty.call(data.env ?? {}, ENV_NAME);
  // The first recorded prior value wins; a re-run only updates what we installed.
  const env = previous
    ? { ...previous, installed }
    : { had, prior: had ? data.env[ENV_NAME] : null, createdEnv: data.env === undefined, installed };
  data.env = { ...data.env, [ENV_NAME]: installed };
  const parentSettings = mergeParentSettings(data, parent, previous);
  if (Object.keys(parentSettings).length) env.settings = parentSettings;
  else delete env.settings;
  return { data, env };
}

export function unmergeSettings(current, env) {
  const data = structuredClone(current);
  removeTagged(data);
  restoreManagedSettings(data, env?.settings);
  if (env && data.env?.[ENV_NAME] === env.installed) {
    if (env.had) data.env[ENV_NAME] = env.prior;
    else delete data.env[ENV_NAME];
    if (env.createdEnv && Object.keys(data.env).length === 0) delete data.env;
  }
  return data;
}

/** Writes (via temp file + rename, keeping a .bak) only when the content really changes. */
export function writeSettings({ file, raw, data: before }, after) {
  if (isDeepStrictEqual(before, after)) return false;
  const indent = raw?.match(/^[ \t]+(?=")/m)?.[0] ?? 2;
  const mode = raw === null ? 0o600 : fs.statSync(file).mode & 0o777;
  if (raw !== null) backUp(file);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.rmSync(temp, { force: true });
    fs.writeFileSync(temp, `${JSON.stringify(after, null, indent)}\n`, { mode, flag: 'wx' });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return true;
}
