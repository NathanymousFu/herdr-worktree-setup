import { spawnSync } from 'node:child_process';

// Cut-off for the raw payload dumped into the hook log. The JSON is the only
// way to debug an unexpected event shape after the fact.
const DUMP_LIMIT = 2000;

export function parseJsonEnv(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// The HERDR_* values a step sees, on top of the hook's own environment.
export function buildStepEnv(env, { mainRepo, worktree, branch }) {
  return {
    ...env,
    HERDR_MAIN_REPO: mainRepo,
    HERDR_WORKTREE: worktree,
    HERDR_BRANCH: branch ?? '',
  };
}

// Truncated dump of the payload a hook was invoked with, for its error path.
export function contextDump(env) {
  const trunc = (v) => (v == null ? '(unset)' : String(v).slice(0, DUMP_LIMIT));
  return [
    `  HERDR_PLUGIN_EVENT_JSON=${trunc(env.HERDR_PLUGIN_EVENT_JSON)}`,
    `  HERDR_PLUGIN_CONTEXT_JSON=${trunc(env.HERDR_PLUGIN_CONTEXT_JSON)}`,
    `  HERDR_WORKSPACE_ID=${env.HERDR_WORKSPACE_ID ?? '(unset)'}`,
    '',
  ].join('\n');
}

export function extractWorktreePath(eventJson, contextJson) {
  const sources = [eventJson, contextJson].filter(Boolean);
  // Ordered most-specific first. Field names verified against herdr 0.7.1:
  //   event   -> data.worktree.path / data.worktree.checkout_path
  //   context -> worktree.checkout_path / workspace_cwd
  // repo_root/repo_key are the MAIN repo, never the new worktree, so they are
  // deliberately excluded. Looser fallbacks are kept for other/older shapes.
  const pickers = [
    (o) => o.data?.worktree?.path,
    (o) => o.data?.worktree?.checkout_path,
    (o) => o.data?.workspace?.worktree?.checkout_path,
    (o) => o.worktree?.path,
    (o) => o.worktree?.checkout_path,
    (o) => o.worktree?.dir,
    (o) => o.worktree?.worktree_path,
    (o) => o.workspace?.worktree?.checkout_path,
    (o) => o.workspace_cwd,
    (o) => o.workspace?.path,
    (o) => o.path,
  ];
  for (const src of sources) {
    for (const pick of pickers) {
      const v = pick(src);
      if (typeof v === 'string' && v.length) return v;
    }
  }
  return null;
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length) return v;
  }
  return null;
}

// Resolve the context of a `worktree.removed` event. `workspace_cwd` is
// deliberately not probed, even though herdr 0.9.1 happens to set it to the
// removed path: a cwd is not a worktree path, and treating one as the removed
// path is what lets `rm -rf "$HERDR_WORKTREE"` delete a live checkout. The
// event's `data.worktree.path` is authoritative — see test/fixtures/.
export function extractRemovedWorktreeInfo(eventJson, contextJson) {
  const eventData = eventJson?.data ?? eventJson;
  const worktree = eventData?.worktree ?? contextJson?.worktree;
  const workspace = eventData?.workspace ?? contextJson?.workspace;

  return {
    worktreePath: firstString(
      worktree?.path,
      worktree?.checkout_path,
      workspace?.worktree?.checkout_path,
    ),
    mainRepo: firstString(
      workspace?.worktree?.repo_root,
      contextJson?.worktree?.repo_root,
      contextJson?.workspace?.worktree?.repo_root,
    ),
    branch: firstString(worktree?.branch, contextJson?.branch),
  };
}

export function parseMainRepo(porcelain) {
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      return line.slice('worktree '.length).trim();
    }
  }
  return null;
}

export function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
  };
}

export function resolveWorktreePath(env, exec = runCmd) {
  const fromJson = extractWorktreePath(
    parseJsonEnv(env.HERDR_PLUGIN_EVENT_JSON),
    parseJsonEnv(env.HERDR_PLUGIN_CONTEXT_JSON),
  );
  if (fromJson) return fromJson;

  const wsId = env.HERDR_WORKSPACE_ID;
  if (!wsId) return null;
  const bin = env.HERDR_BIN_PATH || 'herdr';
  const res = exec(bin, ['worktree', 'list', '--json']);
  if (res.status !== 0) return null;
  let list;
  try {
    list = JSON.parse(res.stdout);
  } catch {
    return null;
  }
  let items = [];
  if (Array.isArray(list)) {
    items = list;
  } else if (list && typeof list === 'object') {
    items = list.result?.worktrees ?? list.worktrees ?? list.items ?? [];
  }
  const match = items.find(
    (w) =>
      w.open_workspace_id === wsId ||
      w.workspace_id === wsId ||
      w.workspaceId === wsId ||
      w.id === wsId,
  );
  if (!match) return null;
  return match.path ?? match.worktree ?? null;
}

export function deriveGitInfo(worktreePath, exec = runCmd) {
  const wt = exec('git', ['-C', worktreePath, 'worktree', 'list', '--porcelain']);
  const mainRepo = wt.status === 0 ? parseMainRepo(wt.stdout) : null;
  const br = exec('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.status === 0 ? br.stdout.trim() : null;
  return { mainRepo, branch };
}
