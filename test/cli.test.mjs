import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function context(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baze-bridge-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    run: (...args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: dir, BAZE_API_KEY: '', PATH: '' },
    }),
  };
}

test('sync requires the environment variable before creating files', async (t) => {
  const { dir, run } = await context(t);
  const result = run('sync', '--project', dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BAZE_API_KEY/);
  assert.deepEqual(await readdir(dir), []);
});

test('doctor reports a missing OpenCode executable and configuration without creating directories', async (t) => {
  const { dir, run } = await context(t);
  const result = run('doctor', '--opencode-executable', join(dir, 'missing-opencode.exe'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /OpenCode: unavailable/);
  assert.match(result.stdout, /BAZE_API_KEY: missing/);
  assert.match(result.stdout, /Managed providers: 0/);
  assert.deepEqual(await readdir(dir), []);
});

test('unknown options are rejected without printing their values', async (t) => {
  const { run } = await context(t);
  const result = run('sync', '--api-key=fixture-secret');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--help/);
  assert.doesNotMatch(result.stderr + result.stdout, /fixture-secret/);
});
