import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyEdits, createScanner, getNodeValue, modify, parseTree, SyntaxKind } from 'jsonc-parser';
import { providerIds } from './catalog.mjs';

const marker = '// t3code-baze-bridge: ';
const maxBytes = 12 * 1024 * 1024;

export function resolveTarget({ project, env = process.env } = {}) {
  const directory = project ?? (env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode'));
  return resolve(directory, 'opencode.jsonc');
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateUniqueKeys(node) {
  if (node.type === 'object') {
    const keys = new Set();
    for (const property of node.children) {
      const [key, value] = property.children;
      if (keys.has(key.value)) throw new Error('OpenCode config contains duplicate keys. Fix it before continuing.');
      keys.add(key.value);
      validateUniqueKeys(value);
    }
  }
  if (node.type === 'array') node.children.forEach(validateUniqueKeys);
}

function parseConfig(source) {
  const errors = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== 'object') throw new Error('OpenCode config is not a valid JSONC object. Fix it before continuing.');
  validateUniqueKeys(tree);
  const config = getNodeValue(tree);
  for (const key of ['providers', 'provider']) {
    if (Object.hasOwn(config, key) && !isRecord(config[key])) throw new Error(`OpenCode ${key} must be an object.`);
  }
  return { tree, config };
}

async function readConfig(file) {
  const stat = await lstat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!stat) return { bytes: null, source: '{}\n', mode: 0o600, bom: '' };
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('OpenCode config must be a regular file without links.');
  if (stat.size > maxBytes) throw new Error('OpenCode config exceeds the supported size.');
  const bytes = await readFile(file);
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\ufeff' : '';
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('OpenCode config must use UTF-8.');
  }
  return { bytes, source, mode: stat.mode & 0o777, bom };
}

function readManaged(source, config) {
  const firstLine = source.split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith(marker)) return { current: {}, previous: null, source };
  let metadata;
  try {
    metadata = JSON.parse(firstLine.slice(marker.length));
  } catch {
    throw new Error('Bridge backup metadata is malformed.');
  }
  if (metadata?.version !== 1 || !Array.isArray(metadata.ids) || !metadata.ids.length ||
    new Set(metadata.ids).size !== metadata.ids.length || metadata.ids.some((id) => !providerIds.includes(id)) ||
    (metadata.previous !== null && (!isRecord(metadata.previous) ||
      Object.keys(metadata.previous).some((id) => !providerIds.includes(id))))) {
    throw new Error('Bridge backup metadata is malformed.');
  }
  const current = Object.fromEntries(metadata.ids.map((id) => [id, config.providers?.[id]]));
  if (Object.values(current).some((provider) => !isRecord(provider)) || digest(current) !== metadata.sha256) {
    throw new Error('Managed provider entries were edited. Restore the managed entries before using the bridge.');
  }
  return { current, previous: metadata.previous, source: source.slice(source.indexOf('\n') + 1) };
}

function checkCollisions(config, current = {}) {
  for (const id of providerIds) {
    if (Object.hasOwn(config.provider ?? {}, id) ||
      (Object.hasOwn(config.providers ?? {}, id) && !Object.hasOwn(current, id))) {
      throw new Error(`Reserved provider ID ${id} is already configured outside the bridge.`);
    }
  }
}

export async function inspectConfig(target) {
  const file = await readConfig(target);
  const { config } = parseConfig(file.source);
  const { current, previous } = readManaged(file.source, config);
  checkCollisions(config, current);
  const sibling = await readConfig(join(dirname(target), 'opencode.json'));
  checkCollisions(parseConfig(sibling.source).config);
  return { active: JSON.parse(JSON.stringify(current)), hasBackup: previous !== null };
}

// Remove the property and one comma while leaving neighboring JSONC comments intact.
function removeProvider(source, id) {
  const { tree } = parseConfig(source);
  const providers = tree.children.find((property) => property.children[0].value === 'providers').children[1];
  const index = providers.children.findIndex((property) => property.children[0].value === id);
  const property = providers.children[index];
  const end = property.offset + property.length;
  const scanner = createScanner(source, true);
  scanner.setPosition(end);
  let comma = scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : -1;
  if (comma === -1 && index > 0) {
    const previous = providers.children[index - 1];
    scanner.setPosition(previous.offset + previous.length);
    if (scanner.scan() === SyntaxKind.CommaToken) comma = scanner.getTokenOffset();
  }
  const edits = [{ offset: property.offset, length: property.length, content: '' }];
  if (comma !== -1) edits.push({ offset: comma, length: 1, content: '' });
  return applyEdits(source, edits);
}

function editManaged(managed, next, backup) {
  let { source } = managed;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  for (const id of Object.keys(managed.current)) {
    if (!Object.hasOwn(next, id)) source = removeProvider(source, id);
  }
  for (const [id, value] of Object.entries(next)) {
    if (JSON.stringify(managed.current[id]) === JSON.stringify(value)) continue;
    const edits = modify(source, ['providers', id], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } });
    source = applyEdits(source, edits);
  }
  const ids = Object.keys(next);
  if (!ids.length) return source;
  const record = { version: 1, ids, sha256: digest(next), previous: backup };
  return `${marker}${JSON.stringify(record)}${eol}${source}`;
}

async function removeIfPresent(path) {
  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function copyWindowsAccessRules(source, target) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('Windows could not locate the access-control tools.');
  const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `
$ErrorActionPreference = 'Stop'
$access = [System.Security.AccessControl.AccessControlSections]::Access
$sourceAcl = Get-Acl -LiteralPath $env:BAZE_BRIDGE_ACL_SOURCE
$targetAcl = Get-Acl -LiteralPath $env:BAZE_BRIDGE_ACL_TARGET
$targetAcl.SetSecurityDescriptorSddlForm($sourceAcl.GetSecurityDescriptorSddlForm($access), $access)
Set-Acl -LiteralPath $env:BAZE_BRIDGE_ACL_TARGET -AclObject $targetAcl
`;
  try {
    execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { SystemRoot: systemRoot, BAZE_BRIDGE_ACL_SOURCE: source, BAZE_BRIDGE_ACL_TARGET: target },
      stdio: 'ignore',
      timeout: 10000,
      windowsHide: true,
    });
  } catch {
    throw new Error('Could not preserve the existing OpenCode configuration access rules.');
  }
}

async function atomicWrite(target, original, source) {
  const temp = `${target}.${randomUUID()}.t3code-baze-bridge.tmp`;
  const bytes = Buffer.from(original.bom + source, 'utf8');
  if (bytes.length > maxBytes) throw new Error('Updated OpenCode config exceeds the supported size.');
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      if (original.bytes && process.platform === 'win32') copyWindowsAccessRules(target, temp);
      if (original.bytes && process.platform !== 'win32') await file.chmod(original.mode);
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const current = await readConfig(target);
    if (original.bytes === null && current.bytes === null) {
      await link(temp, target);
    } else if (original.bytes && current.bytes && current.mode === original.mode && original.bytes.equals(current.bytes)) {
      await rename(temp, target);
    } else {
      throw new Error('OpenCode config changed during this operation. Retry with current settings.');
    }
  } finally {
    await removeIfPresent(temp);
  }
}

export async function updateConfig(target, operation, providers) {
  if (!['sync', 'restore', 'remove'].includes(operation)) throw new Error('Unknown config operation.');
  if (operation === 'sync' && (!isRecord(providers) || !Object.keys(providers).length ||
    Object.keys(providers).some((id) => !providerIds.includes(id)))) throw new Error('No usable BAZE providers to synchronize.');
  const directory = dirname(target);
  if (operation === 'sync') await mkdir(directory, { recursive: true });
  const parent = await realpath(directory).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!parent) return false;
  target = join(parent, 'opencode.jsonc');
  const lockPath = `${target}.t3code-baze-bridge.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('OpenCode config is locked by another bridge operation.');
    throw error;
  });
  try {
    const original = await readConfig(target);
    const { config } = parseConfig(original.source);
    const managed = readManaged(original.source, config);
    if (operation !== 'remove') {
      checkCollisions(config, managed.current);
      const sibling = await readConfig(join(parent, 'opencode.json'));
      checkCollisions(parseConfig(sibling.source).config);
    }
    if (operation === 'restore' && managed.previous === null) return false;
    const next = operation === 'sync' ? providers : operation === 'restore' ? managed.previous : {};
    if (digest(managed.current) === digest(next)) return false;
    const backup = operation === 'sync' && Object.keys(managed.current).length ? managed.current : null;
    const edited = editManaged(managed, next, backup);
    readManaged(edited, parseConfig(edited).config);
    await atomicWrite(target, original, edited);
    return true;
  } finally {
    await lock.close();
    await removeIfPresent(lockPath);
  }
}
