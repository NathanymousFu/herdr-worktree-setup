import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// Run shell steps sequentially, streaming their output live, fail-fast.
// Callbacks (all optional):
//   onStepStart(step)        - before a step runs
//   onData(chunk)            - a stdout/stderr chunk (Buffer) as it arrives
//   onStepEnd(step, status)  - after a step exits, with its exit status
// Resolves { ok: true } when every step exits 0, otherwise
// { ok: false, failedStep, code, error } at the first non-zero step, where
// `error` is the spawn error when the step could not be started at all.
export function runSteps(steps, { cwd, env, onStepStart, onData, onStepEnd } = {}) {
  return new Promise((resolve) => {
    let index = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const runNext = () => {
      if (index >= steps.length) {
        finish({ ok: true });
        return;
      }
      const step = steps[index];
      if (onStepStart) onStepStart(step);

      const child = spawn(step, { shell: '/bin/sh', cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let ended = false;
      const endStep = (status, error) => {
        if (ended) return;
        ended = true;
        if (onStepEnd) onStepEnd(step, status);
        if (status === 0) {
          index += 1;
          runNext();
        } else {
          finish({ ok: false, failedStep: step, code: status, error });
        }
      };

      // Always drain both streams so the child never blocks on a full pipe.
      child.stdout.on('data', (chunk) => { if (onData) onData(chunk); });
      child.stderr.on('data', (chunk) => { if (onData) onData(chunk); });
      child.on('error', (err) => endStep(1, err));
      child.on('close', (code) => endStep(code ?? 1));
    };

    runNext();
  });
}

// Run a step list the way both hooks need it: announce each step, stream its
// output to stdout, and tee the same text into
// <stateDir>/<logPrefix>-<timestamp>-<pid>.log. Logging is best-effort and
// never changes the result; use `write` to capture output in tests.
// Resolves the same shape as runSteps.
export async function runStepsWithLog(
  steps,
  { cwd, env, stateDir, logPrefix, write = (text) => process.stdout.write(text) } = {},
) {
  const log = openStepLog(stateDir, logPrefix);
  const emit = (text) => {
    write(text);
    log.write(text);
  };

  try {
    return await runSteps(steps, {
      cwd,
      env,
      onStepStart: (step) => emit(`$ ${step}\n`),
      onData: (chunk) => emit(chunk.toString()),
      onStepEnd: (_step, status) => emit(`[exit ${status}]\n`),
    });
  } finally {
    log.close();
  }
}

// One log file per run: the pid keeps two runs that start within the same
// millisecond from appending to the same file.
function openStepLog(stateDir, prefix) {
  const noop = { write() {}, close() {} };
  if (!stateDir || !prefix) return noop;

  let fd;
  try {
    mkdirSync(stateDir, { recursive: true });
    fd = openSync(join(stateDir, `${prefix}-${stamp()}-${process.pid}.log`), 'a');
  } catch {
    return noop;
  }

  return {
    write(text) {
      try {
        writeSync(fd, text);
      } catch {
        // best-effort logging
      }
    },
    close() {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    },
  };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
