import { type Plugin, tool } from "@opencode-ai/plugin"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"

const CONFIG_PATH = join(homedir(), ".config", "opencode", "image-gen.json")

// Placeholder defaults only for display before the user configures OpenCode.
// Never load Codex or other product config files.
const DEFAULT_API = Object.freeze({
  protocol: "https",
  host: "",
  port: null as number | null,
  path: "/v1/images/generations",
  modelsPath: "/v1/models",
  model: "",
})

const API_ENV = Object.freeze({
  protocol: "IMAGE_GEN_API_PROTOCOL",
  host: "IMAGE_GEN_API_HOST",
  port: "IMAGE_GEN_API_PORT",
  path: "IMAGE_GEN_API_PATH",
  modelsPath: "IMAGE_GEN_API_MODELS_PATH",
  key: "IMAGE_GEN_API_KEY",
  model: "IMAGE_GEN_API_MODEL",
})

const IMAGE_MODEL_HINT =
  /(image|dall[-_ ]?e|flux|sdxl|stable[-_ ]?diffusion|imagen|seedream|kolors|qwen[-_ ]?image|wan[-_ ]?image)/i

const SIZE_MATRIX: Record<string, Record<string, string>> = {
  "1K": { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" },
  "2K": { square: "2048x2048", landscape: "2048x1536", portrait: "1536x2048" },
  "4K": { square: "2880x2880", landscape: "3840x2160", portrait: "2160x3840" },
}

const DEFAULTS = { quality: "2K", ratio: "square", count: 1, concurrency: 3 }
const RATIO_LABEL: Record<string, string> = {
  square: "square (1:1)",
  landscape: "landscape (3:2)",
  portrait: "portrait (2:3)",
}

type StoredConfig = {
  api?: {
    protocol?: string
    host?: string
    domain?: string
    port?: number | null
    path?: string
    modelsPath?: string
    key?: string
    model?: string
  }
  apiKey?: string
  quickMode?: { quality?: string; ratio?: string; count?: number }
  batchMode?: { quality?: string; ratio?: string; concurrency?: number }
}

type ResolvedApi = {
  protocol: string
  host: string
  port: number | null
  path: string
  endpoint: string | null
  modelsPath: string
  modelsEndpoint: string | null
  key: string | null
  keySource: string | null
  model: string | null
  modelSource: string | null
  hasHost: boolean
  hasKey: boolean
  hasModel: boolean
}

function firstDefined<T>(...values: Array<T | undefined | null | "">): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value as T
  }
  return undefined
}

function normalizeProtocol(value: unknown) {
  const protocol = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/:$/, "")
  if (!["http", "https"].includes(protocol)) {
    throw new Error('API protocol must be "http" or "https".')
  }
  return protocol
}

function normalizeHost(value: unknown, { required = true } = {}) {
  const host = String(value || "").trim()
  if (!host) {
    if (required) throw new Error("API host is required (domain, IP, or localhost, no scheme/path).")
    return ""
  }
  if (host.includes("://") || /[/?#@\s]/.test(host)) {
    throw new Error("API host must be a domain, IP, or localhost without scheme/path.")
  }
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    throw new Error("Put the API port in port, not host.")
  }
  return host
}

function normalizePort(value: unknown) {
  if (value === undefined || value === null || value === "" || String(value).toLowerCase() === "default") {
    return null
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API port must be an integer 1-65535, or omit for default.")
  }
  return port
}

function normalizePath(value: unknown) {
  const p = String(value || "").trim()
  if (!p) throw new Error("API path must not be empty.")
  return `/${p.replace(/^\/+/, "")}`
}

function normalizeModel(value: unknown, { required = true } = {}) {
  const model = String(value || "").trim()
  if (!model) {
    if (required) throw new Error("API model must not be empty.")
    return ""
  }
  return model
}

function previewSecret(value: string | null | undefined) {
  if (!value) return null
  if (value.length <= 8) return `${value.slice(0, 2)}...${value.slice(-2)}`
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function configFileExists() {
  return existsSync(CONFIG_PATH)
}

function loadConfig(): StoredConfig | null {
  if (!configFileExists()) return null
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StoredConfig
  } catch {
    return null
  }
}

function setupGuide(reason: string) {
  return [
    "Image Gen setup required",
    reason,
    "",
    `OpenCode config only: ${CONFIG_PATH}`,
    "",
    "User can EXIT setup at any time:",
    "  - Say cancel / 退出配置 / 先不做了 to stop setup and pause image work.",
    "  - Do not keep pressing for key/host after the user cancels.",
    "  - Resume later with image_status when they want images again.",
    "",
    "Do NOT ask the user to invent a model id first.",
    "Flow: connection (key+host) -> verify -> list models (or manual model) -> generate.",
    "",
    "Step 1 — save connection (model optional, omit it):",
    "  image_configure action=set_api",
    "    protocol=https",
    "    host=<api-host only, e.g. api.example.com>",
    "    key=<api-key>",
    "    path=/v1/images/generations   (optional)",
    "    models_path=/v1/models        (optional)",
    "  After save, connection is verified automatically (unless skip_verify=true).",
    "",
    "Step 2 — if verify found models:",
    "  image_list_models (or use the list from verify output)",
    "  Ask the user to pick a number/id (prefer [image?]).",
    "",
    "Step 3 — if /models is unsupported but auth probe passed:",
    "  Ask the user for a model id they know works on that site,",
    "  then image_configure action=set_model model=<id>",
    "",
    "Step 4 — optional quick defaults, then generate:",
    "  image_configure action=set_quick_mode quality=2K ratio=square count=1",
    "  image_generate prompt=\"...\"",
  ].join("\n")
}

function saveConfig(cfg: StoredConfig) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try {
    chmodSync(CONFIG_PATH, 0o600)
  } catch {
    /* Windows may ignore mode */
  }
}

function resolveApiConfig(cfg: StoredConfig | null = loadConfig(), useEnv = true): ResolvedApi {
  const stored = cfg?.api && typeof cfg.api === "object" ? cfg.api : {}
  const env = useEnv ? process.env : {}

  const protocol = normalizeProtocol(
    firstDefined(env[API_ENV.protocol], stored.protocol, DEFAULT_API.protocol),
  )
  const host = normalizeHost(
    firstDefined(env[API_ENV.host], stored.host, stored.domain, DEFAULT_API.host),
    { required: false },
  )
  const port = normalizePort(firstDefined(env[API_ENV.port], stored.port, DEFAULT_API.port))
  const path = normalizePath(firstDefined(env[API_ENV.path], stored.path, DEFAULT_API.path))
  const modelsPath = normalizePath(
    firstDefined(env[API_ENV.modelsPath], stored.modelsPath, DEFAULT_API.modelsPath),
  )
  const rawModel = firstDefined(env[API_ENV.model], stored.model, "") as string | undefined
  const model = normalizeModel(rawModel || "", { required: false }) || null
  const modelSource = env[API_ENV.model]
    ? API_ENV.model
    : stored.model
      ? "config.api.model"
      : null
  const key =
    (firstDefined(env[API_ENV.key], stored.key, cfg?.apiKey, null) as string | null | undefined) ||
    null
  const keySource = env[API_ENV.key]
    ? API_ENV.key
    : stored.key
      ? "config.api.key"
      : cfg?.apiKey
        ? "legacy config.apiKey"
        : null

  let endpoint: string | null = null
  let modelsEndpoint: string | null = null
  if (host) {
    const authority = port === null ? host : `${host}:${port}`
    endpoint = new URL(path, `${protocol}://${authority}/`).toString()
    modelsEndpoint = new URL(modelsPath, `${protocol}://${authority}/`).toString()
  }

  return {
    protocol,
    host,
    port,
    path,
    endpoint,
    modelsPath,
    modelsEndpoint,
    key,
    keySource,
    model,
    modelSource,
    hasHost: !!host,
    hasKey: !!key,
    hasModel: !!model,
  }
}

function apiForStorage(api: ResolvedApi) {
  return {
    protocol: api.protocol,
    host: api.host,
    port: api.port,
    path: api.path,
    modelsPath: api.modelsPath,
    key: api.key,
    model: api.model || undefined,
  }
}

function resolveSize(quality: string, ratio: string) {
  return SIZE_MATRIX[quality.toUpperCase()]?.[ratio.toLowerCase()] || null
}

function resolveOutputDir(userDir?: string) {
  const dir = userDir?.trim() || join(homedir(), "Pictures", "image-gen")
  mkdirSync(dir, { recursive: true })
  return dir
}

function timestamp() {
  const d = new Date()
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("")
}

function normalizeModelRecord(value: unknown): { id: string; ownedBy: string | null; created: unknown } | null {
  if (typeof value === "string") return { id: value, ownedBy: null, created: null }
  if (!value || typeof value !== "object") return null
  const obj = value as Record<string, unknown>
  const id = obj.id ?? obj.name ?? obj.model
  if (typeof id !== "string" || !id.trim()) return null
  return {
    id: id.trim(),
    ownedBy: (obj.owned_by ?? obj.ownedBy ?? obj.owner ?? null) as string | null,
    created: obj.created ?? null,
  }
}

function extractModels(payload: unknown) {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.data)
      ? (payload as any).data
      : Array.isArray((payload as any)?.models)
        ? (payload as any).models
        : null
  if (raw === null) {
    throw new Error("Model-list response must be an array or contain data/models.")
  }
  const seen = new Set<string>()
  const models: Array<{ id: string; ownedBy: string | null; created: unknown; likelyImageModel: boolean }> =
    []
  for (const value of raw) {
    const model = normalizeModelRecord(value)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push({ ...model, likelyImageModel: IMAGE_MODEL_HINT.test(model.id) })
  }
  models.sort(
    (a, b) => Number(b.likelyImageModel) - Number(a.likelyImageModel) || a.id.localeCompare(b.id),
  )
  return models
}

type HttpProbe = {
  ok: boolean
  status: number | null
  body: string
  error?: string
  json?: unknown
}

async function httpProbe(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<HttpProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    clearTimeout(timer)
    const body = await response.text()
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      json = undefined
    }
    return { ok: response.ok, status: response.status, body, json }
  } catch (err: any) {
    clearTimeout(timer)
    const message =
      err?.name === "AbortError"
        ? `Timeout after ${timeoutMs / 1000}s`
        : String(err?.message || err)
    return { ok: false, status: null, body: "", error: message }
  }
}

function classifyAuthFailure(status: number | null, body: string) {
  if (status === 401 || status === 403) return "auth" as const
  const lower = (body || "").toLowerCase()
  if (
    /invalid api key|incorrect api key|unauthorized|authentication|not authenticated|invalid_api_key|permission denied|access denied/.test(
      lower,
    )
  ) {
    return "auth" as const
  }
  return null
}

function extractErrorMessage(body: string, json: unknown) {
  if (json && typeof json === "object") {
    const obj = json as any
    const msg = obj.error?.message || obj.message || obj.error
    if (typeof msg === "string" && msg.trim()) return msg.trim()
  }
  const trimmed = (body || "").trim()
  if (!trimmed) return "(empty body)"
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed
}

async function queryModels(api: ResolvedApi) {
  if (!api.modelsEndpoint) throw new Error("API host is not configured.")
  const headers: Record<string, string> = { Accept: "application/json" }
  if (api.key) headers.Authorization = `Bearer ${api.key}`
  const probe = await httpProbe(api.modelsEndpoint, { method: "GET", headers })
  if (probe.error) {
    throw new Error(`Model query network error: ${probe.error}`)
  }
  if (!probe.ok) {
    throw new Error(
      `Model query failed HTTP ${probe.status}: ${extractErrorMessage(probe.body, probe.json)}`,
    )
  }
  if (probe.json === undefined) {
    throw new Error("Model-list endpoint did not return valid JSON.")
  }
  const models = extractModels(probe.json)
  return {
    modelsEndpoint: api.modelsEndpoint,
    selectedModel: api.model,
    selectedModelAvailable: models.some((m) => m.id === api.model),
    count: models.length,
    likelyImageModels: models.filter((m) => m.likelyImageModel).map((m) => m.id),
    models,
  }
}

type VerifyResult = {
  valid: boolean
  level: "ok_models" | "ok_auth_no_models" | "invalid_auth" | "invalid_host" | "uncertain"
  summary: string
  details: string[]
  models?: Awaited<ReturnType<typeof queryModels>>
}

/**
 * Validate host+key:
 * 1) GET /models — success with parseable list => OK
 * 2) If models fails, do NOT assume key is wrong:
 *    - network/DNS/timeout => host/url problem
 *    - 401/403 => key problem
 *    - otherwise probe POST image endpoint (auth / reachability)
 */
async function verifyConnection(api: ResolvedApi): Promise<VerifyResult> {
  if (!api.hasHost || !api.endpoint || !api.modelsEndpoint) {
    return {
      valid: false,
      level: "invalid_host",
      summary: "Host is not configured.",
      details: ["Set host via image_configure action=set_api host=..."],
    }
  }
  if (!api.hasKey || !api.key) {
    return {
      valid: false,
      level: "invalid_auth",
      summary: "API key is not configured.",
      details: ["Set key via image_configure action=set_key or set_api key=..."],
    }
  }

  const details: string[] = [
    `Endpoint: ${api.endpoint}`,
    `Models:   ${api.modelsEndpoint}`,
    `Key:      ${previewSecret(api.key)}`,
  ]

  // --- Step 1: models list ---
  const modelsHeaders: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${api.key}`,
  }
  const modelsProbe = await httpProbe(api.modelsEndpoint, { method: "GET", headers: modelsHeaders })

  if (modelsProbe.error) {
    return {
      valid: false,
      level: "invalid_host",
      summary: "Cannot reach the API host (network/DNS/timeout).",
      details: [
        ...details,
        `Models GET error: ${modelsProbe.error}`,
        "Check host/protocol/port. Key was not proven invalid yet.",
      ],
    }
  }

  if (modelsProbe.ok) {
    try {
      const models = extractModels(modelsProbe.json)
      const listed = {
        modelsEndpoint: api.modelsEndpoint,
        selectedModel: api.model,
        selectedModelAvailable: models.some((m) => m.id === api.model),
        count: models.length,
        likelyImageModels: models.filter((m) => m.likelyImageModel).map((m) => m.id),
        models,
      }
      return {
        valid: true,
        level: "ok_models",
        summary: `Connection valid. Model list OK (${listed.count} models).`,
        details: [
          ...details,
          "GET /models succeeded — host and key look good.",
          listed.likelyImageModels.length
            ? `Likely image models: ${listed.likelyImageModels.slice(0, 8).join(", ")}${listed.likelyImageModels.length > 8 ? " ..." : ""}`
            : "No name-heuristic image models; show full list via image_list_models.",
        ],
        models: listed,
      }
    } catch (err: any) {
      // 200 but unusable body — fall through to image probe
      details.push(`GET /models returned 200 but list parse failed: ${err?.message || err}`)
    }
  } else {
    const auth = classifyAuthFailure(modelsProbe.status, modelsProbe.body)
    if (auth === "auth") {
      return {
        valid: false,
        level: "invalid_auth",
        summary: "API key rejected by /models (401/403 or auth error).",
        details: [
          ...details,
          `HTTP ${modelsProbe.status}: ${extractErrorMessage(modelsProbe.body, modelsProbe.json)}`,
          "Ask the user for a new key, or cancel setup.",
        ],
      }
    }
    details.push(
      `GET /models not usable (HTTP ${modelsProbe.status}): ${extractErrorMessage(modelsProbe.body, modelsProbe.json)}`,
      "Some providers do not expose /models — running image-endpoint auth probe...",
    )
  }

  // --- Step 2: image endpoint probe (auth/reachability, not a real generation) ---
  if (!api.endpoint) {
    return {
      valid: false,
      level: "invalid_host",
      summary: "Image endpoint is missing.",
      details,
    }
  }

  const probeModel = api.model || "connection-probe"
  const imageProbe = await httpProbe(
    api.endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.key}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: probeModel,
        prompt: "connection probe",
        n: 1,
        size: "1024x1024",
      }),
    },
    30_000,
  )

  if (imageProbe.error) {
    return {
      valid: false,
      level: "invalid_host",
      summary: "Cannot reach the image API endpoint (network/DNS/timeout).",
      details: [...details, `POST image error: ${imageProbe.error}`, "Check host/path/protocol/port."],
    }
  }

  const imageAuth = classifyAuthFailure(imageProbe.status, imageProbe.body)
  if (imageAuth === "auth") {
    return {
      valid: false,
      level: "invalid_auth",
      summary: "API key rejected by the image endpoint.",
      details: [
        ...details,
        `POST image HTTP ${imageProbe.status}: ${extractErrorMessage(imageProbe.body, imageProbe.json)}`,
        "Host is reachable; key looks wrong. Ask for a new key or cancel setup.",
      ],
    }
  }

  // Auth not clearly rejected: treat as connection OK enough to continue without model catalog
  if (imageProbe.status !== null && imageProbe.status < 500) {
    return {
      valid: true,
      level: "ok_auth_no_models",
      summary:
        "Host reachable and key not rejected. /models is unavailable or unusable; user must provide model id manually.",
      details: [
        ...details,
        `POST image probe HTTP ${imageProbe.status}: ${extractErrorMessage(imageProbe.body, imageProbe.json)}`,
        "This usually means the site has no public model list (or different path), not necessarily a bad key.",
        "Next: ask user for a model id they know works, then set_model.",
        "Optional: try a different models_path via set_api.",
      ],
    }
  }

  return {
    valid: false,
    level: "uncertain",
    summary: "Could not confirm the connection (server error on image probe).",
    details: [
      ...details,
      `POST image HTTP ${imageProbe.status}: ${extractErrorMessage(imageProbe.body, imageProbe.json)}`,
      "May be temporary server issue, wrong path, or provider outage.",
      "User may retry, fix path, or cancel setup.",
    ],
  }
}

function formatVerifyResult(result: VerifyResult) {
  const lines = [
    `Verify: ${result.valid ? "PASS" : "FAIL"} (${result.level})`,
    result.summary,
    "",
    ...result.details,
    "",
    "User may cancel setup anytime (退出配置 / cancel) and pause image work.",
  ]
  if (result.models && result.models.count > 0) {
    lines.push(
      "",
      "Likely image models:",
      ...(result.models.likelyImageModels.length
        ? result.models.likelyImageModels.map((id, i) => `  ${i + 1}. ${id}`)
        : ["  (none by name heuristic)"]),
      "",
      "Next: ask user to pick one, then image_configure action=set_model model=<id>",
      "Or image_list_models for the full list.",
    )
  } else if (result.valid && result.level === "ok_auth_no_models") {
    lines.push(
      "",
      "Next: ask user for a known model id on this provider, then set_model.",
    )
  } else if (!result.valid) {
    lines.push("", "Next: fix host/key based on the error above, re-run set_api, or cancel setup.")
  }
  return lines.join("\n")
}

async function generateOne(
  api: ResolvedApi,
  prompt: string,
  size: string,
  outputDir: string,
  timeoutMs = 220_000,
) {
  if (!api.endpoint || !api.model || !api.key) {
    return { ok: false as const, elapsed: 0, error: "API host, model, and key are required." }
  }
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(api.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.key}`,
      },
      body: JSON.stringify({ model: api.model, prompt, n: 1, size }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    const elapsed = Date.now() - start
    if (!res.ok) {
      const body = await res.text()
      let msg = body
      try {
        msg = JSON.parse(body).error?.message || body
      } catch {
        /* keep */
      }
      return { ok: false as const, elapsed, error: `HTTP ${res.status}: ${msg}` }
    }
    const data = (await res.json()) as { data?: Array<{ b64_json?: string }> }
    const b64 = data.data?.[0]?.b64_json
    if (!b64) return { ok: false as const, elapsed, error: "No image data in response" }
    const buf = Buffer.from(b64, "base64")
    const filename = `img_${timestamp()}_${Math.random().toString(36).slice(2, 6)}.png`
    const filepath = join(outputDir, filename)
    writeFileSync(filepath, buf)
    return {
      ok: true as const,
      elapsed,
      path: filepath,
      fileSize: `${(buf.length / 1024 / 1024).toFixed(2)}MB`,
    }
  } catch (err: any) {
    clearTimeout(timer)
    return {
      ok: false as const,
      elapsed: Date.now() - start,
      error: err?.name === "AbortError" ? `Timeout (${timeoutMs / 1000}s)` : String(err?.message || err),
    }
  }
}

async function editOne(
  api: ResolvedApi,
  imagePath: string,
  prompt: string,
  size: string,
  outputDir: string,
  count = 1,
  timeoutMs = 250_000,
) {
  if (!api.endpoint || !api.model || !api.key) {
    return {
      ok: false as const,
      elapsed: 0,
      error: "API host, model, and key are required.",
      sourceName: basename(imagePath),
    }
  }
  if (!existsSync(imagePath)) {
    return { ok: false as const, elapsed: 0, error: `File not found: ${imagePath}`, sourceName: basename(imagePath) }
  }
  const imageData = readFileSync(imagePath)
  const lp = imagePath.toLowerCase()
  const ext =
    lp.endsWith(".jpg") || lp.endsWith(".jpeg") ? "jpeg" : lp.endsWith(".webp") ? "webp" : "png"
  const dataUrl = `data:image/${ext};base64,${imageData.toString("base64")}`
  const sourceName = basename(imagePath)
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(api.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.key}`,
      },
      body: JSON.stringify({ model: api.model, prompt, n: count, size, image: dataUrl }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    const elapsed = Date.now() - start
    if (!res.ok) {
      const body = await res.text()
      let msg = body
      try {
        msg = JSON.parse(body).error?.message || body
      } catch {
        /* keep */
      }
      return { ok: false as const, elapsed, error: `HTTP ${res.status}: ${msg}`, sourceName }
    }
    const data = (await res.json()) as { data?: Array<{ b64_json?: string }> }
    const results: Array<{ path: string; fileSize: string }> = []
    const ts = timestamp()
    for (let i = 0; i < (data.data?.length || 0); i++) {
      const b64 = data.data?.[i]?.b64_json
      if (!b64) continue
      const buf = Buffer.from(b64, "base64")
      const filename = `edit_${ts}_${i + 1}_${Math.random().toString(36).slice(2, 6)}.png`
      const filepath = join(outputDir, filename)
      writeFileSync(filepath, buf)
      results.push({ path: filepath, fileSize: `${(buf.length / 1024 / 1024).toFixed(2)}MB` })
    }
    if (results.length === 0) {
      return { ok: false as const, elapsed, error: "No image data in response", sourceName }
    }
    return { ok: true as const, elapsed, results, sourceName }
  } catch (err: any) {
    clearTimeout(timer)
    return {
      ok: false as const,
      elapsed: Date.now() - start,
      error: err?.name === "AbortError" ? `Timeout (${timeoutMs / 1000}s)` : String(err?.message || err),
      sourceName,
    }
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

function setupProgress(api: ResolvedApi) {
  return {
    connection: api.hasHost && api.hasKey,
    model: api.hasModel,
    ready: api.hasHost && api.hasKey && api.hasModel,
  }
}

function formatStatus(cfg: StoredConfig | null, api: ResolvedApi) {
  if (!configFileExists() && !api.hasKey && !api.hasHost) {
    return setupGuide(`No OpenCode config file found at:\n  ${CONFIG_PATH}`)
  }

  const progress = setupProgress(api)
  const lines = [
    "Image Gen - status",
    "",
    `Config file: ${CONFIG_PATH}`,
    `File exists: ${configFileExists() ? "yes" : "no"}`,
    `Connection:  ${progress.connection ? "ok" : "incomplete"} (host + key)`,
    `Model:       ${progress.model ? "ok" : "not selected yet"}`,
    `Ready:       ${progress.ready ? "yes" : "no"}`,
    `Endpoint:    ${api.endpoint || "(host not set)"}`,
    `Models URL:  ${api.modelsEndpoint || "(host not set)"}`,
    `Model id:    ${api.model ? `${api.model} (${api.modelSource})` : "NOT SET — use image_list_models then set_model"}`,
    `API key:     ${api.key ? `set (${api.keySource}, ${previewSecret(api.key)})` : "NOT SET"}`,
    "",
    "Quick mode:",
    cfg?.quickMode
      ? `  quality=${cfg.quickMode.quality} ratio=${cfg.quickMode.ratio} count=${cfg.quickMode.count}`
      : "  not configured (defaults: 2K / square / 1)",
    "Batch mode:",
    cfg?.batchMode
      ? `  quality=${cfg.batchMode.quality} ratio=${cfg.batchMode.ratio} concurrency=${cfg.batchMode.concurrency}`
      : "  not configured (defaults: 2K / square / concurrency 3)",
    "",
    "Next steps:",
  ]

  if (!api.hasHost || !api.hasKey) {
    lines.push("- Ask user for API key + host only (not model id).")
    lines.push("- image_configure action=set_api host=... key=... (omit model)")
  } else if (!api.hasModel) {
    lines.push("- image_list_models  (discover from provider; do not invent ids)")
    lines.push("- Ask user to pick from the numbered list")
    lines.push("- image_configure action=set_model model=<chosen-id>")
  } else {
    lines.push("- image_generate prompt=\"...\"")
    lines.push("- or image_list_models to change model")
  }

  return lines.join("\n")
}

/** Enough to call /models (key + host). Model not required. */
function requireConnection(api: ResolvedApi) {
  if (!api.hasHost || !api.hasKey) {
    return setupGuide(
      !api.hasHost && !api.hasKey
        ? "API host and key are not configured."
        : !api.hasHost
          ? "API host is not configured."
          : "API key is not configured.",
    )
  }
  return null
}

/** Enough to generate/edit (key + host + model). */
function requireReady(api: ResolvedApi) {
  const conn = requireConnection(api)
  if (conn) return conn
  if (!api.hasModel) {
    return [
      "Connection is configured, but no image model is selected yet.",
      "",
      "Do not ask the user to guess a model id.",
      "1) image_list_models",
      "2) Show the list (prefer [image?] entries) and ask them to pick one",
      "3) image_configure action=set_model model=<id-from-list>",
      "",
      `Config: ${CONFIG_PATH}`,
    ].join("\n")
  }
  return null
}

export const ImageGenPlugin: Plugin = async () => {
  return {
    tool: {
      image_status: tool({
        description: [
          "Show Image Gen setup status (host/key/model). Call first when the user wants images.",
          "If incomplete: set_api (key+host) with auto-verify -> list/pick model -> generate.",
          "Always tell the user they may cancel setup and pause image work.",
          "Never invent model ids; list from provider when /models works.",
        ].join(" "),
        args: {},
        async execute() {
          const cfg = loadConfig()
          const api = resolveApiConfig(cfg)
          return formatStatus(cfg, api)
        },
      }),

      image_configure: tool({
        description: [
          "Configure Image Gen (local config file).",
          "Actions: set_key | set_api | set_model | set_quick_mode | set_batch_mode | verify.",
          "First-time: set_api with host+key only (omit model). Verifies connection after save.",
          "Verification: tries /models first; if that fails, probes image endpoint (models missing != bad key).",
          "If invalid, tell the user and allow cancel/exit setup (暂停任务).",
          "Do not generate images with this tool.",
        ].join(" "),
        args: {
          action: tool.schema
            .enum(["set_key", "set_api", "set_model", "set_quick_mode", "set_batch_mode", "verify"])
            .describe("Configuration action"),
          key: tool.schema.string().optional().describe("API key (set_key / set_api)"),
          protocol: tool.schema.enum(["http", "https"]).optional().describe("set_api"),
          host: tool.schema.string().optional().describe("Domain/IP/localhost only (set_api)"),
          port: tool.schema
            .string()
            .optional()
            .describe('Port number or "default" (set_api)'),
          path: tool.schema.string().optional().describe("Image generations path, e.g. /v1/images/generations"),
          models_path: tool.schema.string().optional().describe("Models list path, e.g. /v1/models"),
          model: tool.schema
            .string()
            .optional()
            .describe("Image model id. Prefer set_model after image_list_models; optional on set_api."),
          quality: tool.schema.enum(["1K", "2K", "4K"]).optional().describe("set_quick_mode / set_batch_mode"),
          ratio: tool.schema
            .enum(["square", "landscape", "portrait"])
            .optional()
            .describe("set_quick_mode / set_batch_mode"),
          count: tool.schema.number().optional().describe("Images per prompt 1-4 (set_quick_mode)"),
          concurrency: tool.schema.number().optional().describe("Parallel jobs 1-10 (set_batch_mode)"),
          skip_verify: tool.schema
            .boolean()
            .optional()
            .describe("If true, set_api/set_key skip network verification after save."),
        },
        async execute(args) {
          try {
            const cfg = loadConfig() || {}

            if (args.action === "verify") {
              const api = resolveApiConfig(cfg, false)
              const missing = requireConnection(api)
              if (missing) return missing
              const result = await verifyConnection(api)
              return formatVerifyResult(result)
            }

            if (args.action === "set_key") {
              if (!args.key?.trim()) return "Error: key is required for set_key."
              cfg.api = { ...(cfg.api && typeof cfg.api === "object" ? cfg.api : {}), key: args.key.trim() }
              delete cfg.apiKey
              saveConfig(cfg)
              const api = resolveApiConfig(cfg, false)
              const lines = [
                "API key saved.",
                `Key: ${previewSecret(args.key.trim())}`,
                `File: ${CONFIG_PATH}`,
                `Endpoint: ${api.endpoint || "(host not set)"}`,
              ]
              if (!api.hasHost) {
                lines.push("Next: image_configure action=set_api host=<api-host> (model not required yet)")
                lines.push("User may cancel setup anytime.")
                return lines.join("\n")
              }
              if (args.skip_verify) {
                lines.push("Verify skipped (skip_verify=true).")
                lines.push(
                  api.hasModel
                    ? "Ready: image_generate"
                    : "Next: image_list_models or image_configure action=verify",
                )
                return lines.join("\n")
              }
              const result = await verifyConnection(api)
              lines.push("", formatVerifyResult(result))
              return lines.join("\n")
            }

            if (args.action === "set_model") {
              if (!args.model?.trim()) return "Error: model is required for set_model. Prefer picking an id from image_list_models."
              const current = resolveApiConfig(cfg, false)
              if (!current.hasHost || !current.hasKey) {
                return setupGuide("Set host + key before selecting a model.")
              }
              cfg.api = apiForStorage({
                ...current,
                model: normalizeModel(args.model),
                hasModel: true,
              } as ResolvedApi)
              // preserve model string explicitly
              cfg.api = {
                ...cfg.api,
                model: normalizeModel(args.model),
              }
              delete cfg.apiKey
              saveConfig(cfg)
              return [
                "Image model saved.",
                `Model:    ${normalizeModel(args.model)}`,
                `Endpoint: ${current.endpoint}`,
                `File:     ${CONFIG_PATH}`,
                "",
                "You can generate now: image_generate prompt=\"...\"",
              ].join("\n")
            }

            if (args.action === "set_api") {
              const hasAny = [
                args.protocol,
                args.host,
                args.port,
                args.path,
                args.models_path,
                args.model,
                args.key,
              ].some((v) => v !== undefined && v !== null && String(v).length > 0)
              if (!hasAny) {
                return "Error: set_api requires at least host and/or key (model is optional)."
              }

              const current = resolveApiConfig(cfg, false)
              const nextHost = firstDefined(args.host, current.host) || ""
              if (args.host !== undefined) normalizeHost(args.host, { required: true })

              cfg.api = {
                protocol: firstDefined(args.protocol, current.protocol),
                host: nextHost,
                port: args.port === undefined ? current.port : normalizePort(args.port),
                path: firstDefined(args.path, current.path),
                modelsPath: firstDefined(args.models_path, current.modelsPath),
                key: firstDefined(args.key, current.key) || undefined,
                // model optional: only write when user provided it
                model:
                  args.model !== undefined
                    ? normalizeModel(args.model)
                    : current.model || undefined,
              }
              if (!cfg.api.host) {
                return "Error: host is required for a usable connection (domain/IP only, no https://)."
              }
              normalizeHost(cfg.api.host, { required: true })
              delete cfg.apiKey
              const saved = resolveApiConfig(cfg, false)
              cfg.api = {
                protocol: saved.protocol,
                host: saved.host,
                port: saved.port,
                path: saved.path,
                modelsPath: saved.modelsPath,
                key: saved.key || undefined,
                model: saved.model || undefined,
              }
              saveConfig(cfg)

              const lines = [
                "API connection saved.",
                `Endpoint: ${saved.endpoint}`,
                `Models:   ${saved.modelsEndpoint}`,
                `Model:    ${saved.model || "NOT SET"}`,
                `Key:      ${previewSecret(saved.key) || "not set"}`,
                `File:     ${CONFIG_PATH}`,
              ]

              if (!saved.hasKey) {
                lines.push("", "Key still missing. Ask for key or cancel setup.")
                return lines.join("\n")
              }

              if (args.skip_verify) {
                lines.push("", "Verify skipped (skip_verify=true). Run image_configure action=verify when ready.")
                return lines.join("\n")
              }

              const result = await verifyConnection(saved)
              lines.push("", formatVerifyResult(result))
              if (!result.valid) {
                lines.push(
                  "",
                  "Config was still saved so the user can edit host/key and retry.",
                  "If they want to stop: accept cancel and pause image generation.",
                )
              }
              return lines.join("\n")
            }

            if (args.action === "set_quick_mode") {
              cfg.quickMode = {
                quality: (args.quality || cfg.quickMode?.quality || DEFAULTS.quality).toUpperCase(),
                ratio: (args.ratio || cfg.quickMode?.ratio || DEFAULTS.ratio).toLowerCase(),
                count: Math.max(1, Math.min(args.count ?? cfg.quickMode?.count ?? DEFAULTS.count, 4)),
              }
              saveConfig(cfg)
              const q = cfg.quickMode.quality!
              const r = cfg.quickMode.ratio!
              const size = resolveSize(q, r)
              return [
                "Quick mode saved.",
                `Quality: ${q}`,
                `Ratio:   ${RATIO_LABEL[r] || r}${size ? ` (${size})` : ""}`,
                `Count:   ${cfg.quickMode.count}`,
                `File:    ${CONFIG_PATH}`,
                "",
                "Later: image_generate with only prompt uses these defaults.",
              ].join("\n")
            }

            if (args.action === "set_batch_mode") {
              cfg.batchMode = {
                quality: (args.quality || cfg.batchMode?.quality || DEFAULTS.quality).toUpperCase(),
                ratio: (args.ratio || cfg.batchMode?.ratio || DEFAULTS.ratio).toLowerCase(),
                concurrency: Math.max(
                  1,
                  Math.min(args.concurrency ?? cfg.batchMode?.concurrency ?? DEFAULTS.concurrency, 10),
                ),
              }
              saveConfig(cfg)
              const q = cfg.batchMode.quality!
              const r = cfg.batchMode.ratio!
              const size = resolveSize(q, r)
              return [
                "Batch mode saved.",
                `Quality:     ${q}`,
                `Ratio:       ${RATIO_LABEL[r] || r}${size ? ` (${size})` : ""}`,
                `Concurrency: ${cfg.batchMode.concurrency}`,
                `File:        ${CONFIG_PATH}`,
              ].join("\n")
            }

            return `Error: unknown action ${args.action}`
          } catch (err: any) {
            return `Error: ${err?.message || err}`
          }
        },
      }),

      image_list_models: tool({
        description: [
          "Query the configured OpenAI-compatible /models endpoint and list available models.",
          "Use AFTER host+key are saved, and BEFORE asking the user for a model id.",
          "Prefer models flagged [image?]. Present a numbered list and let the user pick;",
          "then call image_configure set_model. Requires connection only (not a selected model).",
          "Does not search the public web.",
        ].join(" "),
        args: {},
        async execute() {
          try {
            const api = resolveApiConfig()
            const missing = requireConnection(api)
            if (missing) return missing
            const result = await queryModels(api)
            const lines = [
              `Models endpoint: ${result.modelsEndpoint}`,
              `Currently selected: ${result.selectedModel || "none"} (${result.selectedModel ? (result.selectedModelAvailable ? "in list" : "not in list") : "n/a"})`,
              `Total models: ${result.count}`,
              "",
              "Likely image models (prefer these):",
              ...(result.likelyImageModels.length
                ? result.likelyImageModels.map((id, i) => `  ${i + 1}. ${id}`)
                : ["  (none matched name heuristics — show full list below)"]),
              "",
              "All models:",
              ...result.models.map((m, i) => `  ${i + 1}. ${m.id}${m.likelyImageModel ? "  [image?]" : ""}`),
              "",
              "Ask the user which number/id to use, then:",
              "  image_configure action=set_model model=<id-from-list>",
              "Do not invent model ids that are not in this list.",
            ]
            return lines.join("\n")
          } catch (err: any) {
            return `Error listing models: ${err?.message || err}`
          }
        },
      }),

      image_generate: tool({
        description: [
          "Generate image(s) via the configured OpenAI-compatible image API (b64_json response).",
          "Use when the user wants to create/draw images with Image Gen.",
          "Requires host+key+model. If model missing, run image_list_models and set_model first.",
          "quality: 1K|2K|4K; ratio: square|landscape|portrait; count 1-4 variations of the same prompt.",
          "For multiple different prompts, pass prompts as a JSON array string in batch_prompts.",
        ].join(" "),
        args: {
          prompt: tool.schema.string().optional().describe("Single image prompt"),
          batch_prompts: tool.schema
            .string()
            .optional()
            .describe('JSON array of prompts, e.g. ["a cat","a dog"] for batch generation'),
          quality: tool.schema.enum(["1K", "2K", "4K"]).optional(),
          ratio: tool.schema.enum(["square", "landscape", "portrait"]).optional(),
          count: tool.schema.number().optional().describe("Variations of one prompt (1-4)"),
          concurrency: tool.schema.number().optional().describe("Batch concurrency (1-10)"),
          output_dir: tool.schema.string().optional().describe("Directory to save PNGs"),
        },
        async execute(args) {
          try {
            const cfg = loadConfig()
            const api = resolveApiConfig(cfg)
            const missing = requireReady(api)
            if (missing) return missing

            let prompts: string[] = []
            if (args.batch_prompts?.trim()) {
              const parsed = JSON.parse(args.batch_prompts)
              if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string" && p.trim())) {
                return 'Error: batch_prompts must be a JSON array of non-empty strings.'
              }
              prompts = parsed.map((p: string) => p.trim())
            } else if (args.prompt?.trim()) {
              prompts = [args.prompt.trim()]
            } else {
              return "Error: provide prompt or batch_prompts."
            }

            const isBatch = prompts.length > 1 || !!args.batch_prompts
            const mode = isBatch ? cfg?.batchMode : cfg?.quickMode
            const quality = (args.quality || mode?.quality || DEFAULTS.quality).toUpperCase()
            const ratio = (args.ratio || mode?.ratio || DEFAULTS.ratio).toLowerCase()
            const size = resolveSize(quality, ratio)
            if (!size) return `Error: invalid quality="${quality}" or ratio="${ratio}".`

            const outputDir = resolveOutputDir(args.output_dir)
            const concurrency = Math.max(
              1,
              Math.min(
                args.concurrency ?? cfg?.batchMode?.concurrency ?? DEFAULTS.concurrency,
                10,
              ),
            )

            // Single prompt with count variations
            if (prompts.length === 1 && !args.batch_prompts) {
              const count = Math.max(1, Math.min(args.count ?? cfg?.quickMode?.count ?? DEFAULTS.count, 4))
              if (count === 1) {
                const result = await generateOne(api, prompts[0], size, outputDir)
                if (!result.ok) return `Generation failed: ${result.error}`
                return [
                  "Image generated.",
                  `Prompt:  ${prompts[0]}`,
                  `Model:   ${api.model}`,
                  `Size:    ${size} (${quality}/${ratio})`,
                  `Time:    ${(result.elapsed / 1000).toFixed(1)}s`,
                  `File:    ${result.path}`,
                  `Bytes:   ${result.fileSize}`,
                ].join("\n")
              }
              prompts = Array(count).fill(prompts[0])
            }

            const startAll = Date.now()
            const results = await mapPool(prompts, concurrency, async (prompt) => {
              const r = await generateOne(api, prompt, size, outputDir)
              return { prompt, ...r }
            })
            const totalTime = Date.now() - startAll
            const ok = results.filter((r) => r.ok)
            const fail = results.filter((r) => !r.ok)
            const lines = [
              `Batch generation finished: ${ok.length}/${results.length} ok in ${(totalTime / 1000).toFixed(1)}s`,
              `Model: ${api.model}  Size: ${size}  Dir: ${outputDir}`,
              "",
            ]
            results.forEach((r, i) => {
              if (r.ok) {
                lines.push(`[${i + 1}] ok  ${(r.elapsed / 1000).toFixed(1)}s  ${r.fileSize}`)
                lines.push(`    ${r.path}`)
                lines.push(`    prompt: ${r.prompt}`)
              } else {
                lines.push(`[${i + 1}] fail  ${r.error}`)
                lines.push(`    prompt: ${r.prompt}`)
              }
            })
            if (fail.length) lines.push("", `${fail.length} failed.`)
            return lines.join("\n")
          } catch (err: any) {
            return `Error: ${err?.message || err}`
          }
        },
      }),

      image_edit: tool({
        description: [
          "Edit an existing image with the configured image API (sends image as data URL + prompt).",
          "Use when the user wants to modify a local image (background change, add/remove objects, style transfer).",
          "image_path must be a readable local file (png/jpg/webp).",
        ].join(" "),
        args: {
          image_path: tool.schema.string().describe("Absolute or relative path to source image"),
          prompt: tool.schema.string().describe("Edit instruction"),
          quality: tool.schema.enum(["1K", "2K", "4K"]).optional(),
          ratio: tool.schema.enum(["square", "landscape", "portrait"]).optional(),
          count: tool.schema.number().optional().describe("Number of edit variants 1-4"),
          output_dir: tool.schema.string().optional(),
        },
        async execute(args) {
          try {
            const cfg = loadConfig()
            const api = resolveApiConfig(cfg)
            const missing = requireReady(api)
            if (missing) return missing
            if (!args.image_path?.trim()) return "Error: image_path is required."
            if (!args.prompt?.trim()) return "Error: prompt is required."

            const quality = (args.quality || cfg?.quickMode?.quality || DEFAULTS.quality).toUpperCase()
            const ratio = (args.ratio || cfg?.quickMode?.ratio || DEFAULTS.ratio).toLowerCase()
            const size = resolveSize(quality, ratio)
            if (!size) return `Error: invalid quality="${quality}" or ratio="${ratio}".`

            const count = Math.max(1, Math.min(args.count ?? 1, 4))
            const outputDir = resolveOutputDir(args.output_dir)
            const result = await editOne(api, args.image_path.trim(), args.prompt.trim(), size, outputDir, count)
            if (!result.ok) {
              return `Edit failed (${result.sourceName}): ${result.error}`
            }
            const lines = [
              "Image edit completed.",
              `Source:  ${result.sourceName}`,
              `Prompt:  ${args.prompt.trim()}`,
              `Model:   ${api.model}`,
              `Size:    ${size}`,
              `Time:    ${(result.elapsed / 1000).toFixed(1)}s`,
              `Output:  ${outputDir}`,
              "",
              ...result.results.map((r, i) => `${i + 1}. ${r.path}  (${r.fileSize})`),
            ]
            return lines.join("\n")
          } catch (err: any) {
            return `Error: ${err?.message || err}`
          }
        },
      }),
    },
  }
}
