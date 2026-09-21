import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJsonEnv,
  extractWorktreePath,
  extractRemovedWorktreeInfo,
  parseMainRepo,
  resolveWorktreePath,
  deriveGitInfo,
} from '../src/worktree.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

test('parseJsonEnv parses valid JSON, returns null otherwise', () => {
  assert.deepEqual(parseJsonEnv('{"a":1}'), { a: 1 });
  assert.equal(parseJsonEnv(''), null);
  assert.equal(parseJsonEnv(undefined), null);
  assert.equal(parseJsonEnv('{bad'), null);
});

test('extractWorktreePath probes event then context for a path field', () => {
  assert.equal(extractWorktreePath({ worktree: { path: '/a' } }, null), '/a');
  assert.equal(extractWorktreePath(null, { worktree: { path: '/b' } }), '/b');
  assert.equal(extractWorktreePath({ path: '/c' }, null), '/c');
  assert.equal(extractWorktreePath(null, null), null);
  assert.equal(extractWorktreePath({}, {}), null);
});

test('extractWorktreePath resolves the real herdr 0.7.1 event JSON shape', () => {
  // Captured from herdr 0.7.1 worktree.created. Worktree path lives at
  // data.worktree.path; repo_root is the MAIN repo and must NOT be picked.
  const eventJson = {
    event: 'worktree_created',
    data: {
      type: 'worktree_created',
      workspace: { workspace_id: 'wY', worktree: { repo_root: '/repo', checkout_path: '/wt/demo-feat' } },
      worktree: { path: '/wt/demo-feat', branch: 'demo-feat' },
    },
  };
  assert.equal(extractWorktreePath(eventJson, null), '/wt/demo-feat');
});

test('extractWorktreePath resolves the real herdr 0.7.1 context JSON shape', () => {
  // Context worktree uses checkout_path (no `path` field); repo_root excluded.
  const contextJson = {
    workspace_id: 'wY',
    workspace_cwd: '/wt/demo-feat',
    worktree: { repo_root: '/repo', repo_name: 'demo-main', checkout_path: '/wt/demo-feat' },
  };
  assert.equal(extractWorktreePath(null, contextJson), '/wt/demo-feat');
});

test('extractRemovedWorktreeInfo reads the removed path, branch, and main repo', () => {
  const eventJson = {
    event: 'worktree_removed',
    data: {
      workspace_id: 'wY',
      workspace: {
        worktree: {
          repo_root: '/repo',
          checkout_path: '/wt/feat',
        },
      },
      worktree: {
        path: '/wt/feat',
        branch: 'feat/demo',
      },
      forced: false,
    },
  };
  assert.deepEqual(extractRemovedWorktreeInfo(eventJson, null), {
    worktreePath: '/wt/feat',
    mainRepo: '/repo',
    branch: 'feat/demo',
  });
});

test('extractRemovedWorktreeInfo falls back to plugin context', () => {
  const contextJson = {
    branch: 'feat',
    worktree: { repo_root: '/repo', checkout_path: '/wt/feat' },
  };
  assert.deepEqual(extractRemovedWorktreeInfo(null, contextJson), {
    worktreePath: '/wt/feat',
    mainRepo: '/repo',
    branch: 'feat',
  });
});

test('extractRemovedWorktreeInfo resolves the captured herdr 0.9.1 payload', () => {
  // Captured from herdr 0.9.1 with a plugin hook on worktree.removed; see
  // test/fixtures/README.md for how to re-capture after a herdr upgrade.
  const eventJson = fixture('herdr-0.9.1-worktree-removed.event.json');
  const contextJson = fixture('herdr-0.9.1-worktree-removed.context.json');

  assert.deepEqual(extractRemovedWorktreeInfo(eventJson, contextJson), {
    worktreePath: '/tmp/herdr-payload-capture/wt',
    mainRepo: '/tmp/herdr-payload-capture/repo',
    branch: 'probe-capture',
  });
});

test('extractRemovedWorktreeInfo never treats a cwd as the removed worktree', () => {
  // Regression: after removal the workspace cwd can be the main checkout.
  // Accepting it as the removed path would let a step that trusts
  // $HERDR_WORKTREE (`rm -rf "$HERDR_WORKTREE"`) delete the repository.
  const contextJson = { workspace_cwd: '/repo', worktree: { repo_root: '/repo' } };
  assert.deepEqual(extractRemovedWorktreeInfo(null, contextJson), {
    worktreePath: null,
    mainRepo: '/repo',
    branch: null,
  });
});

test('extractRemovedWorktreeInfo ignores non-string probe results', () => {
  const eventJson = { data: { worktree: { path: 123, branch: '' } } };
  assert.deepEqual(extractRemovedWorktreeInfo(eventJson, null), {
    worktreePath: null,
    mainRepo: null,
    branch: null,
  });
});

test('parseMainRepo returns the first worktree path from porcelain output', () => {
  const out = [
    'worktree /home/u/code/repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /home/u/code/repo-wt/feat',
    'HEAD def456',
    'branch refs/heads/feat',
    '',
  ].join('\n');
  assert.equal(parseMainRepo(out), '/home/u/code/repo');
  assert.equal(parseMainRepo(''), null);
});

test('resolveWorktreePath prefers the event JSON path (no exec call)', () => {
  const env = { HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ worktree: { path: '/from/event' } }) };
  let called = false;
  const exec = () => { called = true; return { status: 0, stdout: '', stderr: '' }; };
  assert.equal(resolveWorktreePath(env, exec), '/from/event');
  assert.equal(called, false);
});

test('resolveWorktreePath falls back to herdr CLI matched by workspace id (flat array)', () => {
  // Legacy/simple shape: plain array with id field
  const env = { HERDR_WORKSPACE_ID: 'ws-2', HERDR_BIN_PATH: 'herdr' };
  const list = [
    { id: 'ws-1', path: '/wt/one' },
    { id: 'ws-2', path: '/wt/two' },
  ];
  const exec = (cmd, args) => {
    assert.equal(cmd, 'herdr');
    assert.deepEqual(args, ['worktree', 'list', '--json']);
    return { status: 0, stdout: JSON.stringify(list), stderr: '' };
  };
  assert.equal(resolveWorktreePath(env, exec), '/wt/two');
});

test('resolveWorktreePath falls back to herdr CLI matched by workspace id (herdr 0.7.3 shape)', () => {
  // Real herdr 0.7.3 output: { id, result: { worktrees: [{ open_workspace_id, path }] } }
  const env = { HERDR_WORKSPACE_ID: 'wC', HERDR_BIN_PATH: 'herdr' };
  const list = {
    id: 'cli:worktree:list',
    result: {
      type: 'worktree_list',
      worktrees: [
        { open_workspace_id: 'w1', path: '/main/repo' },
        { open_workspace_id: 'wC', path: '/wt/feat' },
      ],
    },
  };
  const exec = () => ({ status: 0, stdout: JSON.stringify(list), stderr: '' });
  assert.equal(resolveWorktreePath(env, exec), '/wt/feat');
});

test('resolveWorktreePath returns null when nothing resolves', () => {
  assert.equal(resolveWorktreePath({}, () => ({ status: 1, stdout: '', stderr: '' })), null);
});

test('resolveWorktreePath returns null when CLI returns literal null JSON', () => {
  const env = { HERDR_WORKSPACE_ID: 'ws-1', HERDR_BIN_PATH: 'herdr' };
  const exec = () => ({ status: 0, stdout: 'null', stderr: '' });
  assert.equal(resolveWorktreePath(env, exec), null);
});

test('deriveGitInfo returns mainRepo and branch from injected git calls', () => {
  const exec = (cmd, args) => {
    assert.equal(cmd, 'git');
    if (args.includes('--porcelain')) {
      return { status: 0, stdout: 'worktree /main/repo\nHEAD abc\n\n', stderr: '' };
    }
    if (args.includes('--abbrev-ref')) {
      return { status: 0, stdout: 'feat\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
  assert.deepEqual(deriveGitInfo('/main/repo/wt', exec), { mainRepo: '/main/repo', branch: 'feat' });
});
