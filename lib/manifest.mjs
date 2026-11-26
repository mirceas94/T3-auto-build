import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isObject, readJson } from '../hooks/_shared.mjs';
import { CliError } from './paths.mjs';

export const MANIFEST_FILE = 't3-auto-build.manifest.json';
export const MODULES = ['full', 'auto-build', 'core'];

export const hashOf = (content) => createHash('sha256').update(content).digest('hex');
export const fileHash = (file) => hashOf(fs.readFileSync(file));

/** The manifest is untrusted input: validate its shape here and every path with safePath(). */
export function readManifest(target) {
  const file = path.join(target, MANIFEST_FILE);
  if (!fs.existsSync(file)) return null;
  let data;
  try {
    data = readJson(file);
  } catch {
    data = null;
  }
  const valid =
    isObject(data) &&
    MODULES.includes(data.modules) &&
    isObject(data.files) &&
    Object.values(data.files).every((hash) => typeof hash === 'string') &&
    (data.env === undefined || (isObject(data.env) && typeof data.env.installed === 'string'));
  if (!valid) throw new CliError(`${file} is not a valid manifest; fix or remove it`);
  return data;
}

export function writeManifest(target, manifest) {
  const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : 1)));
  const text = `${JSON.stringify({ ...manifest, files }, null, 2)}\n`;
  const file = path.join(target, MANIFEST_FILE);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
}
