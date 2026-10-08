import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const {
  buildResponsesImageRequest,
  extractImagePayloads,
  requestImagePayloads,
  resolveImageProtocolEndpoints,
  resolveApiConfig,
  ImageGenPlugin,
} = await import("../plugins/image-gen.ts")

const png = Buffer.alloc(24)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
png.writeUInt32BE(1, 16)
png.writeUInt32BE(1, 20)
const PNG_BASE64 = png.toString("base64")

const JPEG_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11,
  0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]).toString("base64")

const webp = Buffer.alloc(30)
webp.write("RIFF", 0, "ascii")
webp.write("WEBP", 8, "ascii")
webp.write("VP8X", 12, "ascii")
const WEBP_BASE64 = webp.toString("base64")

const gif = Buffer.alloc(10)
gif.write("GIF89a", 0, "ascii")
gif.writeUInt16LE(1, 6)
gif.writeUInt16LE(1, 8)
const GIF_BASE64 = gif.toString("base64")

function api(model) {
  return {
    endpoint: "http://localhost:18765/v1/images/generations",
    model,
    key: "test-key",
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

test("derives the Responses endpoint from the configured Images endpoint", () => {
  assert.deepEqual(
    resolveImageProtocolEndpoints("https://example.test/proxy/v1/images/generations?ignored=true"),
    {
      images: "https://example.test/proxy/v1/images/generations",
      edits: "https://example.test/proxy/v1/images/edits",
      responses: "https://example.test/proxy/v1/responses",
    },
  )
})

test("builds Responses generation and edit requests", () => {
  assert.deepEqual(buildResponsesImageRequest("image-model", "draw it"), {
    model: "image-model",
    input: "draw it",
  })
  const source = { mimeType: "image/jpeg", base64: JPEG_BASE64 }
  const edit = buildResponsesImageRequest("gemini-test", "change it", source)
  assert.equal(edit.model, "gemini-test")
  assert.equal(edit.input[0].content[1].type, "input_image")
  assert.equal(edit.input[0].content[1].image_url, `data:image/jpeg;base64,${JPEG_BASE64}`)
})

test("extracts Images data, Responses text data URIs, and image generation results", () => {
  const images = extractImagePayloads({
    data: [{ b64_json: PNG_BASE64, mime_type: "image/png" }],
    output: [
      { content: [{ text: `![result](data:image/jpeg;base64,${JPEG_BASE64})` }] },
      { type: "image_generation_call", result: GIF_BASE64 },
    ],
  })

  assert.deepEqual(images, [
    { base64: PNG_BASE64, mimeType: "image/png" },
    { base64: JPEG_BASE64, mimeType: "image/jpeg" },
    { base64: GIF_BASE64, mimeType: "image/png" },
  ])
  assert.deepEqual(extractImagePayloads({ data: [{ b64_json: "not-image-data" }] }), [])
})

test("tries Images first and falls back to Responses for every model family", async () => {
  for (const model of ["gemini-3.1-flash-image-2K", "gpt-image-2-team"]) {
    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      if (calls.length === 1) {
        return jsonResponse({ error: { message: "images unavailable" } }, 404)
      }
      return jsonResponse({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: `![image](data:image/jpeg;base64,${JPEG_BASE64})`,
              },
            ],
          },
        ],
      })
    }

    try {
      const result = await requestImagePayloads(api(model), "draw a lighthouse", "2048x1536")
      assert.equal(result.ok, true)
      assert.equal(result.route, "responses-fallback")
      assert.equal(result.images[0].mimeType, "image/jpeg")
      assert.deepEqual(
        calls.map((call) => call.url),
        [
          "http://localhost:18765/v1/images/generations",
          "http://localhost:18765/v1/responses",
        ],
      )
      assert.equal(calls[0].body.model, model)
      assert.equal(calls[0].body.n, 1)
      assert.equal(calls[1].body.model, model)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test("uploads edits as real multipart files with an automatically generated boundary", async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers["Content-Type"], undefined)
    const request = new Request(url, init)
    assert.match(request.headers.get("content-type"), /^multipart\/form-data; boundary=/)
    calls.push({ url: String(url), body: await request.formData() })
    return jsonResponse({
      data: [
        { b64_json: PNG_BASE64, mime_type: "image/png" },
        { b64_json: WEBP_BASE64, mime_type: "image/webp" },
      ],
    })
  }

  try {
    const source = { mimeType: "image/png", base64: PNG_BASE64 }
    const result = await requestImagePayloads(
      api("gpt-image-2-team"),
      "edit this",
      "1024x1024",
      source,
      2,
    )
    assert.equal(result.ok, true)
    assert.equal(result.route, "images-edits")
    assert.equal(result.images.length, 2)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "http://localhost:18765/v1/images/edits")
    assert.equal(calls[0].body.get("n"), "2")
    assert.equal(calls[0].body.get("model"), "gpt-image-2-team")
    assert.equal(calls[0].body.get("prompt"), "edit this")
    assert.equal(calls[0].body.get("size"), "1024x1024")
    const uploaded = calls[0].body.get("image")
    assert.equal(uploaded.name, "image.png")
    assert.equal(uploaded.type, "image/png")
    assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), png)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("derives prefixed, versionless and custom edit paths, including old configs", () => {
  for (const prefix of ["/v1", "/gateway/v1", "/gateway"]) {
    const endpoints = resolveImageProtocolEndpoints(`https://example.test${prefix}/images/generations/`)
    assert.equal(endpoints.edits, `https://example.test${prefix}/images/edits`)
    assert.equal(endpoints.responses, `https://example.test${prefix}/responses`)
  }
  assert.equal(resolveImageProtocolEndpoints("https://example.test/custom").edits, "https://example.test/v1/images/edits")
  const cfg = { api: { host: "example.test", path: "/gateway/v1/images/generations", key: "test", model: "image-model" } }
  const old = resolveApiConfig(cfg, false)
  assert.equal(old.editsPath, null)
  assert.equal(old.editsEndpoint, "https://example.test/gateway/v1/images/edits")
  cfg.api.editsPath = "/custom/edit"
  assert.equal(resolveApiConfig(cfg, false).editsEndpoint, "https://example.test/custom/edit")
  cfg.api.editsPath = "auto"
  assert.equal(resolveApiConfig(cfg, false).editsEndpoint, old.editsEndpoint)
})

test("preserves generation JSON and endpoint", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, api("image-model").endpoint)
    assert.equal(init.headers["Content-Type"], "application/json")
    assert.deepEqual(JSON.parse(init.body), { model: "image-model", prompt: "draw", n: 1, size: "1024x1024" })
    return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] })
  })
  assert.equal((await requestImagePayloads(api("image-model"), "draw", "1024x1024")).route, "images-api")
})

test("custom edits endpoint receives a PNG mask as a file", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "http://localhost:18765/custom/edits")
    assert.equal(init.headers.Authorization, "Bearer test-key")
    const form = await new Request(url, init).formData()
    assert.deepEqual(Buffer.from(await form.get("mask").arrayBuffer()), png)
    assert.equal(form.get("image").type, "image/jpeg")
    return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] })
  })
  const result = await requestImagePayloads(
    { ...api("image-model"), editsPath: "/custom/edits" }, "edit", "1024x1024",
    { mimeType: "image/jpeg", base64: JPEG_BASE64 }, 1, 1000,
    { mask: { mimeType: "image/png", base64: PNG_BASE64 } },
  )
  assert.equal(result.ok, true)
})

test("edit fallback carries the original image to Responses, never generations", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(url))
    if (calls.length === 1) return jsonResponse({ error: { message: "edits unavailable" } }, 404)
    const body = JSON.parse(init.body)
    assert.equal(body.input[0].content[1].image_url, `data:image/webp;base64,${WEBP_BASE64}`)
    return jsonResponse({ output: [{ type: "image_generation_call", result: PNG_BASE64 }] })
  })
  const result = await requestImagePayloads(api("image-model"), "edit", "1024x1024", { mimeType: "image/webp", base64: WEBP_BASE64 })
  assert.equal(result.route, "responses-fallback")
  assert.deepEqual(calls, ["http://localhost:18765/v1/images/edits", "http://localhost:18765/v1/responses"])
})

test("does not silently discard masks during fallback", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () => jsonResponse({ error: { message: "unsupported" } }, 404))
  const source = { mimeType: "image/png", base64: PNG_BASE64 }
  const result = await requestImagePayloads(api("image-model"), "edit", "1024x1024", source, 1, 1000, { mask: source })
  assert.equal(result.ok, false)
  assert.match(result.error, /mask is set/)
  assert.equal(mocked.mock.callCount(), 1)
})

test("does not fallback on auth, quota, server, timeout or network errors", async (t) => {
  for (const status of [401, 403, 429, 500, 502]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => jsonResponse({ error: { message: "failed" } }, status))
    const result = await requestImagePayloads(api("image-model"), "draw", "1024x1024")
    assert.equal(result.ok, false)
    assert.equal(mocked.mock.callCount(), 1)
    mocked.mock.restore()
  }
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network failed") })
  assert.match((await requestImagePayloads(api("image-model"), "draw", "1024x1024")).error, /network failed/)
  assert.equal(network.mock.callCount(), 1)
  network.mock.restore()
  const timeout = t.mock.method(globalThis, "fetch", async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  assert.match((await requestImagePayloads(api("image-model"), "draw", "1024x1024", undefined, 1, 10)).error, /Timeout/)
  assert.equal(timeout.mock.callCount(), 1)
})

test("cancellation aborts an edit and prevents fallback", async (t) => {
  const controller = new AbortController()
  const mocked = t.mock.method(globalThis, "fetch", async (_url, init) => {
    controller.abort()
    init.signal.throwIfAborted()
  })
  const result = await requestImagePayloads(api("image-model"), "edit", "1024x1024", { mimeType: "image/png", base64: PNG_BASE64 }, 1, 1000, { signal: controller.signal })
  assert.equal(result.error, "Cancelled.")
  assert.equal(mocked.mock.callCount(), 1)
  await requestImagePayloads(api("image-model"), "edit", "1024x1024", undefined, 1, 1000, { signal: controller.signal })
  assert.equal(mocked.mock.callCount(), 1)
})

test("downloads URL results without forwarding API credentials", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(url))
    if (calls.length === 1) return jsonResponse({ data: [{ url: "https://cdn.example.test/image.png" }] })
    assert.equal(init.headers, undefined)
    return new Response(png, { headers: { "Content-Type": "image/png" } })
  })
  const result = await requestImagePayloads(api("image-model"), "draw", "1024x1024")
  assert.equal(result.ok, true)
  assert.equal(result.images[0].base64, PNG_BASE64)
  assert.equal(calls.length, 2)
})

test("a failed image download does not trigger a second generation", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async (_url, init) => init.method === "POST"
    ? jsonResponse({ data: [{ url: "https://cdn.example.test/expired.png" }] })
    : new Response("expired", { status: 403 }))
  const result = await requestImagePayloads(api("image-model"), "draw", "1024x1024")
  assert.equal(result.ok, false)
  assert.match(result.error, /download HTTP 403/)
  assert.equal(mocked.mock.callCount(), 2)
})

test("multi-edit fallback reports partial success and combined failures", async (t) => {
  let responses = 0
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/edits")) return jsonResponse({ error: { message: "edits unavailable" } }, 404)
    if (++responses === 1) return jsonResponse({ output: [{ type: "image_generation_call", result: PNG_BASE64 }] })
    return jsonResponse({ error: { message: "response failed" } }, 500)
  })
  const source = { mimeType: "image/png", base64: PNG_BASE64 }
  const result = await requestImagePayloads(api("image-model"), "edit", "1024x1024", source, 2)
  assert.equal(result.ok, true)
  assert.equal(result.images.length, 1)
  assert.match(result.warning, /1\/2/)
  const failed = await requestImagePayloads(api("image-model"), "edit", "1024x1024", source, 2)
  assert.equal(failed.ok, false)
  assert.match(failed.error, /edits unavailable.*response failed/)
})

test("edit tool resolves session-relative paths, sniffs input format and validates masks", async (t) => {
  const dir = mkdtempSync(join(process.env.TEMP || tmpdir(), "image-gen-test-"))
  const env = { IMAGE_GEN_API_HOST: "example.test", IMAGE_GEN_API_KEY: "test-key", IMAGE_GEN_API_MODEL: "test-image" }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, "source.jpg"), png) // Deliberately misleading extension.
  writeFileSync(join(dir, "mask.png"), png)
  writeFileSync(join(dir, "bad.png"), "not an image")
  const wrongSize = Buffer.from(png)
  wrongSize.writeUInt32BE(2, 16)
  writeFileSync(join(dir, "wrong-size.png"), wrongSize)
  const mocked = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.body.get("image").type, "image/png")
    assert.equal(init.body.get("image").name, "source.png")
    assert.equal(init.body.get("mask").type, "image/png")
    return jsonResponse({ data: [{ b64_json: WEBP_BASE64 }] })
  })
  const { tool } = await ImageGenPlugin()
  const context = { directory: dir, signal: new AbortController().signal }
  const args = { image_path: "source.jpg", mask_path: "mask.png", prompt: "change it", quality: "1K", output_dir: "out" }
  const result = await tool.image_edit.execute(args, context)
  assert.match(result, /Image edit completed/)
  const savedPath = result.match(/1\. (.+\.webp)  \(/)[1]
  assert.ok(savedPath.startsWith(join(dir, "out")))
  assert.equal(readFileSync(savedPath).toString("base64"), WEBP_BASE64)
  assert.match(await tool.image_edit.execute({ ...args, image_path: "bad.png" }, context), /must contain/)
  assert.match(await tool.image_edit.execute({ ...args, mask_path: "wrong-size.png" }, context), /dimensions must match/)
  assert.match(await tool.image_edit.execute({ ...args, mask_path: "missing.png" }, context), /not found/)
  assert.equal(mocked.mock.callCount(), 1)
})
