import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const pluginModule = await import("../plugins/sciencedirect.ts")
const ScienceDirectPlugin = pluginModule.default
const {
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
  requestElsevier,
  resolveArticleIdentifier,
} = ScienceDirectPlugin.__test

const ELSEVIER_ENV_NAMES = [
  "ELSEVIER_API_KEY",
  "SCIENCEDIRECT_API_KEY",
  "ELSEVIER_INST_TOKEN",
  "ELSEVIER_AUTHTOKEN",
  "ELSEVIER_OAUTH_TOKEN",
]

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "sciencedirect-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function temporaryConfig(t) {
  return join(temporaryDirectory(t), "nested", "sciencedirect.json")
}

function isolateElsevierEnvironment(t) {
  const previous = new Map(ELSEVIER_ENV_NAMES.map((name) => [name, process.env[name]]))
  for (const name of ELSEVIER_ENV_NAMES) delete process.env[name]
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

function toolContext(sessionID = "test-session", overrides = {}) {
  return {
    sessionID,
    messageID: "test-message",
    agent: "test-agent",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
    ...overrides,
  }
}

test("exports one V2 plugin definition without global system prompt injection", async () => {
  assert.deepEqual(Object.keys(pluginModule), ["default"])
  assert.equal(ScienceDirectPlugin.id, "sciencedirect")
  assert.equal(typeof ScienceDirectPlugin.setup, "function")

  const hooks = await createScienceDirectPlugin()()
  assert.equal(hooks.system, undefined)
  assert.deepEqual(Object.keys(hooks.tool), [
    "sciencedirect_status",
    "sciencedirect_configure",
    "sciencedirect_authenticate",
    "sciencedirect_search",
    "sciencedirect_article",
  ])
})

test("loads Elsevier credentials from environment and local config", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const plugin = createScienceDirectPlugin({ configPath })
  const hooks = await plugin()

  await hooks.tool.sciencedirect_configure.execute(
    {
      action: "set_key",
      api_key: "stored-api-key",
      inst_token: "stored-inst-token",
      skip_verify: true,
    },
    toolContext(),
  )

  assert.deepEqual(getElsevierCredentials({}, configPath), {
    apiKey: "stored-api-key",
    instToken: "stored-inst-token",
    authToken: undefined,
    oauthToken: undefined,
  })

  assert.deepEqual(
    getElsevierCredentials(
      {
        ELSEVIER_API_KEY: " env-api-key ",
        ELSEVIER_INST_TOKEN: " env-inst-token ",
        ELSEVIER_AUTHTOKEN: " auth-token ",
        ELSEVIER_OAUTH_TOKEN: " oauth-token ",
      },
      configPath,
    ),
    {
      apiKey: "env-api-key",
      instToken: "env-inst-token",
      authToken: "auth-token",
      oauthToken: "oauth-token",
    },
  )
})

test("reuses BOM-prefixed legacy config and ignores blank environment overrides", (t) => {
  const directory = temporaryDirectory(t)
  const configPath = join(directory, "sciencedirect.json")
  writeFileSync(configPath, '\uFEFF{"api_key":"legacy-key","inst_token":"legacy-token"}', "utf8")
  assert.deepEqual(getElsevierCredentials({ ELSEVIER_API_KEY: " ", ELSEVIER_INST_TOKEN: "" }, configPath), {
    apiKey: "legacy-key",
    instToken: "legacy-token",
    authToken: undefined,
    oauthToken: undefined,
  })
  assert.equal(getElsevierCredentials({ SCIENCEDIRECT_API_KEY: " alias-key " }, configPath).apiKey, "alias-key")
  assert.equal(getElsevierCredentials({ ELSEVIER_API_KEY: "primary-key", SCIENCEDIRECT_API_KEY: "alias-key" }, configPath).apiKey, "primary-key")
  writeFileSync(configPath, '{"apiKey":123,"api_key":"fallback-key"}', "utf8")
  assert.equal(getElsevierCredentials({}, configPath).apiKey, "fallback-key")
})

test("missing or invalid config returns a concise diagnostic, not instructions to interrogate the user", async (t) => {
  isolateElsevierEnvironment(t)
  const directory = temporaryDirectory(t)
  const configPath = join(directory, "sciencedirect.json")
  const hooks = await createScienceDirectPlugin({ configPath })()
  const missing = await hooks.tool.sciencedirect_status.execute({})
  assert.match(missing, /not configured/)
  assert.doesNotMatch(missing, /REQUIRED ASSISTANT|compliance|confirm_ai_use|disclaimer|Ask the user/i)
  assert.ok(missing.length < 600)

  writeFileSync(configPath, "invalid json", "utf8")
  const invalid = await hooks.tool.sciencedirect_status.execute({})
  assert.match(invalid, /could not be parsed/)
  assert.equal(readFileSync(configPath, "utf8"), "invalid json")

  writeFileSync(configPath, '{"api_key":"stored-already"}', "utf8")
  process.env.ELSEVIER_API_KEY = " "
  const configured = await hooks.tool.sciencedirect_status.execute({})
  assert.match(configured, /API key: configured \(local config\)/)
  assert.doesNotMatch(configured, /stored-already|AI-use|excerpts remaining|setup required/i)
})

test("configures a key directly without consent gates, never echoes secrets, and works immediately", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const apiKey = "test-personal-api-key-123456789"
  const calls = []
  const context = toolContext("configure-session")
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ resultsFound: 0, results: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "99",
        },
      })
    },
  })
  const hooks = await plugin()

  const configured = await hooks.tool.sciencedirect_configure.execute(
    {
      action: "set_key",
      api_key: apiKey,
    },
    context,
  )
  assert.match(configured, /ScienceDirect configuration saved/)
  assert.match(configured, /ScienceDirect Search API v2 is ready/)
  assert.doesNotMatch(configured, new RegExp(apiKey))

  const stored = loadConfig(configPath)
  assert.equal(stored.apiKey, apiKey)

  const status = await hooks.tool.sciencedirect_status.execute({}, context)
  assert.match(status, /API key: configured \(local config\)/)
  assert.doesNotMatch(status, new RegExp(apiKey))

  await hooks.tool.sciencedirect_search.execute({ query: "photovoltaic", limit: 1 }, context)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers["X-ELS-APIKey"], apiKey)
  assert.equal(calls[1].init.headers["X-ELS-APIKey"], apiKey)
  assert.equal(JSON.parse(calls[1].init.body).qs, "photovoltaic")

  const cleared = await hooks.tool.sciencedirect_configure.execute({ action: "clear" }, context)
  assert.match(cleared, /configuration cleared/)
  assert.equal(loadConfig(configPath).apiKey, undefined)
})

test("supports reading api_key_file and inst_token_file (e.g. from openchamber_secret)", async (t) => {
  isolateElsevierEnvironment(t)
  const dir = temporaryDirectory(t)
  const configPath = join(dir, "sciencedirect.json")
  const keyFile = join(dir, "secret-key.txt")
  const instFile = join(dir, "secret-inst.txt")
  writeFileSync(keyFile, "file-api-key-abcdef\n", "utf8")
  writeFileSync(instFile, "file-inst-token-123456\n", "utf8")

  const seenHeaders = []
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async (_url, init) => {
      seenHeaders.push(init.headers)
      return new Response(JSON.stringify({ resultsFound: 0, results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  const hooks = await plugin()

  const output = await hooks.tool.sciencedirect_configure.execute(
    {
      action: "set_key",
      api_key_file: keyFile,
      inst_token_file: instFile,
    },
    toolContext("secret-file-session", { directory: dir }),
  )

  assert.match(output, /configuration saved/)
  assert.doesNotMatch(output, /file-api-key-abcdef/)
  assert.doesNotMatch(output, /file-inst-token-123456/)
  assert.equal(seenHeaders[0]["X-ELS-APIKey"], "file-api-key-abcdef")
  assert.equal(seenHeaders[0]["X-ELS-Insttoken"], "file-inst-token-123456")

  const stored = loadConfig(configPath)
  assert.equal(stored.apiKey, "file-api-key-abcdef")
  assert.equal(stored.instToken, "file-inst-token-123456")

  await hooks.tool.sciencedirect_configure.execute(
    {
      action: "set_key",
      clear_inst_token: true,
      skip_verify: true,
    },
    toolContext(),
  )
  assert.equal(loadConfig(configPath).apiKey, "file-api-key-abcdef")
  assert.equal(loadConfig(configPath).instToken, undefined)
})

test("rejects APIKEY_INVALID without replacing an existing saved key or echoing secrets", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const previousKey = "previous-valid-key-123456"
  const rejectedKey = "rejected-key-987654321"
  let reject = false
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          reject
            ? {
                "error-response": {
                  "error-code": "APIKEY_INVALID",
                  "error-message": `The provided apiKey ${rejectedKey} is invalid.`,
                },
              }
            : { resultsFound: 0, results: [] },
        ),
        {
          status: reject ? 401 : 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  })
  const hooks = await plugin()
  await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: previousKey,
  })

  reject = true
  const output = await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: rejectedKey,
  })

  assert.match(output, /APIKEY_INVALID/)
  assert.match(output, /new key was not saved/i)
  assert.doesNotMatch(output, new RegExp(rejectedKey))
  assert.equal(loadConfig(configPath).apiKey, previousKey)
})

test("saves valid API keys even when current IP lacks ScienceDirect entitlement (401/403 non-APIKEY_INVALID)", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const validOffCampusKey = "valid-off-campus-key-123456"
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async (url) => {
      if (String(url).includes("/authenticate/")) {
        return new Response(JSON.stringify({ "authenticate-response": { authtoken: "campus-token" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(
        JSON.stringify({
          "service-error": {
            status: {
              statusCode: "AUTHORIZATION_ERROR",
              statusText: "Requestor configuration settings undefined or insufficient for access to this resource.",
            },
          },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      )
    },
  })
  const hooks = await plugin()

  const configured = await hooks.tool.sciencedirect_configure.execute(
    {
      action: "set_key",
      api_key: validOffCampusKey,
    },
    toolContext(),
  )

  assert.match(configured, /ScienceDirect configuration saved/)
  assert.match(configured, /HTTP 403/)
  assert.equal(loadConfig(configPath).apiKey, validOffCampusKey)

  // Because the key was saved, sciencedirect_authenticate can now run without deadlock!
  const auth = await hooks.tool.sciencedirect_authenticate.execute({}, toolContext())
  assert.match(auth, /authentication succeeded/)
})

test("a failed online probe does not lose the user's supplied key", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const hooks = await createScienceDirectPlugin({
    configPath,
    fetchImpl: async () => { throw new Error("Connection unavailable") },
  })()
  const output = await hooks.tool.sciencedirect_configure.execute({ action: "set_key", api_key: "offline-key" })
  assert.match(output, /configuration saved/)
  assert.match(output, /could not reach/)
  assert.equal(loadConfig(configPath).apiKey, "offline-key")
  assert.doesNotMatch(output, /offline-key/)
})

test("distinguishes invalid API keys from IP/entitlement errors", () => {
  assert.equal(
    isInvalidApiKey({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      contentType: "application/json",
      body: JSON.stringify({
        "error-response": {
          "error-code": "APIKEY_INVALID",
          "error-message": "The provided apiKey is invalid.",
        },
      }),
      rateLimit: {},
    }),
    true,
  )

  assert.equal(
    isInvalidApiKey({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      contentType: "text/xml",
      body: "<service-error><status><statusCode>AUTHENTICATION_ERROR</statusCode><statusText>APIKey abc with IP address 1.2.3.4 is unrecognized or has insufficient privileges for access to this resource</statusText></status></service-error>",
      rateLimit: {},
    }),
    false,
  )
})

test("cancellation prevents a candidate key from being sent or saved", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const controller = new AbortController()
  let requests = 0
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async () => {
      requests += 1
      return new Response(JSON.stringify({ resultsFound: 0, results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  const hooks = await plugin()
  const context = toolContext("cancelled-session", {
    abort: controller.signal,
  })
  controller.abort()

  const output = await hooks.tool.sciencedirect_configure.execute(
    {
      action: "set_key",
      api_key: "cancelled-key-123456789",
    },
    context,
  )

  assert.match(output, /cancelled/)
  assert.equal(requests, 0)
  assert.equal(existsSync(configPath), false)
})

test("a clear in another plugin instance prevents an in-flight key write", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  let releaseVerification
  const verificationStarted = new Promise((resolve) => {
    releaseVerification = resolve
  })
  let markVerificationStarted
  const started = new Promise((resolve) => {
    markVerificationStarted = resolve
  })
  const pluginA = createScienceDirectPlugin({
    configPath,
    fetchImpl: async () => {
      markVerificationStarted()
      await verificationStarted
      return new Response(JSON.stringify({ resultsFound: 0, results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  const pluginB = createScienceDirectPlugin({ configPath })
  const hooksA = await pluginA()
  const hooksB = await pluginB()

  const inFlight = hooksA.tool.sciencedirect_configure.execute(
    {
      action: "set_key",
      api_key: "in-flight-key-123456789",
    },
    toolContext("session-a"),
  )
  await started
  await hooksB.tool.sciencedirect_configure.execute({ action: "clear" }, toolContext("session-b"))
  releaseVerification()
  const output = await inFlight

  assert.match(output, /configuration changed concurrently/)
  assert.equal(loadConfig(configPath).apiKey, undefined)
})

test("sends one credential method in headers and preserves quota metadata", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ resultsFound: 0, results: [] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": "20000",
        "X-RateLimit-Remaining": "19999",
        "X-RateLimit-Reset": "1770000000",
      },
    })
  }

  const response = await requestElsevier("/content/search/sciencedirect", {
    credentials: {
      apiKey: "secret-key",
      instToken: "secret-inst",
      oauthToken: "secret-oauth",
    },
    method: "PUT",
    body: { qs: "climate" },
    sessionToken: "secret-session",
    fetchImpl,
  })

  assert.equal(response.ok, true)
  assert.deepEqual(response.rateLimit, {
    limit: "20000",
    remaining: "19999",
    reset: "1770000000",
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://api.elsevier.com/content/search/sciencedirect")
  assert.equal(calls[0].init.method, "PUT")
  assert.equal(calls[0].init.headers["X-ELS-APIKey"], "secret-key")
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-oauth")
  assert.equal(calls[0].init.headers["X-ELS-Insttoken"], undefined)
  assert.equal(calls[0].init.headers["X-ELS-Authtoken"], undefined)

  await requestElsevier("/content/search/sciencedirect", {
    credentials: { apiKey: "secret-key", instToken: "secret-inst" },
    sessionToken: "secret-session",
    fetchImpl,
  })
  assert.equal(calls[1].init.headers["X-ELS-Insttoken"], "secret-inst")
  assert.equal(calls[1].init.headers["X-ELS-Authtoken"], undefined)
})

test("discards oversized responses before exposing their body", async () => {
  const response = await requestElsevier("/content/article/pii/S123", {
    credentials: { apiKey: "secret-key" },
    maxResponseBytes: 4,
    fetchImpl: async () =>
      new Response("12345", {
        status: 200,
        headers: { "Content-Type": "text/plain", "Content-Length": "5" },
      }),
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 413)
  assert.equal(response.body, "")
})

test("parses Authentication API tokens and institution choices", () => {
  const payload = {
    "authenticate-response": {
      authtoken: "sat_secret",
      pathChoices: {
        choice: [{ "@id": "123", "@name": "NUIST" }],
      },
    },
  }
  assert.equal(authenticationToken(payload, ""), "sat_secret")
  assert.deepEqual(authenticationChoices(payload, ""), [{ id: "123", name: "NUIST" }])
})

test("shares active IP authtoken across sessions/subagents and clears it on clear", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_API_KEY = "test-key"
  const configPath = temporaryConfig(t)
  const calls = []
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes("/authenticate/")) {
        return new Response(JSON.stringify({ "authenticate-response": { authtoken: "shared-ip-token" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ resultsFound: 0, results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  const hooks = await plugin()

  const authenticated = await hooks.tool.sciencedirect_authenticate.execute({}, toolContext("main-session"))
  assert.match(authenticated, /authentication succeeded/)
  assert.doesNotMatch(authenticated, /shared-ip-token/)

  await hooks.tool.sciencedirect_search.execute({ query: "solar", limit: 1 }, toolContext("subagent-session"))
  assert.equal(calls[1].init.headers["X-ELS-Authtoken"], "shared-ip-token")

  await hooks.tool.sciencedirect_configure.execute({ action: "clear" }, toolContext("main-session"))
  await hooks.tool.sciencedirect_search.execute({ query: "wind", limit: 1 }, toolContext("subagent-session"))
  assert.equal(calls[2].init.headers["X-ELS-Authtoken"], undefined)
})

test("builds Search v2 PUT body and Article Metadata fallback query", () => {
  const request = buildScienceDirectSearchBody({
    query: '(climate OR weather) AND "machine learning"',
    authors: "Zhang",
    publication: "Atmospheric Research",
    year: "2020 - 2026",
    open_access_only: true,
    loaded_after: "2025-01-02",
    offset: 25,
    limit: 60,
    sort: "date",
    highlights: true,
  })

  assert.deepEqual(request, {
    body: {
      qs: '(climate OR weather) AND "machine learning"',
      authors: "Zhang",
      pub: "Atmospheric Research",
      date: "2020-2026",
      filters: { openAccess: true },
      loadedAfter: "2025-01-02T00:00:00Z",
      display: {
        highlights: true,
        offset: 25,
        show: 100,
        sortBy: "date",
      },
    },
    requestedLimit: 60,
    offset: 25,
    sort: "date",
  })

  const metaPath = buildArticleMetadataSearchPath({
    query: "perovskite",
    authors: "Wang",
    year: "2024",
    open_access_only: true,
    limit: 10,
  })
  assert.match(metaPath, /^\/content\/metadata\/article\?/)
  const decoded = new URL(metaPath, "https://api.elsevier.com").searchParams.get("query")
  assert.match(decoded, /title\(perovskite\) OR keywords\(perovskite\)/)
  assert.match(decoded, /authors\(Wang\)/)
  assert.match(decoded, /pub-date AFT 20231231/)
  assert.match(decoded, /pub-date BEF 20250101/)
  assert.match(decoded, /openaccess\(1\)/)
})

test("automatically falls back to Article Metadata API when Search v2 returns 403", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_API_KEY = "metadata-only-key"
  const configPath = temporaryConfig(t)
  const urls = []
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async (url) => {
      urls.push(String(url))
      if (String(url).includes("/content/search/sciencedirect")) {
        return new Response(
          JSON.stringify({
            "service-error": { status: { statusCode: "AUTHORIZATION_ERROR", statusText: "Not entitled to Search v2" } },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response(
        JSON.stringify({
          "search-results": {
            "opensearch:totalResults": "1",
            entry: [
              {
                "dc:title": "Metadata Fallback Paper",
                "dc:creator": "J. Doe",
                "prism:publicationName": "Solar Energy",
                "prism:coverDate": "2025-05-01",
                "prism:doi": "10.1016/j.solener.2025.01.001",
                pii: "S0038092X25000015",
                openaccess: "1",
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    },
  })
  const hooks = await plugin()

  const output = await hooks.tool.sciencedirect_search.execute({ query: "solar", limit: 5 }, toolContext())
  assert.equal(urls.length, 2)
  assert.match(output, /Article Metadata API fallback/)
  assert.match(output, /Metadata Fallback Paper/)
  assert.match(output, /DOI: 10\.1016\/j\.solener\.2025\.01\.001/)
})

test("rejects invalid search parameters", () => {
  assert.throws(() => buildScienceDirectSearchBody({}), /Provide at least one/)
  assert.throws(
    () => buildScienceDirectSearchBody({ query: "weather", year: "2026-2020" }),
    /start must not be after/,
  )
  assert.throws(
    () => buildScienceDirectSearchBody({ query: "weather", loaded_after: "not-a-date" }),
    /ISO 8601/,
  )
  assert.throws(
    () => buildScienceDirectSearchBody({ query: "weather", limit: 101 }),
    /between 1 and 100/,
  )
  assert.throws(() => buildScienceDirectSearchBody({ query: "weather", limit: NaN }), /between 1 and 100/)
  assert.throws(() => buildScienceDirectSearchBody({ query: "weather", offset: Infinity }), /between 0 and 6000/)
})

test("formats native search results cleanly without disclaimer footers", () => {
  const output = formatScienceDirectSearchResponse(
    {
      resultsFound: 767,
      results: [
        {
          authors: [{ order: 0, name: "Xiao He" }, { order: 1, name: "Xing Chen" }],
          doi: "10.1016/j.infsof.2018.07.010",
          openAccess: false,
          pages: { first: "98", last: "117" },
          pii: "S0950584918301538",
          publicationDate: "2018-07-17",
          sourceTitle: "Information and Software Technology",
          title: "Testing Bidirectional Model Transformation",
          uri: "https://www.sciencedirect.com/science/article/pii/S0950584918301538",
          volumeIssue: "Volume 98",
        },
      ],
    },
    {
      requestedLimit: 10,
      offset: 0,
      sort: "relevance",
      rateLimit: { remaining: "99", limit: "100" },
    },
  )

  assert.match(output, /Found: 767; returned: 1/)
  assert.match(output, /Xiao He, Xing Chen/)
  assert.match(output, /DOI: 10\.1016\/j\.infsof\.2018\.07\.010/)
  assert.match(output, /PII: S0950584918301538/)
  assert.match(output, /99\/100 remaining/)
  assert.doesNotMatch(output, /untrusted publisher data/i)
})

test("resolves DOI, ScienceDirect URL, and explicit numeric identifiers", () => {
  assert.deepEqual(resolveArticleIdentifier("https://doi.org/10.1016/j.test.2026.01.001"), {
    type: "doi",
    value: "10.1016/j.test.2026.01.001",
  })
  assert.deepEqual(
    resolveArticleIdentifier(
      "https://www.sciencedirect.com/science/article/pii/S0950584918301538?via%3Dihub",
    ),
    { type: "pii", value: "S0950584918301538" },
  )
  assert.deepEqual(resolveArticleIdentifier("12345678", "pubmed_id"), {
    type: "pubmed_id",
    value: "12345678",
  })
  assert.throws(() => resolveArticleIdentifier("12345678"), /ambiguous/)
})

test("formats article metadata, strips markup, and preserves scientific inequalities", () => {
  const output = formatScienceDirectArticleResponse(
    {
      "full-text-retrieval-response": {
        link: [
          {
            "@rel": "scidir",
            "@href": "https://www.sciencedirect.com/science/article/pii/S1234567890123456",
          },
        ],
        coredata: {
          "dc:title": "A useful atmospheric paper",
          "dc:creator": "First Author",
          "dc:description": "<abstract><para>First sentence.</para><para>Second &amp; final.</para></abstract>",
          "prism:doi": "10.1016/j.example.2026.01.001",
          "prism:publicationName": "Atmospheric Research",
          "prism:coverDate": "2026-01-10",
          "prism:startingPage": "10",
          "prism:endingPage": "19",
          pii: "S1234567890123456",
          openaccessArticle: true,
          authors: {
            author: [
              { "given-name": "First", surname: "Author" },
              { "given-name": "Second", surname: "Author" },
            ],
          },
        },
      },
    },
    "abstract",
  )

  assert.match(output, /Authors: First Author, Second Author/)
  assert.match(output, /PII: S1234567890123456/)
  assert.match(output, /Citation details: 10-19/)
  assert.match(output, /Open access: yes/)
  assert.match(output, /First sentence\.\n\nSecond & final\./)
  assert.doesNotMatch(output, /<para>/)
  assert.doesNotMatch(output, /untrusted publisher data/i)

  assert.equal(
    cleanMarkup("<ce:para>Result p &lt; 0.05 and x &gt; 1.</ce:para>"),
    "Result p < 0.05 and x > 1.",
  )
  assert.equal(cleanMarkup("Result &#99999999; remains readable."), "Result &#99999999; remains readable.")

  const jsonBody = JSON.stringify({
    "full-text-retrieval-response": {
      originalText:
        "&lt;xocs:doc&gt;&lt;ce:section&gt;&lt;ce:title&gt;Results&lt;/ce:title&gt;&lt;ce:para&gt;Useful &amp;amp; relevant.&lt;/ce:para&gt;&lt;/ce:section&gt;&lt;/xocs:doc&gt;",
    },
  })
  assert.match(extractFullText(jsonBody, "application/json"), /Useful & relevant\./)
})

test("supports unlimited full-text requests, offset pagination, and automatic view downgrade", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_API_KEY = "test-key"
  const configPath = temporaryConfig(t)
  const fullBody = "Section 1: Introduction. Section 2: Methods. Section 3: Results and Conclusion."
  let restrictFullView = false

  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async (url) => {
      const target = String(url)
      if (restrictFullView && target.includes("view=FULL")) {
        return new Response("View parameter specified in request is not valid", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        })
      }
      if (restrictFullView) {
        return new Response(
          JSON.stringify({
            "full-text-retrieval-response": {
              originalText: `<ce:para>${fullBody}</ce:para>`,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response(fullBody, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    },
  })
  const hooks = await plugin()
  const context = toolContext("reading-session")

  // Can make more than 3 full-text calls in one session without artificial lockout
  for (let i = 0; i < 5; i += 1) {
    const res = await hooks.tool.sciencedirect_article.execute(
      {
        identifier: "S1234567890123456",
        mode: "full_text",
        offset: 0,
        max_chars: 25,
      },
      context,
    )
    assert.match(res, /Characters: 0-25/)
    assert.match(res, /offset=25/)
  }

  const secondChunk = await hooks.tool.sciencedirect_article.execute(
    {
      identifier: "S1234567890123456",
      mode: "full_text",
      offset: 25,
      max_chars: 200,
    },
    context,
  )
  assert.match(secondChunk, /Section 2: Methods\. Section 3: Results and Conclusion\./)

  // Automatic fallback when explicit view=FULL is rejected with 400/403
  restrictFullView = true
  const downgraded = await hooks.tool.sciencedirect_article.execute(
    {
      identifier: "S1234567890123456",
      mode: "full_text",
    },
    context,
  )
  assert.match(downgraded, /Section 1: Introduction/)
})

test("saves the complete article text even when the model preview is paginated", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_API_KEY = "download-test-key"
  const directory = temporaryDirectory(t)
  const text = "Introduction. 方法与结果。\n".repeat(100)
  let requests = 0
  const hooks = await createScienceDirectPlugin({
    configPath: join(directory, "sciencedirect.json"),
    fetchImpl: async () => {
      requests += 1
      return new Response(text, { headers: { "Content-Type": "text/plain" } })
    },
  })()
  const context = toolContext("download-session", { directory })
  const args = { identifier: "S1234567890123456", mode: "full_text", max_chars: 20, output_path: "papers/article.txt" }
  const output = await hooks.tool.sciencedirect_article.execute(args, context)
  const outputPath = join(directory, "papers", "article.txt")
  assert.match(output, /Saved complete full text/)
  assert.match(output, /Characters: 0-20/)
  assert.match(output, /offset=20/)
  assert.equal(readFileSync(outputPath, "utf8"), text.trim())
  assert.equal(requests, 1)

  const conflict = await hooks.tool.sciencedirect_article.execute(args, context)
  assert.match(conflict, /already exists/)
  assert.equal(requests, 1)
  assert.equal(readFileSync(outputPath, "utf8"), text.trim())

  const replaced = await hooks.tool.sciencedirect_article.execute({ ...args, overwrite: true }, context)
  assert.match(replaced, /Saved complete full text/)
  assert.equal(requests, 2)

  const invalid = await hooks.tool.sciencedirect_article.execute({ ...args, mode: "abstract" }, context)
  assert.match(invalid, /requires mode=full_text/)
  const invalidOffset = await hooks.tool.sciencedirect_article.execute({ identifier: args.identifier, mode: "full_text", offset: NaN }, context)
  assert.match(invalidOffset, /finite number/)
  assert.equal(requests, 2)
})

test("XML metadata and HTML are not mislabeled or saved as full text", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_API_KEY = "test-key"
  const directory = temporaryDirectory(t)
  const xml = '<full-text-retrieval-response><coredata><dc:title>Metadata only</dc:title></coredata></full-text-retrieval-response>'
  assert.equal(extractFullText(xml, "text/xml"), "")
  assert.equal(extractFullText("<html>Login required</html>", "text/html"), "")
  assert.match(extractFullText('<full-text-retrieval-response><originalText><ce:para>Real methods.</ce:para></originalText></full-text-retrieval-response>', "text/xml"), /Real methods\./)

  const hooks = await createScienceDirectPlugin({
    configPath: join(directory, "sciencedirect.json"),
    fetchImpl: async (url) => String(url).includes("view=FULL")
      ? new Response(xml, { headers: { "Content-Type": "text/xml" } })
      : new Response(JSON.stringify({ "full-text-retrieval-response": { coredata: { "dc:title": "Metadata only" } } }), { headers: { "Content-Type": "application/json" } }),
  })()
  const output = await hooks.tool.sciencedirect_article.execute({ identifier: "S1234567890123456", mode: "full_text", output_path: "not-full-text.txt" }, toolContext("metadata-session", { directory }))
  assert.match(output, /metadata/)
  assert.doesNotMatch(output, /Saved complete full text/)
  assert.equal(existsSync(join(directory, "not-full-text.txt")), false)
})

test("official quota errors are reported without retrying or inventing another local quota", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_API_KEY = "quota-test-key"
  let requests = 0
  const hooks = await createScienceDirectPlugin({
    configPath: temporaryConfig(t),
    fetchImpl: async () => {
      requests += 1
      return new Response(JSON.stringify({ "error-response": { "error-code": "QUOTA_EXCEEDED", "error-message": "Official quota reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "0" },
      })
    },
  })()
  const output = await hooks.tool.sciencedirect_article.execute({ identifier: "S1234567890123456", mode: "full_text" }, toolContext())
  assert.match(output, /HTTP 429/)
  assert.match(output, /QUOTA_EXCEEDED/)
  assert.match(output, /0\/100 remaining/)
  assert.doesNotMatch(output, /per.*session|excerpts|disclaimer/i)
  assert.equal(requests, 1)
})
