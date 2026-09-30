import assert from "node:assert/strict"
import test from "node:test"
import { defineToolsPlugin, tool } from "../plugins/lib/tools.ts"

function runtime() {
  const tools = new Map()
  const hooks = new Map()
  const state = { directory: "E:/current-session" }
  return {
    tools, hooks, state,
    ctx: {
      session: {
        async get() { return { location: { directory: state.directory } } },
        async hook(name, callback) { hooks.set(name, callback) },
      },
      tool: {
        async transform(callback) {
          callback({ add(definition) { tools.set(definition.name, definition) } })
        },
      },
    },
  }
}

const call = {
  sessionID: "ses_test",
  messageID: "msg_test",
  id: "call_test",
  agent: "build",
  signal: new AbortController().signal,
  async progress() {},
}

for (const id of ["bandizip", "everything-search", "image-gen", "lolia-frp", "office-docs", "sciencedirect"]) {
  test(`${id}: V2 entrypoint registers valid JSON-schema tools`, async () => {
    const plugin = (await import(`../plugins/${id}.ts`)).default
    assert.equal(plugin.id, id)
    const { ctx, tools, hooks } = runtime()
    await plugin.setup(ctx)
    assert.ok(tools.size > 0)
    for (const [name, definition] of tools) {
      assert.equal(definition.input.type, "object", name)
      assert.equal(definition.options.permission, name)
      assert.equal(definition.options.codemode, false)
      assert.equal(typeof definition.execute, "function")
      assert.ok(definition.description.length > 0)
      assert.doesNotThrow(() => JSON.stringify(definition.input))
    }
    if (id === "everything-search") {
      const event = { system: [] }
      await hooks.get("context")(event)
      assert.equal(event.system[0].type, "text")
      assert.match(event.system[0].text, /everything_search/)
      const result = await tools.get("everything_search").execute({ query: " " }, call)
      assert.deepEqual(result, { content: "Error: query is required." })
    }
    if (id === "sciencedirect") assert.ok(hooks.has("context"))
  })
}

test("V2 tool execution validates input, follows moved sessions and forwards cancellation", async () => {
  const plugin = defineToolsPlugin("probe", async () => ({
    tool: {
      probe: tool({
        description: "Test the registration boundary",
        args: { value: tool.schema.string(), count: tool.schema.number().optional() },
        async execute(input, context) {
          assert.equal(context.abort, call.signal)
          assert.equal(context.signal, call.signal)
          assert.equal(context.sessionID, call.sessionID)
          assert.equal(context.worktree, context.directory)
          return `${context.directory}:${input.value}`
        },
      }),
    },
  }))
  const { ctx, tools, state } = runtime()
  await plugin.setup(ctx)
  const probe = tools.get("probe")
  assert.deepEqual(probe.input.required, ["value"])
  assert.deepEqual(await probe.execute({ value: "hello" }, call), { content: "E:/current-session:hello" })
  state.directory = "E:/moved-session"
  assert.deepEqual(await probe.execute({ value: "hello" }, call), { content: "E:/moved-session:hello" })
  await assert.rejects(probe.execute({ value: 123 }, call))
})
