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

You only need your Command Code API key (the same one you use with Pi). No proxy to start and no key in the configuration: OpenCode asks for it through `/connect`.

### 1. Install the plugin

#### With `opencode plugin add` (recommended)

The GitHub repository installs directly:

```bash
opencode plugin add github:Sokoshy/opencode-commandcode-go
```

The command installs the plugin and adds it to the **global** configuration (`~/.config/opencode/opencode.json` on Linux). The entry is just the package string; no options are required:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:Sokoshy/opencode-commandcode-go"
  ]
}
```

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
    "/absolute/path/to/commandcode"
  ]
}
```

The plugin imports `proxy.mjs`: point at the **whole directory**, not just `plugin.ts`. Replace `/absolute/path/to/commandcode` with the real path of the directory.

### 2. Connect Command Code Go

Start OpenCode:

```bash
opencode --standalone
```

The plugin starts a local bridge on an ephemeral port and registers the **Command Code Go** provider. Connect it like any other provider:

```text
/connect
# Select Command Code Go, then paste your Command Code API key.
/models
# Select a commandcode-go/* model.
```

Or use the CLI:

```bash
opencode auth login commandcode-go --method key
opencode run \
  -m commandcode-go/claude-haiku-4-5-20251001 \
  "Answer with just: ok"
```

The key is stored in OpenCode's credential store. It is not written to `opencode.jsonc` and does not need to be exported in the environment.

Verification:

```bash
opencode --standalone models | grep '^commandcode-go/'
```

Expected: `71` models with the `models.dev` catalog from 2026-10-29. The count depends on the catalog.

If the model is not included in the Go plan, the `403 upgrade_required` error surfaces in OpenCode; try another model.

### If OpenCode runs as a background service

`/connect` works through the background service; the key is stored in its database. If you prefer the environment method instead, the service must see the variable:

```bash
opencode service stop
export CMD_API_KEY='your-Command-Code-API-key'
opencode service start
```

## Plugin options

No option is required. These exist for debugging and for the manual bridge:

| Option | Purpose |
|---|---|
| `apiBase` | Upstream base URL, defaults to `https://api.commandcode.ai`. Useful for a mock. |
| `url` | Forces the use of an **external** bridge instead of the internal one. |
| `token` | External bridge token, used only with `url`. |
| `apiKey` | Legacy fallback: Command Code key handed to the bridge when /connect has none. Prefer /connect. |

Upgrading from 0.1.x: the key now comes from OpenCode's `/connect` credential store. The `apiKey` option is a fallback only; it still works when set, but prefer `/connect`.

## Manual mode — separate bridge

Useful for debugging or if you want to isolate the bridge from OpenCode.

```bash
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

The plugin token and the bridge token must match. In this mode, `plugin.ts` does not start an internal bridge. The Command Code key still comes from `/connect`; set `CMD_API_KEY` on the bridge only when you call the bridge directly (curl, another client). Warning: OpenCode sends the real Command Code key as the bearer token to `url`; use loopback or HTTPS only.

## Bridge environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CMD_API_KEY` / `COMMAND_CODE_API_KEY` | — | Fallback Command Code key for `proxy.mjs` when it is called directly. Normal requests carry the key from the `/connect` credential. |
| `COMMANDCODE_GO_BRIDGE_TOKEN` | — | Token for the **external** bridge only; must match the `token` option. |
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
- rejection when the bridge token is missing or wrong;
- the legacy mode where the bridge token itself is sent as the bearer token.

Automatic mode was validated end to end against a fake `/alpha/generate` server: key stored through the `/connect` API → OpenCode 2.2.x → plugin → internal bridge → SSE, with the key forwarded upstream as `Authorization: Bearer`. No test with a real Go key has been done in this repository.

## Known limitations

- **Every** model in the `commandcode` catalog is copied, including those the Go plan does not cover. A `403 upgrade_required` error then surfaces in OpenCode. There is no public list of Go models.
- The bridge only handles `stream: true`.
- Images must be `data:<mime>;base64,...` data URLs. HTTP URLs are not fetched.
- Reasoning is forwarded as `reasoning_content`; Anthropic-specific reasoning variants are removed from the catalog copy.
- `threadId` is derived from the OpenCode session (`x-opencode-session`) to keep a stable thread. Without a session, a random UUID is generated per request.
- The `x-command-code-version` header is pinned. A CLI change can break the bridge; there is no SLA.
- In automatic mode, the API key is stored in OpenCode's credential store and sent by OpenCode to the internal bridge as a bearer token. The plugin entry in `opencode.jsonc` never contains the key.
- The internal bridge listens only on `127.0.0.1`, gates every request on a random `x-bridge-token` generated per process, and forwards whatever bearer key OpenCode sends.
- OpenCode's title generation may pick another model from the provider (observed: `gpt-6-luna`); if that model is not included in Go, only title generation fails.

## Troubleshooting

- `commandcode-go` missing from `opencode models`: the plugin is not loaded, or the `commandcode` catalog is not available yet. Restart OpenCode after installing.
- `commandcode-go` missing from `/connect`: same causes; the provider is registered by the plugin, so check `opencode --standalone --print-logs models` for `[commandcode-go]`.
- No Command Code API key: run `/connect`, select **Command Code Go**, and paste the key.
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
