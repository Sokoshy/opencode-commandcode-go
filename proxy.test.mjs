import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import {
  buildGenerateRequest,
  createServer,
  parseEventLine,
  threadIdFor,
} from "./proxy.mjs"

const IMAGE = "data:image/png;base64,iVBORw0KGgo="

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(server.address().port)
    })
  })
}

test("converts an OpenAI transcript to the generate body", () => {
  const body = {
    model: "test-model",
    messages: [
      { role: "system", content: "system rules" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read", arguments: '{"filePath":"a"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_2", type: "function", function: { name: "grep", arguments: "{}" } }],
      },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: IMAGE } }] },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { filePath: { type: "string" } } },
        },
      },
    ],
    max_tokens: 1234,
  }

  const payload = buildGenerateRequest(body, {
    workdir: "/tmp/cc-go",
    maxTokens: 64_000,
    headers: {},
  })

  assert.equal(payload.params.model, "test-model")
  assert.equal(payload.params.system, "system rules")
  assert.equal(payload.params.max_tokens, 1234)
  assert.deepEqual(payload.params.tools[0], {
    type: "function",
    name: "read",
    description: "Read a file",
    input_schema: { type: "object", properties: { filePath: { type: "string" } } },
  })
  assert.equal(payload.memory, null)
  assert.equal(payload.taste, null)
  assert.equal(payload.skills, null)
  assert.match(payload.threadId, /^[0-9a-f-]{36}$/)

  assert.deepEqual(payload.params.messages[0], { role: "user", content: "hello" })

  const assistant = payload.params.messages[1]
  assert.equal(assistant.role, "assistant")
  assert.deepEqual(assistant.content[0], { type: "text", text: "checking" })
  assert.deepEqual(assistant.content[1], {
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "read",
    input: { filePath: "a" },
  })

  assert.deepEqual(payload.params.messages[2], {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "read",
        output: { type: "text", value: "file body" },
      },
    ],
  })

  assert.equal(payload.params.messages[3].role, "assistant")

  const missing = payload.params.messages[4]
  assert.equal(missing.role, "tool")
  assert.equal(missing.content[0].toolCallId, "call_2")
  assert.equal(missing.content[0].output.type, "error-text")

  const user = payload.params.messages[5]
  assert.equal(user.role, "user")
  assert.equal(user.content[0].type, "text")
  assert.deepEqual(user.content[1], { type: "image", image: IMAGE, mimeType: "image/png" })
})

test("rejects remote image URLs", () => {
  assert.throws(
    () =>
      buildGenerateRequest(
        {
          model: "m",
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
            },
          ],
        },
        { workdir: "/tmp", maxTokens: 100, headers: {} },
      ),
    /Only base64 data: image URLs/,
  )
})

test("maps tool ids over 64 characters deterministically", () => {
  const long = "call_" + "x".repeat(100)
  const body = {
    model: "m",
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: long, type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: long, content: "ok" },
    ],
  }
  const payload = buildGenerateRequest(body, { workdir: "/tmp", maxTokens: 100, headers: {} })
  const callId = payload.params.messages[0].content[0].toolCallId
  assert.equal(callId.length, 64)
  assert.equal(payload.params.messages[1].content[0].toolCallId, callId)
})

test("parses data-prefixed event lines", () => {
  assert.deepEqual(parseEventLine('data: {"type":"text-delta","text":"hi"}'), { type: "text-delta", text: "hi" })
  assert.equal(parseEventLine(": keep-alive"), undefined)
  assert.equal(parseEventLine("data: [DONE]"), undefined)
})

test("derives a stable UUID from the OpenCode session", () => {
  const a = threadIdFor({ "x-opencode-session": "ses_abc" })
  const b = threadIdFor({ "x-opencode-session": "ses_abc" })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("bridges an OpenAI stream to the generate endpoint", async (t) => {
  let seen
  const cc = http.createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      seen = { headers: request.headers, body: JSON.parse(raw) }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ type: "text-delta", text: "Hello" })}\n\n`)
      response.write(`data: ${JSON.stringify({ type: "reasoning-delta", text: "thinking" })}\n\n`)
      response.write(
        `data: ${JSON.stringify({ type: "tool-input-start", id: "call_9", toolName: "read" })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ type: "tool-input-delta", id: "call_9", delta: '{"path":"a"}' })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ type: "tool-call", toolCallId: "call_9", toolName: "read", input: { path: "a" } })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: {
            inputTokens: 10,
            outputTokens: 2,
            inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0 },
          },
        })}\n\n`,
      )
      response.end()
    })
  })
  const ccPort = await listen(cc)
  t.after(() => cc.close())

  const bridge = createServer({
    apiKey: "cc-key",
    bridgeToken: "bridge-token",
    apiBase: `http://127.0.0.1:${ccPort}`,
    cliVersion: "1.88.0",
    maxTokens: 64_000,
    timeoutMs: 5_000,
    workdir: "/tmp/cc-go",
  })
  const bridgePort = await listen(bridge)
  t.after(() => bridge.close())

  const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer bridge-token",
      "content-type": "application/json",
      "x-opencode-session": "ses_test",
      "x-opencode-directory": "/tmp/cc-go-test",
    },
    body: JSON.stringify({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    }),
  })

  assert.equal(response.status, 200)
  const text = await response.text()
  assert.equal(seen.headers.authorization, "Bearer cc-key")
  assert.equal(seen.headers["x-command-code-version"], "1.88.0")
  assert.equal(seen.body.config.workingDir, "/tmp/cc-go-test")
  assert.equal(seen.body.params.system, "rules")
  assert.equal(seen.body.params.messages[0].content, "hi")
  assert.match(text, /"content":"Hello"/)
  assert.match(text, /"reasoning_content":"thinking"/)
  assert.match(text, /"name":"read"/)
  assert.match(text, /"arguments":"\{\\"path\\":\\"a\\"\}"/)
  assert.match(text, /"finish_reason":"tool_calls"/)
  assert.match(text, /"prompt_tokens":10/)
  assert.match(text, /data: \[DONE\]/)
})

test("rejects a request without the bridge token", async (t) => {
  const bridge = createServer({
    apiKey: "cc-key",
    bridgeToken: "bridge-token",
    apiBase: "http://127.0.0.1:1",
    cliVersion: "1.88.0",
    maxTokens: 64_000,
    timeoutMs: 1_000,
    workdir: "/tmp",
  })
  const port = await listen(bridge)
  t.after(() => bridge.close())

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [] }),
  })
  assert.equal(response.status, 401)
})
