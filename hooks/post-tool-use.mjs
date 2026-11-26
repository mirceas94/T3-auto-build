// PostToolUse: best-effort formatter dispatch. Never blocks.
import fs from 'node:fs';
import path from 'node:path';
import { prop, readPayload, run, str, warn, which } from './_shared.mjs';

const WEB = ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.md'];

// First formatter found on PATH wins, per extension.
function formatters(extension) {
  if (WEB.includes(extension)) return [['biome', 'format', '--write'], ['prettier', '--write']];
  if (extension === '.py') return [['ruff', 'format']];
  if (extension === '.go') return [['gofmt', '-w']];
  return [];
}

try {
  const file = str(prop(prop(await readPayload(), 'tool_input'), 'file_path'));
  if (file && fs.existsSync(file)) {
    const base = path.basename(file);
    const dot = base.lastIndexOf('.');
    const extension = dot < 0 ? '' : base.slice(dot).toLowerCase();
    for (const [name, ...args] of formatters(extension)) {
      const executable = which(name);
      if (!executable) continue;
      // A leading "-" must not read as an option.
      const target = file.startsWith('-') ? `.${path.sep}${file}` : file;
      if (run(executable, [...args, target], { stdio: 'ignore' }) === null) warn(`skipped ${name}: path is unsafe for a .cmd shim`);
      break;
    }
  }
} catch (error) {
  warn(`post-tool-use failed (${error.message})`);
}
