import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';

export function expandTilde(p, home = homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

export function canonicalize(p, home = homedir()) {
  const expanded = resolve(expandTilde(p, home));
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

// Identity for paths that need not exist — the removed worktree is gone, so
// resolving the path itself would leave symlinked parents (e.g. /tmp) spelled
// differently on each side and hide a real match. The parent still exists.
function canonicalizeMaybeMissing(p, home = homedir()) {
  const expanded = resolve(expandTilde(p, home));
  try {
    return join(realpathSync(dirname(expanded)), basename(expanded));
  } catch {
    return canonicalize(expanded, home);
  }
}

export function samePath(a, b, home = homedir()) {
  return canonicalizeMaybeMissing(a, home) === canonicalizeMaybeMissing(b, home);
}

export function loadConfig(configDir) {
  if (!configDir) return null;
  const file = join(configDir, 'config.toml');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return parse(text);
  } catch (err) {
    throw new Error(`worktree-setup: invalid config.toml at ${file}: ${err.message}`);
  }
}

// A present-but-malformed list fails loudly: silently treating it as empty
// would leave the user believing their steps are configured when they are not.
function stepList(value, key, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`worktree-setup: ${key} for ${where} must be an array of strings`);
  }
  value.forEach((step, i) => {
    if (typeof step !== 'string') {
      throw new Error(
        `worktree-setup: ${key} for ${where} must be an array of strings (entry ${i + 1} is ${typeof step})`,
      );
    }
  });
  return value;
}

function selectStepList(config, mainRepoPath, key, home = homedir()) {
  if (!config) return null;
  const target = canonicalize(mainRepoPath, home);
  const projects = Array.isArray(config.project) ? config.project : [];
  for (const entry of projects) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (canonicalize(entry.path, home) === target) {
      return stepList(entry[key], key, entry.path);
    }
  }
  if (config.default && config.default[key] !== undefined) {
    return stepList(config.default[key], key, '[default]');
  }
  return null;
}

export function selectSteps(config, mainRepoPath, home = homedir()) {
  return selectStepList(config, mainRepoPath, 'steps', home);
}

export function selectCleanupSteps(config, mainRepoPath, home = homedir()) {
  return selectStepList(config, mainRepoPath, 'cleanup_steps', home);
}
