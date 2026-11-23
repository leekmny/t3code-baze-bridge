# T3 Code BAZE Bridge

Use BAZE Gateway models in T3 Code through the existing OpenCode provider. The bridge fetches your account's available models and updates OpenCode's JSONC configuration. T3 Code and OpenCode handle sessions and requests directly.

**T3 Code → OpenCode 2 → BAZE Gateway**

This independent community project is unaffiliated with T3 Code, OpenCode and Mindlogic.

## Requirements

- Node.js 22 or later and npm on the machine running the T3 Code environment.
- A T3 Code build with OpenCode 2 support and OpenCode 2.0.18 or later in the 2.x series. If no OpenCode is installed, run `npm.cmd install --global @opencode/cli` on Windows. Read the migration guide before upgrading an existing 1.x installation. [T3 Code provider guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-opencode.md) · [OpenCode migration](https://opencode.ai/docs/migrate-v1/)
- A BAZE Gateway API key available as `BAZE_API_KEY` in the bridge and OpenCode processes. [BAZE authentication](https://docs.mindlogic.ai/docs/general/api-gateway/getting-started/authentication)

## Install and connect

From a checkout, run these commands from the repository directory.

```powershell
npm.cmd ci --ignore-scripts
node src/cli.mjs --help
```

For a packaged install, download `t3code-baze-bridge-0.1.0.tgz` from the release when available. Run `npm.cmd install --global --ignore-scripts .\t3code-baze-bridge-0.1.0.tgz`, then use `t3code-baze-bridge.cmd` in place of `node src/cli.mjs`. On macOS and Linux, use `npm` and `t3code-baze-bridge` without the `.cmd` suffix.

In PowerShell, enter the key with a masked prompt. The environment assignment applies to this PowerShell process and programs it starts.

```powershell
$bazeKey = Read-Host 'BAZE API key' -AsSecureString
$env:BAZE_API_KEY = [System.Net.NetworkCredential]::new('', $bazeKey).Password
Remove-Variable bazeKey
node src/cli.mjs sync --dry-run
node src/cli.mjs sync
node src/cli.mjs doctor --catalog
```

For the NCP region, append `--region ncp` to every `sync` command. To scope the configuration to one project, add `--project 'path\to\project'` to each command. The default target is `~/.config/opencode/opencode.jsonc`. It follows `OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME` when set.

In **Settings → Providers**, enable OpenCode and choose **Refresh provider status**. With **Server URL** empty, OpenCode is started by the T3 Code environment host and inherits its environment. If you set `BAZE_API_KEY` in a new shell, gracefully close the existing local T3 Code instance and launch it from that shell. For a remote environment or existing OpenCode server, configure the key and run the bridge on the server host using the same runtime account. Restart or reload that server when appropriate.

Look for **BAZE Gateway** entries in the OpenCode model picker. For a project-only configuration, open the picker in that project. T3 Code documents that its local helper can cache config changes. Wait 30 seconds without generation or model refreshes before refreshing again. [OpenCode in T3 Code](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-opencode.md#refresh-models-commands-and-skills)

## Update and recover

```powershell
node src/cli.mjs sync
node src/cli.mjs doctor
node src/cli.mjs restore
node src/cli.mjs remove
```

`sync` uses the official model list endpoint and is safe to repeat. It never makes a model inference request. `doctor --catalog` starts a temporary loopback OpenCode server and checks the same local model endpoint that T3 Code reads. It can load normal OpenCode plugins and use OpenCode's data directory. For an already running external server, verify visibility in that server's T3 Code environment as well.

The bridge changes only its reserved `baze-bridge-*` entries in `opencode.jsonc`. It preserves unrelated settings, reads the sibling `opencode.json` for ID collisions, and excludes the API key from generated entries. A JSONC comment stores ownership information and a backup of the previous managed entries. `restore` consumes that backup while preserving newer unrelated edits. `remove` deletes the managed entries and the backup comment. The configuration file can remain after removal.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| API key missing or rejected | Set `BAZE_API_KEY` in the correct process and use the region that issued the key. |
| `doctor` cannot find OpenCode | Put the executable or its npm installation on `PATH`, or run `doctor --opencode-executable <path-to-binary>`. |
| Catalog is visible locally but missing in T3 Code | Confirm the T3 Code environment has the same key, config scope and OpenCode binary. Refresh after the local helper has idled. An external server can require a separate reload. |
| Some models are absent | BAZE access is account-specific. The bridge skips audio-only and non-LLM rows and models whose advertised routes cannot be mapped to a supported protocol. A managed OpenCode policy can also affect visibility. |
| Tools are unavailable for a model | The bridge uses model-specific metadata or documented tool compatibility when available. Other models are configured conservatively. |
| File or provider collision | Correct malformed or duplicate JSONC keys and resolve pre-existing uses of a reserved ID before running `sync`. Keep the bridge header and managed entries together. |
| Bridge lock remains after an interrupted run | Check that no bridge invocation is active. Then remove only the `opencode.jsonc.t3code-baze-bridge.lock` file next to the configuration and rerun. |

The bridge uses the Gateway's catalog metadata when available. It routes GPT through Responses, Claude through Messages, Gemini through the native Gemini API, and other compatible models through Chat Completions. Limits and supported capabilities depend on the model data returned by Gateway. [BAZE models](https://docs.mindlogic.ai/docs/general/api-gateway/getting-started/models) · [OpenCode custom providers](https://opencode.ai/docs/providers/#packages)

## Development and packaging

```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd pack --ignore-scripts
```

Tests mock Gateway responses and use temporary configuration files. They do not require credentials. The versioned npm tarball can be installed locally without publishing to the npm registry. See [CHANGELOG.md](CHANGELOG.md) for release notes and [NOTICE.md](NOTICE.md) for acknowledgements.
