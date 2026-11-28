// Blind edge-case tests written from the contracts, not from the implementation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { MAX_PAYLOAD_BYTES, isBanned, withFileLock } from '../hooks/_shared.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { backUp } from '../lib/settings.mjs';
import { ROOT, json, read, sandbox, tree, write } from './helpers.mjs';

const CLI = path.join(ROOT, 'bin', 'cli.mjs');
const v3 = () => toConfig(resolveTiers({ claude: 'max', codex: 'pro-200', antigravity: 'pro' }), { preset: 'custom' });

function box(t) {
  const b = sandbox(t);
  b.env.APPDATA = path.join(b.home, 'AppData', 'Roaming');
  b.env.LOCALAPPDATA = path.join(b.home, 'AppData', 'Local');
  return b;
}

function installed(t, change = () => {}) {
  const b = box(t);
  const init = b.cli('init', '--yes');
  assert.equal(init.status, 0, init.stderr);
  const config = v3();
  change(config);
  write(b.path('auto-build.config.json'), config);
  return b;
}

const hook = (b, payload) => b.hook('pre-tool-use', payload, { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const delegate = (input) => ({ tool_name: 'mcp__t3-code__delegate_task', tool_input: input });

function expect(b, payload, status, label = JSON.stringify(payload)) {
  const result = hook(b, payload);
  assert.equal(result.status, status, `${label} -> exit ${result.status} ${result.stderr}`);
}

describe('pre-tool-use secret files', () => {
  const blocked = [
    '.env::$DATA', '.env::$data', '.env:stream', '.env.local::$DATA', 'C:\\proj\\.env::$DATA', 'C:/proj/.env:ads',
    'certs\\server.pem::$DATA', 'C:\\k\\server.pem:stream', 'server.PEM:x:$DATA', '.env:x:$DATA',
  ];
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    test(`blocks NTFS suffixes (${tool})`, (t) => {
      const b = installed(t);
      for (const file of blocked) expect(b, { tool_name: tool, tool_input: { file_path: file } }, 2);
    });
  }

  test('allows normal drive-letter paths', (t) => {
    const b = installed(t);
    for (const file of ['C:\\proj\\src\\app.js', 'D:/work/README.md', 'c:\\a\\env.js', 'C:relative.txt', 'E:\\.envdir\\notes.txt']) {
      expect(b, { tool_name: 'Write', tool_input: { file_path: file } }, 0);
    }
  });
});

describe('pre-tool-use commands', () => {
  const cases = {
    'blocks rm': [2, [
      'rm -rf {~,x}', 'rm -rf {x,~}', 'rm -rf {..,x}', 'rm -rf {x,..}', 'rm -rf $FOO', 'rm -rf "$FOO"',
      'rm -rf "${FOO}"', 'rm -rf ${FOO}', 'rm -fr -- $FOO', 'rm -rf build $FOO', 'cd x && rm -r -f "${FOO}"',
    ]],
    'allows rm': [0, ['rm -rf build', 'rm -rf $TMPDIR/x', 'rm -rf "$TMPDIR/x"', 'rm -rf ${TMPDIR}/x']],
    'blocks git': [2, [
      'git -C . push -f', 'git -c a=b reset --hard', 'git push origin +main', 'git -C . -c a=b push --force',
      'git -c a=b -C . reset --hard HEAD~1', 'git push origin +refs/heads/main', 'git push origin main +dev',
      'cd x && git -C "a b" push -f',
    ]],
    'allows git': [0, [
      'git -C . status', 'git push origin main', 'git -c a=b status', 'git -C . reset --soft HEAD~1',
      'git push origin main && echo +x',
    ]],
  };
  for (const [name, [status, commands]] of Object.entries(cases)) {
    for (const command of commands) {
      test(`${name}: ${command}`, (t) => expect(installed(t), bash(command), status));
    }
  }
});

describe('pre-tool-use delegate_task', () => {
  for (const target of ['x', '', 42, 0, true, false, [], ['x']]) {
    test(`blocks non-object target ${JSON.stringify(target)}`, (t) => expect(installed(t), delegate({ task: 'x', target }), 2));
  }

  test('allows no target', (t) => expect(installed(t), delegate({ task: 'x' }), 0));

  test('validates target.options.model like target.model', (t) => {
    const b = installed(t, (c) => { c.bannedModels = [...(c.bannedModels ?? []), 'claude-haiku-5-5']; });
    const cases = [['claude-sonnet-5-5', 0], ['gemini-4-argon', 2], ['claude-haiku-5-5', 2], ['not-on-allowlist-1', 2]];
    for (const [model, status] of cases) {
      expect(b, delegate({ task: 'x', target: { model } }), status);
      expect(b, delegate({ task: 'x', target: { options: { model } } }), status);
      expect(b, delegate({ task: 'x', target: { model: 'claude-sonnet-5-5', options: { model } } }), status);
    }
    expect(b, delegate({ task: 'x', target: { provider: 'codex', options: { model: 'claude-opus-5-5' } } }), 2);
  });

  test('validates { id, value } model option pairs', (t) => {
    const b = installed(t);
    expect(b, delegate({ task: 'x', target: { options: [{ id: 'model', value: 'claude-sonnet-5-5' }] } }), 0);
    expect(b, delegate({ task: 'x', target: { options: [{ id: 'model', value: 'gemini-4-argon' }] } }), 2);
  });
});

describe('payload limit', () => {
  const sized = (content) => ({ tool_name: 'Write', tool_input: { file_path: 'a.txt', content } });

  test('blocks over 8 MiB', (t) => expect(installed(t), sized('a'.repeat(MAX_PAYLOAD_BYTES + 1)), 2, 'ascii 8MiB+1'));
  test('counts bytes, not characters', (t) => expect(installed(t), sized('\u20ac'.repeat(3 * 1024 * 1024)), 2, '9 MiB of euro signs'));
  test('allows 1 MiB', (t) => expect(installed(t), sized('a'.repeat(1024 * 1024)), 0, '1 MiB'));
  test('limit constant is 8 MiB', () => assert.equal(MAX_PAYLOAD_BYTES, 8 * 1024 * 1024));
});

describe('withFileLock hostile lock paths', () => {
  const link = (t, target, at, type) => {
    try {
      fs.symlinkSync(target, at, type);
      return true;
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.skip('symlinks need privilege here');
      return false;
    }
  };
  function refuses(file, opts) {
    let ran = false;
    const start = Date.now();
    assert.throws(() => withFileLock(file, () => { ran = true; }, { timeoutMs: 5000, ...opts }), { code: 'ELOCKED' });
    assert.ok(Date.now() - start < 1500, `took ${Date.now() - start} ms`);
    assert.equal(ran, false);
  }

  for (const suffix of ['.lock', '.lock.guard']) {
    for (const staleMs of [10_000, 1]) {
      test(`directory at <file>${suffix}, staleMs ${staleMs}`, (t) => {
        const b = box(t);
        const file = path.join(b.dir, 'data.json');
        write(path.join(`${file}${suffix}`, 'keep'), 'KEEP');
        const old = new Date(Date.now() - 3_600_000);
        fs.utimesSync(`${file}${suffix}`, old, old);
        refuses(file, { staleMs });
        assert.equal(read(path.join(`${file}${suffix}`, 'keep')), 'KEEP');
      });

      for (const [kind, type, dangling] of [
        ['junction', 'junction', false], ['dangling junction', 'junction', true],
        ['file symlink', 'file', false], ['dangling file symlink', 'file', true],
      ]) {
        test(`${kind} at <file>${suffix}, staleMs ${staleMs}`, (t) => {
          const b = box(t);
          const file = path.join(b.dir, 'data.json');
          const target = path.join(b.dir, 'elsewhere');
          if (!dangling && type === 'junction') write(path.join(target, 'keep'), 'KEEP');
          if (!dangling && type === 'file') write(target, 'KEEP');
          if (!link(t, target, `${file}${suffix}`, type)) return;
          refuses(file, { staleMs });
          if (dangling) assert.equal(fs.existsSync(target), false, 'created at link target');
          else if (type === 'file') assert.equal(read(target), 'KEEP');
          else assert.deepEqual(tree(target), { keep: 'KEEP' });
        });
      }
    }
  }

  test('releases the lock when the action throws', (t) => {
    const b = box(t);
    const file = path.join(b.dir, 'data.json');
    assert.throws(() => withFileLock(file, () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(fs.readdirSync(b.dir).filter((n) => n.includes('.lock')), []);
  });
});

const exec = (args, env, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stderr }));
});

describe('withFileLock concurrency', () => {
  for (const staleLeftover of [false, true]) {
    test(`processes never overlap${staleLeftover ? ' while reclaiming a stale lock' : ''}`, async (t) => {
      const b = box(t);
      const file = path.join(b.dir, 'counter');
      const worker = path.join(b.dir, 'worker.mjs');
      write(file, '0');
      if (staleLeftover) {
        write(`${file}.lock`, '999999');
        const old = new Date(Date.now() - 3_600_000);
        fs.utimesSync(`${file}.lock`, old, old);
      }
      write(worker, `
        import fs from 'node:fs';
        import { withFileLock } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'hooks', '_shared.mjs')).href)};
        const file = ${JSON.stringify(file)};
        for (let i = 0; i < 20; i += 1) withFileLock(file, () => {
          fs.closeSync(fs.openSync(file + '.marker', 'wx'));
          const n = Number(fs.readFileSync(file, 'utf8'));
          const end = Date.now() + 2; while (Date.now() < end);
          fs.writeFileSync(file, String(n + 1));
          fs.rmSync(file + '.marker');
        }, { timeoutMs: 40000, pollMs: 2 });
      `);
      const results = await Promise.all(Array.from({ length: 6 }, () => exec([worker], b.env, b.dir)));
      for (const r of results) assert.equal(r.status, 0, r.stderr);
      assert.equal(read(file), '120');
      assert.deepEqual(fs.readdirSync(b.dir).filter((n) => /\.lock|\.tmp|marker/.test(n)), []);
    });
  }
});

describe('aliases and bans', () => {
  const aliases = { Speedy: 'Quick', Quick: 'claude-haiku-5-5', Calm: 'Mid', Mid: 'claude-sonnet-5-5' };
  const allow = (c) => { c.allowlist.Claude.push('Speedy', 'Quick', 'Calm', 'Mid'); };
  const model = (name) => delegate({ task: 'x', target: { model: name } });
  const banHaiku = (c) => { c.bannedModels = [...(c.bannedModels ?? []), 'claude-haiku-5-5']; };

  function aliased(t, change = () => {}) {
    const b = installed(t, (c) => { allow(c); change(c); });
    write(b.path('catalog.overrides.json'), { aliases });
    return b;
  }

  test('catalog alias resolving transitively to a banned model is blocked', (t) => {
    const b = aliased(t, banHaiku);
    expect(b, model('Calm'), 0);
    for (const name of ['claude-haiku-5-5', 'Quick', 'Speedy']) expect(b, model(name), 2);
  });

  test('catalog alias resolving transitively to a locked model is blocked', (t) => {
    const b = aliased(t);
    for (const name of ['Speedy', 'Quick', 'Calm']) expect(b, model(name), 0);
    const set = b.cli('quota', 'set', 'claude-haiku-5-5');
    assert.equal(set.status, 0, set.stderr);
    expect(b, model('Calm'), 0);
    for (const name of ['claude-haiku-5-5', 'Quick', 'Speedy']) expect(b, model(name), 2);
  });

  test('config modelIds chain to a banned model is blocked', (t) => {
    const b = installed(t, (c) => { allow(c); c.modelIds = aliases; banHaiku(c); });
    expect(b, model('Calm'), 0);
    for (const name of ['Quick', 'Speedy']) expect(b, model(name), 2);
  });

  test('alias cycle terminates, and a cycle through a banned name is blocked', (t) => {
    const b = installed(t, (c) => {
      c.allowlist.Claude.push('A', 'B', 'C');
      c.modelIds = { A: 'B', B: 'C', C: 'A' };
    });
    const open = hook(b, model('A'));
    assert.equal(open.error, undefined);
    assert.ok([0, 2].includes(open.status), open.stderr);
    const config = json(b.path('auto-build.config.json'));
    write(b.path('auto-build.config.json'), { ...config, bannedModels: ['C'] });
    expect(b, model('A'), 2);
  });

  test('isBanned: a dated ban does not ban a different version', () => {
    const ban = ['claude-sonnet-4-20250514'];
    assert.ok(isBanned('claude-sonnet-4-20250514', ban, {}));
    for (const id of ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']) assert.ok(!isBanned(id, ban, {}), id);
  });

  test('hook: a dated ban does not ban claude-sonnet-4-5', (t) => {
    const b = installed(t, (c) => {
      c.allowlist.Claude.push('claude-sonnet-4-5', 'claude-sonnet-4-20250514');
      c.bannedModels = ['claude-sonnet-4-20250514'];
    });
    expect(b, model('claude-sonnet-4-20250514'), 2);
    expect(b, model('claude-sonnet-4-5'), 0);
  });
});

describe('quota CLI', () => {
  for (const filled of [false, true]) {
    test(`quota clear --all succeeds when the cooldown lock path is a ${filled ? 'non-empty ' : ''}directory`, async (t) => {
      const b = installed(t);
      const set = b.cli('quota', 'set', 'codex');
      assert.equal(set.status, 0, set.stderr);
      const file = b.path('auto-build-cooldowns.json');
      fs.mkdirSync(`${file}.lock`);
      if (filled) write(path.join(`${file}.lock`, 'keep'), 'KEEP');
      const cleared = await exec([CLI, 'quota', 'clear', '--all'], b.env, b.dir);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.ok(!fs.existsSync(file) || !read(file).includes('codex'), 'lock still recorded');
      expect(b, delegate({ task: 'x', target: { provider: 'codex' } }), 0);
    });
  }

  test('concurrent quota set calls lose no lock', async (t) => {
    const b = installed(t);
    const models = [
      'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6-luna',
      'gpt-6.1-terra', 'gpt-6.1-sol', 'gemini-4-neon', 'gemini-4-carbon',
    ];
    const results = await Promise.all(models.map((m) => exec([CLI, 'quota', 'set', m], b.env, b.dir)));
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const stored = read(b.path('auto-build-cooldowns.json'));
    assert.deepEqual(models.filter((m) => !stored.includes(m)), [], stored);
    assert.deepEqual(fs.readdirSync(b.target).filter((n) => /\.lock|\.tmp/.test(n)), []);
  });
});

describe('backups', () => {
  test('backUp never overwrites an existing .bak with different content', (t) => {
    const b = box(t);
    const file = path.join(b.dir, 'f.json');
    write(`${file}.bak`, 'OLD0');
    write(`${file}.bak.1`, 'OLD1');
    for (const content of ['X', 'Y', 'X']) {
      write(file, content);
      backUp(file);
    }
    assert.equal(read(`${file}.bak`), 'OLD0');
    assert.equal(read(`${file}.bak.1`), 'OLD1');
    const kept = Object.values(tree(b.dir));
    for (const content of ['X', 'Y']) assert.ok(kept.includes(content), content);
  });

  test('backUp does not write through a dangling link at .bak', (t) => {
    const b = box(t);
    const file = path.join(b.dir, 'f.json');
    const target = path.join(b.dir, 'elsewhere');
    write(file, 'X');
    fs.symlinkSync(target, `${file}.bak`, 'junction');
    backUp(file);
    assert.equal(fs.existsSync(target), false);
    assert.equal(read(`${file}.bak.1`), 'X');
  });

  test('init --force, upgrade and doctor --fix keep every existing .bak', (t) => {
    const b = box(t);
    assert.equal(b.cli('init', '--yes').status, 0);
    const managed = [
      'settings.json', 'auto-build.config.json', 'skills/auto-build/SKILL.md', 'hooks/t3-auto-build/pre-tool-use.mjs', 'CLAUDE.md',
    ];
    const history = {};
    for (const name of managed) {
      history[`${name}.bak`] = `SENTINEL ${name}`;
      write(b.path(`${name}.bak`), history[`${name}.bak`]);
    }
    const runs = [['init', '--yes', '--force'], ['upgrade', '--yes'], ['doctor', '--fix', '--yes'], ['init', '--yes', '--force']];
    for (const [i, args] of runs.entries()) {
      for (const name of managed) {
        const file = b.path(name);
        if (name === 'settings.json') write(file, { custom: i });
        else if (name.endsWith('.json')) write(file, { ...json(file), defaultEffort: ['low', 'high'][i % 2] });
        else fs.appendFileSync(file, `\n// edit ${i}\n`);
      }
      const result = b.cli(...args);
      assert.equal(result.error, undefined);
      for (const [name, content] of Object.entries(tree(b.target))) {
        if (!/\.bak(\.\d+)?$/.test(name)) continue;
        if (name in history) assert.equal(content, history[name], `${args.join(' ')} overwrote ${name}`);
        history[name] = content;
      }
      for (const name of Object.keys(history)) assert.ok(fs.existsSync(b.path(name)), `${args.join(' ')} removed ${name}`);
    }
    assert.ok(Object.keys(history).length > managed.length, 'no run created a backup');
  });
});
