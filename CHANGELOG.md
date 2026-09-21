# Changelog

## Unreleased

- Add `cleanup_steps` for removing worktree-owned resources after herdr emits `worktree.removed`.
- Expose the removed worktree path and branch through the existing `HERDR_WORKTREE` and `HERDR_BRANCH` variables during cleanup; the removed path is never the main repo.
- Write cleanup output to `cleanup-<timestamp>-<pid>.log` in the plugin state directory.
- Cleanup degrades instead of failing: an unresolvable payload (herdr older than 0.7.4) or a missing main repo logs the raw payload and skips, while a payload that resolves to the main repo is refused.
- Reject a `steps`/`cleanup_steps` value that is not an array of strings instead of silently running nothing.
- Clarify that event output streams to herdr's background runner rather than the worktree terminal.
- Upgrade `smol-toml` to 1.8.0 to address malformed-input denial of service.
