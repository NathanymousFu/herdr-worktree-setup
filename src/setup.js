import { homedir } from 'node:os';
import { loadConfig, selectSteps } from './config.js';
import { resolveWorktreePath, deriveGitInfo, runCmd, buildStepEnv, contextDump } from './worktree.js';
import { runStepsWithLog } from './runner.js';

let setupStarted = false;

// Every status expires: setup runs once per worktree, so a stale token can never be corrected.
const TTL_MS = { running: 3600000, done: 5000, failed: 3600000 };

function reportStatus(status) {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) return;
  // herdr 0.7.4+ CLI contract; on older herdr the command fails and setup only warns.
  const args = [
    'workspace', 'report-metadata', workspaceId,
    '--source', 'plugin:tdi.worktree-setup',
    '--token', `setup=setup: ${status}`,
    '--ttl-ms', String(TTL_MS[status]),
  ];
  const result = runCmd(process.env.HERDR_BIN_PATH || 'herdr', args, { timeout: 2000 });
  if (result.status !== 0) {
    const reason = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    process.stderr.write(`worktree-setup: sidebar status update failed: ${reason}\n`);
  }
}

async function main() {
  const env = process.env;

  const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR);
  if (!config) return 0;

  const worktree = resolveWorktreePath(env);
  if (!worktree) {
    process.stderr.write('worktree-setup: could not resolve new worktree path\n');
    process.stderr.write(contextDump(env));
    return 1;
  }

  const { mainRepo, branch } = deriveGitInfo(worktree);
  if (!mainRepo) {
    process.stderr.write('worktree-setup: could not derive main repo path\n');
    return 1;
  }

  const steps = selectSteps(config, mainRepo, homedir());
  if (!steps || steps.length === 0) return 0;

  setupStarted = true;
  reportStatus('running');
  const result = await runStepsWithLog(steps, {
    cwd: worktree,
    env: buildStepEnv(env, { mainRepo, worktree, branch }),
    stateDir: env.HERDR_PLUGIN_STATE_DIR,
    logPrefix: 'setup',
  });

  if (!result.ok) {
    const reason = result.error ? `${result.failedStep} (${result.error.message})` : result.failedStep;
    process.stderr.write(`worktree-setup: step failed: ${reason}\n`);
    return result.code;
  }
  return 0;
}

main()
  .then((code) => {
    if (setupStarted) reportStatus(code === 0 ? 'done' : 'failed');
    process.exit(code);
  })
  .catch((err) => {
    if (setupStarted) reportStatus('failed');
    process.stderr.write(`worktree-setup: ${err.message}\n`);
    process.exit(1);
  });
