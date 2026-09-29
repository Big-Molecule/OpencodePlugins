import type { Plugin } from "@opencode-ai/plugin"

// Only filter the known malformed heartbeat emitted by the local NewAPI route.
// This intentionally does not touch other providers, endpoints, or non-streaming responses.
const INSTALL_MARK = Symbol.for("opencode.aijavis.sse-filter")

function isMalformedKeepAlive(frame: string): boolean {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")

  if (!data) return false

  try {
    const event = JSON.parse(data) as Record<string, unknown>

    return (
      event.type === "response.output_text.delta" &&
      (event.item_id === "SSE-Keep-Alive" || event["SSE-Keep-Alive"] === true)
    )
  } catch {
    // Non-JSON SSE data is passed through unchanged.
    return false
  }
}

function filterSSE(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })

        while (true) {
          const separator = pending.match(/\r?\n\r?\n/)
          if (!separator || separator.index === undefined) break

          const end = separator.index + separator[0].length
          const frame = pending.slice(0, end)
          pending = pending.slice(end)

          if (!isMalformedKeepAlive(frame)) {
            controller.enqueue(encoder.encode(frame))
          }
        }
      },

      flush(controller) {
        pending += decoder.decode()
        if (pending && !isMalformedKeepAlive(pending)) {
          controller.enqueue(encoder.encode(pending))
        }
      },
    }),
  )
}

function getRequestURL(input: RequestInfo | URL): URL | null {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    return new URL(raw)
  } catch {
    return null
  }
}

function isTargetResponse(input: RequestInfo | URL, response: Response): boolean {
  const url = getRequestURL(input)
  if (!url) return false

  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost"
  const eventStream = (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream")

  return loopback && url.port === "18765" && url.pathname.endsWith("/responses") && eventStream
}

function installFetchFilter() {
  const runtime = globalThis as any
  if (runtime[INSTALL_MARK]) return

  const nativeFetch = runtime.fetch.bind(runtime)
  runtime[INSTALL_MARK] = true

  runtime.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(input, init)

    if (!isTargetResponse(input, response) || !response.body) {
      return response
    }

    const headers = new Headers(response.headers)
    // The body length/encoding may no longer match after filtering frames.
    headers.delete("content-length")
    headers.delete("content-encoding")

    return new Response(filterSSE(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

// Install at module load and again in the Plugin callback. The second call is
// harmless and covers runtimes that defer plugin initialization.
installFetchFilter()

export const AijavisSSEFilter: Plugin = async () => {
  installFetchFilter()
  return {}
}

export default AijavisSSEFilter
