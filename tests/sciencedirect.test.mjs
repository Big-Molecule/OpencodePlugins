import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin") {
      return {
        url: "data:text/javascript,const schema=new Proxy(function(){return schema},{get(){return schema}});export function tool(value){return value};tool.schema=schema",
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})

const pluginModule = await import("../plugins/sciencedirect.ts")
const ScienceDirectPlugin = pluginModule.default
const {
  aiUseConfirmed,
  authenticationChoices,
  authenticationToken,
  buildScienceDirectSearchBody,
  cleanMarkup,
  createScienceDirectPlugin,
  extractFullText,
  formatScienceDirectArticleResponse,
  formatScienceDirectSearchResponse,
  getElsevierCredentials,
  loadConfig,
  requestElsevier,
  resolveArticleIdentifier,
} = ScienceDirectPlugin.__test

const ELSEVIER_ENV_NAMES = [
  "ELSEVIER_API_KEY",
  "ELSEVIER_INST_TOKEN",
  "ELSEVIER_AUTHTOKEN",
  "ELSEVIER_OAUTH_TOKEN",
  "ELSEVIER_AI_USE_CONFIRMED",
]

function temporaryConfig(t) {
  const directory = mkdtempSync(join(tmpdir(), "sciencedirect-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, "nested", "sciencedirect.json")
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

test("exports one V2 plugin definition", () => {
  assert.deepEqual(Object.keys(pluginModule), ["default"])
  assert.equal(ScienceDirectPlugin.id, "sciencedirect")
  assert.equal(typeof ScienceDirectPlugin.setup, "function")
})

test("registers the setup, authentication, search, and article tools", async () => {
  const hooks = await createScienceDirectPlugin()()
  assert.equal(typeof hooks.system, "function")
  assert.deepEqual(Object.keys(hooks.tool), [
    "sciencedirect_status",
    "sciencedirect_configure",
    "sciencedirect_authenticate",
    "sciencedirect_search",
    "sciencedirect_article",
  ])
  assert.match(hooks.tool.sciencedirect_search.description, /not the only source/)
  assert.match(hooks.tool.sciencedirect_search.description, /other appropriate scholarly databases or web search tools/)
  assert.match(hooks.tool.sciencedirect_article.description, /Never use for bulk downloading/)
})

test("requires a user-facing setup question instead of stopping at missing status", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const plugin = createScienceDirectPlugin({ configPath })
  const hooks = await plugin()
  const system = { system: [] }

  await hooks.system(system)

  assert.equal(system.system.length, 1)
  assert.match(system.system[0], /MUST NOT stop after showing or summarizing status/)
  assert.match(system.system[0], /explicitly ask them to provide the personal key/)
  assert.match(system.system[0], /A key alone is not compliance confirmation/)

  const status = await hooks.tool.sciencedirect_status.execute({}, toolContext())
  assert.match(status, /^REQUIRED ASSISTANT FOLLOW-UP:/)
  assert.match(status, /Ask the user for every missing setup item/)

  process.env.ELSEVIER_API_KEY = "configured-environment-key"
  const confirmationSystem = { system: [] }
  await hooks.system(confirmationSystem)
  assert.match(confirmationSystem.system[0], /ask the user.*explicitly confirm compliance/i)
  assert.match(confirmationSystem.system[0], /action=confirm_ai_use/)
  assert.match(confirmationSystem.system[0], /Do not ask for the key again/)

  process.env.ELSEVIER_AI_USE_CONFIRMED = "1"
  const configuredSystem = { system: [] }
  await hooks.system(configuredSystem)
  assert.deepEqual(configuredSystem.system, [])
})

test("loads Elsevier credentials from the environment when local config is absent", (t) => {
  const configPath = temporaryConfig(t)
  assert.deepEqual(
    getElsevierCredentials({
      ELSEVIER_API_KEY: " api-key ",
      ELSEVIER_INST_TOKEN: " inst-token ",
      ELSEVIER_AUTHTOKEN: " auth-token ",
      ELSEVIER_OAUTH_TOKEN: " oauth-token ",
    }, configPath),
    {
      apiKey: "api-key",
      instToken: "inst-token",
      authToken: "auth-token",
      oauthToken: "oauth-token",
    },
  )
  assert.equal(aiUseConfirmed({ ELSEVIER_AI_USE_CONFIRMED: "true" }, configPath), true)
  assert.equal(aiUseConfirmed({ ELSEVIER_AI_USE_CONFIRMED: "0" }, configPath), false)
})

test("explicit environment settings override stored key and consent", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async () =>
      new Response(JSON.stringify({ resultsFound: 0, results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  })
  const hooks = await plugin()
  await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: "stored-key-123456789",
    ai_use_confirmed: true,
  }, toolContext())

  const environment = {
    ELSEVIER_API_KEY: " environment-key ",
    ELSEVIER_AI_USE_CONFIRMED: "0",
  }
  assert.equal(getElsevierCredentials(environment, configPath).apiKey, "environment-key")
  assert.equal(aiUseConfirmed(environment, configPath), false)
})

test("an explicit environment opt-out prevents in-chat configuration", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_AI_USE_CONFIRMED = "0"
  const configPath = temporaryConfig(t)
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

  const output = await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: "blocked-key-123456789",
    ai_use_confirmed: true,
  }, toolContext())

  assert.match(output, /explicitly disables AI use/)
  assert.equal(requests, 0)
  assert.equal(existsSync(configPath), false)

  const status = await hooks.tool.sciencedirect_status.execute({}, toolContext())
  assert.match(status, /explicitly disabled/)
  assert.match(status, /Do not ask for a key or confirmation/)
  assert.doesNotMatch(status, /First-time in-chat setup/)
})

test("requires explicit AI-use confirmation before sending or saving a key", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
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

  const output = await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: "not-sent-without-consent",
  })

  assert.match(output, /AI-use confirmation required/)
  assert.match(output, /Do not confirm on the user's behalf/)
  assert.equal(requests, 0)
  assert.equal(existsSync(configPath), false)
})

test("configures a key without echoing it and uses it immediately", async (t) => {
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

  const configured = await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: apiKey,
    ai_use_confirmed: true,
  }, context)
  assert.match(configured, /configuration saved/)
  assert.match(configured, /verified with Elsevier/)
  assert.doesNotMatch(configured, new RegExp(apiKey))

  const stored = loadConfig(configPath)
  assert.equal(stored.apiKey, apiKey)
  assert.equal(stored.aiUse.confirmed, true)
  assert.equal(stored.aiUse.revision, 1)
  const storedText = readFileSync(configPath, "utf8")
  assert.doesNotMatch(storedText, /instToken|authToken|oauthToken/)

  process.env.ELSEVIER_API_KEY = "rotated-environment-key"
  assert.equal(getElsevierCredentials(process.env, configPath).apiKey, "rotated-environment-key")
  delete process.env.ELSEVIER_API_KEY

  const status = await hooks.tool.sciencedirect_status.execute({})
  assert.match(status, /Personal API key: configured \(local config\)/)
  assert.match(status, /AI-use confirmation: confirmed \(local config\)/)
  assert.doesNotMatch(status, new RegExp(apiKey))

  await hooks.tool.sciencedirect_search.execute({ query: "photovoltaic", limit: 1 }, context)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers["X-ELS-APIKey"], apiKey)
  assert.equal(calls[1].init.headers["X-ELS-APIKey"], apiKey)
  assert.equal(JSON.parse(calls[0].init.body).qs, "solar energy")
  assert.equal(JSON.parse(calls[1].init.body).qs, "photovoltaic")

  const cleared = await hooks.tool.sciencedirect_configure.execute({ action: "clear" }, context)
  assert.match(cleared, /credentials and AI-use confirmation cleared/)
  assert.doesNotMatch(cleared, new RegExp(apiKey))
  assert.equal(loadConfig(configPath).apiKey, undefined)
  assert.equal(loadConfig(configPath).aiUse, undefined)
})

test("does not replace an existing key when Elsevier returns 401", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const previousKey = "previous-valid-key-123456"
  const rejectedKey = "rejected-key-987654321"
  let reject = false
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async () =>
      new Response(
        JSON.stringify(reject ? { error: { message: `echo ${rejectedKey}` } } : { resultsFound: 0, results: [] }),
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
    ai_use_confirmed: true,
  })

  reject = true
  const output = await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: rejectedKey,
    ai_use_confirmed: true,
  })

  assert.match(output, /HTTP 401/)
  assert.match(output, /new key was not saved/i)
  assert.doesNotMatch(output, new RegExp(rejectedKey))
  assert.equal(loadConfig(configPath).apiKey, previousKey)
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

  const output = await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: "cancelled-key-123456789",
    ai_use_confirmed: true,
  }, context)

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

  const inFlight = hooksA.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: "in-flight-key-123456789",
    ai_use_confirmed: true,
  }, toolContext("session-a"))
  await started
  await hooksB.tool.sciencedirect_configure.execute({ action: "clear" }, toolContext("session-b"))
  releaseVerification()
  const output = await inFlight

  assert.match(output, /configuration changed/)
  assert.equal(loadConfig(configPath).apiKey, undefined)
  assert.equal(loadConfig(configPath).aiUse, undefined)
})

test("does not save a candidate key after an inconclusive server failure", async (t) => {
  isolateElsevierEnvironment(t)
  const configPath = temporaryConfig(t)
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "temporary failure" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
  })
  const hooks = await plugin()

  const output = await hooks.tool.sciencedirect_configure.execute({
    action: "set_key",
    api_key: "not-saved-after-503-123456",
    ai_use_confirmed: true,
  }, toolContext())

  assert.match(output, /not saved/)
  assert.match(output, /HTTP 503/)
  assert.equal(existsSync(configPath), false)
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
  assert.doesNotMatch(calls[0].url, /secret/)
  assert.equal(calls[0].init.method, "PUT")
  assert.equal(calls[0].init.redirect, "manual")
  assert.equal(calls[0].init.headers["X-ELS-APIKey"], "secret-key")
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-oauth")
  assert.equal(calls[0].init.headers["X-ELS-Insttoken"], undefined)
  assert.equal(calls[0].init.headers["X-ELS-Authtoken"], undefined)
  assert.equal(calls[0].init.headers["Content-Type"], "application/json")
  assert.deepEqual(JSON.parse(calls[0].init.body), { qs: "climate" })

  await requestElsevier("/content/search/sciencedirect", {
    credentials: { apiKey: "secret-key", instToken: "secret-inst" },
    sessionToken: "secret-session",
    fetchImpl,
  })
  assert.equal(calls[1].init.headers["X-ELS-Insttoken"], "secret-inst")
  assert.equal(calls[1].init.headers["X-ELS-Authtoken"], undefined)
  assert.equal(calls[1].init.headers.Authorization, undefined)
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

test("reuses an in-memory IP authtoken without exposing it", async (t) => {
  const configPath = temporaryConfig(t)
  const previous = {
    key: process.env.ELSEVIER_API_KEY,
    inst: process.env.ELSEVIER_INST_TOKEN,
    auth: process.env.ELSEVIER_AUTHTOKEN,
    oauth: process.env.ELSEVIER_OAUTH_TOKEN,
    confirmed: process.env.ELSEVIER_AI_USE_CONFIRMED,
  }
  const originalFetch = globalThis.fetch
  const calls = []
  process.env.ELSEVIER_API_KEY = "test-key"
  delete process.env.ELSEVIER_INST_TOKEN
  delete process.env.ELSEVIER_AUTHTOKEN
  delete process.env.ELSEVIER_OAUTH_TOKEN
  process.env.ELSEVIER_AI_USE_CONFIRMED = "1"
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("/authenticate/")) {
      return new Response(JSON.stringify({ "authenticate-response": { authtoken: "sat_secret" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ resultsFound: 0, results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    const plugin = createScienceDirectPlugin({ configPath })
    const hooks = await plugin()
    const authenticated = await hooks.tool.sciencedirect_authenticate.execute({})
    assert.match(authenticated, /authentication succeeded/)
    assert.doesNotMatch(authenticated, /sat_secret/)
    await hooks.tool.sciencedirect_search.execute({ query: "climate", limit: 1 })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].init.headers["X-ELS-Authtoken"], undefined)
    assert.equal(calls[1].init.headers["X-ELS-Authtoken"], "sat_secret")
  } finally {
    globalThis.fetch = originalFetch
    for (const [name, value] of [
      ["ELSEVIER_API_KEY", previous.key],
      ["ELSEVIER_INST_TOKEN", previous.inst],
      ["ELSEVIER_AUTHTOKEN", previous.auth],
      ["ELSEVIER_OAUTH_TOKEN", previous.oauth],
      ["ELSEVIER_AI_USE_CONFIRMED", previous.confirmed],
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("keeps institutional IP authtokens isolated by OpenCode session", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_API_KEY = "test-key"
  process.env.ELSEVIER_AI_USE_CONFIRMED = "1"
  const configPath = temporaryConfig(t)
  const calls = []
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes("/authenticate/")) {
        return new Response(JSON.stringify({ "authenticate-response": { authtoken: "session-a-token" } }), {
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
  const sessionA = toolContext("session-a")
  const sessionB = toolContext("session-b")

  await hooks.tool.sciencedirect_authenticate.execute({}, sessionA)
  await hooks.tool.sciencedirect_search.execute({ query: "solar", limit: 1 }, sessionA)
  await hooks.tool.sciencedirect_search.execute({ query: "wind", limit: 1 }, sessionB)

  assert.equal(calls[1].init.headers["X-ELS-Authtoken"], "session-a-token")
  assert.equal(calls[2].init.headers["X-ELS-Authtoken"], undefined)
})

test("builds the native ScienceDirect Search v2 PUT body", () => {
  const request = buildScienceDirectSearchBody({
    query: '(climate OR weather) AND "machine learning"',
    authors: "Zhang",
    publication: "Atmospheric Research",
    year: "2020 - 2026",
    open_access_only: true,
    loaded_after: "2025-01-02",
    offset: 25,
    limit: 12,
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
        show: 25,
        sortBy: "date",
      },
    },
    requestedLimit: 12,
    offset: 25,
    sort: "date",
  })
})

test("rejects invalid or unbounded search requests", () => {
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
    () => buildScienceDirectSearchBody({ query: "weather", limit: 51 }),
    /between 1 and 50/,
  )
})

test("formats native search results with stable identifiers and links", () => {
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
  assert.match(output, /Access: subscription\/entitlement required/)
  assert.match(output, /99\/100 remaining/)
  assert.match(output, /not an exhaustive index of scholarly literature/)
  assert.match(output, /other appropriate databases or search tools/)
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

test("formats article metadata and strips abstract markup", () => {
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
          "dc:identifier": "doi:10.1016/j.example.2026.01.001",
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
  assert.match(output, /Access: open access/)
  assert.match(output, /First sentence\.\n\nSecond & final\./)
  assert.doesNotMatch(output, /<para>/)
})

test("decodes entity-encoded XML before extracting JSON originalText", () => {
  const body = JSON.stringify({
    "full-text-retrieval-response": {
      originalText:
        "&lt;xocs:doc&gt;&lt;ce:section&gt;&lt;ce:title&gt;Results&lt;/ce:title&gt;&lt;ce:para&gt;Useful &amp;amp; relevant.&lt;/ce:para&gt;&lt;/ce:section&gt;&lt;/xocs:doc&gt;",
    },
  })

  const text = extractFullText(body, "application/json")
  assert.match(text, /Results/)
  assert.match(text, /Useful & relevant\./)
  assert.doesNotMatch(text, /<\/?(?:xocs|ce):/)
})

test("preserves entity-encoded scientific inequalities while stripping tags", () => {
  assert.equal(
    cleanMarkup("<ce:para>Result p &lt; 0.05 and x &gt; 1.</ce:para>"),
    "Result p < 0.05 and x > 1.",
  )
})

test("leaves out-of-range numeric entities intact instead of throwing", () => {
  assert.equal(cleanMarkup("Result &#99999999; remains readable."), "Result &#99999999; remains readable.")
})

test("bounds unusually large abstract output", () => {
  const output = formatScienceDirectArticleResponse(
    {
      "full-text-retrieval-response": {
        coredata: {
          "dc:title": "Large abstract",
          "dc:description": "x".repeat(25_000),
        },
      },
    },
    "abstract",
  )

  assert.ok(output.length < 21_000)
  assert.match(output, /Abstract truncated locally at 20000 characters/)
})

test("status sends institution-token users directly to search", async (t) => {
  const configPath = temporaryConfig(t)
  const previous = {
    key: process.env.ELSEVIER_API_KEY,
    inst: process.env.ELSEVIER_INST_TOKEN,
    confirmed: process.env.ELSEVIER_AI_USE_CONFIRMED,
  }
  process.env.ELSEVIER_API_KEY = "test-key"
  process.env.ELSEVIER_INST_TOKEN = "test-insttoken"
  process.env.ELSEVIER_AI_USE_CONFIRMED = "1"

  try {
    const plugin = createScienceDirectPlugin({ configPath })
    const hooks = await plugin()
    const output = await hooks.tool.sciencedirect_status.execute({})
    assert.match(output, /Token-based authentication is configured/)
    assert.match(output, /Call sciencedirect_search directly/)
  } finally {
    if (previous.key === undefined) delete process.env.ELSEVIER_API_KEY
    else process.env.ELSEVIER_API_KEY = previous.key
    if (previous.inst === undefined) delete process.env.ELSEVIER_INST_TOKEN
    else process.env.ELSEVIER_INST_TOKEN = previous.inst
    if (previous.confirmed === undefined) delete process.env.ELSEVIER_AI_USE_CONFIRMED
    else process.env.ELSEVIER_AI_USE_CONFIRMED = previous.confirmed
  }
})

test("atomically limits concurrent full-text excerpts per OpenCode session", async (t) => {
  const configPath = temporaryConfig(t)
  const previous = {
    key: process.env.ELSEVIER_API_KEY,
    inst: process.env.ELSEVIER_INST_TOKEN,
    confirmed: process.env.ELSEVIER_AI_USE_CONFIRMED,
  }
  const originalFetch = globalThis.fetch
  let requests = 0
  process.env.ELSEVIER_API_KEY = "test-key"
  process.env.ELSEVIER_INST_TOKEN = "test-insttoken"
  process.env.ELSEVIER_AI_USE_CONFIRMED = "1"
  globalThis.fetch = async () => {
    requests += 1
    return new Response("A bounded full-text response.", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  try {
    const plugin = createScienceDirectPlugin({ configPath })
    const hooks = await plugin()
    const context = toolContext("full-text-limit-session")
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () =>
        hooks.tool.sciencedirect_article.execute({
          identifier: "S1234567890123456",
          mode: "full_text",
          max_chars: 100,
        }, context),
      ),
    )
    assert.equal(outputs.filter((output) => /ScienceDirect full-text excerpt/.test(output)).length, 3)
    assert.equal(outputs.filter((output) => /reached its limit of 3 full-text excerpts/.test(output)).length, 3)
    assert.equal(requests, 3)

    const blocked = await hooks.tool.sciencedirect_article.execute({
        identifier: "S1234567890123456",
        mode: "full_text",
        max_chars: 100,
      }, context)
    assert.match(blocked, /reached its limit of 3 full-text excerpts/)
    assert.equal(requests, 3)
  } finally {
    globalThis.fetch = originalFetch
    if (previous.key === undefined) delete process.env.ELSEVIER_API_KEY
    else process.env.ELSEVIER_API_KEY = previous.key
    if (previous.inst === undefined) delete process.env.ELSEVIER_INST_TOKEN
    else process.env.ELSEVIER_INST_TOKEN = previous.inst
    if (previous.confirmed === undefined) delete process.env.ELSEVIER_AI_USE_CONFIRMED
    else process.env.ELSEVIER_AI_USE_CONFIRMED = previous.confirmed
  }
})

test("releases only the failed full-text reservation during concurrent calls", async (t) => {
  isolateElsevierEnvironment(t)
  process.env.ELSEVIER_API_KEY = "test-key"
  process.env.ELSEVIER_INST_TOKEN = "test-insttoken"
  process.env.ELSEVIER_AI_USE_CONFIRMED = "1"
  const configPath = temporaryConfig(t)
  let requests = 0
  const plugin = createScienceDirectPlugin({
    configPath,
    fetchImpl: async () => {
      requests += 1
      if (requests === 1) {
        return new Response("temporary failure", { status: 500, headers: { "Content-Type": "text/plain" } })
      }
      return new Response("Successful bounded full text.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    },
  })
  const hooks = await plugin()
  const context = toolContext("partial-failure-session")
  const request = () =>
    hooks.tool.sciencedirect_article.execute({
      identifier: "S1234567890123456",
      mode: "full_text",
      max_chars: 100,
    }, context)

  const first = await Promise.all([request(), request(), request()])
  assert.equal(first.filter((output) => /full-text excerpt/.test(output)).length, 2)
  assert.equal(first.filter((output) => /retrieval failed/.test(output)).length, 1)

  const replacement = await request()
  assert.match(replacement, /full-text excerpt/)
  const blocked = await request()
  assert.match(blocked, /reached its limit of 3/)
  assert.equal(requests, 4)
})
