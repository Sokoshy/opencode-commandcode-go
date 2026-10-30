# Command Code Go in OpenCode — provider + local bridge

**English** · [Français](README.fr.md)

This repository contains a two-part proof of concept:

```text
OpenCode 2.2.x
  └── "commandcode-go" provider          (plugin.ts, catalog copied from models.dev)
        └── @opencode/ai/providers/openai-compatible
              └── http://127.0.0.1:<port>/v1/chat/completions
                    └── bridge started by the plugin
                          └── POST https://api.commandcode.ai/alpha/generate
```

- `plugin.ts`: adds the `commandcode-go` provider, copies the models from the `commandcode` provider in `models.dev`, and starts the bridge **inside the OpenCode process**.
- `proxy.mjs`: the OpenAI ↔ `/alpha/generate` bridge. It is imported by the plugin and can also be started on its own for debugging.
- `proxy.test.mjs`: tests for the conversions and the stream, against a fake Command Code server.

Repository: <https://github.com/Sokoshy/opencode-commandcode-go>.

## Warning

This setup is **unofficial**. Command Code's Go plan does not include Provider API access, `/alpha/generate` is the CLI's internal transport, and the terms of service prohibit reverse engineering and access sharing. The bridge bypasses neither quotas nor Go plan entitlements. Keep it local and experimental; do not distribute it.

## Quick start — automatic mode

You only need your Command Code API key (the same one you use with Pi). There is no `proxy.mjs` to start and no local token to manage.

### 1. Install the plugin

#### With `opencode plugin add` (recommended)

The GitHub repository installs directly:

```bash
opencode plugin add github:Sokoshy/opencode-commandcode-go
```

The command installs the plugin and adds it to the **global** configuration (`~/.config/opencode/opencode.json` on Linux). Automatic mode reads `CMD_API_KEY`, so there is nothing else to configure when the variable is exported.

To keep the key in the configuration instead of the environment, replace the added entry with its object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:Sokoshy/opencode-commandcode-go",
      "options": {
        "apiKey": "{env:CMD_API_KEY}"
      }
    }
  ]
}
```

`{env:CMD_API_KEY}` keeps the key out of the file in plain text. You can also put the key directly in `apiKey`, or omit the option and export `CMD_API_KEY` / `COMMAND_CODE_API_KEY` before starting OpenCode.

Update or uninstall:

```bash
opencode plugin update github:Sokoshy/opencode-commandcode-go
opencode plugin remove github:Sokoshy/opencode-commandcode-go
```

After installing, restart OpenCode — or run `opencode service restart` if you use the background service — so the plugin loads.

#### From Git / GitHub at a specific revision

`opencode plugin add` accepts npm-compatible Git specifiers:

```bash
# branch
opencode plugin add 'github:Sokoshy/opencode-commandcode-go#main'

# tag or full commit
opencode plugin add 'github:Sokoshy/opencode-commandcode-go#<tag-or-commit>'

# HTTPS
opencode plugin add 'git+https://github.com/Sokoshy/opencode-commandcode-go.git#main'

# SSH (private repository or an already configured key)
opencode plugin add 'git+ssh://git@github.com/Sokoshy/opencode-commandcode-go.git#main'
```

A branch or tag is re-checked by `opencode plugin update`; a full commit stays pinned. The same specifiers can be written by hand in `plugins`.

#### From a local directory

`opencode plugin add` rejects local paths. To develop or test a local copy, point directly at the **directory** in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/commandcode",
      "options": {
        "apiKey": "{env:CMD_API_KEY}"
      }
    }
  ]
}
```

The plugin imports `proxy.mjs`: point at the **whole directory**, not just `plugin.ts`. Replace `/absolute/path/to/commandcode` with the real path of the directory.

### 2. Start OpenCode

```bash
export CMD_API_KEY='your-Command-Code-API-key'
opencode --standalone
```

The plugin starts a local bridge on an ephemeral port, generates a random local token, and configures the provider by itself. No other process needs to stay open.

Verification:

```bash
opencode --standalone models | grep '^commandcode-go/'
```

Expected: `71` models with the `models.dev` catalog from 2026-10-29. The count depends on the catalog.

Then pick a `commandcode-go/*` model in the TUI, or run:

```bash
opencode --standalone run \
  -m commandcode-go/claude-haiku-4-5-20251001 \
  "Answer with just: ok"
```

If the model is not included in the Go plan, the `403 upgrade_required` error surfaces in OpenCode; try another model.

### If OpenCode runs as a background service

The service must see `CMD_API_KEY`. For testing, `opencode --standalone` is the simplest. Otherwise:

```bash
opencode service stop
export CMD_API_KEY='your-Command-Code-API-key'
opencode service start
```

## Plugin options

| Option | Purpose |
|---|---|
| `apiKey` | Your Command Code API key. When absent, the plugin reads `CMD_API_KEY`, then `COMMAND_CODE_API_KEY`. |
| `apiBase` | Upstream base URL, defaults to `https://api.commandcode.ai`. Useful for a mock. |
| `url` | Forces the use of an **external** bridge instead of the internal one. |
| `token` | External bridge token, used only with `url`. |

## Manual mode — separate bridge

Useful for debugging or if you want to isolate the bridge from OpenCode.

```bash
export CMD_API_KEY='your-Command-Code-API-key'
export COMMANDCODE_GO_BRIDGE_TOKEN='a-long-local-secret'
node proxy.mjs
```

Then in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/commandcode",
      "options": {
        "url": "http://127.0.0.1:8787/v1",
        "token": "a-long-local-secret"
      }
    }
  ]
}
```

The plugin token and the bridge token must match. In this mode, `plugin.ts` does not start an internal bridge.

## Bridge environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CMD_API_KEY` / `COMMAND_CODE_API_KEY` | — | Command Code key. Read by the plugin in automatic mode and by `proxy.mjs` in manual mode. |
| `COMMANDCODE_GO_BRIDGE_TOKEN` | — | Token for the **external** bridge only. |
| `COMMANDCODE_GO_BRIDGE_URL` | — | Forces an external bridge (equivalent to the `url` option). |
| `COMMANDCODE_GO_API_BASE` | `https://api.commandcode.ai` | Upstream base URL, in both modes. |
| `COMMANDCODE_GO_HOST` | `127.0.0.1` | Listen address for `proxy.mjs` in manual mode. |
| `COMMANDCODE_GO_PORT` | `8787` | Port for `proxy.mjs` in manual mode. The internal bridge uses an ephemeral port. |
| `COMMANDCODE_GO_CLI_VERSION` | `1.88.0` | `x-command-code-version` header. |
| `COMMANDCODE_GO_MAX_TOKENS` | `64000` | `max_tokens` cap. |
| `COMMANDCODE_GO_TIMEOUT_MS` | `900000` | Total timeout for the upstream request. |
| `COMMANDCODE_GO_WORKDIR` | `process.cwd()` | Fallback `config.workingDir`. In normal use, the plugin passes the directory of its location (the project). |

## Tests

```bash
node --test proxy.test.mjs
```

The tests cover:

- system / user / assistant / tool / tool-result conversion;
- synthesis of a missing result for an interrupted tool call;
- deterministic truncation of tool identifiers to 64 characters;
- images as data URLs;
- a full SSE stream with text, reasoning, a tool call, `finish_reason`, and usage;
- rejection without a local token.

Automatic mode was validated end to end against a fake `/alpha/generate` server: OpenCode 2.2.x → plugin → internal bridge → SSE. No test with a real Go key has been done in this repository.

## Known limitations

- **Every** model in the `commandcode` catalog is copied, including those the Go plan does not cover. A `403 upgrade_required` error then surfaces in OpenCode. There is no public list of Go models.
- The bridge only handles `stream: true`.
- Images must be `data:<mime>;base64,...` data URLs. HTTP URLs are not fetched.
- Reasoning is forwarded as `reasoning_content`; Anthropic-specific reasoning variants are removed from the catalog copy.
- `threadId` is derived from the OpenCode session (`x-opencode-session`) to keep a stable thread. Without a session, a random UUID is generated per request.
- The `x-command-code-version` header is pinned. A CLI change can break the bridge; there is no SLA.
- In automatic mode, the API key is held by the OpenCode process. Prefer `{env:CMD_API_KEY}` over a key written in plain text in `opencode.jsonc`.
- The internal bridge listens only on `127.0.0.1`, with a random token per process.
- OpenCode's title generation may pick another model from the provider (observed: `gpt-6-luna`); if that model is not included in Go, only title generation fails.

## Troubleshooting

- `commandcode-go` missing from `opencode models`: the API key is missing, the plugin is not loaded, or the `commandcode` catalog is not available yet.
- `401 Invalid bridge token`: manual mode only; the plugin token and the bridge token differ.
- `403 upgrade_required`: the model is not included in the Go plan.
- `502`: the bridge cannot reach Command Code, or the endpoint changed.
- `Command Code stream ended before the finish event`: truncated upstream stream or incompatible CLI version.
- When in doubt, run `opencode --standalone --print-logs models` and look for `[commandcode-go]`.

## Files

- `plugin.ts` — OpenCode provider + internal bridge startup.
- `proxy.mjs` — OpenAI ↔ `/alpha/generate` bridge, importable or runnable on its own.
- `proxy.test.mjs` — tests.
- `package.json` — entry point and metadata for `opencode plugin add`, Git, or directory installs.
- `ETUDE-FAISABILITE-COMMANDCODE-OPENCODE.md` — full feasibility study and contractual warnings (in French).
- `README.fr.md` — French version of this document.
