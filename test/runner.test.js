import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSteps, runStepsWithLog } from '../src/runner.js';

test('runSteps runs in cwd with injected env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtrun-'));
  const res = await runSteps(['printf "%s" "$MARKER" > out.txt'], {
    cwd: dir,
    env: { ...process.env, MARKER: 'hello' },
  });
  assert.deepEqual(res, { ok: true });
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'hello');
  rmSync(dir, { recursive: true, force: true });
});

test('runSteps is fail-fast: stops at first non-zero step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtrun-'));
  const res = await runSteps(['true', 'false', 'echo late > late.txt'], { cwd: dir, env: process.env });
  assert.equal(res.ok, false);
  assert.equal(res.failedStep, 'false');
  assert.equal(res.code, 1);
  assert.equal(existsSync(join(dir, 'late.txt')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('runSteps reports each executed step via onStepStart/onStepEnd', async () => {
  const started = [];
  const ended = [];
  await runSteps(['echo one', 'echo two'], {
    cwd: process.cwd(),
    env: process.env,
    onStepStart: (s) => started.push(s),
    onStepEnd: (s, code) => ended.push([s, code]),
  });
  assert.deepEqual(started, ['echo one', 'echo two']);
  assert.deepEqual(ended, [['echo one', 0], ['echo two', 0]]);
});

test('runSteps forwards step output via onData', async () => {
  let out = '';
  await runSteps(['printf hello'], {
    cwd: process.cwd(),
    env: process.env,
    onData: (chunk) => { out += chunk.toString(); },
  });
  assert.match(out, /hello/);
});

test('runSteps handles output larger than the old 1MB spawnSync cap without failing', async () => {
  // `yes | head -c 2000000` emits ~2MB then exits 0. The previous spawnSync
  // implementation exceeded its 1MB maxBuffer and killed the child (false failure).
  const res = await runSteps(['yes | head -c 2000000'], { cwd: process.cwd(), env: process.env });
  assert.deepEqual(res, { ok: true });
});

test('runSteps does not hang on a step that reads stdin', { timeout: 10000 }, async () => {
  // `cat` reads until EOF; with stdin closed it gets immediate EOF and exits 0.
  // Without the stdin fix this hangs forever.
  const res = await runSteps(['cat'], { cwd: process.cwd(), env: process.env });
  assert.deepEqual(res, { ok: true });
});

test('runSteps surfaces the spawn error when a step cannot be started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtrun-'));
  const res = await runSteps(['echo hi'], { cwd: join(dir, 'missing-cwd'), env: process.env });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.equal(res.failedStep, 'echo hi');
  assert.ok(res.error instanceof Error, 'the spawn error is reported, not swallowed');
  rmSync(dir, { recursive: true, force: true });
});

test('runStepsWithLog streams to the sink and tees the same text to the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtrun-'));
  const stateDir = join(dir, 'state');
  let out = '';
  const res = await runStepsWithLog(['printf hello'], {
    cwd: dir,
    env: process.env,
    stateDir,
    logPrefix: 'setup',
    write: (text) => { out += text; },
  });

  assert.deepEqual(res, { ok: true });
  const logs = readdirSync(stateDir).filter((file) => file.endsWith('.log'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^setup-.*-\d+\.log$/);
  const logged = readFileSync(join(stateDir, logs[0]), 'utf8');
  assert.equal(logged, out);
  assert.equal(logged, '$ printf hello\nhello[exit 0]\n');
  rmSync(dir, { recursive: true, force: true });
});

test('runStepsWithLog runs without a log when no state dir is set', async () => {
  let out = '';
  const res = await runStepsWithLog(['echo hi'], {
    cwd: process.cwd(),
    env: process.env,
    stateDir: undefined,
    logPrefix: 'setup',
    write: (text) => { out += text; },
  });
  assert.deepEqual(res, { ok: true });
  assert.match(out, /echo hi/);
});
