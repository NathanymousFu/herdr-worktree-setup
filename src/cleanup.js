import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { loadConfig, selectCleanupSteps, samePath } from './config.js';
import { parseJsonEnv, extractRemovedWorktreeInfo, buildStepEnv, contextDump } from './worktree.js';
import { runStepsWithLog } from './runner.js';

// Cleanup is best-effort. It runs after the worktree is gone and its payload
// shape is not pinned by herdr, so a context that cannot be resolved (older
// herdr) warns and skips instead of failing the hook on every removal.
function skipCleanup(env, reason) {
  process.stderr.write(`worktree-setup: skipping cleanup: ${reason}\n`);
  process.stderr.write(contextDump(env));
  return 0;
}

async function main() {
  const env = process.env;
  const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR);
  if (!config) return 0;

  const removed = extractRemovedWorktreeInfo(
    parseJsonEnv(env.HERDR_PLUGIN_EVENT_JSON),
    parseJsonEnv(env.HERDR_PLUGIN_CONTEXT_JSON),
  );
  if (!removed.mainRepo) return skipCleanup(env, 'the main repository could not be resolved');
  if (!removed.worktreePath) return skipCleanup(env, 'the removed worktree path could not be resolved');

  // Safety: never hand a live checkout to a step as $HERDR_WORKTREE. A step
  // like `rm -rf "$HERDR_WORKTREE"` would otherwise delete the repository.
  if (samePath(removed.worktreePath, removed.mainRepo)) {
    process.stderr.write(
      'worktree-setup: refusing to run cleanup: the removed worktree resolves to the main repository\n',
    );
    process.stderr.write(contextDump(env));
    return 1;
  }

  // Cleanup steps run with the main repo as cwd, so a path that is gone (or a
  // payload field that points somewhere unexpected) must be named explicitly:
  // otherwise the run fails as a bare "spawn /bin/sh ENOENT" step failure.
  if (!existsSync(removed.mainRepo)) {
    return skipCleanup(env, `the main repository ${removed.mainRepo} does not exist`);
  }

  const steps = selectCleanupSteps(config, removed.mainRepo, homedir());
  if (!steps || steps.length === 0) return 0;

  // Deliberately no sidebar status here: the workspace's worktree is already
  // gone, so there is nothing left to report against.
  const result = await runStepsWithLog(steps, {
    cwd: removed.mainRepo,
    env: buildStepEnv(env, {
      mainRepo: removed.mainRepo,
      worktree: removed.worktreePath,
      branch: removed.branch,
    }),
    stateDir: env.HERDR_PLUGIN_STATE_DIR,
    logPrefix: 'cleanup',
  });

  if (!result.ok) {
    const reason = result.error ? `${result.failedStep} (${result.error.message})` : result.failedStep;
    process.stderr.write(`worktree-setup: cleanup step failed: ${reason}\n`);
    return result.code;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`worktree-setup: ${err.message}\n`);
    process.exit(1);
  });
