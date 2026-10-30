/**
 * commandcode-go bridge: OpenAI Chat Completions -> Command Code /alpha/generate.
 *
 * Experimental. Command Code's Go plan has no documented API access and
 * /alpha/generate is the CLI transport, not a public contract.
 *
 * Run: CMD_API_KEY=... COMMANDCODE_GO_BRIDGE_TOKEN=... node proxy.mjs
 */

import crypto from "node:crypto"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_API_BASE = "https://api.commandcode.ai"
const DEFAULT_CLI_VERSION = "1.88.0"
const DEFAULT_MAX_TOKENS = 64_000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const MAX_BODY_BYTES = 32 * 1024 * 1024
const TOOL_ID_MAX = 64
const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function configFromEnv(env = process.env) {
  return {
    apiKey: env.CMD_API_KEY || env.COMMAND_CODE_API_KEY || "",
    bridgeToken: env.COMMANDCODE_GO_BRIDGE_TOKEN || "",
    apiBase: (env.COMMANDCODE_GO_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, ""),
    host: env.COMMANDCODE_GO_HOST || "127.0.0.1",
    port: positiveInt(env.COMMANDCODE_GO_PORT, 8787),
    cliVersion: env.COMMANDCODE_GO_CLI_VERSION || DEFAULT_CLI_VERSION,
    maxTokens: positiveInt(env.COMMANDCODE_GO_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    timeoutMs: positiveInt(env.COMMANDCODE_GO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    workdir: env.COMMANDCODE_GO_WORKDIR || process.cwd(),
  }
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => isRecord(part) && part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
}

function parseToolInput(value) {
  if (isRecord(value)) return value
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Streaming arguments can be incomplete; fall through to {}.
    }
  }
  return {}
}

function imagePart(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) {
    throw new HttpError(400, "Only base64 data: image URLs are supported by the bridge")
  }
  const match = /^data:([^;,]+);base64,/i.exec(url)
  if (!match) throw new HttpError(400, "Invalid image data URL")
  return { type: "image", image: url, mimeType: match[1] }
}

function userContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === "text") parts.push({ type: "text", text: typeof part.text === "string" ? part.text : "" })
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
      parts.push(imagePart(url))
    }
  }
  return parts.length === 0 ? "" : parts
}

function imageParts(content) {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (!isRecord(part)) return []
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
      return [imagePart(url)]
    }
    return []
  })
}

function shortToolId(id) {
  const value = String(id ?? "")
  if (value.length <= TOOL_ID_MAX) return value
  return `call_${crypto.createHash("sha256").update(value).digest("hex").slice(0, TOOL_ID_MAX - 5)}`
}

function toolMetadata(messages) {
  const names = new Map()
  const callIds = new Set()
  const resultIds = new Set()
  for (const message of messages) {
    if (!isRecord(message)) continue
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = call?.id
        if (!id) continue
        names.set(String(id), call.function?.name ?? "")
        callIds.add(String(id))
      }
    }
    if (message.role === "tool" && message.tool_call_id) resultIds.add(String(message.tool_call_id))
  }
  return { names, callIds, resultIds }
}

export function convertMessages(input) {
  if (!Array.isArray(input)) throw new HttpError(400, "messages must be an array")
  const { names, callIds, resultIds } = toolMetadata(input)
  const output = []

  for (let i = 0; i < input.length; i++) {
    const message = input[i]
    if (!isRecord(message)) continue

    if (message.role === "system") continue

    if (message.role === "developer") {
      output.push({ role: "user", content: textOf(message.content) })
      continue
    }

    if (message.role === "user") {
      output.push({ role: "user", content: userContent(message.content) })
      continue
    }

    if (message.role === "assistant") {
      const parts = []
      if (typeof message.content === "string" && message.content) {
        parts.push({ type: "text", text: message.content })
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text) {
            parts.push({ type: "text", text: part.text })
          }
        }
      }

      const missing = []
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const rawId = call?.id
        if (!rawId) continue
        const id = shortToolId(rawId)
        const name = call.function?.name ?? names.get(String(rawId)) ?? ""
        parts.push({
          type: "tool-call",
          toolCallId: id,
          toolName: name,
          input: parseToolInput(call.function?.arguments),
        })
        if (!resultIds.has(String(rawId))) {
          missing.push({
            type: "tool-result",
            toolCallId: id,
            toolName: name,
            output: {
              type: "error-text",
              value: "No result — the tool call did not complete (interrupted or lost).",
            },
          })
        }
      }

      if (parts.length > 0) output.push({ role: "assistant", content: parts })
      if (missing.length > 0) output.push({ role: "tool", content: missing })
      continue
    }

    if (message.role === "tool") {
      const results = []
      const images = []
      let j = i
      for (; j < input.length && input[j]?.role === "tool"; j++) {
        const toolMessage = input[j]
        const rawId = toolMessage.tool_call_id
        if (!rawId || !callIds.has(String(rawId))) continue
        results.push({
          type: "tool-result",
          toolCallId: shortToolId(rawId),
          toolName: names.get(String(rawId)) ?? "",
          output: toolMessage.is_error
            ? { type: "error-text", value: textOf(toolMessage.content) }
            : { type: "text", value: textOf(toolMessage.content) },
        })
        images.push(...imageParts(toolMessage.content))
      }
      i = j - 1
      if (results.length > 0) output.push({ role: "tool", content: results })
      if (images.length > 0) output.push({ role: "user", content: images })
    }
  }

  return output
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || !tool.function?.name) return []
    const parameters = isRecord(tool.function.parameters)
      ? tool.function.parameters
      : { type: "object", properties: {} }
    return [
      {
        type: "function",
        name: String(tool.function.name),
        description: typeof tool.function.description === "string" ? tool.function.description : "",
        input_schema: parameters,
      },
    ]
  })
}

function reasoningEffort(body) {
  const effort = body.reasoning_effort ?? body.reasoning?.effort
  return typeof effort === "string" && effort !== "off" ? effort : undefined
}

export function projectSlug(workingDir) {
  return (
    String(workingDir)
      .toLowerCase()
      .replace(/^[a-z]:/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  )
}

export function threadIdFor(headers, body = {}) {
  const session = headers["x-opencode-session"] || body.user
  if (typeof session === "string" && session.trim()) {
    const hex = crypto.createHash("sha256").update(session.trim()).digest("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  return crypto.randomUUID()
}

export function buildGenerateRequest(body, options) {
  if (!isRecord(body)) throw new HttpError(400, "Invalid request body")
  if (typeof body.model !== "string" || !body.model) throw new HttpError(400, "model is required")
  if (!Array.isArray(body.messages)) throw new HttpError(400, "messages must be an array")

  const system = body.messages
    .filter((message) => message?.role === "system")
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join("\n\n")

  const requested = Number(body.max_completion_tokens ?? body.max_tokens ?? options.maxTokens)
  const maxTokens = Math.min(
    positiveInt(Number.isFinite(requested) ? requested : options.maxTokens, options.maxTokens),
    options.maxTokens,
  )

  return {
    config: {
      workingDir: options.workdir,
      date: new Date().toISOString().slice(0, 10),
      environment: `${process.platform}-${process.arch}, Node ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: body.model,
      messages: convertMessages(body.messages),
      tools: convertTools(body.tools),
      system,
      max_tokens: maxTokens,
      stream: true,
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(reasoningEffort(body) ? { reasoning_effort: reasoningEffort(body) } : {}),
    },
    threadId: threadIdFor(options.headers, body),
  }
}

export function parseEventLine(line) {
  let value = line.trim()
  if (!value || value.startsWith(":") || value.startsWith("event:")) return undefined
  if (value.startsWith("data:")) value = value.slice(5).trim()
  if (!value || value === "[DONE]") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function mapFinishReason(reason) {
  if (reason === "tool-calls" || reason === "tool_calls") return "tool_calls"
  if (["length", "max_tokens", "max-tokens", "max_output_tokens"].includes(reason)) return "length"
  if (reason === "content-filter" || reason === "content_filter") return "content_filter"
  return "stop"
}

function usageOf(totalUsage) {
  if (!isRecord(totalUsage)) return undefined
  const details = isRecord(totalUsage.inputTokenDetails) ? totalUsage.inputTokenDetails : {}
  const input = Number(totalUsage.inputTokens) || 0
  const cacheRead = Number(details.cacheReadTokens) || 0
  const cacheWrite = Number(details.cacheWriteTokens) || 0
  const noCache = Number(details.noCacheTokens) || Math.max(0, input - cacheRead - cacheWrite)
  const output = Number(totalUsage.outputTokens) || 0
  const prompt = noCache + cacheRead + cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cacheRead },
    completion_tokens_details: { reasoning_tokens: Number(totalUsage.reasoningTokens) || 0 },
  }
}

function errorText(value) {
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.message === "string") return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return "Command Code stream error"
  }
}

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}

function sendOpenAIError(response, status, message, code) {
  sendJson(response, status, {
    error: {
      message: redact(message),
      type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error",
      param: null,
      code: code ?? null,
    },
  })
}

async function readJson(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, "Request body too large")
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "Invalid JSON body")
  }
}

function authorized(request, token) {
  const header = request.headers.authorization ?? ""
  if (!header.startsWith("Bearer ")) return false
  const supplied = header.slice(7).trim()
  if (!supplied) return false
  const a = crypto.createHash("sha256").update(supplied).digest()
  const b = crypto.createHash("sha256").update(token).digest()
  return crypto.timingSafeEqual(a, b)
}

function upstreamError(status, text) {
  let message = text.trim().slice(0, 1_000) || `Command Code returned HTTP ${status}`
  let code
  try {
    const payload = JSON.parse(text)
    code = payload.error?.code ?? payload.code
    message = payload.error?.message ?? payload.message ?? message
  } catch {
    // Keep the plain text body.
  }
  if (status === 403 && code === "upgrade_required") {
    message = `This model is not included in the Go plan (upgrade_required). ${message}`
  }
  return {
    status: status >= 400 && status <= 599 ? status : 502,
    code,
    message: redact(message),
  }
}

async function relay(upstream, response, state) {
  const reader = upstream.body?.getReader()
  if (!reader) throw new Error("Command Code returned no response body")

  const decoder = new TextDecoder()
  let buffer = ""
  let finished = false
  let sawTool = false
  let finishReason
  let usage
  const pending = new Map()
  let nextToolIndex = 0

  const emit = (delta, finish = null, extra = {}) => {
    response.write(
      `data: ${JSON.stringify({
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      })}\n\n`,
    )
  }

  const emitTool = (tool) => {
    if (tool.emitted) return
    tool.emitted = true
    let args = tool.args.trim() || "{}"
    try {
      if (!isRecord(JSON.parse(args))) args = "{}"
    } catch {
      args = "{}"
    }
    emit({
      tool_calls: [
        {
          index: tool.index,
          id: shortToolId(tool.id),
          type: "function",
          function: { name: tool.name, arguments: args },
        },
      ],
    })
    sawTool = true
  }

  const handle = (event) => {
    if (!isRecord(event)) return

    if (event.type === "text-delta") {
      const text = typeof event.text === "string" ? event.text : ""
      if (text) emit({ content: text })
      return
    }

    if (event.type === "reasoning-delta") {
      const text = typeof event.text === "string" ? event.text : ""
      if (text) emit({ reasoning_content: text })
      return
    }

    if (event.type === "tool-input-start") {
      const id = String(event.id ?? "")
      if (!id) return
      pending.set(id, {
        id,
        name: String(event.toolName ?? ""),
        args: "",
        index: nextToolIndex++,
        emitted: false,
      })
      return
    }

    if (event.type === "tool-input-delta") {
      const tool = pending.get(String(event.id ?? ""))
      if (tool && typeof event.delta === "string") tool.args += event.delta
      return
    }

    if (event.type === "tool-call") {
      const rawId = String(event.toolCallId ?? event.id ?? "")
      const name = String(event.toolName ?? "")
      const input = event.input ?? event.args ?? event.arguments ?? {}
      let tool = pending.get(rawId)
      if (!tool) {
        tool = { id: rawId || `call_${nextToolIndex}`, name, args: "", index: nextToolIndex++, emitted: false }
        pending.set(rawId, tool)
      }
      tool.name = name || tool.name
      tool.args = typeof input === "string" ? input : JSON.stringify(input ?? {})
      emitTool(tool)
      return
    }

    if (event.type === "finish") {
      finishReason = event.finishReason
      usage = usageOf(event.totalUsage)
      finished = true
      return
    }

    if (event.type === "abort") throw new Error("Command Code aborted the request")
    if (event.type === "error") throw new Error(errorText(event.error ?? event.message))
  }

  try {
    emit({ role: "assistant", content: "" })

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const event = parseEventLine(line)
        if (event) handle(event)
        if (finished) break
      }
      if (finished) break
    }

    if (!finished) {
      const event = parseEventLine(buffer)
      if (event) handle(event)
    }
    if (!finished) throw new Error("Command Code stream ended before the finish event")

    for (const tool of pending.values()) emitTool(tool)

    let reason = mapFinishReason(finishReason)
    if (sawTool && reason === "stop") reason = "tool_calls"
    emit({}, reason)

    if (usage && state.includeUsage) {
      response.write(
        `data: ${JSON.stringify({
          id: state.id,
          object: "chat.completion.chunk",
          created: state.created,
          model: state.model,
          choices: [],
          usage,
        })}\n\n`,
      )
    }

    response.write("data: [DONE]\n\n")
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The reader may already be closed.
    }
  }
}

async function handleChat(request, response, config) {
  if (!config.bridgeToken) {
    sendOpenAIError(response, 500, "COMMANDCODE_GO_BRIDGE_TOKEN is not set on the bridge")
    return
  }
  if (!authorized(request, config.bridgeToken)) {
    sendOpenAIError(response, 401, "Invalid bridge token")
    return
  }
  if (!config.apiKey) {
    sendOpenAIError(response, 500, "CMD_API_KEY is not set on the bridge")
    return
  }

  let body
  try {
    body = await readJson(request, MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof HttpError) {
      sendOpenAIError(response, error.status, error.message)
      return
    }
    throw error
  }

  if (body.stream === false) {
    sendOpenAIError(response, 400, "Only stream:true is supported by this bridge")
    return
  }
  if (typeof body.model !== "string" || !body.model) {
    sendOpenAIError(response, 400, "model is required")
    return
  }
  if (!Array.isArray(body.messages)) {
    sendOpenAIError(response, 400, "messages must be an array")
    return
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.timeoutMs)
  const onClose = () => controller.abort()
  response.on("close", onClose)
  response.on("error", () => undefined)

  try {
    const workingDir =
      typeof request.headers["x-opencode-directory"] === "string" && request.headers["x-opencode-directory"]
        ? request.headers["x-opencode-directory"]
        : config.workdir
    const payload = buildGenerateRequest(body, {
      workdir: workingDir,
      maxTokens: config.maxTokens,
      headers: request.headers,
    })

    const session = request.headers["x-opencode-session"]
    const sessionUUID =
      typeof session === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(session) ? session : undefined

    const upstream = await fetch(`${config.apiBase}/alpha/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        "x-command-code-version": config.cliVersion,
        "x-cli-environment": "production",
        "x-project-slug": projectSlug(workingDir),
        "x-taste-learning": "true",
        ...(sessionUUID ? { "x-session-id": sessionUUID } : {}),
        "user-agent": "cli",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "")
      const error = upstreamError(upstream.status, text)
      sendOpenAIError(response, error.status, error.message, error.code)
      return
    }

    response.writeHead(200, STREAM_HEADERS)
    response.flushHeaders?.()
    if (response.destroyed) return

    await relay(upstream, response, {
      id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      includeUsage: body.stream_options?.include_usage !== false,
    })
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error))
    if (response.headersSent) {
      try {
        response.write(`data: ${JSON.stringify({ error: { message, type: "api_error", param: null, code: null } })}\n\n`)
        response.write("data: [DONE]\n\n")
      } catch {
        // The client may already be gone.
      }
    } else if (error instanceof HttpError) {
      sendOpenAIError(response, error.status, error.message)
    } else if (timedOut) {
      sendOpenAIError(response, 504, "Command Code request timed out")
    } else if (!controller.signal.aborted) {
      sendOpenAIError(response, 502, message)
    }
  } finally {
    clearTimeout(timer)
    response.off("close", onClose)
    if (!response.writableEnded && !response.destroyed) response.end()
  }
}

export function createServer(config) {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      void handleChat(request, response, config).catch((error) => {
        if (!response.headersSent) {
          sendOpenAIError(response, 500, error instanceof Error ? error.message : String(error))
        } else if (!response.writableEnded) {
          response.end()
        }
      })
      return
    }
    sendOpenAIError(response, 404, "Not found")
  })
}

function main() {
  const config = configFromEnv()
  if (!config.bridgeToken) {
    console.error("COMMANDCODE_GO_BRIDGE_TOKEN is required (same value in OpenCode and the bridge).")
    process.exit(1)
  }
  if (!config.apiKey) {
    console.error("CMD_API_KEY (or COMMAND_CODE_API_KEY) is required by the bridge.")
    process.exit(1)
  }
  const server = createServer(config)
  server.on("error", (error) => {
    console.error(`Bridge failed: ${error.message}`)
    process.exit(1)
  })
  server.listen(config.port, config.host, () => {
    console.log(
      `commandcode-go bridge on http://${config.host}:${config.port}/v1 -> ${config.apiBase}/alpha/generate (CLI ${config.cliVersion})`,
    )
  })
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (entry && entry === fileURLToPath(import.meta.url)) main()
