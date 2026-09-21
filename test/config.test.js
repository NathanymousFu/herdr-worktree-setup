import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandTilde, loadConfig, samePath, selectCleanupSteps, selectSteps } from '../src/config.js';

test('expandTilde expands ~ and ~/ using home', () => {
  assert.equal(expandTilde('~', '/home/u'), '/home/u');
  assert.equal(expandTilde('~/x/y', '/home/u'), '/home/u/x/y');
  assert.equal(expandTilde('/abs/path', '/home/u'), '/abs/path');
});

test('loadConfig returns null for missing dir, missing file, or empty file', () => {
  assert.equal(loadConfig(undefined), null);
  const dir = mkdtempSync(join(tmpdir(), 'wtcfg-'));
  assert.equal(loadConfig(dir), null); // no config.toml
  writeFileSync(join(dir, 'config.toml'), '   \n');
  assert.equal(loadConfig(dir), null); // empty
  rmSync(dir, { recursive: true, force: true });
});

test('loadConfig parses a valid config.toml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtcfg-'));
  writeFileSync(join(dir, 'config.toml'), '[[project]]\npath = "/x"\nsteps = ["echo hi"]\n');
  const cfg = loadConfig(dir);
  assert.equal(cfg.project[0].path, '/x');
  assert.deepEqual(cfg.project[0].steps, ['echo hi']);
  rmSync(dir, { recursive: true, force: true });
});

test('selectSteps matches main repo by realpath and returns its steps', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wtrepo-'));
  const cfg = { project: [{ path: repo, steps: ['echo match'] }] };
  assert.deepEqual(selectSteps(cfg, repo), ['echo match']);
  rmSync(repo, { recursive: true, force: true });
});

test('selectCleanupSteps selects project cleanup steps independently', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wtrepo-'));
  const cfg = {
    project: [{ path: repo, steps: ['setup'], cleanup_steps: ['cleanup'] }],
  };
  assert.deepEqual(selectSteps(cfg, repo), ['setup']);
  assert.deepEqual(selectCleanupSteps(cfg, repo), ['cleanup']);
  rmSync(repo, { recursive: true, force: true });
});

test('selectCleanupSteps falls back to default cleanup steps', () => {
  const cfg = { default: { cleanup_steps: ['cleanup default'] } };
  assert.deepEqual(selectCleanupSteps(cfg, '/other'), ['cleanup default']);
});

test('selectSteps falls back to [default] when no project matches', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wtrepo-'));
  const cfg = { project: [{ path: '/nope', steps: ['x'] }], default: { steps: ['echo def'] } };
  assert.deepEqual(selectSteps(cfg, repo), ['echo def']);
  rmSync(repo, { recursive: true, force: true });
});

test('selectSteps returns null when no match and no default', () => {
  assert.equal(selectSteps({ project: [{ path: '/nope', steps: ['x'] }] }, '/other'), null);
  assert.equal(selectSteps(null, '/other'), null);
});

test('loadConfig throws a clear error for malformed TOML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtcfg-'));
  writeFileSync(join(dir, 'config.toml'), 'not = = valid [[[');
  assert.throws(() => loadConfig(dir), /invalid config\.toml/);
  rmSync(dir, { recursive: true, force: true });
});

test('selectSteps matches a ~-prefixed project path via realpath', () => {
  const home = mkdtempSync(join(tmpdir(), 'wthome-'));
  const repo = join(home, 'proj');
  mkdirSync(repo);
  const cfg = { project: [{ path: '~/proj', steps: ['echo tilde'] }] };
  assert.deepEqual(selectSteps(cfg, repo, home), ['echo tilde']);
  rmSync(home, { recursive: true, force: true });
});

test('a matching project entry wins outright over [default]', () => {
  // Pins the documented rule: the project entry does not inherit from
  // [default], so its missing cleanup_steps is an empty list, not a fallback.
  const repo = mkdtempSync(join(tmpdir(), 'wtrepo-'));
  const cfg = {
    project: [{ path: repo, steps: ['setup only'] }],
    default: { cleanup_steps: ['cleanup default'] },
  };
  assert.deepEqual(selectCleanupSteps(cfg, repo), []);
  rmSync(repo, { recursive: true, force: true });
});

test('a step list that is not an array of strings is rejected, not ignored', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wtrepo-'));
  const asString = { project: [{ path: repo, cleanup_steps: 'echo hi' }] };
  assert.throws(() => selectCleanupSteps(asString, repo), /cleanup_steps for .* must be an array of strings/);

  const asNumbers = { project: [{ path: repo, cleanup_steps: [123] }] };
  assert.throws(() => selectCleanupSteps(asNumbers, repo), /entry 1 is number/);

  const defaultAsString = { default: { steps: 'echo hi' } };
  assert.throws(() => selectSteps(defaultAsString, '/other'), /steps for \[default\] must be an array of strings/);

  // Absent is still a legitimate empty list.
  assert.deepEqual(selectCleanupSteps({ project: [{ path: repo }] }, repo), []);
  rmSync(repo, { recursive: true, force: true });
});

test('samePath compares a removed path against a live one through symlinks', () => {
  const home = mkdtempSync(join(tmpdir(), 'wthome-'));
  const repo = join(home, 'main');
  mkdirSync(repo);
  const real = realpathSync(repo);
  assert.equal(samePath(repo, real, home), true);
  assert.equal(samePath(repo, join(home, 'other'), home), false);
  // The removed worktree no longer exists; its parent still does.
  assert.equal(samePath(join(repo, 'gone-wt'), join(real, 'gone-wt'), home), true);
  rmSync(home, { recursive: true, force: true });
});
