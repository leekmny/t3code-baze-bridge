const hosts = Object.freeze({
  aws: 'https://factchat-cloud.mindlogic.ai',
  ncp: 'https://api.baze.co',
});

export const providerEnv = 'BAZE_API_KEY';

const lanes = {
  'baze-bridge-gpt': { name: 'BAZE Gateway (GPT)', adapter: 'openai/responses', path: '' },
  'baze-bridge-claude': { name: 'BAZE Gateway (Claude)', adapter: 'anthropic', path: '/claude/v1' },
  'baze-bridge-gemini': { name: 'BAZE Gateway (Gemini)', adapter: 'google', path: '/gemini/v1beta' },
  'baze-bridge-chat': { name: 'BAZE Gateway (Other models)', adapter: 'openai-compatible', path: '' },
};

export const providerIds = Object.freeze(Object.keys(lanes));

const CHAT = 'baze-bridge-chat';
const CLAUDE = 'baze-bridge-claude';
const GEMINI = 'baze-bridge-gemini';
const GPT = 'baze-bridge-gpt';
const catalogByteLimit = 2 * 1024 * 1024;
const modalities = new Set(['text', 'image', 'audio', 'video', 'pdf']);
const effortLevels = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const reservedNames = new Set(['__proto__', 'constructor', 'prototype']);

// Mindlogic's OpenCode guide identifies these models for agent tool use.
// The public model list does not generally report function-tool support.
const documentedToolModels = new Set([
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'deepseek-v4-pro',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'grok-4.6',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalidCatalog() {
  return new Error('BAZE returned an invalid model catalog. Configuration was left untouched.');
}

function validId(id, apiKey) {
  return typeof id === 'string' && id.length <= 256 && !id.includes(apiKey)
    && id.split('/').every((segment) => /^[a-z0-9][a-z0-9._-]*$/i.test(segment) && !reservedNames.has(segment));
}

function family(row) {
  const owner = row.owned_by?.toLowerCase();
  const model = row.id.split('/').at(-1).toLowerCase();
  if (owner === 'claude' || owner === 'anthropic' || model.startsWith('claude-')) return CLAUDE;
  if (owner === 'gemini' || model.startsWith('gemini-')) return GEMINI;
  if (owner === 'openai' || /^(gpt-|o[1-9](?:-|$)|codex-)/.test(model)) return GPT;
  return CHAT;
}

function protocol(row, endpoints) {
  if (!endpoints?.length) return family(row);
  const paths = endpoints.map((endpoint) => new URL(endpoint, hosts.aws).pathname);
  if (paths.some((path) => path.startsWith('/v1/gateway/claude/'))) return CLAUDE;
  if (paths.some((path) => path.startsWith('/v1/gateway/gemini/'))) return GEMINI;
  if (paths.some((path) => /^\/v1\/gateway\/responses\/?$/.test(path))) return GPT;

  // A GPT or Claude row that explicitly lists only Chat cannot use its native endpoint.
  const modelFamily = family(row);
  if (modelFamily === GPT || modelFamily === CLAUDE) return undefined;
  if (paths.some((path) => /^\/v1\/gateway\/chat\/completions\/?$/.test(path))) return CHAT;
  return undefined;
}

function parseLimits(row) {
  const limit = {};
  for (const [target, value] of [['context', row.context_limit], ['output', row.max_output_tokens]]) {
    if (value == null) continue;
    if (!Number.isSafeInteger(value) || value <= 0) throw invalidCatalog();
    limit[target] = value;
  }
  return Object.keys(limit).length ? limit : undefined;
}

function parsePricing(pricing) {
  if (pricing == null) return undefined;
  if (!isObject(pricing)) throw invalidCatalog();
  for (const field of ['input', 'output', 'cache_read', 'cache_write', 'audio_input', 'audio_output']) {
    const rate = pricing[field];
    if (rate != null && (!Number.isFinite(rate) || rate < 0)) throw invalidCatalog();
  }
  return pricing;
}

function modelCost(pricing) {
  if (pricing?.input == null || pricing.output == null) return undefined;
  const cost = { input: pricing.input, output: pricing.output };
  const cache = {};
  if (pricing.cache_read != null) cache.read = pricing.cache_read;
  if (pricing.cache_write != null) cache.write = pricing.cache_write;
  if (Object.keys(cache).length) cost.cache = cache;
  return cost;
}

function parseModalities(values) {
  if (values == null) return ['text'];
  if (!Array.isArray(values) || !values.length || values.some((value) => !modalities.has(value))) {
    throw invalidCatalog();
  }
  return [...new Set(values)];
}

function parseCapabilities(row) {
  const explicit = row.capabilities ?? {};
  if (!isObject(explicit) || (explicit.tools != null && typeof explicit.tools !== 'boolean')) {
    throw invalidCatalog();
  }
  return {
    tools: explicit.tools ?? documentedToolModels.has(row.id),
    input: parseModalities(explicit.input),
    output: parseModalities(explicit.output),
  };
}

function modelVariants(reasoning, lane) {
  // An omitted variants property makes OpenCode synthesize default reasoning efforts.
  if (reasoning == null) return [];
  if (!isObject(reasoning) || typeof reasoning.supported !== 'boolean') throw invalidCatalog();
  if (!reasoning.supported || reasoning.effort == null || lane !== GPT) return [];
  if (!Array.isArray(reasoning.effort)
    || reasoning.effort.some((effort) => effort !== 'default' && !effortLevels.has(effort))) {
    throw invalidCatalog();
  }
  return [...new Set(reasoning.effort)].filter((effort) => effort !== 'default')
    .map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }));
}

function modelEntry(row, apiKey, lane, pricing) {
  const name = row.display_name ?? row.name ?? row.id;
  if (typeof name !== 'string' || !name.trim() || name.length > 256
    || /[{}\u0000-\u001f\u007f-\u009f]/u.test(name) || name.includes(apiKey)) {
    throw invalidCatalog();
  }
  const limit = parseLimits(row);
  const cost = modelCost(pricing);
  const capabilities = parseCapabilities(row);
  const variants = modelVariants(row.capabilities?.reasoning, lane);
  return {
    name,
    ...(limit && { limit }),
    ...(cost && { cost }),
    capabilities,
    variants,
  };
}

function buildProviders(body, apiKey, baseURL) {
  if (!isObject(body) || (body.object != null && body.object !== 'list') || !Array.isArray(body.data)) {
    throw invalidCatalog();
  }

  const modelsByLane = new Map();
  const seen = new Set();
  for (const row of body.data) {
    if (!isObject(row) || typeof row.type !== 'string' || !/^[a-z][a-z0-9_]*$/.test(row.type)) {
      throw invalidCatalog();
    }
    if (row.type !== 'llm') continue;
    if (!validId(row.id, apiKey) || seen.has(row.id)) throw invalidCatalog();
    seen.add(row.id);

    const pricing = parsePricing(row.pricing);
    if (pricing?.audio_input != null || pricing?.audio_output != null || /^(?:openai\/)?gpt-audio(?:-|$)/i.test(row.id)) continue;
    if (row.owned_by != null && typeof row.owned_by !== 'string') throw invalidCatalog();
    if (row.endpoints != null && (!Array.isArray(row.endpoints)
      || row.endpoints.some((endpoint) => typeof endpoint !== 'string' || !endpoint.startsWith('/v1/gateway/')))) {
      throw invalidCatalog();
    }

    const lane = protocol(row, row.endpoints);
    if (!lane) continue;
    const models = modelsByLane.get(lane) ?? [];
    models.push([row.id, modelEntry(row, apiKey, lane, pricing)]);
    modelsByLane.set(lane, models);
  }

  if (!modelsByLane.size) throw new Error('The BAZE catalog contains no supported text models for this key.');
  return Object.fromEntries(providerIds.filter((id) => modelsByLane.has(id)).map((id) => {
    const { name, adapter, path } = lanes[id];
    return [id, {
      name,
      env: [providerEnv],
      package: `@opencode/ai/providers/${adapter}`,
      settings: { baseURL: `${baseURL}${path}` },
      models: Object.fromEntries(modelsByLane.get(id).sort(([left], [right]) => (left < right ? -1 : 1))),
    }];
  }));
}

function responseError(status, region) {
  if (status >= 300 && status < 400) return new Error('The BAZE catalog endpoint attempted to redirect.');
  if (status === 401) return new Error(`BAZE did not accept ${providerEnv} for the ${region.toUpperCase()} region.`);
  if (status === 403) return new Error('The BAZE key lacks permission to access this model catalog.');
  if (status === 429) return new Error('The BAZE catalog is rate limited. Try again shortly.');
  return new Error(`The BAZE catalog request failed (HTTP ${status}).`);
}

async function readCatalog(response, signal) {
  if (!response.body) throw invalidCatalog();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > catalogByteLimit) {
        void reader.cancel().catch(() => {});
        throw new Error('Catalog size limit exceeded');
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    if (signal.aborted) throw new Error('The BAZE catalog request timed out.');
    throw invalidCatalog();
  } finally {
    reader.releaseLock();
  }
}

export async function discoverProviders(apiKey, { region = 'aws', fetchImpl = fetch } = {}) {
  if (typeof region !== 'string' || !Object.hasOwn(hosts, region)) {
    throw new Error('Choose an official BAZE region (aws or ncp).');
  }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error(`Set a valid ${providerEnv} before querying the BAZE catalog.`);
  }

  const baseURL = `${hosts[region]}/v1/gateway`;
  const signal = AbortSignal.timeout(15000);
  let response;
  try {
    response = await fetchImpl(`${baseURL}/models/?type=llm`, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      redirect: 'manual',
      signal,
    });
  } catch {
    if (signal.aborted) throw new Error('The BAZE catalog request timed out.');
    throw new Error('Could not reach the BAZE catalog. Check the network and chosen region.');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw responseError(response.status, region);
  }
  const body = await readCatalog(response, signal);
  return buildProviders(body, key, baseURL);
}
