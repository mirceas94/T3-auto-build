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
  assert.equal(pkg.version, '2.1.2');
  for (const value of [pkg.repository.url, pkg.homepage, pkg.bugs.url]) assert.match(value, /github\.com\/mirceas94\/t3-auto-build/);
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) assert.ok(!pkg[k] || (Array.isArray(pkg[k]) ? pkg[k].length === 0 : Object.keys(pkg[k]).length === 0), `${k} must be empty`);
  for (const f of pkg.files) {
    assert.doesNotMatch(f, /^(\.\/)?(\.github|\.claude|assets|test|SECURITY\.md|CONTRIBUTING\.md)(\/|$)/);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `files entry "${f}" does not exist`);
  }
  assert.deepEqual([...pkg.files].sort(), ['CHANGELOG.md', 'bin', 'core', 'hooks', 'lib', 'presets', 'skills']);
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

test('the changelog and security policy name the package version', () => {
  const changelog = path.join(ROOT, 'CHANGELOG.md');
  if (fs.existsSync(changelog)) {
    const top = read(changelog).match(/^## .*$/m)?.[0] ?? '';
    assert.ok(top.startsWith(`## [${pkg.version}]`), `top CHANGELOG entry is "${top}"`);
  }
  const security = read(path.join(ROOT, 'SECURITY.md'));
  assert.match(security, new RegExp(`^\\| ${pkg.version.split('.')[0]}\\.x \\| Yes \\|`, 'm'));
  assert.match(security, /^\| 1\.x and older \| No\b/m);
  for (const topic of [/Speed-mode guard/, /provider:claude/, /cross-hosted only/, /unparsable hook input/, /invalid shape/, /RETIRED_MODELS/]) {
    assert.match(security, topic);
  }
  const contributing = read(path.join(ROOT, 'CONTRIBUTING.md'));
  for (const topic of ['lib/plans.mjs', 'MODELS', 'family', 'version', 'POOLS', 'scarceQuota', 'PREFERENCE', 'RETIRED_MODELS', 'test/plans.test.mjs']) {
    assert.ok(contributing.includes(topic), topic);
  }
});

// GitHub's heading anchors: punctuation dropped, spaces to hyphens, repeats numbered.
function anchors(markdown) {
  const seen = new Map();
  return new Set([...markdown.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)].map(([, heading]) => {
    const slug = heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
}

test('links into this repository resolve to files and headings', () => {
  const prose = (file) => read(file).replace(/\r\n/g, '\n').replace(/^[ \t]*(\x60{3}|~{3})[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');
  const github = ['.github', path.join('.github', 'ISSUE_TEMPLATE')].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
    .filter((name) => /\.(md|yml)$/.test(name)).map((name) => path.join(dir, name)));
  const docs = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', ...github]
    .filter((name) => fs.existsSync(path.join(ROOT, name)));
  const own = /^https:\/\/(?:github\.com\/mirceas94\/t3-auto-build\/(?:blob|tree)\/main|raw\.githubusercontent\.com\/mirceas94\/t3-auto-build\/main)\//;
  const broken = [];
  let checked = 0;
  for (const doc of docs) {
    for (const [, markdown, html] of prose(path.join(ROOT, doc)).matchAll(/\]\(<?([^)\s>]+)[^)]*\)|\b(?:href|src)="([^"]+)"/g)) {
      const link = markdown ?? html;
      const local = link.replace(own, '');
      const absolute = local !== link;
      if (!absolute && /^[a-z][a-z\d+.-]*:/i.test(link)) continue;
      const [file, anchor] = local.split('#');
      const target = file ? path.resolve(ROOT, absolute ? '.' : path.dirname(doc), decodeURIComponent(file)) : path.join(ROOT, doc);
      checked += 1;
      if (!fs.existsSync(target) || (anchor && target.endsWith('.md') && !anchors(prose(target)).has(anchor))) {
        broken.push(`${doc}: ${link}`);
      }
    }
  }
  assert.ok(checked > 0);
  assert.deepEqual(broken, []);
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
  for (const topic of [/### Starting model/, /orchestrator\/coordinator/, /pre-tool-use\.mjs/, /Follow-Up Refinement Rule/]) {
    assert.match(readme, topic);
  }
});
