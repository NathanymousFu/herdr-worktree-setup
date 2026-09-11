import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { loadConfig, selectSteps } from './config.js';
import { resolveWorktreePath, deriveGitInfo, runCmd } from './worktree.js';
import { runSteps } from './runner.js';

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

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const env = process.env;

  const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR);
  if (!config) return 0;

  const worktree = resolveWorktreePath(env);
  if (!worktree) {
    process.stderr.write('worktree-setup: could not resolve new worktree path\n');
    const trunc = (v) => (v == null ? '(unset)' : String(v).slice(0, 2000));
    process.stderr.write(`  HERDR_PLUGIN_EVENT_JSON=${trunc(env.HERDR_PLUGIN_EVENT_JSON)}\n`);
    process.stderr.write(`  HERDR_PLUGIN_CONTEXT_JSON=${trunc(env.HERDR_PLUGIN_CONTEXT_JSON)}\n`);
    process.stderr.write(`  HERDR_WORKSPACE_ID=${env.HERDR_WORKSPACE_ID ?? '(unset)'}\n`);
    return 1;
  }

  const { mainRepo, branch } = deriveGitInfo(worktree);
  if (!mainRepo) {
    process.stderr.write('worktree-setup: could not derive main repo path\n');
    return 1;
  }

  const steps = selectSteps(config, mainRepo, homedir());
  if (!steps || steps.length === 0) return 0;

  const stepEnv = {
    ...env,
    HERDR_MAIN_REPO: mainRepo,
    HERDR_WORKTREE: worktree,
    HERDR_BRANCH: branch ?? '',
  };

  let logFd = null;
  if (env.HERDR_PLUGIN_STATE_DIR) {
    try {
      mkdirSync(env.HERDR_PLUGIN_STATE_DIR, { recursive: true });
      logFd = openSync(join(env.HERDR_PLUGIN_STATE_DIR, `setup-${stamp()}.log`), 'a');
    } catch {
      logFd = null;
    }
  }

  const writeOut = (text) => {
    process.stdout.write(text);
    if (logFd !== null) {
      try {
        writeSync(logFd, text);
      } catch {
        // best-effort logging
      }
    }
  };

  setupStarted = true;
  reportStatus('running');
  const result = await runSteps(steps, {
    cwd: worktree,
    env: stepEnv,
    onStepStart: (step) => writeOut(`$ ${step}\n`),
    onData: (chunk) => writeOut(chunk.toString()),
    onStepEnd: (_step, status) => writeOut(`[exit ${status}]\n`),
  });
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      // ignore
    }
  }

  if (!result.ok) {
    process.stderr.write(`worktree-setup: step failed: ${result.failedStep}\n`);
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
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
