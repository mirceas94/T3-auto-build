import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, read } from './helpers.mjs';

// A concrete name after the profile root; placeholders such as <name>, $HOME or %USER% do not match.
const PROFILE_PATH = /(?:[A-Za-z]:[\\/]+Users|(?<![A-Za-z0-9_.-])\/(?:home|Users))[\\/]+[\p{L}\p{N}_][\p{L}\p{N}_.-]*/giu;
// The same root as Git Bash or WSL spells it, and as a flattened project directory name.
const SHELL_PROFILE_PATH = /(?<![A-Za-z0-9_.-])(?:\/mnt)?\/[A-Za-z]\/Users\/[\p{L}\p{N}_][\p{L}\p{N}_.-]*/giu;
const FLAT_PROFILE_PATH = /(?<![A-Za-z0-9])[A-Za-z]--Users-[\p{L}\p{N}_]+/gu;
const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;

const offences = (text) => [
  ...(text.match(PROFILE_PATH) ?? []),
  ...(text.match(SHELL_PROFILE_PATH) ?? []),
  ...(text.match(FLAT_PROFILE_PATH) ?? []),
  ...(text.match(EMAIL) ?? []).filter((email) => !/noreply/i.test(email)),
];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git') return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

test('the patterns catch personal paths and emails', () => {
  const name = ['some', 'one'].join('');
  const slash = String.fromCharCode(47);
  const samples = [
    ['C:', 'Users', name].join('\\'),
    ['C:', 'Users', name].join('\\\\'),
    ['', 'home', name, 'x'].join(slash),
    ['', 'Users', name].join(slash),
    [name, 'mail.example'].join('@'),
    ['', 'c', 'Users', name].join(slash),
    ['', 'mnt', 'c', 'Users', name].join(slash),
    ['C-', 'Users', name].join('-'),
  ];
  for (const sample of samples) assert.equal(offences(`at ${sample} here`).length, 1, sample);
  assert.deepEqual(offences([`1+${name}`, 'users.noreply.example.com'].join('@')), []);
});

test('no repo file contains a user-profile path or a non-noreply email', () => {
  // File names are published too, so they are scanned with the contents.
  const found = files(ROOT).flatMap((file) => {
    const name = path.relative(ROOT, file);
    return offences(`${name}\n${read(file)}`).map((hit) => `${name}: ${hit}`);
  });
  assert.deepEqual(found, []);
});
