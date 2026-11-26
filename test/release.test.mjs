import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { json, read, ROOT, sandbox } from './helpers.mjs';

const pkg = json(path.join(ROOT, 'package.json'));

test('release CLI flags and usage errors', (t) => {
  const box = sandbox(t);
  for (const flag of ['--version', '-v']) {
    const r = box.cli(flag);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${pkg.version}\n`);
    assert.equal(r.stderr, '');
    assert.equal(fs.existsSync(box.target), false);
  }
  for (const flags of [['--version', '--help'], ['--help', '--version'], ['-v', '-h']]) {
    const r = box.cli(...flags);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--version/);
  }
  assert.notEqual(box.cli('--version=x').status, 0);
  assert.equal(box.cli('--nonsense').status, 2);
});

test('package identity, dependencies, and packed file exclusions', () => {
  assert.equal(pkg.version, '1.0.1');
  for (const value of [pkg.repository.url, pkg.homepage, pkg.bugs.url]) assert.match(value, /github\.com\/mirceas94\/t3-auto-build/);
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) assert.ok(!pkg[k] || (Array.isArray(pkg[k]) ? pkg[k].length === 0 : Object.keys(pkg[k]).length === 0), `${k} must be empty`);
  for (const f of pkg.files) assert.ok(!['.github', 'assets', 'test', 'SECURITY.md', 'CONTRIBUTING.md'].includes(f));
});

test('release metadata and assets meet the published contract', () => {
  const logo = read(path.join(ROOT, 'assets/logo.svg'));
  const banner = read(path.join(ROOT, 'assets/banner.svg'));
  const [, , , logoW, logoH] = logo.match(/viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/).map(Number);
  assert.equal(logoW, logoH, 'logo viewBox is square');
  assert.match(banner, /viewBox="0 0 1280 360"/);
  for (const svg of [logo, banner]) {
    // The mandatory xmlns URI is a namespace name, not a resource load.
    assert.doesNotMatch(svg.replace(/\sxmlns(?::\w+)?="[^"]*"/g, ''), /<script|<image|https?:|@import|@font-face|\son[a-z]+\s*=|href\s*=/i);
    assert.equal((svg.match(/<([\w:-]+)\b[^>]*>/g) || []).length, (svg.match(/<\/[\w:-]+\s*>/g) || []).length + (svg.match(/<([\w:-]+)\b[^>]*\/>/g) || []).length);
  }
});

test('CI, Dependabot, issue template, and README release links are valid', () => {
  const ci = read(path.join(ROOT, '.github/workflows/ci.yml'));
  assert.match(ci, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(ci, /workflow_dispatch:/); assert.match(ci, /pull_request:[\s\S]*?main/); assert.match(ci, /push:[\s\S]*?main/);
  for (const [, sha, version] of ci.matchAll(/uses:\s*[^@\s]+@([\da-f]{40})\s+#\s*(v\d+\.\d+\.\d+)/gi)) { assert.match(sha, /^[\da-f]{40}$/i); assert.match(version, /^v/); }
  assert.ok([...ci.matchAll(/uses:/g)].length > 0);
  assert.match(ci, /persist-credentials:\s*false/); for (const os of ['ubuntu', 'windows', 'macos']) assert.ok(ci.includes(os)); for (const n of ['18', '20', '22']) assert.ok(ci.includes(n));
  const dep = read(path.join(ROOT, '.github/dependabot.yml'));
  assert.match(dep, /package-ecosystem:\s*["']?github-actions/); assert.match(dep, /schedule:[\s\S]*?interval:\s*weekly/); assert.match(dep, /prefix:\s*["']?chore\(ci\)["']?/); assert.match(dep, /open-pull-requests-limit:/);
  assert.match(read(path.join(ROOT, '.github/ISSUE_TEMPLATE/config.yml')), /blank_issues_enabled:\s*false/);
  const readme = read(path.join(ROOT, 'README.md'));
  assert.notEqual(readme.charCodeAt(0), 0xfeff, 'README must not start with a BOM');
  assert.match(readme, /<img[^>]*src="https:\/\/raw\.githubusercontent\.com\/[^"#]*assets\/banner\.svg"[^>]*alt="[^"]+"[^>]*width="100%"/i);
  assert.doesNotMatch(readme, /<img[^>]*assets\/banner\.svg[^>]*height=/i);
});
