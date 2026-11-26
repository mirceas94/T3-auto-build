import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** --target > CLAUDE_CONFIG_DIR > <home>/.claude */
export function resolveTarget(flag, env = process.env) {
  return path.resolve(flag || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

/**
 * Absolute path for a target-relative file, or null when it could leave the target: absolute,
 * "..", drive or stream syntax, or any symlink/junction on the way down.
 */
export function safePath(target, relative) {
  if (typeof relative !== 'string' || relative.includes(':') || relative.includes('\0')) return null;
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return null;
  const parts = relative.split(/[\\/]/);
  // Empty, ".", "..", and Windows look-alikes such as ".. " are all rejected.
  if (parts.some((part) => /^[. ]*$/.test(part))) return null;
  let current = target;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return null;
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      break;
    }
  }
  return path.join(target, ...parts);
}
