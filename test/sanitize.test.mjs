import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, read, sandbox, write } from './helpers.mjs';

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

// Without git: everything except .git and tool caches, which mark themselves with CACHEDIR.TAG.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (!entry.isDirectory()) return [file];
    return entry.name === '.git' || fs.existsSync(path.join(file, 'CACHEDIR.TAG')) ? [] : walk(file);
  });
}

// What could be published: tracked files and untracked ones that are not ignored.
function files(root) {
  const git = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (git.status !== 0) return walk(root);
  return git.stdout.split('\0').filter(Boolean).map((name) => path.join(root, name))
    // A tracked file may be deleted in the working tree, and a gitlink is a directory.
    .filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}

// File names are published too, so they are scanned with the contents.
const scan = (root, list = files(root)) => list.flatMap((file) => {
  const name = path.relative(root, file).replace(/\\/g, '/');
  return offences(`${name}\n${read(file)}`).map((hit) => `${name}: ${hit}`);
});

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
  assert.deepEqual(scan(ROOT), []);
});

test('the file list skips ignored caches but keeps tracked offences', (t) => {
  const repo = path.join(sandbox(t).dir, 'repo');
  const bad = ['someone', 'mail.example'].join('@');
  write(path.join(repo, 'tracked.txt'), bad);
  write(path.join(repo, '.ruff_cache', '.gitignore'), '*\n');
  write(path.join(repo, '.ruff_cache', 'CACHEDIR.TAG'), 'cache');
  write(path.join(repo, '.ruff_cache', 'entry'), bad);
  for (const args of [['init', '-q'], ['add', 'tracked.txt']]) {
    const git = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  assert.deepEqual(scan(repo), [`tracked.txt: ${bad}`]);
  assert.deepEqual(scan(repo, walk(repo)), [`tracked.txt: ${bad}`]);
});
