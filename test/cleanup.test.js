import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLEANUP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cleanup.js');

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

// A repo whose linked worktree has already been removed, plus the payload herdr
// sends for that event. The temp tree is cleaned up even when an assertion fails.
function makeRemovedWorktreeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wtcleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const repo = join(root, 'main');
  const wt = join(root, 'wt');
  const configDir = join(root, 'cfg');
  const stateDir = join(root, 'state');

  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'file.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'worktree', 'add', '-b', 'feat/demo', wt);
  mkdirSync(configDir);
  mkdirSync(stateDir);
  git(repo, 'worktree', 'remove', '--force', wt);

  const event = {
    event: 'worktree_removed',
    data: {
      workspace_id: 'wY',
      workspace: {
        worktree: {
          repo_root: realpathSync(repo),
          checkout_path: wt,
          is_linked_worktree: true,
        },
      },
      worktree: {
        path: wt,
        branch: 'feat/demo',
        is_linked_worktree: true,
      },
      forced: false,
    },
  };

  return { root, repo, wt, configDir, stateDir, event };
}

function runCleanup(fixture, { config, ...env } = {}) {
  if (config !== undefined) writeFileSync(join(fixture.configDir, 'config.toml'), config);
  return spawnSync('node', [CLEANUP], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: fixture.configDir,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify(fixture.event),
      ...env,
    },
    encoding: 'utf8',
  });
}

test('cleanup.js runs matched cleanup steps after the worktree path is gone', (t) => {
  const fixture = makeRemovedWorktreeFixture(t);
  const result = runCleanup(fixture, {
    config: `[[project]]\npath = ${JSON.stringify(realpathSync(fixture.repo))}\ncleanup_steps = ['printf "%s|%s|%s" "$HERDR_MAIN_REPO" "$HERDR_WORKTREE" "$HERDR_BRANCH" > CLEANUP_OK']\n`,
    HERDR_PLUGIN_STATE_DIR: fixture.stateDir,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.wt), false);
  assert.equal(
    readFileSync(join(fixture.repo, 'CLEANUP_OK'), 'utf8'),
    `${realpathSync(fixture.repo)}|${fixture.wt}|feat/demo`,
  );
  const logs = readdirSync(fixture.stateDir).filter(
    (file) => file.startsWith('cleanup-') && file.endsWith('.log'),
  );
  assert.equal(logs.length, 1);
  // One file per run: the pid keeps same-millisecond runs apart.
  assert.match(logs[0], /^cleanup-.*-\d+\.log$/);
  assert.match(readFileSync(join(fixture.stateDir, logs[0]), 'utf8'), /\[exit 0\]/);
});

test('cleanup.js is a no-op when the matched project has no cleanup steps', (t) => {
  const fixture = makeRemovedWorktreeFixture(t);
  const result = runCleanup(fixture, {
    config: `[[project]]\npath = ${JSON.stringify(realpathSync(fixture.repo))}\nsteps = ["true"]\n`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(fixture.repo, 'CLEANUP_OK')), false);
});

test('cleanup.js exits with the failing cleanup step exit code', (t) => {
  const fixture = makeRemovedWorktreeFixture(t);
  const result = runCleanup(fixture, {
    config: `[[project]]\npath = ${JSON.stringify(realpathSync(fixture.repo))}\ncleanup_steps = ["exit 7"]\n`,
  });

  assert.equal(result.status, 7);
  assert.match(result.stderr, /cleanup step failed/);
});

test('cleanup.js skips with a warning when the payload names no removed worktree', (t) => {
  // herdr older than 0.7.4: the event carries no worktree, only a cwd that is
  // the main checkout. Never treat that cwd as the removed path.
  const fixture = makeRemovedWorktreeFixture(t);
  const result = runCleanup(fixture, {
    config: `[default]\ncleanup_steps = ["touch RAN_CLEANUP"]\n`,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'worktree_removed', data: {} }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_cwd: realpathSync(fixture.repo),
      worktree: { repo_root: realpathSync(fixture.repo) },
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /skipping cleanup: the removed worktree path could not be resolved/);
  assert.match(result.stderr, /HERDR_PLUGIN_CONTEXT_JSON=/);
  assert.equal(existsSync(join(fixture.repo, 'RAN_CLEANUP')), false);
});

test('cleanup.js refuses to run when the removed path is the main repository', (t) => {
  const fixture = makeRemovedWorktreeFixture(t);
  const repo = realpathSync(fixture.repo);
  const result = runCleanup(fixture, {
    config: `[default]\ncleanup_steps = ["touch RAN_CLEANUP"]\n`,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'worktree_removed', data: {} }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      worktree: { repo_root: repo, checkout_path: repo },
    }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to run cleanup/);
  assert.equal(existsSync(join(fixture.repo, 'RAN_CLEANUP')), false);
});

test('cleanup.js skips with a warning when the main repository is gone', (t) => {
  const fixture = makeRemovedWorktreeFixture(t);
  const missing = join(fixture.root, 'deleted-repo');
  const result = runCleanup(fixture, {
    config: `[default]\ncleanup_steps = ["touch RAN_CLEANUP"]\n`,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: 'worktree_removed',
      data: {
        workspace: { worktree: { repo_root: missing } },
        worktree: { path: fixture.wt, branch: 'feat/demo' },
      },
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /skipping cleanup: the main repository .* does not exist/);
  assert.equal(existsSync(join(fixture.repo, 'RAN_CLEANUP')), false);
});

test('cleanup.js fails loudly on a malformed cleanup_steps', (t) => {
  const fixture = makeRemovedWorktreeFixture(t);
  const result = runCleanup(fixture, {
    config: `[[project]]\npath = ${JSON.stringify(realpathSync(fixture.repo))}\ncleanup_steps = "echo hi"\n`,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /worktree-setup: cleanup_steps for .* must be an array of strings/);
});
