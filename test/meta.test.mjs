import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { CATALOG } from '../lib/plans.mjs';
import { json, read, ROOT, sandbox } from './helpers.mjs';

const pkg = json(path.join(ROOT, 'package.json'));

test('--version and -v print the package version; --help wins', (t) => {
  const box = sandbox(t);
  for (const flag of ['--version', '-v']) {
    const result = box.cli(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${pkg.version}\n`);
  }
  assert.match(box.cli('--version', '--help').stdout, /--version/);
});

test('the SVG assets are self-contained and script-free', () => {
  for (const name of ['logo', 'banner']) {
    const svg = read(path.join(ROOT, 'assets', `${name}.svg`)).replace(/\sxmlns(?::\w+)?="[^"]*"/g, '');
    for (const banned of [/https?:/i, /<script/i, /<image/i, /<foreignObject/i, /@import/i, /@font-face/i, /url\(/i, /\son[a-z]+\s*=/i, /href\s*=/i, /<!(DOCTYPE|ENTITY)/i, /data:/i]) {
      assert.doesNotMatch(svg, banned, `${name}.svg`);
    }
  }
  const [, , width, height] = read(path.join(ROOT, 'assets', 'logo.svg')).match(/viewBox="([^"]*)"/)[1].trim().split(/[\s,]+/).map(Number);
  assert.ok(width > 0 && width === height, 'logo viewBox is square');
});

test('package metadata is complete', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  assert.match(pkg.repository.url, /mirceas94\/t3-auto-build/);
  assert.ok(pkg.homepage);
  assert.ok(pkg.bugs?.url);
  assert.ok(pkg.keywords?.length);
  assert.equal(pkg.version, '2.0.1');
  assert.equal(pkg.engines.node, '>=18.18.0');
  assert.match(pkg.description, /subscription.*quota.*availability/i);
  for (const keyword of ['subscription', 'quota', 'availability', 'cross-provider']) assert.ok(pkg.keywords.includes(keyword), keyword);
  assert.equal(pkg.dependencies, undefined);
  assert.doesNotMatch(JSON.stringify(pkg.author ?? ''), /@/);
});

test('the banner describes subscription-aware routing', () => {
  assert.match(read(path.join(ROOT, 'assets', 'banner.svg')), /<text[^>]*>Subscription-aware[^<]*routing/);
});

test('the bug report asks for version, tiers and diagnostics', () => {
  const form = read(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml')).replace(/\r\n/g, '\n');
  const field = (id) => form.split(/\n  - type: /).find((block) => block.includes(`\n    id: ${id}\n`)) ?? assert.fail(id);
  for (const [provider, tiers] of Object.entries(CATALOG)) {
    const options = field(`${provider}-tier`).match(/options: \[([^\]]*)\]/)[1].split(',').map((option) => option.trim());
    assert.deepEqual(options, [...Object.keys(tiers), 'not sure or v1 config'], provider);
  }
  assert.match(field('version'), /t3-auto-build --version/);
  for (const [id, command] of [['doctor', 't3-auto-build doctor'], ['check-models', 't3-auto-build check-models --json']]) {
    assert.ok(field(id).includes(command), command);
    assert.match(field(id), /render: shell/);
  }
});
