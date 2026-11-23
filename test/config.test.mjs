import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { resolveTarget, updateConfig, inspectConfig } from '../src/config.mjs';

const provider = (id) => ({
  'baze-bridge-gpt': {
    env: ['BAZE_API_KEY'],
    package: '@opencode/ai/providers/openai/responses',
    settings: { baseURL: 'https://factchat-cloud.mindlogic.ai/v1/gateway' },
    models: { [id]: { name: id } },
  },
});

async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 't3code-baze-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'opencode.jsonc');
  if (source) await writeFile(target, source);
  return { target, dir, read: () => readFile(target, 'utf8') };
}

test('resolves global XDG and a project without touching the sibling JSON file', async (t) => {
  const { dir, target } = await fixture(t);
  assert.equal(resolveTarget({ project: dir }), target);
  assert.equal(resolveTarget({ env: { XDG_CONFIG_HOME: dir } }), join(dir, 'opencode', 'opencode.jsonc'));
  assert.equal(resolveTarget({ env: { XDG_CONFIG_HOME: dir, OPENCODE_CONFIG_DIR: dir } }), target);
  const sibling = join(dir, 'opencode.json');
  const bytes = '{"model":"legacy/keep"}\r\n';
  await writeFile(sibling, bytes);
  await updateConfig(target, 'sync', provider('gpt-example'));
  assert.equal(await readFile(sibling, 'utf8'), bytes);
});

test('synchronizes idempotently and restores the last catalog without discarding later user edits', async (t) => {
  const { target, read } = await fixture(t, '{\r\n  // local preferences\r\n  "providers": {\r\n    "existing": {"name":"Original"},\r\n  },\r\n}\r\n');
  assert.equal(await updateConfig(target, 'sync', provider('gpt-old')), true);
  const once = await read();
  assert.equal(await updateConfig(target, 'sync', provider('gpt-old')), false);
  assert.equal(await read(), once);
  assert.equal(await updateConfig(target, 'sync', provider('gpt-new')), true);
  await writeFile(target, (await read()).replace('Original', 'User edit'));
  await updateConfig(target, 'restore');
  assert.deepEqual((await inspectConfig(target)).active, provider('gpt-old'));
  assert.equal(await updateConfig(target, 'restore'), false);
  await updateConfig(target, 'remove');
  const combined = await read();
  assert.deepEqual(parse(combined).providers, { existing: { name: 'User edit' } });
  assert.match(combined, /\/\/ local preferences\r\n/);
  assert.doesNotMatch(combined, /gpt-old|gpt-new|t3code-baze-bridge:/);
});

test('rejects unowned provider collisions including legacy and sibling config', async (t) => {
  const old = '{"provider":{"baze-bridge-gpt":{"name":"Local"}}}\n';
  const { target, dir, read } = await fixture(t, old);
  await assert.rejects(updateConfig(target, 'sync', provider('gpt-example')), /reserved provider/i);
  assert.equal(await read(), old);
  await writeFile(target, '{}');
  await writeFile(join(dir, 'opencode.json'), old);
  await assert.rejects(updateConfig(target, 'sync', provider('gpt-example')), /reserved provider/i);
  assert.equal(await read(), '{}');
});

test('rejects malformed or duplicate config and hand-edited managed providers', async (t) => {
  const { target, read } = await fixture(t, '{"providers":{},"providers":{}}');
  await assert.rejects(updateConfig(target, 'sync', provider('gpt-example')), /duplicate/i);
  assert.equal(await read(), '{"providers":{},"providers":{}}');
  await writeFile(target, '{}');
  await updateConfig(target, 'sync', provider('gpt-example'));
  const edited = (await read()).replace('"name": "gpt-example"', '"name": "override"');
  await writeFile(target, edited);
  await assert.rejects(updateConfig(target, 'remove'), /edited/i);
  assert.equal(await read(), edited);
});

test('a backup contains only the previous managed providers and removal leaves no backup', async (t) => {
  const { target, dir, read } = await fixture(t, '{"providers":{"private":{"settings":{"apiKey":"fixture-secret"}}}}');
  await updateConfig(target, 'sync', provider('gpt-first'));
  await updateConfig(target, 'sync', provider('gpt-second'));
  const result = await read();
  assert.equal(result.match(/fixture-secret/g).length, 1);
  assert.match(result.split(/\r?\n/)[0], /gpt-first/);
  await updateConfig(target, 'remove');
  assert.deepEqual(await readdir(dir), ['opencode.jsonc']);
  assert.doesNotMatch(await read(), /gpt-first|gpt-second/);
});

test('parallel synchronizations cannot leave a partial managed edit', async (t) => {
  const { target, dir } = await fixture(t);
  const results = await Promise.allSettled([
    updateConfig(target, 'sync', provider('gpt-first')),
    updateConfig(target, 'sync', provider('gpt-second')),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.match(results.find(({ status }) => status === 'rejected').reason.message, /locked/i);
  assert.equal(Object.keys((await inspectConfig(target)).active).length, 1);
  assert.deepEqual(await readdir(dir), ['opencode.jsonc']);
});

test('refuses to replace a symbolic link', { skip: process.platform === 'win32' }, async (t) => {
  const { target, dir } = await fixture(t);
  const original = join(dir, 'real.jsonc');
  await writeFile(original, '{}');
  await symlink(original, target);
  await assert.rejects(updateConfig(target, 'sync', provider('gpt-example')), /regular file/i);
  assert.equal(await readFile(original, 'utf8'), '{}');
});
