import { defineToolsPlugin, type ToolFactory, tool } from "./lib/tools.ts"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

const API_BASE = "https://api.elsevier.com"
const SEARCH_PATH = "/content/search/sciencedirect"
const METADATA_SEARCH_PATH = "/content/metadata/article"
const AUTH_PATH = "/authenticate/"
const CONFIG_PATH = join(homedir(), ".config", "opencode", "sciencedirect.json")
const API_KEY_REGISTRATION_URL = "https://dev.elsevier.com/apikey/manage"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_FULL_TEXT_CHARS = 30_000
const MAX_FULL_TEXT_CHARS = 100_000
const MAX_ABSTRACT_CHARS = 25_000
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024
const MAX_SECRET_FILE_BYTES = 16 * 1024
const SEARCH_PAGE_SIZES = [10, 25, 50, 100] as const
const METADATA_PAGE_SIZES = [10, 25] as const
const MAX_SEARCH_RESULTS = 100
const SESSION_TOKEN_LIFETIME_MS = 115 * 60 * 1000

const IDENTIFIER_TYPES = ["auto", "doi", "pii", "eid", "scopus_id", "pubmed_id"] as const
const ARTICLE_MODES = ["metadata", "abstract", "full_text"] as const
const SEARCH_APIS = ["auto", "search_v2", "metadata"] as const

type IdentifierType = Exclude<(typeof IDENTIFIER_TYPES)[number], "auto">
type ArticleMode = (typeof ARTICLE_MODES)[number]
type SearchApiMode = (typeof SEARCH_APIS)[number]

export type ElsevierCredentials = {
  apiKey: string
  instToken?: string
  authToken?: string
  oauthToken?: string
}

type RateLimit = {
  limit?: string
  remaining?: string
  reset?: string
}

export type ElsevierResponse = {
  ok: boolean
  status: number
  statusText: string
  contentType: string
  body: string
  elsStatus?: string
  location?: string
  rateLimit: RateLimit
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

type SearchInput = {
  query?: string
  title?: string
  authors?: string
  publication?: string
  year?: string
  open_access_only?: boolean
  loaded_after?: string
  offset?: number
  limit?: number
  sort?: string
  highlights?: boolean
  search_api?: SearchApiMode
}

type InMemoryAuth = {
  token: string
  expiresAt: number
}

type StoredConfig = {
  version?: number
  mutationId?: string
  apiKey?: string
  api_key?: string
  instToken?: string
  inst_token?: string
}

type ScienceDirectPluginOptions = {
  configPath?: string
  fetchImpl?: FetchLike
}

function configFileExists(configPath = CONFIG_PATH) {
  return existsSync(configPath)
}

function loadConfig(configPath = CONFIG_PATH): StoredConfig | null {
  if (!configFileExists(configPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as StoredConfig
  } catch {
    return null
  }
}

function saveConfig(config: StoredConfig, configPath = CONFIG_PATH) {
  const directory = dirname(configPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(directory, `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    try {
      chmodSync(temporaryPath, 0o600)
    } catch {
      /* Windows relies on the user profile directory ACL. */
    }
    renameSync(temporaryPath, configPath)
    try {
      chmodSync(configPath, 0o600)
    } catch {
      /* Windows relies on the user profile directory ACL. */
    }
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

async function withConfigLock<T>(
  configPath: string,
  signal: AbortSignal | undefined,
  operation: () => T,
): Promise<T> {
  const lockPath = `${configPath}.lock`
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (signal?.aborted) throw new Error("ScienceDirect configuration change cancelled.")
    let handle: number | undefined
    try {
      handle = openSync(lockPath, "wx", 0o600)
      return operation()
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      if (code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 120_000) rmSync(lockPath, { force: true })
      } catch {
        /* Another process may have released the lock. */
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      if (handle !== undefined) {
        closeSync(handle)
        rmSync(lockPath, { force: true })
      }
    }
  }
  throw new Error("Timed out waiting for another ScienceDirect configuration change to finish.")
}

function storedApiKey(config: StoredConfig | null) {
  return nonEmptyConfigString(config?.apiKey) || nonEmptyConfigString(config?.api_key)
}

function storedInstToken(config: StoredConfig | null) {
  return nonEmptyConfigString(config?.instToken) || nonEmptyConfigString(config?.inst_token)
}

function nonEmptyConfigString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function configRevision(configPath = CONFIG_PATH) {
  const config = loadConfig(configPath)
  if (typeof config?.mutationId === "string" && config.mutationId) return config.mutationId
  return configFileExists(configPath) ? "legacy-or-invalid" : "missing"
}

function getElsevierCredentials(
  env: NodeJS.ProcessEnv = process.env,
  configPath = CONFIG_PATH,
): ElsevierCredentials {
  const config = loadConfig(configPath)
  const configuredKey = storedApiKey(config)
  const configuredInstToken = storedInstToken(config)
  return {
    apiKey: env.ELSEVIER_API_KEY?.trim() || env.SCIENCEDIRECT_API_KEY?.trim() || configuredKey,
    instToken: env.ELSEVIER_INST_TOKEN?.trim() || configuredInstToken || undefined,
    authToken: env.ELSEVIER_AUTHTOKEN?.trim() || undefined,
    oauthToken: env.ELSEVIER_OAUTH_TOKEN?.trim() || undefined,
  }
}

function apiKeySource(env: NodeJS.ProcessEnv = process.env, configPath = CONFIG_PATH) {
  if (env.ELSEVIER_API_KEY?.trim()) return "ELSEVIER_API_KEY"
  if (env.SCIENCEDIRECT_API_KEY?.trim()) return "SCIENCEDIRECT_API_KEY"
  if (storedApiKey(loadConfig(configPath))) return "local config"
  return null
}

function instTokenSource(env: NodeJS.ProcessEnv = process.env, configPath = CONFIG_PATH) {
  if (env.ELSEVIER_INST_TOKEN?.trim()) return "ELSEVIER_INST_TOKEN"
  if (storedInstToken(loadConfig(configPath))) return "local config"
  return null
}

function activeAuthToken(state: { current: InMemoryAuth | null }, now = Date.now()) {
  if (!state.current) return undefined
  if (state.current.expiresAt <= now) {
    state.current = null
    return undefined
  }
  return state.current.token
}

function normalizeSecretValue(value: unknown, label: string) {
  const normalized = String(value || "").trim()
  if (!normalized) throw new Error(`${label} must not be empty.`)
  if (normalized.length > 512) throw new Error(`${label} must be at most 512 characters.`)
  if (/[\u0000-\u0020\u007f]/.test(normalized)) {
    throw new Error(`${label} must not contain whitespace or control characters.`)
  }
  return normalized
}

function readSecretFromFile(filePath: string, baseDirectory: string | undefined, label: string) {
  const rawPath = filePath.trim()
  if (!rawPath) throw new Error(`${label}_file must not be empty.`)
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(baseDirectory || process.cwd(), rawPath)
  if (!existsSync(resolved)) throw new Error(`${label}_file does not exist: ${resolved}`)
  const stats = statSync(resolved)
  if (!stats.isFile()) throw new Error(`${label}_file is not a regular file: ${resolved}`)
  if (stats.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(`${label}_file exceeds ${MAX_SECRET_FILE_BYTES} bytes.`)
  }
  const content = readFileSync(resolved, "utf8").trim()
  return normalizeSecretValue(content, label)
}

function buildHeaders(
  credentials: ElsevierCredentials,
  accept: string,
  sessionToken?: string,
  hasJsonBody = false,
) {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-ELS-APIKey": credentials.apiKey,
  }
  if (hasJsonBody) headers["Content-Type"] = "application/json"
  if (credentials.oauthToken) {
    headers.Authorization = credentials.oauthToken.startsWith("Bearer ")
      ? credentials.oauthToken
      : `Bearer ${credentials.oauthToken}`
  } else if (credentials.instToken) {
    headers["X-ELS-Insttoken"] = credentials.instToken
  } else {
    const authToken = sessionToken || credentials.authToken
    if (authToken) headers["X-ELS-Authtoken"] = authToken
  }
  return headers
}

async function readResponseBody(response: Response, maxBytes: number) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel()
    return { body: "", tooLarge: true }
  }
  if (!response.body) return { body: "", tooLarge: false }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ""
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      return { body: "", tooLarge: true }
    }
    body += decoder.decode(chunk.value, { stream: true })
  }
  body += decoder.decode()
  return { body, tooLarge: false }
}

async function requestElsevier(
  path: string,
  options: {
    credentials: ElsevierCredentials
    method?: "GET" | "PUT"
    accept?: string
    body?: unknown
    sessionToken?: string
    timeoutMs?: number
    maxResponseBytes?: number
    fetchImpl?: FetchLike
    signal?: AbortSignal
  },
): Promise<ElsevierResponse> {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let didTimeout = false
  const abortFromCaller = () => controller.abort()
  if (options.signal?.aborted) abortFromCaller()
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort()
  }, timeoutMs)
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    const response = await fetchImpl(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: buildHeaders(
        options.credentials,
        options.accept ?? "application/json",
        options.sessionToken,
        options.body !== undefined,
      ),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
      signal: controller.signal,
    })
    const contentType = response.headers.get("content-type") || ""
    const rateLimit = {
      limit: response.headers.get("x-ratelimit-limit") || undefined,
      remaining: response.headers.get("x-ratelimit-remaining") || undefined,
      reset: response.headers.get("x-ratelimit-reset") || undefined,
    }
    const content = await readResponseBody(response, options.maxResponseBytes ?? MAX_RESPONSE_BYTES)
    if (content.tooLarge) {
      return {
        ok: false,
        status: 413,
        statusText: `Response exceeded the local ${options.maxResponseBytes ?? MAX_RESPONSE_BYTES} byte limit`,
        contentType,
        body: "",
        elsStatus: response.headers.get("x-els-status") || undefined,
        location: response.headers.get("location") || undefined,
        rateLimit,
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType,
      body: content.body,
      elsStatus: response.headers.get("x-els-status") || undefined,
      location: response.headers.get("location") || undefined,
      rateLimit,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = options.signal?.aborted && !didTimeout
    return {
      ok: false,
      status: 0,
      statusText: didTimeout ? `Timed out after ${timeoutMs}ms` : cancelled ? "Request cancelled" : message,
      contentType: "",
      body: "",
      rateLimit: {},
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abortFromCaller)
  }
}

function decodeEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (/^#x/i.test(entity)) {
      const codePoint = Number.parseInt(entity.slice(2), 16)
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10)
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function validCodePoint(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
}

function cleanMarkup(value: string) {
  const stripTags = (input: string) =>
    input
      .replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>/gi, " ")
      .replace(
        /<\/?[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g,
        (tag) => {
          const name = tag.match(/^<\/?([A-Za-z_][\w:.-]*)/)?.[1] || ""
          return /(?:^|:)(?:abstract|br|p|para|section|title)$/i.test(name) ? "\n" : " "
        },
      )

  let decoded = value
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeEntities(stripTags(decoded))
    if (next === decoded) break
    decoded = next
  }
  return stripTags(decoded)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(scalar).find(Boolean) || ""
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["$", "_", "value", "@value"]) {
      const text = scalar(record[key])
      if (text) return text
    }
  }
  return ""
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value
  const text = scalar(value).toLowerCase()
  if (["1", "true", "yes"].includes(text)) return true
  if (["0", "false", "no"].includes(text)) return false
  return null
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function findProperty(value: unknown, names: string[]): unknown {
  if (!value || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProperty(item, names)
      if (found !== undefined) return found
    }
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    if (names.includes(key.toLowerCase())) return child
  }
  for (const child of Object.values(record)) {
    const found = findProperty(child, names)
    if (found !== undefined) return found
  }
  return undefined
}

function apiErrorCode(response: ElsevierResponse) {
  const parsed = parseJson(response.body)
  if (parsed) {
    const code = scalar(findProperty(parsed, ["error-code", "errorcode", "statuscode"]))
    if (code) return code
  }
  return cleanMarkup(response.body.match(/<statusCode[^>]*>([\s\S]*?)<\/statusCode>/i)?.[1] || "")
}

function apiMessage(response: ElsevierResponse) {
  const parsed = parseJson(response.body)
  if (parsed) {
    const found = findProperty(parsed, [
      "message",
      "error-message",
      "errormessage",
      "statustext",
      "error_description",
    ])
    const text = scalar(found)
    if (text) return cleanMarkup(text)
  }

  const statusText = response.body.match(/<statusText[^>]*>([\s\S]*?)<\/statusText>/i)?.[1]
  if (statusText) return cleanMarkup(statusText)
  const stripped = cleanMarkup(response.body)
  return stripped.length > 500 ? `${stripped.slice(0, 500)}...` : stripped
}

function isInvalidApiKey(response: ElsevierResponse) {
  if (response.status !== 401 && response.status !== 403) return false
  const code = apiErrorCode(response).toUpperCase()
  if (code === "APIKEY_INVALID" || code === "APIKEY_MISSING") return true
  const combined = `${response.elsStatus || ""}\n${apiMessage(response)}`.toLowerCase()
  return /apikey_invalid|apikey\b[^.\n]*\bis invalid\b|invalid api\s*key/.test(combined)
}

function redactSecret(text: string, secrets: Array<string | undefined>) {
  let result = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      result = result.split(secret).join("[REDACTED]")
    }
  }
  return result
}

function formatRateLimit(rateLimit: RateLimit) {
  if (!rateLimit.limit && !rateLimit.remaining && !rateLimit.reset) return ""
  const parts = []
  if (rateLimit.remaining || rateLimit.limit) {
    parts.push(`${rateLimit.remaining ?? "?"}/${rateLimit.limit ?? "?"} remaining`)
  }
  if (rateLimit.reset) parts.push(`reset ${rateLimit.reset}`)
  return `API quota: ${parts.join(", ")}`
}

function formatApiFailure(
  response: ElsevierResponse,
  operation: string,
  secrets: Array<string | undefined> = [],
) {
  const lines = [`ScienceDirect ${operation} failed.`]
  if (response.status === 0) {
    lines.push(`Network error: ${response.statusText}`)
  } else {
    lines.push(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`)
    const code = apiErrorCode(response)
    const message = redactSecret(apiMessage(response), secrets)
    if (code) lines.push(`Code: ${code}`)
    if (message) lines.push(`Elsevier: ${message}`)
  }
  if (response.elsStatus) lines.push(`X-ELS-Status: ${redactSecret(response.elsStatus, secrets)}`)

  if (isInvalidApiKey(response)) {
    lines.push("The configured Elsevier API key was rejected as invalid. Update it with sciencedirect_configure action=set_key.")
  } else if (response.status === 401 || response.status === 403) {
    lines.push(
      "Entitlement check failed for this network/account. Troubleshooting:",
      "- On campus network/VPN: make sure api.elsevier.com connects directly (not routed through a non-campus proxy/TUN) and try sciencedirect_authenticate.",
      "- Off-campus: configure an institutional token via sciencedirect_configure action=set_key inst_token=... (or ELSEVIER_INST_TOKEN).",
      "- New API keys may also need ScienceDirect entitlement activated on https://dev.elsevier.com.",
    )
  } else if (response.status === 404) {
    lines.push("No ScienceDirect article matched that identifier.")
  } else if (response.status === 429) {
    lines.push("Elsevier quota or per-second rate limit exceeded. Retry after the reset window.")
  } else if (response.status >= 300 && response.status < 400) {
    let destination = "another location"
    if (response.location) {
      try {
        const url = new URL(response.location, API_BASE)
        destination = `${url.origin}${url.pathname}`
      } catch {
        destination = "an invalid location"
      }
    }
    lines.push(`Elsevier returned a redirect to ${destination}.`)
  } else if (response.status === 413) {
    lines.push("Response exceeded the local size limit.")
  }

  const quota = formatRateLimit(response.rateLimit)
  if (quota) lines.push(quota)
  return redactSecret(lines.join("\n"), secrets)
}

function setupGuide(reason: string, configPath = CONFIG_PATH) {
  return [
    reason,
    `Config file: ${configPath}`,
    "Use an existing key from ELSEVIER_API_KEY / SCIENCEDIRECT_API_KEY, or save it with sciencedirect_configure action=set_key api_key_file=<secret file>.",
  ].join("\n")
}

function requireApiKey(credentials: ElsevierCredentials, configPath = CONFIG_PATH) {
  if (credentials.apiKey) return ""
  if (configFileExists(configPath) && !loadConfig(configPath)) {
    return setupGuide("ScienceDirect config could not be parsed as a JSON object; the existing file was not changed.", configPath)
  }
  return setupGuide("Elsevier API key is not configured.", configPath)
}

type VerificationOutcome = {
  invalidKey: boolean
  searchOk: boolean
  metadataOk: boolean
  searchResponse: ElsevierResponse
  metadataResponse?: ElsevierResponse
}

async function verifyCredentials(
  credentials: ElsevierCredentials,
  sessionToken: string | undefined,
  fetchImpl?: FetchLike,
  signal?: AbortSignal,
): Promise<VerificationOutcome> {
  const searchResponse = await requestElsevier(SEARCH_PATH, {
    credentials,
    method: "PUT",
    accept: "application/json",
    body: {
      qs: "solar energy",
      display: { offset: 0, show: 10, sortBy: "relevance" },
    },
    sessionToken,
    maxResponseBytes: 1024 * 1024,
    fetchImpl,
    signal,
  })

  if (searchResponse.ok) {
    return {
      invalidKey: false,
      searchOk: true,
      metadataOk: true,
      searchResponse,
    }
  }

  if (isInvalidApiKey(searchResponse)) {
    return {
      invalidKey: true,
      searchOk: false,
      metadataOk: false,
      searchResponse,
    }
  }

  if ((searchResponse.status === 401 || searchResponse.status === 403) && !signal?.aborted) {
    const metadataParams = new URLSearchParams({
      query: "title(solar)",
      count: "1",
      view: "STANDARD",
    })
    const metadataResponse = await requestElsevier(`${METADATA_SEARCH_PATH}?${metadataParams}`, {
      credentials,
      method: "GET",
      accept: "application/json",
      sessionToken,
      maxResponseBytes: 1024 * 1024,
      fetchImpl,
      signal,
    })
    if (isInvalidApiKey(metadataResponse)) {
      return {
        invalidKey: true,
        searchOk: false,
        metadataOk: false,
        searchResponse,
        metadataResponse,
      }
    }
    return {
      invalidKey: false,
      searchOk: false,
      metadataOk: metadataResponse.ok,
      searchResponse,
      metadataResponse,
    }
  }

  return {
    invalidKey: false,
    searchOk: false,
    metadataOk: false,
    searchResponse,
  }
}

function formatVerificationSummary(
  outcome: VerificationOutcome,
  secrets: Array<string | undefined> = [],
) {
  if (outcome.searchOk) {
    const quota = formatRateLimit(outcome.searchResponse.rateLimit)
    return ["Verified with Elsevier: ScienceDirect Search API v2 is ready.", quota]
      .filter(Boolean)
      .join("\n")
  }

  if (outcome.invalidKey) {
    return "Elsevier rejected the API key as invalid (APIKEY_INVALID)."
  }

  if (outcome.metadataOk) {
    const quota = formatRateLimit(outcome.metadataResponse?.rateLimit ?? {})
    return [
      `Elsevier recognized the API key: Article Metadata API is ready, while Search API v2 returned HTTP ${outcome.searchResponse.status}.`,
      "sciencedirect_search will automatically fall back to Article Metadata API when needed.",
      quota,
    ]
      .filter(Boolean)
      .join("\n")
  }

  const res = outcome.searchResponse
  if (res.status === 401 || res.status === 403) {
    const detail = redactSecret(apiMessage(res), secrets)
    return [
      `ScienceDirect verification returned HTTP ${res.status}; the key has not been confirmed invalid.`,
      detail ? `Elsevier: ${detail}` : "",
      "If on campus network/VPN, ensure api.elsevier.com bypasses any proxy/TUN and call sciencedirect_authenticate; for off-campus access, configure inst_token.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (res.status === 0) {
    return `Online verification could not reach api.elsevier.com (${res.statusText}). Run sciencedirect_configure action=verify later.`
  }

  return `Online verification returned HTTP ${res.status}. Run sciencedirect_configure action=verify later.`
}

function validateSearchText(name: string, value?: string) {
  const text = value?.trim() || ""
  if (text.length > 250) throw new Error(`${name} must be at most 250 characters.`)
  return text
}

function normalizeLoadedAfter(value?: string) {
  const text = value?.trim()
  if (!text) return undefined
  const expanded = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text
  const timestamp = Date.parse(expanded)
  if (!Number.isFinite(timestamp)) {
    throw new Error("loaded_after must be YYYY-MM-DD or an ISO 8601 timestamp.")
  }
  return new Date(timestamp).toISOString().replace(".000Z", "Z")
}

function validateYearRange(rawYear?: string) {
  const year = rawYear?.trim()
  if (!year) return undefined
  if (!/^\d{4}\s*(?:-\s*\d{4})?$/.test(year)) {
    throw new Error('year must be a year or range, for example "2024" or "2020-2024".')
  }
  if (year.includes("-")) {
    const [from, to] = year.split("-").map((part) => Number.parseInt(part.trim(), 10))
    if (from > to) throw new Error("year range start must not be after its end.")
    return { normalized: `${from}-${to}`, from, to }
  }
  const single = Number.parseInt(year, 10)
  return { normalized: String(single), from: single, to: single }
}

function buildScienceDirectSearchBody(input: SearchInput) {
  const query = validateSearchText("query", input.query)
  const title = validateSearchText("title", input.title)
  const authors = validateSearchText("authors", input.authors)
  const publication = validateSearchText("publication", input.publication)
  if (!query && !title && !authors && !publication) {
    throw new Error("Provide at least one of query, title, authors, or publication.")
  }

  const yearInfo = validateYearRange(input.year)
  const offset = Math.floor(input.offset ?? 0)
  if (!Number.isFinite(offset) || offset < 0 || offset > 6000) throw new Error("offset must be between 0 and 6000.")
  const requestedLimit = Math.floor(input.limit ?? 10)
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_SEARCH_RESULTS) {
    throw new Error(`limit must be between 1 and ${MAX_SEARCH_RESULTS}.`)
  }
  const show = SEARCH_PAGE_SIZES.find((size) => size >= requestedLimit) ?? 100
  const sort = input.sort?.trim().toLowerCase() || "relevance"
  if (!(["relevance", "date"] as const).includes(sort as "relevance" | "date")) {
    throw new Error('sort must be "relevance" or "date".')
  }

  const body: Record<string, unknown> = {
    display: {
      highlights: input.highlights === true,
      offset,
      show,
      sortBy: sort,
    },
  }
  if (query) body.qs = query
  if (title) body.title = title
  if (authors) body.authors = authors
  if (publication) body.pub = publication
  if (yearInfo) body.date = yearInfo.normalized
  if (input.open_access_only === true) body.filters = { openAccess: true }
  const loadedAfter = normalizeLoadedAfter(input.loaded_after)
  if (loadedAfter) body.loadedAfter = loadedAfter

  return { body, requestedLimit, offset, sort }
}

function buildArticleMetadataSearchPath(input: SearchInput) {
  const query = validateSearchText("query", input.query)
  const title = validateSearchText("title", input.title)
  const authors = validateSearchText("authors", input.authors)
  const publication = validateSearchText("publication", input.publication)
  if (!query && !title && !authors && !publication) {
    throw new Error("Provide at least one of query, title, authors, or publication.")
  }

  const clauses: string[] = []
  if (query) {
    const hasFieldSyntax = /^[a-z-]+\s*\(/i.test(query) || /\b(?:pub-date|available-online-date)\b/i.test(query)
    clauses.push(hasFieldSyntax ? `(${query})` : `(title(${query}) OR keywords(${query}))`)
  }
  if (title) clauses.push(`title(${title})`)
  if (authors) clauses.push(`authors(${authors})`)
  if (publication) clauses.push(`srctitle(${publication})`)

  const yearInfo = validateYearRange(input.year)
  if (yearInfo) {
    clauses.push(`pub-date AFT ${yearInfo.from - 1}1231`)
    clauses.push(`pub-date BEF ${yearInfo.to + 1}0101`)
  }

  const loadedAfter = normalizeLoadedAfter(input.loaded_after)
  if (loadedAfter) {
    const ymd = loadedAfter.slice(0, 10).replace(/-/g, "")
    clauses.push(`available-online-date AFT ${ymd}`)
  }

  if (input.open_access_only === true) clauses.push("openaccess(1)")

  const offset = Math.floor(input.offset ?? 0)
  const requestedLimit = Math.floor(input.limit ?? 10)
  const count = METADATA_PAGE_SIZES.find((size) => size >= Math.min(requestedLimit, 25)) ?? 25

  const params = new URLSearchParams({
    query: clauses.join(" AND "),
    start: String(offset),
    count: String(count),
    view: "STANDARD",
  })
  return `${METADATA_SEARCH_PATH}?${params}`
}

function formatAuthor(author: unknown) {
  if (typeof author === "string") return author.trim().split(/\s*\|\s*/).filter(Boolean).join(", ")
  if (!author || typeof author !== "object") return ""
  const record = author as Record<string, unknown>
  const direct = scalar(record.name) || scalar(record["ce:indexed-name"])
  if (direct) return direct
  return [scalar(record["given-name"]), scalar(record.initials), scalar(record.surname)]
    .filter(Boolean)
    .join(" ")
}

function formatAuthors(value: unknown, fallback?: unknown) {
  let source = value
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const record = source as Record<string, unknown>
    source = record.author ?? source
  }
  const names = asArray(source).map(formatAuthor).filter(Boolean)
  if (names.length === 0) {
    const first = scalar(fallback)
    if (first) names.push(first)
  }
  if (names.length > 8) return `${names.slice(0, 8).join(", ")}, et al.`
  return names.join(", ")
}

function findLink(value: unknown, ref: string) {
  for (const link of asArray(value)) {
    if (!link || typeof link !== "object") continue
    const record = link as Record<string, unknown>
    if (
      scalar(record["@ref"]) === ref ||
      scalar(record.ref) === ref ||
      scalar(record["@rel"]) === ref ||
      scalar(record.rel) === ref
    ) {
      return scalar(record["@href"]) || scalar(record.href)
    }
  }
  return ""
}

function normalizeDoi(value: unknown) {
  return scalar(value).replace(/^doi:\s*/i, "")
}

function normalizePii(value: unknown) {
  return scalar(value).replace(/^pii:\s*/i, "")
}

function normalizeSearchResult(value: unknown) {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  const doi = normalizeDoi(record.doi || record["prism:doi"] || record["dc:identifier"])
  const pii = normalizePii(record.pii)
  const url =
    scalar(record.uri) ||
    findLink(record.link, "scidir") ||
    (pii ? `https://www.sciencedirect.com/science/article/pii/${encodeURIComponent(pii)}` : "") ||
    (doi ? `https://doi.org/${doi}` : "")
  const pages =
    record.pages && typeof record.pages === "object" ? (record.pages as Record<string, unknown>) : {}
  const firstPage = scalar(pages.first) || scalar(record["prism:startingPage"])
  const lastPage = scalar(pages.last) || scalar(record["prism:endingPage"])

  return {
    title: cleanMarkup(scalar(record.title) || scalar(record["dc:title"]) || "Untitled result"),
    authors: formatAuthors(record.authors, record["dc:creator"]),
    doi,
    pii,
    url,
    source: scalar(record.sourceTitle) || scalar(record["prism:publicationName"]),
    date: scalar(record.publicationDate) || scalar(record["prism:coverDate"]),
    volumeIssue: scalar(record.volumeIssue) || scalar(record["prism:volume"]),
    pages: firstPage ? (lastPage && lastPage !== firstPage ? `${firstPage}-${lastPage}` : firstPage) : "",
    openAccess: parseBooleanFlag(record.openAccess ?? record.openaccessArticle ?? record.openaccess),
  }
}

function formatScienceDirectSearchResponse(
  payload: unknown,
  context: {
    requestedLimit: number
    offset: number
    sort: string
    rateLimit?: RateLimit
    sourceLabel?: string
  },
) {
  const root = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
  const legacy = (root["search-results"] && typeof root["search-results"] === "object"
    ? root["search-results"]
    : {}) as Record<string, unknown>
  const entries = asArray(root.results ?? legacy.entry)
  // Elsevier's legacy search-results returns [{ error: "Result set was empty" }] on 0 hits.
  const validEntries = entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return false
    const rec = entry as Record<string, unknown>
    return !(rec.error && !rec["dc:title"] && !rec.title)
  })
  const rawResults = validEntries.slice(0, context.requestedLimit)
  const total = scalar(root.resultsFound ?? legacy["opensearch:totalResults"]) || "unknown"
  const headerLabel = context.sourceLabel || "ScienceDirect Search API v2"
  const lines = [
    `ScienceDirect search results (${headerLabel})`,
    `Found: ${total}; returned: ${rawResults.length}; offset: ${context.offset}; sort: ${context.sort}`,
  ]
  const quota = formatRateLimit(context.rateLimit ?? {})
  if (quota) lines.push(quota)

  const message = scalar(root.message)
  if (rawResults.length === 0) {
    lines.push(message ? `Message: ${message}` : "No results.")
    return lines.join("\n")
  }

  rawResults.forEach((raw, index) => {
    const result = normalizeSearchResult(raw)
    lines.push("", `${index + 1}. ${result.title}`)
    if (result.authors) lines.push(`   Authors: ${result.authors}`)
    const citation = [result.source, result.date, result.volumeIssue, result.pages ? `pp. ${result.pages}` : ""]
      .filter(Boolean)
      .join(" | ")
    if (citation) lines.push(`   Published: ${citation}`)
    if (result.doi) lines.push(`   DOI: ${result.doi}`)
    if (result.pii) lines.push(`   PII: ${result.pii}`)
    if (result.openAccess !== null) {
      lines.push(`   Open access: ${result.openAccess ? "yes" : "no"}`)
    }
    if (result.url) lines.push(`   URL: ${result.url}`)
  })
  return lines.join("\n")
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeExplicitIdentifier(value: string, type: IdentifierType) {
  let normalized = value.trim()
  if (type === "doi") normalized = normalized.replace(/^doi:\s*/i, "")
  if (type === "pii") normalized = normalized.replace(/^pii:\s*/i, "")
  if (type === "pubmed_id") normalized = normalized.replace(/^(?:pmid|pubmed(?:_id)?):\s*/i, "")
  if (type === "scopus_id") normalized = normalized.replace(/^scopus(?:_id)?:\s*/i, "")
  if (type === "eid") normalized = normalized.replace(/^eid:\s*/i, "")
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error("identifier is empty or invalid.")
  return { type, value: normalized }
}

function resolveArticleIdentifier(
  identifier: string,
  requestedType: (typeof IDENTIFIER_TYPES)[number] = "auto",
): { type: IdentifierType; value: string } {
  const raw = identifier?.trim()
  if (!raw) throw new Error("identifier is required.")
  if (requestedType !== "auto") return normalizeExplicitIdentifier(raw, requestedType)

  if (/^https?:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error("identifier URL is invalid.")
    }
    if (/^(?:dx\.)?doi\.org$/i.test(url.hostname)) {
      return normalizeExplicitIdentifier(safeDecode(url.pathname.replace(/^\//, "")), "doi")
    }
    const apiMatch = url.pathname.match(
      /\/content\/article\/(doi|pii|eid|scopus_id|pubmed_id)\/(.+)$/i,
    )
    if (apiMatch) {
      return normalizeExplicitIdentifier(
        safeDecode(apiMatch[2]),
        apiMatch[1].toLowerCase() as IdentifierType,
      )
    }
    const piiMatch = url.pathname.match(/\/science\/article\/pii\/([^/]+)/i)
    if (piiMatch) return normalizeExplicitIdentifier(safeDecode(piiMatch[1]), "pii")
    throw new Error("URL is not a recognized DOI or ScienceDirect article URL.")
  }

  if (/^doi:/i.test(raw) || /^10\.\d{4,9}\/[\S]+$/i.test(raw)) {
    return normalizeExplicitIdentifier(raw, "doi")
  }
  if (/^pii:/i.test(raw) || /^[SB][A-Za-z0-9().-]{8,}$/i.test(raw)) {
    return normalizeExplicitIdentifier(raw, "pii")
  }
  if (/^eid:/i.test(raw) || /^2-s2\.0-\d+$/i.test(raw)) {
    return normalizeExplicitIdentifier(raw, "eid")
  }
  if (/^(?:pmid|pubmed(?:_id)?):/i.test(raw)) {
    return normalizeExplicitIdentifier(raw, "pubmed_id")
  }
  if (/^scopus(?:_id)?:/i.test(raw)) {
    return normalizeExplicitIdentifier(raw, "scopus_id")
  }
  if (/^\d+$/.test(raw)) {
    throw new Error("A numeric identifier is ambiguous; set identifier_type to scopus_id or pubmed_id.")
  }
  throw new Error("Could not infer identifier type. Provide a DOI/PII/URL or set identifier_type explicitly.")
}

function encodeIdentifier(value: string) {
  return value.split("/").map(encodeURIComponent).join("/")
}

function articleRoot(payload: unknown) {
  const top = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
  const root = top["full-text-retrieval-response"]
  return (root && typeof root === "object" ? root : top) as Record<string, unknown>
}

function articleAuthors(root: Record<string, unknown>, core: Record<string, unknown>) {
  return formatAuthors(root.authors ?? core.authors, core["dc:creator"])
}

function articleSubjects(value: unknown) {
  const values = asArray(value)
    .flatMap((item) => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>
        return asArray(record.subject ?? item)
      }
      return [item]
    })
    .map(scalar)
    .filter(Boolean)
  return [...new Set(values)].join(", ")
}

function formatScienceDirectArticleResponse(
  payload: unknown,
  mode: Exclude<ArticleMode, "full_text">,
  rateLimit: RateLimit = {},
  note?: string,
) {
  const root = articleRoot(payload)
  const core = (root.coredata && typeof root.coredata === "object" ? root.coredata : {}) as Record<
    string,
    unknown
  >
  const doi = normalizeDoi(core["prism:doi"] || core["dc:identifier"])
  const pii = normalizePii(core.pii ?? root.pii)
  const url =
    findLink(root.link, "scidir") ||
    findLink(core.link, "scidir") ||
    (pii ? `https://www.sciencedirect.com/science/article/pii/${encodeURIComponent(pii)}` : "") ||
    (doi ? `https://doi.org/${doi}` : "")
  const openAccess = parseBooleanFlag(core.openaccessArticle ?? core.openaccess)
  const lines = [
    `ScienceDirect article ${mode === "abstract" ? "metadata and abstract" : "metadata"}`,
    `Title: ${cleanMarkup(scalar(core["dc:title"])) || "Not reported"}`,
  ]
  const authors = articleAuthors(root, core)
  if (authors) lines.push(`Authors: ${authors}`)
  if (scalar(core["prism:publicationName"])) {
    lines.push(`Publication: ${scalar(core["prism:publicationName"])}`)
  }
  if (scalar(core["prism:coverDate"])) lines.push(`Date: ${scalar(core["prism:coverDate"])}`)
  const volumeIssue = [
    scalar(core["prism:volume"]) ? `volume ${scalar(core["prism:volume"])}` : "",
    scalar(core["prism:issueIdentifier"]) ? `issue ${scalar(core["prism:issueIdentifier"])}` : "",
    scalar(core["prism:pageRange"]) ||
      (scalar(core["prism:startingPage"])
        ? scalar(core["prism:endingPage"]) && scalar(core["prism:endingPage"]) !== scalar(core["prism:startingPage"])
          ? `${scalar(core["prism:startingPage"])}-${scalar(core["prism:endingPage"])}`
          : scalar(core["prism:startingPage"])
        : ""),
  ]
    .filter(Boolean)
    .join(", ")
  if (volumeIssue) lines.push(`Citation details: ${volumeIssue}`)
  if (doi) lines.push(`DOI: ${doi}`)
  if (pii) lines.push(`PII: ${pii}`)
  if (openAccess !== null) {
    lines.push(`Open access: ${openAccess ? "yes" : "no"}`)
  }
  const subjects = articleSubjects(core["dcterms:subject"])
  if (subjects) lines.push(`Subjects: ${subjects}`)
  const license = scalar(core.openaccessUserLicense)
  if (license) lines.push(`License: ${license}`)
  if (url) lines.push(`URL: ${url}`)
  const quota = formatRateLimit(rateLimit)
  if (quota) lines.push(quota)
  if (note) lines.push(`Note: ${note}`)

  if (mode === "abstract") {
    const abstract = cleanMarkup(scalar(core["dc:description"]))
    const shown = abstract.slice(0, MAX_ABSTRACT_CHARS)
    lines.push("", "Abstract:", shown || "Abstract was not returned for the current entitlement.")
    if (shown.length < abstract.length) {
      lines.push(`[Abstract truncated at ${MAX_ABSTRACT_CHARS} characters.]`)
    }
  }
  return lines.join("\n")
}

function extractFullText(body: string, contentType: string) {
  if (/json/i.test(contentType) || body.trimStart().startsWith("{")) {
    const payload = parseJson(body)
    if (payload) {
      const root = articleRoot(payload)
      const original = scalar(root.originalText)
      if (original) return cleanMarkup(original)
      return ""
    }
  }
  if (/html/i.test(contentType)) return ""
  if (/xml/i.test(contentType) || /^\s*</.test(body)) {
    const original = body.match(/<(?:[\w.-]+:)?originalText\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?originalText\s*>/i)
    if (original) return cleanMarkup(original[1])
    if (/<(?:[\w.-]+:)?full-text-retrieval-response\b/i.test(body)) return ""
    return cleanMarkup(body)
  }
  return body.replace(/\r\n/g, "\n").trim()
}

function formatFullTextOutput(
  text: string,
  resolved: { type: IdentifierType; value: string },
  offset: number,
  maxChars: number,
  rateLimit: RateLimit,
  outputPath?: string,
) {
  const safeOffset = Math.min(offset, text.length)
  const end = Math.min(safeOffset + maxChars, text.length)
  const lines = [
    "ScienceDirect article full text",
    `Identifier: ${resolved.type}:${resolved.value}`,
    `Characters: ${safeOffset}-${end} of ${text.length}`,
  ]
  const quota = formatRateLimit(rateLimit)
  if (quota) lines.push(quota)
  if (outputPath) lines.push(`Saved complete full text: ${outputPath} (${text.length} characters, UTF-8)`)
  lines.push("", text.slice(safeOffset, end))
  if (end < text.length) {
    lines.push("", `[More content available: call sciencedirect_article with mode="full_text" and offset=${end} to continue reading.]`)
  }
  return lines.join("\n")
}

function authenticationChoices(payload: unknown, rawBody: string) {
  const pathChoices = findProperty(payload, ["pathchoices", "path-choices"])
  const choiceValue =
    pathChoices && typeof pathChoices === "object"
      ? (pathChoices as Record<string, unknown>).choice
      : undefined
  const choices = asArray(choiceValue)
    .map((choice) => {
      if (!choice || typeof choice !== "object") return null
      const record = choice as Record<string, unknown>
      const id = scalar(record.id) || scalar(record["@id"])
      const name = scalar(record.name) || scalar(record["@name"])
      return id ? { id, name: name || "Unnamed institution" } : null
    })
    .filter((choice): choice is { id: string; name: string } => choice !== null)
  if (choices.length > 0) return choices

  const xmlChoices = []
  const regex = /<choice\b[^>]*\bid=["']([^"']+)["'][^>]*\bname=["']([^"']*)["'][^>]*\/?\s*>/gi
  for (const match of rawBody.matchAll(regex)) {
    xmlChoices.push({
      id: decodeEntities(match[1]),
      name: decodeEntities(match[2]) || "Unnamed institution",
    })
  }
  return xmlChoices
}

function authenticationToken(payload: unknown, rawBody: string) {
  const token = scalar(findProperty(payload, ["authtoken"]))
  if (token) return token
  return decodeEntities(rawBody.match(/<authtoken[^>]*>([\s\S]*?)<\/authtoken>/i)?.[1]?.trim() || "")
}

function createScienceDirectPlugin(options: ScienceDirectPluginOptions = {}): ToolFactory {
  const configPath = options.configPath ?? CONFIG_PATH
  const fetchImpl = options.fetchImpl
  const inMemoryAuth: { current: InMemoryAuth | null } = { current: null }
  let configGeneration = 0

  return async () => {
    return {
      tool: {
        sciencedirect_status: tool({
          description: [
            "Check ScienceDirect API configuration and authentication state.",
            "Call first when the user wants to configure ScienceDirect or troubleshoot access.",
            "Does not make a network request and never prints secret values.",
            "Do NOT use for local project search.",
          ].join(" "),
          args: {},
          async execute() {
            const localConfig = loadConfig(configPath)
            const credentials = getElsevierCredentials(process.env, configPath)
            const sessionToken = activeAuthToken(inMemoryAuth)

            if (!credentials.apiKey) {
              return requireApiKey(credentials, configPath)
            }

            const nextStep =
              credentials.instToken || credentials.oauthToken
                ? "Ready: token-based authentication is configured. Call sciencedirect_search or sciencedirect_article directly."
                : credentials.authToken || sessionToken
                  ? "Ready: authtoken is active. Call sciencedirect_search or sciencedirect_article."
                  : "Ready to try sciencedirect_search directly (campus IP is recognized automatically). If campus IP has multiple accounts or returns 401, call sciencedirect_authenticate; for off-campus access, set inst_token."

            return [
              "ScienceDirect status",
              `API endpoint: ${API_BASE}`,
              `Config file: ${!configFileExists(configPath) ? `not created (${configPath})` : localConfig ? configPath : `invalid JSON (${configPath})`}`,
              `API key: configured (${apiKeySource(process.env, configPath)})`,
              `Institution token: ${credentials.instToken ? `configured (${instTokenSource(process.env, configPath)})` : "not set"}`,
              `Environment authtoken: ${credentials.authToken ? "configured" : "not set"}`,
              `OAuth token: ${credentials.oauthToken ? "configured" : "not set"}`,
              `In-memory IP authtoken: ${sessionToken ? "active" : "not active"}`,
              "",
              nextStep,
            ].join("\n")
          },
        }),

        sciencedirect_configure: tool({
          description: [
            "Configure, verify, or clear Elsevier ScienceDirect API credentials in ~/.config/opencode/sciencedirect.json.",
            "Actions: set_key | verify | clear.",
            "Supports passing secrets directly (api_key / inst_token) or via secret file paths (api_key_file / inst_token_file, e.g. from openchamber_secret).",
            "Valid keys are saved even if the current IP is off-campus, so sciencedirect_authenticate or inst_token can be used afterward.",
            "Never echo secret values in chat.",
          ].join(" "),
          args: {
            action: tool.schema
              .enum(["set_key", "verify", "clear"])
              .describe("Configuration action: set_key | verify | clear."),
            api_key: tool.schema
              .string()
              .optional()
              .describe(`Elsevier API key from ${API_KEY_REGISTRATION_URL}.`),
            api_key_file: tool.schema
              .string()
              .optional()
              .describe("Path to a file containing the Elsevier API key (for example from openchamber_secret)."),
            inst_token: tool.schema
              .string()
              .optional()
              .describe("Optional Elsevier institutional token (X-ELS-Insttoken) for off-campus entitlement."),
            inst_token_file: tool.schema
              .string()
              .optional()
              .describe("Path to a file containing the Elsevier institutional token (for example from openchamber_secret)."),
            clear_inst_token: tool.schema
              .boolean()
              .optional()
              .describe("When true on set_key, remove any stored local instToken."),
            skip_verify: tool.schema
              .boolean()
              .optional()
              .describe("Save credentials without probing api.elsevier.com first."),
          },
          async execute(args, context) {
            try {
              if (args.action === "clear") {
                if (context?.abort.aborted) return "ScienceDirect configuration change cancelled."
                await withConfigLock(configPath, context?.abort, () => {
                  configGeneration += 1
                  saveConfig({ version: 1, mutationId: randomUUID() }, configPath)
                })
                inMemoryAuth.current = null
                return [
                  "ScienceDirect local configuration cleared.",
                  `File: ${configPath}`,
                ].join("\n")
              }

              if (args.action === "verify") {
                const credentials = getElsevierCredentials(process.env, configPath)
                const missing = requireApiKey(credentials, configPath)
                if (missing) return missing
                const outcome = await verifyCredentials(
                  credentials,
                  activeAuthToken(inMemoryAuth),
                  fetchImpl,
                  context?.abort,
                )
                return formatVerificationSummary(outcome, [
                  credentials.apiKey,
                  credentials.instToken,
                  credentials.authToken,
                  credentials.oauthToken,
                ])
              }

              if (args.action === "set_key") {
                const currentConfig = loadConfig(configPath)
                const existingCredentials = getElsevierCredentials(process.env, configPath)

                const candidateApiKey = args.api_key_file
                  ? readSecretFromFile(args.api_key_file, context?.directory, "api_key")
                  : args.api_key !== undefined
                    ? normalizeSecretValue(args.api_key, "api_key")
                    : storedApiKey(currentConfig) || existingCredentials.apiKey

                if (!candidateApiKey) {
                  return "Error: Provide api_key or api_key_file for action=set_key."
                }

                let candidateInstToken: string | undefined
                if (args.clear_inst_token === true) {
                  candidateInstToken = undefined
                } else if (args.inst_token_file) {
                  candidateInstToken = readSecretFromFile(
                    args.inst_token_file,
                    context?.directory,
                    "inst_token",
                  )
                } else if (args.inst_token !== undefined) {
                  const trimmed = args.inst_token.trim()
                  candidateInstToken = trimmed
                    ? normalizeSecretValue(trimmed, "inst_token")
                    : undefined
                } else {
                  candidateInstToken = storedInstToken(currentConfig) || undefined
                }

                if (context?.abort.aborted) {
                  return "ScienceDirect configuration change cancelled; changes were not saved."
                }

                const expectedGeneration = configGeneration
                const expectedRevision = configRevision(configPath)
                const effectiveForProbe: ElsevierCredentials = {
                  apiKey: candidateApiKey,
                  instToken:
                    Boolean(process.env.ELSEVIER_INST_TOKEN?.trim()) &&
                    args.inst_token === undefined &&
                    !args.inst_token_file &&
                    !args.clear_inst_token
                      ? process.env.ELSEVIER_INST_TOKEN?.trim() || undefined
                      : candidateInstToken,
                  authToken: existingCredentials.authToken,
                  oauthToken: existingCredentials.oauthToken,
                }

                let verificationSummary = "Skipped online verification (skip_verify=true)."
                if (args.skip_verify !== true) {
                  const outcome = await verifyCredentials(
                    effectiveForProbe,
                    activeAuthToken(inMemoryAuth),
                    fetchImpl,
                    context?.abort,
                  )
                  if (outcome.invalidKey) {
                    return [
                      formatVerificationSummary(outcome, [candidateApiKey, candidateInstToken]),
                      "The new key was not saved.",
                    ].join("\n")
                  }
                  if (context?.abort.aborted) {
                    return "ScienceDirect configuration change cancelled; changes were not saved."
                  }
                  verificationSummary = formatVerificationSummary(outcome, [
                    candidateApiKey,
                    candidateInstToken,
                  ])
                }

                if (configGeneration !== expectedGeneration || configRevision(configPath) !== expectedRevision) {
                  return "ScienceDirect configuration changed concurrently; retry if still needed."
                }

                const saved = await withConfigLock(configPath, context?.abort, () => {
                  if (configGeneration !== expectedGeneration || configRevision(configPath) !== expectedRevision) {
                    return false
                  }
                  configGeneration += 1
                  const nextConfig: StoredConfig = {
                    version: 1,
                    mutationId: randomUUID(),
                    apiKey: candidateApiKey,
                    ...(candidateInstToken ? { instToken: candidateInstToken } : {}),
                  }
                  saveConfig(nextConfig, configPath)
                  return true
                })
                if (!saved) {
                  return "ScienceDirect configuration changed concurrently; retry if still needed."
                }

                const envOverrides: string[] = []
                if (process.env.ELSEVIER_API_KEY?.trim()) envOverrides.push("ELSEVIER_API_KEY")
                else if (process.env.SCIENCEDIRECT_API_KEY?.trim()) envOverrides.push("SCIENCEDIRECT_API_KEY")
                if (
                  Boolean(process.env.ELSEVIER_INST_TOKEN?.trim()) &&
                  (args.inst_token !== undefined || Boolean(args.inst_token_file))
                ) {
                  envOverrides.push("ELSEVIER_INST_TOKEN")
                }

                return [
                  "ScienceDirect configuration saved.",
                  `File: ${configPath}`,
                  envOverrides.length > 0
                    ? `Note: ${envOverrides.join(", ")} is set in the environment and takes precedence until unset.`
                    : "Credentials are active immediately without restarting OpenCode.",
                  verificationSummary,
                ].join("\n")
              }

              return "Error: unsupported ScienceDirect configuration action."
            } catch (error) {
              return `Error: ScienceDirect configuration failed: ${error instanceof Error ? error.message : String(error)}`
            }
          },
        }),

        sciencedirect_authenticate: tool({
          description: [
            "Authenticate the current campus/institutional IP via Elsevier's official Authentication API (/authenticate/?platform=SCIDIR).",
            "Stores the returned two-hour authtoken in memory for search and article retrieval.",
            "If multiple institutional accounts match the IP, returns the choices so the user can pick one.",
            "Unnecessary when inst_token or ELSEVIER_INST_TOKEN is already configured.",
          ].join(" "),
          args: {
            choice: tool.schema
              .string()
              .optional()
              .describe("Institution choice ID returned when multiple accounts match the current IP."),
          },
          async execute(args, context) {
            const credentials = getElsevierCredentials(process.env, configPath)
            const missing = requireApiKey(credentials, configPath)
            if (missing) return missing
            if (credentials.oauthToken || credentials.instToken) {
              return "Token-based authentication (inst_token / oauthToken) is already configured; IP authentication is not needed."
            }

            const params = new URLSearchParams({ platform: "SCIDIR" })
            if (args.choice?.trim()) params.set("choice", args.choice.trim())
            const response = await requestElsevier(`${AUTH_PATH}?${params}`, {
              credentials: { ...credentials, authToken: undefined },
              accept: "application/json",
              fetchImpl,
              signal: context?.abort,
            })
            const payload = parseJson(response.body)
            const token = authenticationToken(payload, response.body)
            if (response.status >= 200 && response.status < 300 && token) {
              inMemoryAuth.current = {
                token,
                expiresAt: Date.now() + SESSION_TOKEN_LIFETIME_MS,
              }
              return [
                "ScienceDirect institutional IP authentication succeeded.",
                "Authtoken cached in memory (~2 hours) for subsequent search and article requests.",
              ].join("\n")
            }

            const choices = authenticationChoices(payload, response.body)
            if (response.status === 300 || choices.length > 0) {
              return [
                "Multiple institutional entitlement paths matched this IP:",
                ...choices.map((choice) => `- ${choice.id}: ${choice.name}`),
                "Call sciencedirect_authenticate with the desired choice ID.",
              ].join("\n")
            }
            if (response.ok) {
              return [
                "Elsevier accepted the authentication request without issuing a separate authtoken; direct IP entitlement is active.",
                apiMessage(response),
              ]
                .filter(Boolean)
                .join("\n")
            }
            return formatApiFailure(response, "institutional authentication", [credentials.apiKey])
          },
        }),

        sciencedirect_search: tool({
          description: [
            "Search ScienceDirect scholarly articles and book chapters via Elsevier's official API.",
            "Uses ScienceDirect Search API v2 (PUT /content/search/sciencedirect) and automatically falls back to Article Metadata API (GET /content/metadata/article) if the key only has metadata search entitlement.",
            "Do NOT use for local project file search or general non-academic web queries.",
          ].join(" "),
          args: {
            query: tool.schema
              .string()
              .optional()
              .describe("Search query (max 250 chars; uppercase AND/OR/NOT supported)."),
            title: tool.schema.string().optional().describe("Article or chapter title query (max 250 chars)."),
            authors: tool.schema.string().optional().describe("Author name query (max 250 chars)."),
            publication: tool.schema.string().optional().describe("Journal or book title query (max 250 chars)."),
            year: tool.schema
              .string()
              .optional()
              .describe('Publication year or range, e.g. "2024" or "2020-2026".'),
            open_access_only: tool.schema.boolean().optional().describe("Only return open-access articles."),
            loaded_after: tool.schema
              .string()
              .optional()
              .describe("Only articles loaded after YYYY-MM-DD or an ISO 8601 timestamp."),
            offset: tool.schema.number().optional().describe("Result offset, 0-6000 (default 0)."),
            limit: tool.schema
              .number()
              .optional()
              .describe(`Results to return, 1-${MAX_SEARCH_RESULTS} (default 10).`),
            sort: tool.schema.string().optional().describe('Sort by "relevance" (default) or "date".'),
            highlights: tool.schema.boolean().optional().describe("Include search-term highlights."),
            search_api: tool.schema
              .enum(SEARCH_APIS)
              .optional()
              .describe("auto (default: Search v2 with Metadata API fallback) | search_v2 | metadata."),
          },
          async execute(args, context) {
            const credentials = getElsevierCredentials(process.env, configPath)
            const missing = requireApiKey(credentials, configPath)
            if (missing) return missing

            let request
            try {
              request = buildScienceDirectSearchBody(args)
            } catch (error) {
              return `Error: ${error instanceof Error ? error.message : String(error)}`
            }

            const apiMode = args.search_api ?? "auto"
            const sessionToken = activeAuthToken(inMemoryAuth)
            const secrets = [
              credentials.apiKey,
              credentials.instToken,
              credentials.authToken,
              credentials.oauthToken,
            ]

            if (apiMode === "metadata") {
              const metadataPath = buildArticleMetadataSearchPath(args)
              const metaResponse = await requestElsevier(metadataPath, {
                credentials,
                method: "GET",
                accept: "application/json",
                sessionToken,
                fetchImpl,
                signal: context?.abort,
              })
              if (!metaResponse.ok) return formatApiFailure(metaResponse, "metadata search", secrets)
              const metaPayload = parseJson(metaResponse.body)
              if (!metaPayload) return "ScienceDirect search failed: Elsevier returned invalid JSON."
              return formatScienceDirectSearchResponse(metaPayload, {
                requestedLimit: request.requestedLimit,
                offset: request.offset,
                sort: request.sort,
                rateLimit: metaResponse.rateLimit,
                sourceLabel: "Article Metadata API",
              })
            }

            const response = await requestElsevier(SEARCH_PATH, {
              credentials,
              method: "PUT",
              accept: "application/json",
              body: request.body,
              sessionToken,
              fetchImpl,
              signal: context?.abort,
            })

            if (response.ok) {
              const payload = parseJson(response.body)
              if (!payload) return "ScienceDirect search failed: Elsevier returned invalid JSON."
              return formatScienceDirectSearchResponse(payload, {
                requestedLimit: request.requestedLimit,
                offset: request.offset,
                sort: request.sort,
                rateLimit: response.rateLimit,
                sourceLabel: "ScienceDirect Search API v2",
              })
            }

            if (
              apiMode === "auto" &&
              (response.status === 401 || response.status === 403) &&
              !isInvalidApiKey(response) &&
              !context?.abort.aborted
            ) {
              const metadataPath = buildArticleMetadataSearchPath(args)
              const metaResponse = await requestElsevier(metadataPath, {
                credentials,
                method: "GET",
                accept: "application/json",
                sessionToken,
                fetchImpl,
                signal: context?.abort,
              })
              if (metaResponse.ok) {
                const metaPayload = parseJson(metaResponse.body)
                if (metaPayload) {
                  return formatScienceDirectSearchResponse(metaPayload, {
                    requestedLimit: request.requestedLimit,
                    offset: request.offset,
                    sort: request.sort,
                    rateLimit: metaResponse.rateLimit,
                    sourceLabel: "Article Metadata API fallback",
                  })
                }
              }
            }

            return formatApiFailure(response, "search", secrets)
          },
        }),

        sciencedirect_article: tool({
          description: [
            "Retrieve a ScienceDirect article's metadata, abstract, or full text via Elsevier's official Article Retrieval API.",
            "Accepts DOI, PII, EID, Scopus ID, PubMed ID, doi.org URL, or sciencedirect.com article URL.",
            "Automatically downgrades view when full entitlement is unavailable, and supports offset pagination for long full-text articles.",
            "Set output_path in full_text mode to save the complete article text as a UTF-8 file, independently of preview length.",
            "Do NOT use for local files or non-Elsevier URLs.",
          ].join(" "),
          args: {
            identifier: tool.schema.string().describe("Article DOI, PII, EID, ID, or DOI/ScienceDirect URL."),
            identifier_type: tool.schema
              .enum(IDENTIFIER_TYPES)
              .optional()
              .describe("Identifier type (default auto). Required for bare numeric scopus_id or pubmed_id."),
            mode: tool.schema
              .enum(ARTICLE_MODES)
              .optional()
              .describe("metadata | abstract (default) | full_text."),
            offset: tool.schema
              .number()
              .optional()
              .describe("Character offset when reading full_text in sections (default 0)."),
            max_chars: tool.schema
              .number()
              .optional()
              .describe(
                `Maximum full_text characters returned per call (default ${DEFAULT_FULL_TEXT_CHARS}, max ${MAX_FULL_TEXT_CHARS}).`,
              ),
            output_path: tool.schema
              .string()
              .optional()
              .describe("Save complete full_text as a UTF-8 text file; relative paths use the current session directory."),
            overwrite: tool.schema
              .boolean()
              .optional()
              .describe("Allow replacing output_path if it already exists (default false)."),
          },
          async execute(args, context) {
            const credentials = getElsevierCredentials(process.env, configPath)
            const missing = requireApiKey(credentials, configPath)
            if (missing) return missing

            let resolved
            try {
              resolved = resolveArticleIdentifier(args.identifier, args.identifier_type ?? "auto")
            } catch (error) {
              return `Error: ${error instanceof Error ? error.message : String(error)}`
            }

            const mode = (args.mode ?? "abstract") as ArticleMode
            const offset = Math.floor(args.offset ?? 0)
            if (!Number.isFinite(offset) || offset < 0) return "Error: offset must be a finite number >= 0."
            const maxChars = Math.floor(args.max_chars ?? DEFAULT_FULL_TEXT_CHARS)
            if (mode === "full_text" && (!Number.isFinite(maxChars) || maxChars < 1 || maxChars > MAX_FULL_TEXT_CHARS)) {
              return `Error: max_chars must be between 1 and ${MAX_FULL_TEXT_CHARS}.`
            }

            let outputPath: string | undefined
            if (args.output_path !== undefined) {
              if (mode !== "full_text") return "Error: output_path requires mode=full_text."
              if (!args.output_path.trim()) return "Error: output_path must not be empty."
              outputPath = resolve(context?.directory || process.cwd(), args.output_path.trim())
              if (existsSync(outputPath) && args.overwrite !== true) {
                return `Error: output_path already exists: ${outputPath}. Choose another path or set overwrite=true.`
              }
            }

            const fullTextResult = (text: string, rateLimit: RateLimit) => {
              if (context?.abort.aborted) return "ScienceDirect full-text retrieval cancelled."
              if (outputPath) {
                try {
                  mkdirSync(dirname(outputPath), { recursive: true })
                  writeFileSync(outputPath, text, { encoding: "utf8", flag: args.overwrite === true ? "w" : "wx" })
                } catch (error) {
                  return `Error: could not save full text: ${error instanceof Error ? error.message : String(error)}`
                }
              }
              return formatFullTextOutput(text, resolved, offset, maxChars, rateLimit, outputPath)
            }

            const sessionToken = activeAuthToken(inMemoryAuth)
            const secrets = [
              credentials.apiKey,
              credentials.instToken,
              credentials.authToken,
              credentials.oauthToken,
            ]
            const baseArticlePath = `/content/article/${resolved.type}/${encodeIdentifier(resolved.value)}`

            if (mode === "metadata" || mode === "abstract") {
              const view = mode === "metadata" ? "META" : "META_ABS"
              const response = await requestElsevier(
                `${baseArticlePath}?${new URLSearchParams({ view })}`,
                {
                  credentials,
                  accept: "application/json",
                  sessionToken,
                  fetchImpl,
                  signal: context?.abort,
                },
              )
              if (response.ok) {
                const payload = parseJson(response.body)
                if (!payload) return `ScienceDirect ${mode} retrieval failed: Elsevier returned invalid JSON.`
                return formatScienceDirectArticleResponse(payload, mode, response.rateLimit)
              }

              // META_ABS is entitlement-restricted on some keys/articles while META is allowed.
              if (
                mode === "abstract" &&
                (response.status === 400 || response.status === 401 || response.status === 403) &&
                !isInvalidApiKey(response) &&
                !context?.abort.aborted
              ) {
                const fallback = await requestElsevier(
                  `${baseArticlePath}?${new URLSearchParams({ view: "META" })}`,
                  {
                    credentials,
                    accept: "application/json",
                    sessionToken,
                    fetchImpl,
                    signal: context?.abort,
                  },
                )
                if (fallback.ok) {
                  const payload = parseJson(fallback.body)
                  if (payload) {
                    return formatScienceDirectArticleResponse(
                      payload,
                      "metadata",
                      fallback.rateLimit,
                      "Abstract view (META_ABS) was restricted for the current entitlement; showing article metadata.",
                    )
                  }
                }
              }

              return formatApiFailure(response, `${mode} retrieval`, secrets)
            }

            // mode === "full_text"
            const fullResponse = await requestElsevier(
              `${baseArticlePath}?${new URLSearchParams({ view: "FULL" })}`,
              {
                credentials,
                accept: "text/plain",
                sessionToken,
                fetchImpl,
                signal: context?.abort,
              },
            )

            if (fullResponse.ok) {
              const text = extractFullText(fullResponse.body, fullResponse.contentType)
              if (text) {
                return fullTextResult(text, fullResponse.rateLimit)
              }
            }

            // Fallback: Elsevier returns HTTP 400/401/403/406 on explicit view=FULL when
            // the caller only has open-access or partial entitlement. Requesting default/ENTITLED
            // JSON lets Elsevier auto-downgrade to the highest entitled representation (including
            // originalText for Open Access papers).
            if (
              (fullResponse.ok ||
                fullResponse.status === 400 ||
                fullResponse.status === 401 ||
                fullResponse.status === 403 ||
                fullResponse.status === 406) &&
              !isInvalidApiKey(fullResponse) &&
              !context?.abort.aborted
            ) {
              const fallbackResponse = await requestElsevier(baseArticlePath, {
                credentials,
                accept: "application/json",
                sessionToken,
                fetchImpl,
                signal: context?.abort,
              })
              if (fallbackResponse.ok) {
                const extracted = extractFullText(fallbackResponse.body, fallbackResponse.contentType)
                if (extracted) {
                  return fullTextResult(extracted, fallbackResponse.rateLimit)
                }
                const payload = parseJson(fallbackResponse.body)
                if (payload) {
                  const core = articleRoot(payload).coredata as Record<string, unknown> | undefined
                  const hasAbstract = Boolean(core && scalar(core["dc:description"]))
                  return formatScienceDirectArticleResponse(
                    payload,
                    hasAbstract ? "abstract" : "metadata",
                    fallbackResponse.rateLimit,
                    "Full text is not entitled on the current network/account; returned highest available metadata/abstract.",
                  )
                }
              }
            }

            if (fullResponse.ok) {
              return "ScienceDirect returned an empty full-text response."
            }
            return formatApiFailure(fullResponse, "full_text retrieval", secrets)
          },
        }),
      },
    }
  }
}

const ScienceDirectPlugin = defineToolsPlugin("sciencedirect", createScienceDirectPlugin())

Object.defineProperty(ScienceDirectPlugin, "__test", {
  value: Object.freeze({
    authenticationChoices,
    authenticationToken,
    buildArticleMetadataSearchPath,
    buildScienceDirectSearchBody,
    cleanMarkup,
    createScienceDirectPlugin,
    extractFullText,
    formatScienceDirectArticleResponse,
    formatScienceDirectSearchResponse,
    getElsevierCredentials,
    isInvalidApiKey,
    loadConfig,
    normalizeSecretValue,
    requestElsevier,
    resolveArticleIdentifier,
    saveConfig,
  }),
})

export default ScienceDirectPlugin
