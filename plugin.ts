/**
 * Adds an unofficial "commandcode-go" provider to OpenCode.
 *
 * The provider is backed by an in-process bridge and authenticates through
 * OpenCode's normal /connect flow. Set `url` to use an external proxy
 * (see proxy.mjs) instead.
 */

import crypto from "node:crypto"
import { Plugin } from "@opencode/plugin"
import { configFromEnv, createServer } from "./proxy.mjs"

const SOURCE_ID = "commandcode"
const PROVIDER_ID = "commandcode-go"
const PROVIDER_NAME = "Command Code Go"

function option(ctx, key) {
  const value = ctx.options?.[key]
  return typeof value === "string" && value ? value : undefined
}

function trimURL(value) {
  return value.replace(/\/+$/, "")
}

let bridge
let starting

async function startBridge(ctx, apiBase) {
  const config = configFromEnv()
  config.apiKey = option(ctx, "apiKey") || config.apiKey
  config.bridgeToken = crypto.randomBytes(32).toString("hex")
  config.host = "127.0.0.1"
  config.port = 0
  config.workdir = ctx.location?.directory || config.workdir
  config.apiBase = apiBase

  const server = createServer(config)
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(undefined)
    })
  })
  server.unref()

  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("local bridge did not bind to a port")
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    token: config.bridgeToken,
  }
}

async function getBridge(ctx) {
  const apiBase = trimURL(
    option(ctx, "apiBase") ||
      process.env.COMMANDCODE_GO_API_BASE ||
      configFromEnv().apiBase,
  )

  if (bridge && bridge.apiBase === apiBase) return bridge
  if (starting) {
    if (starting.apiBase === apiBase) return starting.promise
    // The failed start belongs to another base; swallow its error so this caller
    // surfaces its own start failure, not the foreign one.
    return starting.promise.catch(() => {}).then(() => getBridge(ctx))
  }

  const promise = (async () => {
    if (bridge) {
      bridge.server.close()
      bridge.server.closeAllConnections?.()
      bridge = undefined
    }
    const started = await startBridge(ctx, apiBase)
    bridge = { ...started, apiBase }
    return bridge
  })()
  starting = { apiBase, promise }
  return promise.finally(() => {
    if (starting?.promise === promise) starting = undefined
  })
}

export default Plugin.define({
  id: "commandcode-go",
  async setup(ctx) {
    const externalURL = trimURL(
      process.env.COMMANDCODE_GO_BRIDGE_URL || option(ctx, "url") || "",
    )

    let baseURL
    let token

    if (externalURL) {
      try {
        const parsed = new URL(externalURL)
        if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname))
          console.warn("[commandcode-go] the Command Code key travels to this URL in clear text; use loopback or HTTPS")
      } catch {
        // A malformed url fails later at provider registration; only the warning is skipped here.
      }
      token = process.env.COMMANDCODE_GO_BRIDGE_TOKEN || option(ctx, "token")
      if (!token) {
        console.warn("[commandcode-go] external bridge token is not set; provider disabled")
        return
      }
      baseURL = externalURL
    } else {
      try {
        const localBridge = await getBridge(ctx)
        baseURL = localBridge.url
        token = localBridge.token
        console.log(`[commandcode-go] local bridge on ${baseURL}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[commandcode-go] could not start the local bridge: ${message}`)
        return
      }
    }

    // Register the provider account before adding the provider so /connect can
    // store the Command Code key as a normal OpenCode credential.
    await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = PROVIDER_NAME
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "key", label: "Manually enter API Key" },
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "env", names: ["CMD_API_KEY", "COMMAND_CODE_API_KEY"] },
      })
    })

    let added = false
    await ctx.provider.transform((editor) => {
      const source = editor.get(SOURCE_ID)
      if (!source) {
        console.warn("[commandcode-go] commandcode catalog is not loaded; provider not added")
        return
      }

      const models = [...source.models.values()].flatMap((model) => {
        if ((model.type ?? "chat") !== "chat") return []

        const copy = structuredClone(model)
        copy.providerID = PROVIDER_ID
        delete copy.canonical
        delete copy.package
        delete copy.body
        delete copy.headers
        copy.variants = []
        copy.compatibility = {
          maxTokensField: "max_tokens",
          reasoningField: "reasoning_content",
          streamUsage: true,
        }
        copy.capabilities = {
          ...copy.capabilities,
          input: copy.capabilities.input.filter((kind) => kind === "text" || kind === "image"),
          output: copy.capabilities.output.filter((kind) => kind === "text"),
        }

        if (copy.settings) {
          delete copy.settings.baseURL
          delete copy.settings.provider
          if (Object.keys(copy.settings).length === 0) delete copy.settings
        }

        return [copy]
      })

      if (models.length === 0) {
        console.warn("[commandcode-go] no chat models found in the commandcode catalog")
        return
      }

      editor.add({
        info: {
          id: PROVIDER_ID,
          name: PROVIDER_NAME,
          activation: "enabled",
          integrationID: PROVIDER_ID,
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL,
            provider: PROVIDER_ID,
          },
          headers: {
            "x-bridge-token": token,
          },
        },
        models,
      })
      added = true
    })

    if (!added) {
      return
    }

    // Give the bridge a stable thread per OpenCode session instead of a new UUID per request.
    await ctx.session.hook(
      "http.request",
      (event) => {
        event.request.headers.set("x-opencode-session", event.sessionID)
        if (ctx.location?.directory) event.request.headers.set("x-opencode-directory", ctx.location.directory)
      },
      { providerID: PROVIDER_ID },
    )
  },
})
