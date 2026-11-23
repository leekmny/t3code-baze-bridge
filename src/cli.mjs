#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { discoverProviders, providerEnv } from './catalog.mjs';
import { inspectConfig, resolveTarget, updateConfig } from './config.mjs';
import { readOpenCodeCatalog } from './opencode.mjs';

const usage = `Usage: t3code-baze-bridge <sync|doctor|restore|remove> [options]

  sync       Discover BAZE models and update managed OpenCode providers.
  doctor     Check the key, OpenCode version and configuration.
  restore    Restore the previous managed catalog.
  remove     Remove the managed providers and their backup.

  --project <directory>          Use the project's opencode.jsonc.
  --region <aws|ncp>             Select the BAZE Gateway region (sync only).
  --dry-run                      Plan model changes without writing (sync only).
  --catalog                      Verify with OpenCode's local model list (doctor only).
  --opencode-executable <path>   Use a specific OpenCode binary (doctor only).
  --help, -h                     Show this help.
  --version                      Show the bridge version.

Set ${providerEnv} in the environment that launches the bridge and OpenCode.
`;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findOpenCode(explicit) {
  if (explicit) return resolve(explicit);
  const windows = process.platform === 'win32';
  const names = windows ? ['opencode.exe', join('node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')] : ['opencode'];
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(directory)) continue;
    const executable = names.map((name) => join(directory, name)).find(isExecutable);
    if (executable) return executable;
  }
}

function runOpenCode(executable, args, cwd, timeout) {
  return spawnSync(executable, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
}

async function doctor(target, options) {
  console.log(`Config: ${target}`);
  if (process.env.OPENCODE_CONFIG || process.env.OPENCODE_CONFIG_CONTENT) {
    console.log('An OpenCode configuration overlay is set. Use --catalog to check the resulting model list.');
  }
  const keyPresent = Boolean(process.env[providerEnv]?.trim());
  console.log(`${providerEnv}: ${keyPresent ? 'present' : 'missing'}`);
  const executable = findOpenCode(options['opencode-executable']);
  const versionResult = executable && runOpenCode(executable, ['--version'], process.cwd(), 5000);
  const version = versionResult?.status === 0 && versionResult.stdout.match(/^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)\s*$/i);
  const compatible = version && Number(version[1]) === 2 && (Number(version[2]) > 0 || Number(version[3]) >= 18);
  console.log(version ? `OpenCode: ${version.slice(1).join('.')} (${compatible ? 'supported' : 'requires 2.0.18 or later in the 2.x series'})` : 'OpenCode: unavailable on PATH or at the specified executable');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const t3Present = ['T3 Code.exe', 'T3 Code (Beta).exe'].some((name) => isExecutable(join(process.env.LOCALAPPDATA, 'Programs', 't3code', name)));
    console.log(`T3 Code desktop: ${t3Present ? 'detected' : 'not detected in the standard per-user install directory'} (the bridge targets the environment host)`);
  }
  const { active, hasBackup } = await inspectConfig(target);
  const expected = Object.entries(active).flatMap(([id, provider]) => Object.keys(provider.models).map((model) => `${id}/${model}`));
  console.log(`Managed providers: ${Object.keys(active).length}; models: ${expected.length}; rollback: ${hasBackup ? 'available' : 'unavailable'}`);
  if (!keyPresent || !compatible || !expected.length) return 1;
  if (!options.catalog) {
    console.log('Use doctor --catalog to check model visibility, then refresh provider status in T3 Code.');
    return 0;
  }
  const visible = await readOpenCodeCatalog(executable, options.project ?? process.cwd(), expected);
  console.log(`OpenCode model visibility: ${visible}/${expected.length}. Refresh provider status in T3 Code.`);
  if (visible !== expected.length) {
    console.log('Check the OpenCode config scope, project or managed overrides, and the process environment.');
    return 1;
  }
  return 0;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      project: { type: 'string' },
      region: { type: 'string' },
      'dry-run': { type: 'boolean' },
      catalog: { type: 'boolean' },
      'opencode-executable': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    } });
  } catch {
    throw new Error('Invalid arguments. Run with --help for usage.');
  }
  const { values, positionals: [operation, ...extra] } = parsed;
  if (values.version) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
    return 0;
  }
  if (values.help || process.argv.length < 3) {
    console.log(usage.trimEnd());
    return 0;
  }
  if (extra.length || !['sync', 'doctor', 'restore', 'remove'].includes(operation) ||
    (operation !== 'sync' && (values.region !== undefined || values['dry-run'])) ||
    (operation !== 'doctor' && (values.catalog || values['opencode-executable'] !== undefined))) {
    throw new Error('Invalid command or options. Run with --help for usage.');
  }
  if (values.project !== undefined) {
    const directory = values.project && await stat(values.project).catch(() => null);
    if (!directory?.isDirectory()) throw new Error('--project must identify an existing directory.');
    values.project = resolve(values.project);
  }
  const target = resolveTarget(values);
  if (operation === 'doctor') return doctor(target, values);
  if (operation === 'sync') {
    const key = process.env[providerEnv]?.trim();
    if (!key) throw new Error(`Set ${providerEnv} before synchronizing.`);
    await inspectConfig(target);
    const providers = await discoverProviders(key, { region: values.region });
    const count = Object.values(providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
    if (values['dry-run']) {
      console.log(`Discovered ${count} BAZE models for ${target}. No files written.`);
      return 0;
    }
    const changed = await updateConfig(target, operation, providers);
    console.log(`${changed ? 'Synchronized' : 'Already synchronized'} ${count} BAZE models in ${target}.`);
    return 0;
  }
  const changed = await updateConfig(target, operation);
  console.log(changed ? `Bridge configuration updated in ${target}.` : 'No managed configuration to change.');
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = error.code ? `Unable to access the configuration (${error.code}).` : error.message;
  console.error(message);
  process.exitCode = 1;
}
