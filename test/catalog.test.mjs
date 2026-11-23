import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverProviders } from '../src/catalog.mjs';

const key = 'synthetic-catalog-test-key';

async function discover(rows, options = {}) {
  return discoverProviders(key, {
    fetchImpl: async () => Response.json({ object: 'list', data: rows }),
    ...options,
  });
}

test('uses the selected official model endpoint with no redirects or credential in the URL', async () => {
  await discover([], {
    region: 'ncp',
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://api.baze.co/v1/gateway/models/?type=llm');
      assert.equal(options.redirect, 'manual');
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${key}`);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ data: [{ type: 'llm', id: 'other-model' }] });
    },
  });
});

test('uses the native protocol for each advertised endpoint and preserves model IDs', async () => {
  const providers = await discover([
    { type: 'llm', id: 'custom-gpt', endpoints: ['/v1/gateway/responses/'] },
    { type: 'llm', id: 'custom-claude', endpoints: ['/v1/gateway/claude/v1/messages'] },
    { type: 'llm', id: 'custom-gemini', endpoints: ['/v1/gateway/gemini/v1beta/models/custom-gemini:generateContent'] },
    { type: 'llm', id: 'google/gemma-4-31B-it', endpoints: ['/v1/gateway/chat/completions/'] },
  ]);
  const expected = {
    'baze-bridge-gpt': ['openai/responses', '', 'custom-gpt'],
    'baze-bridge-claude': ['anthropic', '/claude/v1', 'custom-claude'],
    'baze-bridge-gemini': ['google', '/gemini/v1beta', 'custom-gemini'],
    'baze-bridge-chat': ['openai-compatible', '', 'google/gemma-4-31B-it'],
  };
  for (const [id, [adapter, path, model]] of Object.entries(expected)) {
    assert.equal(providers[id].package, `@opencode/ai/providers/${adapter}`);
    assert.equal(providers[id].settings.baseURL, `https://factchat-cloud.mindlogic.ai/v1/gateway${path}`);
    assert.deepEqual(providers[id].env, ['BAZE_API_KEY']);
    assert.deepEqual(Object.keys(providers[id].models), [model]);
  }
  assert.doesNotMatch(JSON.stringify(providers), new RegExp(key));
});

test('falls back to model family for older catalogs and excludes audio-only and non-chat rows', async () => {
  const providers = await discover([
    { type: 'llm', id: 'gpt-6.1-sol', owned_by: 'openai' },
    { type: 'llm', id: 'claude-opus-5', owned_by: 'claude' },
    { type: 'llm', id: 'gemini-4-neon', owned_by: 'gemini' },
    { type: 'llm', id: 'deepseek-v4-pro', owned_by: 'deepseek' },
    { type: 'llm', id: 'gpt-audio-1.5', pricing: { audio_output: 64 } },
    { type: 'llm', id: 'gpt-audio-next' },
    { type: 'image', id: 'gpt-image-1' },
  ]);
  assert.deepEqual(Object.keys(providers['baze-bridge-gpt'].models), ['gpt-6.1-sol']);
  assert.deepEqual(Object.keys(providers['baze-bridge-claude'].models), ['claude-opus-5']);
  assert.deepEqual(Object.keys(providers['baze-bridge-gemini'].models), ['gemini-4-neon']);
  assert.deepEqual(Object.keys(providers['baze-bridge-chat'].models), ['deepseek-v4-pro']);
});

test('does not publish GPT or Claude in the Chat provider when only Chat is advertised', async () => {
  const providers = await discover([
    { type: 'llm', id: 'gpt-6.1-sol', endpoints: ['/v1/gateway/chat/completions/'] },
    { type: 'llm', id: 'claude-opus-5', endpoints: ['/v1/gateway/chat/completions/'] },
    { type: 'llm', id: 'deepseek-v4-pro', endpoints: ['/v1/gateway/chat/completions/'] },
  ]);
  assert.deepEqual(Object.keys(providers), ['baze-bridge-chat']);
  assert.deepEqual(Object.keys(providers['baze-bridge-chat'].models), ['deepseek-v4-pro']);
});

test('maps safe metadata without inventing support for unknown models', async () => {
  const providers = await discover([
    {
      type: 'llm', id: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol',
      context_limit: 1050000, max_output_tokens: 65536,
      pricing: { input: 3, output: 15, cache_read: 0.3, cache_write: null },
    },
    { type: 'llm', id: 'unlisted-model', context_limit: 12000 },
  ]);
  assert.deepEqual(providers['baze-bridge-gpt'].models['gpt-6.1-sol'], {
    name: 'GPT-6.1 Sol',
    limit: { context: 1050000, output: 65536 },
    cost: { input: 3, output: 15, cache: { read: 0.3 } },
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [],
  });
  assert.deepEqual(providers['baze-bridge-chat'].models['unlisted-model'], {
    name: 'unlisted-model',
    limit: { context: 12000 },
    capabilities: { tools: false, input: ['text'], output: ['text'] },
    variants: [],
  });
});

test('preserves model-specific modalities, tools and reasoning variants when the catalog supplies them', async () => {
  const providers = await discover([{
    type: 'llm', id: 'gpt-next',
    capabilities: {
      tools: false, input: ['text', 'image'], output: ['text'],
      reasoning: { supported: true, effort: ['low', 'high'] },
    },
  }]);
  const model = providers['baze-bridge-gpt'].models['gpt-next'];
  assert.deepEqual(model.capabilities, { tools: false, input: ['text', 'image'], output: ['text'] });
  assert.deepEqual(model.variants, [
    { id: 'low', settings: { reasoningEffort: 'low' } },
    { id: 'high', settings: { reasoningEffort: 'high' } },
  ]);
});

test('keeps provider snapshots stable when the Gateway reorders the catalog', async () => {
  const rows = [
    { type: 'llm', id: 'z-model' },
    { type: 'llm', id: 'gpt-6.1-sol' },
    { type: 'llm', id: 'a-model' },
    { type: 'llm', id: 'gpt-6-astra' },
  ];
  const providers = await discover(rows);
  assert.deepEqual(Object.keys(providers['baze-bridge-chat'].models), ['a-model', 'z-model']);
  assert.deepEqual(Object.keys(providers['baze-bridge-gpt'].models), ['gpt-6-astra', 'gpt-6.1-sol']);
  assert.equal(JSON.stringify(providers), JSON.stringify(await discover(rows.toReversed())));
});

test('rejects malformed, duplicate, unsafe, and empty catalogs', async (t) => {
  const valid = { type: 'llm', id: 'valid' };
  const cases = [
    ['wrong top level', { data: {} }],
    ['empty result', { data: [] }],
    ['duplicate model IDs', { data: [valid, valid] }],
    ['unknown row type shape', { data: [{ id: 'missing-type' }] }],
    ['unsafe model ID', { data: [{ ...valid, id: '__proto__' }] }],
    ['unsafe nested model ID', { data: [{ ...valid, id: 'provider/constructor' }] }],
    ['configuration interpolation', { data: [{ ...valid, display_name: '{file:credential-path}' }] }],
    ['credential in display metadata', { data: [{ ...valid, display_name: key }] }],
    ['invalid token limit', { data: [{ ...valid, context_limit: -1 }] }],
    ['invalid endpoint metadata', { data: [{ ...valid, endpoints: [null] }] }],
  ];
  for (const [description, body] of cases) {
    await t.test(description, async () => {
      await assert.rejects(discover([], { fetchImpl: async () => Response.json(body) }), (error) => {
        assert.match(error.message, /catalog/i);
        assert.doesNotMatch(error.message, new RegExp(key));
        return true;
      });
    });
  }
});

test('accepts only configured BAZE regions and rejects missing credentials before network activity', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; };
  await assert.rejects(discoverProviders(key, { region: 'https://other.example', fetchImpl }), /region/i);
  await assert.rejects(discoverProviders(key, { region: 'constructor', fetchImpl }), /region/i);
  await assert.rejects(discoverProviders('', { fetchImpl }), /BAZE_API_KEY/);
  assert.equal(requests, 0);
});

test('reports catalog failures by status without reproducing the upstream body or exception', async () => {
  for (const [status, message] of [[302, /redirect/i], [401, /credential|key/i], [403, /permission|access/i], [429, /rate|try again/i], [503, /503/]]) {
    await assert.rejects(discover([], { fetchImpl: async () => new Response(key, { status }) }), (error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, new RegExp(key));
      return true;
    });
  }
  await assert.rejects(discover([], { fetchImpl: async () => { throw new Error(key); } }), (error) => {
    assert.match(error.message, /reach|network/i);
    assert.doesNotMatch(error.stack, new RegExp(key));
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(discover([], { fetchImpl: async () => new Response(`invalid JSON ${key}`) }), (error) => {
    assert.match(error.message, /catalog/i);
    assert.doesNotMatch(error.message, new RegExp(key));
    return true;
  });
});
