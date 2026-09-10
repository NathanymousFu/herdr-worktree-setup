import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'setup.js');

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function makeRepoWorktree(root) {
  const repo = join(root, 'main');
  const wt = join(root, 'wt');
  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'file.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'worktree', 'add', '-b', 'feat', wt);
  return { repo, wt };
}

test('setup.js runs matched steps in the new worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtint-'));
  const repo = join(root, 'main');
  const wt = join(root, 'wt');
  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'file.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'worktree', 'add', '-b', 'feat', wt);

  const configDir = join(root, 'cfg');
  const stateDir = join(root, 'state');
  execFileSync('mkdir', ['-p', configDir, stateDir]);
  writeFileSync(
    join(configDir, 'config.toml'),
    `[[project]]\npath = ${JSON.stringify(realpathSync(repo))}\nsteps = ["printf ok > SETUP_OK"]\n`,
  );

  const res = spawnSync('node', [SETUP], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ worktree: { path: wt } }),
    },
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(join(wt, 'SETUP_OK'), 'utf8'), 'ok');
  rmSync(root, { recursive: true, force: true });
});

test('setup.js is a no-op (exit 0) when no config exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtint-'));
  const res = spawnSync('node', [SETUP], {
    env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: join(root, 'nope') },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js exits non-zero with a clear message on malformed config', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtint-'));
  const configDir = join(root, 'cfg');
  execFileSync('mkdir', ['-p', configDir]);
  writeFileSync(join(configDir, 'config.toml'), 'not = = valid [[[');
  const res = spawnSync('node', [SETUP], {
    env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: configDir },
    encoding: 'utf8',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /invalid config\.toml/);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js writes a log to the state dir and passes HERDR_ env to the step', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtint-'));
  const { repo, wt } = makeRepoWorktree(root);
  const configDir = join(root, 'cfg');
  const stateDir = join(root, 'state');
  execFileSync('mkdir', ['-p', configDir, stateDir]);
  writeFileSync(
    join(configDir, 'config.toml'),
    `[[project]]\npath = ${JSON.stringify(realpathSync(repo))}\nsteps = ['printf "%s|%s|%s" "$HERDR_MAIN_REPO" "$HERDR_WORKTREE" "$HERDR_BRANCH" > ENVOUT']\n`,
  );
  const res = spawnSync('node', [SETUP], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ worktree: { path: wt } }),
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const envOut = readFileSync(join(wt, 'ENVOUT'), 'utf8').split('|');
  assert.ok(envOut[0].length > 0);      // HERDR_MAIN_REPO non-empty
  assert.equal(envOut[1], wt);          // HERDR_WORKTREE is the event path verbatim
  assert.equal(envOut[2], 'feat');      // HERDR_BRANCH
  const logs = readdirSync(stateDir).filter((f) => f.startsWith('setup-') && f.endsWith('.log'));
  assert.equal(logs.length, 1);
  assert.match(readFileSync(join(stateDir, logs[0]), 'utf8'), /\[exit 0\]/);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js exits with the failing step exit code', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtint-'));
  const { repo, wt } = makeRepoWorktree(root);
  const configDir = join(root, 'cfg');
  execFileSync('mkdir', ['-p', configDir]);
  writeFileSync(
    join(configDir, 'config.toml'),
    `[[project]]\npath = ${JSON.stringify(realpathSync(repo))}\nsteps = ["exit 7"]\n`,
  );
  const res = spawnSync('node', [SETUP], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ worktree: { path: wt } }),
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 7, res.stderr);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js exits 1 when the worktree path cannot be resolved', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtint-'));
  const configDir = join(root, 'cfg');
  execFileSync('mkdir', ['-p', configDir]);
  writeFileSync(join(configDir, 'config.toml'), '[[project]]\npath = "/x"\nsteps = ["true"]\n');
  const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: configDir };
  delete env.HERDR_PLUGIN_EVENT_JSON;
  delete env.HERDR_PLUGIN_CONTEXT_JSON;
  delete env.HERDR_WORKSPACE_ID;
  const res = spawnSync('node', [SETUP], { env, encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /could not resolve/);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js exits 1 when the worktree is not a git repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtint-'));
  const notGit = join(root, 'plain');
  const configDir = join(root, 'cfg');
  execFileSync('mkdir', ['-p', notGit, configDir]);
  writeFileSync(join(configDir, 'config.toml'), '[[project]]\npath = "/x"\nsteps = ["true"]\n');
  const res = spawnSync('node', [SETUP], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ worktree: { path: notGit } }),
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /could not derive main repo/);
  rmSync(root, { recursive: true, force: true });
});

function makeStatusFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wtstatus-'));
  const { repo, wt } = makeRepoWorktree(root);
  const configDir = join(root, 'cfg');
  const callLog = join(root, 'calls');
  const reporter = join(root, 'herdr');
  execFileSync('mkdir', ['-p', configDir]);
  writeFileSync(reporter, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STATUS_CALLS"\nexit "${STATUS_EXIT:-0}"\n', { mode: 0o755 });

  const run = (steps, overrides = {}) => {
    writeFileSync(callLog, '');
    writeFileSync(join(configDir, 'config.toml'),
      `[[project]]\npath = ${JSON.stringify(realpathSync(repo))}\nsteps = ${JSON.stringify(steps)}\n`);
    const result = spawnSync('node', [SETUP], {
      env: {
        ...process.env,
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ worktree: { path: wt } }),
        HERDR_WORKSPACE_ID: 'test-workspace',
        HERDR_BIN_PATH: reporter,
        STATUS_CALLS: callLog,
        ...overrides,
      },
      encoding: 'utf8',
    });
    return { result, calls: readFileSync(callLog, 'utf8') };
  };

  return { root, wt, run };
}

test('setup.js reports running before the steps it announces and done after them', () => {
  const { root, run } = makeStatusFixture();
  const { calls } = run(['printf "step\\n" >> "$STATUS_CALLS"']);

  const phases = calls.trim().split('\n').map((line) => {
    const token = line.match(/setup=setup: (\w+)/);
    return token ? token[1] : line;
  });
  assert.deepEqual(phases, ['running', 'step', 'done']);
  assert.match(calls, /^workspace report-metadata test-workspace --source plugin:tdi\.worktree-setup --token setup=setup: running --ttl-ms 3600000$/m);
  assert.match(calls, /--token setup=setup: done --ttl-ms 5000$/m);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js reports failed with a long ttl when a step fails', () => {
  const { root, run } = makeStatusFixture();
  const { result, calls } = run(['exit 7']);

  assert.equal(result.status, 7);
  assert.match(calls, /--source plugin:tdi\.worktree-setup --token setup=setup: failed --ttl-ms 3600000$/m);
  assert.doesNotMatch(calls, /setup: done/);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js keeps its exit code and its steps when the status command fails', () => {
  const { root, wt, run } = makeStatusFixture();
  const { result } = run(['printf installed > installed'], { STATUS_EXIT: '1' });

  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(wt, 'installed'), 'utf8'), 'installed');
  assert.match(result.stderr, /sidebar status update failed: exit 1/);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js names the spawn failure when the herdr binary is missing', () => {
  const { root, run } = makeStatusFixture();
  const { result } = run(['true'], { HERDR_BIN_PATH: join(root, 'no-such-herdr') });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /sidebar status update failed: .*ENOENT/);
  rmSync(root, { recursive: true, force: true });
});

test('setup.js reports no status without steps or without a workspace id', () => {
  const { root, run } = makeStatusFixture();

  assert.equal(run([]).calls, '');
  assert.equal(run(['true'], { HERDR_WORKSPACE_ID: '' }).calls, '');
  rmSync(root, { recursive: true, force: true });
});

test('setup.js reports no status when it fails before the steps start', () => {
  const { root, run } = makeStatusFixture();
  const { result, calls } = run(['true'], { HERDR_PLUGIN_EVENT_JSON: '{}' });

  assert.equal(result.status, 1);
  assert.doesNotMatch(calls, /setup=setup:/);
  rmSync(root, { recursive: true, force: true });
});
