/**
 * OpenCode port of niu-image-gen (Codex / AiMaMi lineage).
 *
 * Upstream: borawong/AiMaMi (Apache-2.0), commit 297c7af
 * Codex marketplace port: Big-Molecule/CodexPlugins
 * OpenCode adaptation: config under ~/.config/opencode, tool-based API, minimal decoration.
 *
 * See plugins/niu-image-gen.NOTICE.md for attribution.
 */

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

const CONFIG_PATH = join(homedir(), ".config", "opencode", "niu-image-gen.json")
const LEGACY_CONFIG_PATH = join(homedir(), ".codex", "niu-image-gen-config.json")

const DEFAULT_API = Object.freeze({
  protocol: "https",
  host: "api.iiiiitoken.com",
  port: null as number | null,
  path: "/v1/images/generations",
  modelsPath: "/v1/models",
  model: "gpt-image-2-x",
})

const API_ENV = Object.freeze({
  protocol: "NIU_IMAGE_GEN_API_PROTOCOL",
  host: "NIU_IMAGE_GEN_API_HOST",
  port: "NIU_IMAGE_GEN_API_PORT",
  path: "NIU_IMAGE_GEN_API_PATH",
  modelsPath: "NIU_IMAGE_GEN_API_MODELS_PATH",
  key: "NIU_IMAGE_GEN_API_KEY",
  model: "NIU_IMAGE_GEN_API_MODEL",
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
  endpoint: string
  modelsPath: string
  modelsEndpoint: string
  key: string | null
  keySource: string | null
  model: string
  modelSource: string
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

function normalizeHost(value: unknown) {
  const host = String(value || "").trim()
  if (!host || host.includes("://") || /[/?#@\s]/.test(host)) {
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

function normalizeModel(value: unknown) {
  const model = String(value || "").trim()
  if (!model) throw new Error("API model must not be empty.")
  return model
}

function previewSecret(value: string | null | undefined) {
  if (!value) return null
  if (value.length <= 8) return `${value.slice(0, 2)}...${value.slice(-2)}`
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function loadConfig(): StoredConfig | null {
  for (const path of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as StoredConfig
    } catch {
      /* try next */
    }
  }
  return null
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
  )
  const port = normalizePort(firstDefined(env[API_ENV.port], stored.port, DEFAULT_API.port))
  const path = normalizePath(firstDefined(env[API_ENV.path], stored.path, DEFAULT_API.path))
  const modelsPath = normalizePath(
    firstDefined(env[API_ENV.modelsPath], stored.modelsPath, DEFAULT_API.modelsPath),
  )
  const model = normalizeModel(firstDefined(env[API_ENV.model], stored.model, DEFAULT_API.model))
  const modelSource = env[API_ENV.model]
    ? API_ENV.model
    : stored.model
      ? "config.api.model"
      : "default"
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

  const authority = port === null ? host : `${host}:${port}`
  const endpoint = new URL(path, `${protocol}://${authority}/`).toString()
  const modelsEndpoint = new URL(modelsPath, `${protocol}://${authority}/`).toString()

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
    model: api.model,
  }
}

function resolveSize(quality: string, ratio: string) {
  return SIZE_MATRIX[quality.toUpperCase()]?.[ratio.toLowerCase()] || null
}

function resolveOutputDir(userDir?: string) {
  const dir = userDir?.trim() || join(homedir(), "Pictures", "niu-image-gen")
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

async function queryModels(api: ResolvedApi) {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (api.key) headers.Authorization = `Bearer ${api.key}`
  const response = await fetch(api.modelsEndpoint, { method: "GET", headers })
  if (!response.ok) {
    const body = await response.text()
    let message = body
    try {
      message = JSON.parse(body).error?.message || body
    } catch {
      /* keep */
    }
    throw new Error(`Model query failed HTTP ${response.status}: ${message}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error("Model-list endpoint did not return valid JSON.")
  }
  const models = extractModels(payload)
  return {
    modelsEndpoint: api.modelsEndpoint,
    selectedModel: api.model,
    selectedModelAvailable: models.some((m) => m.id === api.model),
    count: models.length,
    likelyImageModels: models.filter((m) => m.likelyImageModel).map((m) => m.id),
    models,
  }
}

async function generateOne(
  api: ResolvedApi,
  prompt: string,
  size: string,
  outputDir: string,
  timeoutMs = 220_000,
) {
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

function formatStatus(cfg: StoredConfig | null, api: ResolvedApi) {
  const lines = [
    "Niu Image Gen — status",
    "",
    `Config file: ${CONFIG_PATH}`,
    `Endpoint:    ${api.endpoint}`,
    `Models URL:  ${api.modelsEndpoint}`,
    `Model:       ${api.model} (${api.modelSource})`,
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
    "Env overrides: NIU_IMAGE_GEN_API_PROTOCOL|HOST|PORT|PATH|MODELS_PATH|KEY|MODEL",
    "",
    "Next steps:",
    api.key
      ? "- Use niu_image_generate with a prompt, or niu_image_list_models to pick a model."
      : "- Call niu_image_configure with action=set_key (or set_api) before generating.",
  ]
  return lines.join("\n")
}

function requireKey(api: ResolvedApi) {
  if (!api.key) {
    return [
      "API key is not configured.",
      `Set env ${API_ENV.key}, or call niu_image_configure with action=set_key / set_api.`,
      `Config path: ${CONFIG_PATH}`,
    ].join("\n")
  }
  return null
}

export const NiuImageGenPlugin: Plugin = async () => {
  return {
    tool: {
      niu_image_status: tool({
        description:
          "Show Niu Image Gen configuration status (endpoint, model, key presence, quick/batch defaults). Call this first when the user wants to generate or edit images with Niu Image Gen, or when checking setup. Do not use for OpenCode built-in image tools.",
        args: {},
        async execute() {
          const cfg = loadConfig()
          const api = resolveApiConfig(cfg)
          return formatStatus(cfg, api)
        },
      }),

      niu_image_configure: tool({
        description: [
          "Configure Niu Image Gen (local config file, no network except validation).",
          "Actions: set_key | set_api | set_model | set_quick_mode | set_batch_mode.",
          "Use when the user provides API key, endpoint, model, or default quality/ratio.",
          "Do not generate images with this tool.",
        ].join(" "),
        args: {
          action: tool.schema
            .enum(["set_key", "set_api", "set_model", "set_quick_mode", "set_batch_mode"])
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
          model: tool.schema.string().optional().describe("Image model id (set_model / set_api)"),
          quality: tool.schema.enum(["1K", "2K", "4K"]).optional().describe("set_quick_mode / set_batch_mode"),
          ratio: tool.schema
            .enum(["square", "landscape", "portrait"])
            .optional()
            .describe("set_quick_mode / set_batch_mode"),
          count: tool.schema.number().optional().describe("Images per prompt 1-4 (set_quick_mode)"),
          concurrency: tool.schema.number().optional().describe("Parallel jobs 1-10 (set_batch_mode)"),
        },
        async execute(args) {
          try {
            const cfg = loadConfig() || {}

            if (args.action === "set_key") {
              if (!args.key?.trim()) return "Error: key is required for set_key."
              cfg.api = { ...(cfg.api && typeof cfg.api === "object" ? cfg.api : {}), key: args.key.trim() }
              delete cfg.apiKey
              saveConfig(cfg)
              const api = resolveApiConfig(cfg, false)
              return [
                "API key saved.",
                `Key: ${previewSecret(args.key.trim())}`,
                `File: ${CONFIG_PATH}`,
                `Will authenticate to: ${api.endpoint}`,
              ].join("\n")
            }

            if (args.action === "set_model") {
              if (!args.model?.trim()) return "Error: model is required for set_model."
              const current = resolveApiConfig(cfg, false)
              cfg.api = apiForStorage({ ...current, model: normalizeModel(args.model) })
              delete cfg.apiKey
              saveConfig(cfg)
              return [
                "Image model updated.",
                `Model: ${cfg.api.model}`,
                `Endpoint: ${current.endpoint}`,
                `File: ${CONFIG_PATH}`,
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
              if (!hasAny) return "Error: set_api requires at least one of protocol/host/port/path/models_path/model/key."

              const current = resolveApiConfig(cfg, false)
              cfg.api = {
                protocol: firstDefined(args.protocol, current.protocol),
                host: firstDefined(args.host, current.host),
                port: args.port === undefined ? current.port : normalizePort(args.port),
                path: firstDefined(args.path, current.path),
                modelsPath: firstDefined(args.models_path, current.modelsPath),
                key: firstDefined(args.key, current.key),
                model: firstDefined(args.model, current.model),
              }
              delete cfg.apiKey
              const saved = resolveApiConfig(cfg, false)
              cfg.api = apiForStorage(saved)
              saveConfig(cfg)
              return [
                "API configuration saved.",
                `Endpoint: ${saved.endpoint}`,
                `Models:   ${saved.modelsEndpoint}`,
                `Model:    ${saved.model}`,
                `Key:      ${previewSecret(saved.key) || "not set"}`,
                `File:     ${CONFIG_PATH}`,
              ].join("\n")
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
                "Later: niu_image_generate with only prompt uses these defaults.",
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

      niu_image_list_models: tool({
        description:
          "Query the configured OpenAI-compatible /models endpoint and list available models. Prefer models flagged as likely image models. Use when choosing or verifying an image model. Does not search the public web.",
        args: {},
        async execute() {
          try {
            const api = resolveApiConfig()
            const result = await queryModels(api)
            const lines = [
              `Models endpoint: ${result.modelsEndpoint}`,
              `Selected model:  ${result.selectedModel} (${result.selectedModelAvailable ? "present in list" : "not in list"})`,
              `Total models:    ${result.count}`,
              "",
              "Likely image models:",
              ...(result.likelyImageModels.length
                ? result.likelyImageModels.map((id, i) => `  ${i + 1}. ${id}`)
                : ["  (none matched name heuristics)"]),
              "",
              "All models:",
              ...result.models.map((m, i) => `  ${i + 1}. ${m.id}${m.likelyImageModel ? "  [image?]" : ""}`),
              "",
              "To select: niu_image_configure action=set_model model=<id>",
            ]
            return lines.join("\n")
          } catch (err: any) {
            return `Error listing models: ${err?.message || err}`
          }
        },
      }),

      niu_image_generate: tool({
        description: [
          "Generate image(s) via the configured OpenAI-compatible image API (b64_json response).",
          "Use when the user wants to create/draw images with Niu Image Gen.",
          "Requires API key (niu_image_status / niu_image_configure first if missing).",
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
            const missing = requireKey(api)
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

      niu_image_edit: tool({
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
            const missing = requireKey(api)
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
