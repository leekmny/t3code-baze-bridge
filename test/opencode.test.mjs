import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { waitForModels } from '../src/opencode.mjs';

test('waits for a cold catalog and matches exact provider and model IDs', async (t) => {
  const directory = 'example project';
  const password = 'synthetic-test-password';
  const expected = ['baze-bridge-gpt/gpt-example', 'baze-bridge-claude/claude-example'];
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  let requests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/model' || url.searchParams.get('directory') !== directory ||
      request.headers.authorization !== authorization) {
      response.writeHead(403).end();
      return;
    }
    const unrelated = { providerID: 'other', id: 'gpt-example' };
    const gpt = { providerID: 'baze-bridge-gpt', id: 'gpt-example' };
    const claude = { providerID: 'baze-bridge-claude', id: 'claude-example' };
    const snapshots = [[], [unrelated, claude], [gpt, claude]];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: snapshots[Math.min(requests++, snapshots.length - 1)] }));
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await waitForModels(origin, directory, password, expected, AbortSignal.timeout(5000)), 2);
  assert.equal(requests, 3);
});
