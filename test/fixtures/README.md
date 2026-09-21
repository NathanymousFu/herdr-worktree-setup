# Captured herdr payloads

Verbatim `HERDR_PLUGIN_EVENT_JSON` / `HERDR_PLUGIN_CONTEXT_JSON` pairs, used to
keep the resolvers honest about herdr's real field names.

| File | herdr | Event |
|------|-------|-------|
| `herdr-0.9.1-worktree-removed.{event,context}.json` | 0.9.1 | `worktree.removed` (forced) |

## Re-capturing

The payload shape is not documented upstream, so capture it again after a herdr
upgrade instead of guessing:

```bash
# 1. A throwaway plugin whose only job is to dump the hook environment.
mkdir -p /tmp/capture/plugin /tmp/capture/out
cat > /tmp/capture/plugin/herdr-plugin.toml <<'TOML'
id = "probe.payload-dump"
name = "Payload Probe"
version = "0.0.1"
min_herdr_version = "0.7.0"
platforms = ["linux", "macos"]

[[events]]
on = "worktree.created"
command = ["node", "probe.js"]

[[events]]
on = "worktree.removed"
command = ["node", "probe.js"]
TOML

cat > /tmp/capture/plugin/probe.js <<'JS'
import { appendFileSync } from 'node:fs';
appendFileSync('/tmp/capture/out/dump.jsonl', `${JSON.stringify({
  event: process.env.HERDR_PLUGIN_EVENT,
  eventJson: process.env.HERDR_PLUGIN_EVENT_JSON,
  contextJson: process.env.HERDR_PLUGIN_CONTEXT_JSON,
})}\n`);
JS

herdr plugin link /tmp/capture/plugin --enabled

# 2. Create and remove a throwaway worktree to trigger both hooks.
git init -q /tmp/capture/repo && git -C /tmp/capture/repo commit -q --allow-empty -m init
herdr worktree create --cwd /tmp/capture/repo --branch probe --path /tmp/capture/wt
herdr worktree remove --workspace <id from the create output> --force

# 3. Read /tmp/capture/out/dump.jsonl, then put the environment back.
herdr plugin unlink probe.payload-dump
rm -rf /tmp/capture
```

Hook environment observed on 0.9.1 (`worktree.removed`): `HERDR_PLUGIN_EVENT`
(`worktree.removed`), `HERDR_PLUGIN_EVENT_JSON`, `HERDR_PLUGIN_CONTEXT_JSON`,
`HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`,
`HERDR_PLUGIN_STATE_DIR`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`,
`HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_ENV`.

Note for 0.9.1: `context.workspace_cwd` is the **removed** worktree path, not the
main checkout, so it is not evidence for or against re-adding that fallback in
`extractRemovedWorktreeInfo` — the event's `data.worktree.path` is the field
that resolves it, and `cleanup.js` still refuses to run if the resolved path
ever equals the main repo.
