// SessionStart: prune expired cooldowns and report the active ones.
import fs from 'node:fs';
import path from 'node:path';
import { COOLDOWN_FILE, configDirOf, cooldownEntries, readJson, str, warn } from './_shared.mjs';

try {
  const file = path.join(configDirOf(import.meta.url), COOLDOWN_FILE);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const data = text.trim() ? readJson(file) : {};
    const now = Date.now();
    // Iterating fully before writing: one bad entry leaves the file untouched.
    const active = [...cooldownEntries(data)].filter(([, , until]) => until > now);
    if (active.length === 0) {
      fs.rmSync(file, { force: true });
    } else {
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(Object.fromEntries(active), null, 2)}\n`);
      fs.renameSync(temp, file);
      const summary = active.map(([key, value, until]) => `${key} (${Math.ceil((until - now) / 60_000)}m left: ${str(value.reason)})`);
      process.stdout.write(`ACTIVE AUTO-BUILD COOLDOWNS (skip these models/providers): ${summary.join('; ')}\n`);
    }
  }
} catch (error) {
  warn(`ignoring ${COOLDOWN_FILE} (${error.name})`);
}
