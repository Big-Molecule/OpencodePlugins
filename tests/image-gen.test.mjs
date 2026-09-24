import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin") {
      return {
        url: "data:text/javascript,export const tool = {}",
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})

const {
  buildResponsesImageRequest,
  extractImagePayloads,
  requestImagePayloads,
  resolveImageProtocolEndpoints,
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

test("keeps GPT generation and editing on the configured Images endpoint", async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
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
    assert.equal(result.route, "images-api")
    assert.equal(result.images.length, 2)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "http://localhost:18765/v1/images/generations")
    assert.equal(calls[0].body.n, 2)
    assert.equal(calls[0].body.image, `data:image/png;base64,${PNG_BASE64}`)
  } finally {
    globalThis.fetch = originalFetch
  }
})
