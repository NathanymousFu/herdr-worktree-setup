# Worktree Setup — herdr plugin

Runs user-configured shell steps when herdr creates or removes a worktree.
Creation steps prepare the checkout in the background (copy `.env*`, `mise
trust`, `direnv allow`, install deps, etc.); cleanup steps remove worktree-owned
resources such as containers. Solves
[herdr discussion #394](https://github.com/ogulcancelik/herdr/discussions/394).

## Install

From GitHub (recommended):

```bash
herdr plugin install tdi/herdr-worktree-setup
```

herdr fetches the repo, runs the build step (`npm ci`) to install the one
dependency, and enables the plugin. Re-run the same command to update; remove
with `herdr plugin uninstall tdi.worktree-setup`.

Cleanup reads the removed worktree path, branch, and main repo from the event
payload; that shape is verified against herdr 0.9.1 in `test/fixtures/` (see its
README to re-capture after an upgrade). On a herdr whose payload does not carry
those fields, cleanup logs the raw payload and skips, so `min_herdr_version`
stays at `0.7.0` and setup keeps working on older herdr.

For local development, link a working copy instead:

```bash
herdr plugin link /path/to/herdr-worktree-setup
```

## Configure

Find the plugin's config dir and drop a `config.toml` in it (copy
`config.example.toml` as a starting point):

```bash
herdr plugin config-dir tdi.worktree-setup
```

```toml
[default]
steps = ["direnv allow 2>/dev/null || true"]

[[project]]
path = "~/code/myrepo"
steps = [
  'cp "$HERDR_MAIN_REPO"/.env* . 2>/dev/null || true',
  "mise trust",
  "direnv allow",
  "pnpm install",
]
cleanup_steps = [
  'echo "cleaning resources for $HERDR_BRANCH"',
]
```

- `path` — the MAIN repo path (supports `~`); matched by realpath against the
  worktree's main checkout.
- `steps` — commands run after `worktree.created`, with the new worktree as cwd.
- `cleanup_steps` — commands run after `worktree.removed`, with the main repo as
  cwd. The removed path remains available as `$HERDR_WORKTREE`, but no longer
  exists. It is never the main repo: if herdr reports that, cleanup refuses to
  run rather than risk deleting your checkout.
- `[default]` — optional catch-all for repos without a `[[project]]` entry. A
  matching `[[project]]` entry wins outright, so a missing `steps` or
  `cleanup_steps` there is an empty list, not a fallback to `[default]`.
- No match and no `[default]` — the plugin does nothing.
- A list that is present but not an array of strings is an error, not a no-op:
  the hook exits non-zero with `worktree-setup: <key> for <repo> must be an
  array of strings`, so a typo cannot silently disable a phase.

### Env available to steps

| Var | Meaning |
|-----|---------|
| `HERDR_MAIN_REPO` | Absolute path to the main repo checkout |
| `HERDR_WORKTREE` | Absolute path to the worktree; during cleanup this is its former, removed path |
| `HERDR_BRANCH` | Branch checked out in the worktree |

## Behavior

- Setup steps run sequentially via `sh -c`, cwd = the new worktree.
- Cleanup steps run sequentially via `sh -c`, cwd = the main repository because
  the removed worktree directory no longer exists.
- Both phases are fail-fast: the first step that exits non-zero stops the run;
  make optional steps tolerant with `... || true`.
- Output is streamed to herdr's background plugin runner and also written to
  `$HERDR_PLUGIN_STATE_DIR/setup-<ts>-<pid>.log` or `cleanup-<ts>-<pid>.log`
  (one file per run; they accumulate, nothing rotates them). Event-hook output is
  not printed in the new worktree's terminal pane. Inspect captured output with
  `herdr plugin log list --plugin tdi.worktree-setup`, or follow the
  state-directory log directly.
- Cleanup degrades instead of failing: when the payload does not name a removed
  worktree (herdr older than 0.7.4) or the main repository is gone, cleanup
  writes the raw payload to stderr and exits 0 without running steps. When the
  resolved path *is* the main repository, it refuses to run and exits 1.

### Sidebar status

On herdr 0.7.4+, setup publishes a `setup` workspace metadata token so the
sidebar shows when a new worktree is still installing: `setup: running`, then
`setup: done` or `setup: failed`. herdr expires `done` after 5s and the other
two after an hour, so a setup that is killed or that you fix by hand never
leaves a stale token behind. Repos with no matched steps publish nothing, and on
older herdr the report only logs a warning; setup's exit code never changes.

Display it by adding `$setup` to `[ui.sidebar.spaces].rows` in
`~/.config/herdr/config.toml`, then `herdr config check` and
`herdr server reload-config`. This is herdr's default layout with the token
appended; merge it into your own rows rather than replacing them:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status", "$setup"],
]
```

- The plugin never edits herdr config; this is a one-time display setting.
- Step output still goes to the setup log — the token is display-only.
- To drop a status before it expires, use the workspace id from `herdr workspace list`:
  `herdr workspace report-metadata <id> --source plugin:tdi.worktree-setup --clear-token setup`.

## Develop

```bash
npm ci
npm test
```
