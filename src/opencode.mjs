import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

function waitForListener(child, signal) {
  return new Promise((resolve, reject) => {
    let output = '';
    const failed = () => reject(new Error('The temporary OpenCode server could not start.'));
    child.once('error', failed);
    child.once('close', failed);
    signal.addEventListener('abort', failed, { once: true });
    const onData = (chunk) => {
      output += chunk;
      const match = /^server listening on (http:\/\/127\.0\.0\.1:[1-9]\d{0,4})\r?\n/m.exec(output);
      if (match) {
        child.stdout.off('data', onData);
        child.stdout.resume();
        resolve(match[1]);
      } else if (output.length > 16384) {
        failed();
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
  });
}

export async function waitForModels(baseURL, directory, password, expected, signal) {
  const url = new URL('/api/model', baseURL);
  url.searchParams.set('directory', directory);
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const deadline = Date.now() + 8000;
  while (true) {
    const response = await fetch(url, { headers: { authorization }, redirect: 'error', signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error('OpenCode rejected the local model catalog request.');
    }
    const { data } = await response.json();
    if (!Array.isArray(data)) throw new Error('OpenCode returned an invalid model catalog.');
    const available = new Set(data.map(({ providerID, id }) => `${providerID}/${id}`));
    const visible = expected.filter((model) => available.has(model)).length;
    if (visible === expected.length || Date.now() >= deadline) return visible;
    // A newly started server can return an empty catalog while loading providers.
    await delay(400, undefined, { signal });
  }
}

export async function readOpenCodeCatalog(executable, directory, expected) {
  const password = randomBytes(24).toString('hex');
  const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: directory,
    env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: undefined },
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const signal = AbortSignal.timeout(18000);
  try {
    const url = await waitForListener(child, signal);
    return await waitForModels(url, directory, password, expected, signal);
  } catch {
    throw new Error('OpenCode could not list its models from a temporary local server. Check OpenCode and its configuration.');
  } finally {
    child.kill();
    child.stdout.destroy();
    const escalation = setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    try {
      await closed;
    } finally {
      clearTimeout(escalation);
    }
  }
}
