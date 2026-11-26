import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, read } from './helpers.mjs';

// A concrete name after the profile root; placeholders such as <name>, $HOME or %USER% do not match.
const PROFILE_PATH = /(?:[A-Za-z]:[\\/]+Users|(?<![A-Za-z0-9_.-])\/(?:home|Users))[\\/]+[\p{L}\p{N}_][\p{L}\p{N}_.-]*/giu;
const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;

const offences = (text) => [
  ...(text.match(PROFILE_PATH) ?? []),
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
  ];
  for (const sample of samples) assert.equal(offences(`at ${sample} here`).length, 1, sample);
  assert.deepEqual(offences([`1+${name}`, 'users.noreply.example.com'].join('@')), []);
});

test('no repo file contains a user-profile path or a non-noreply email', () => {
  const found = files(ROOT).flatMap((file) => offences(read(file)).map((hit) => `${path.relative(ROOT, file)}: ${hit}`));
  assert.deepEqual(found, []);
});
