import { Plugin } from "@opencode/plugin"
import type { ToolContext as RuntimeToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"

// Keep schema inference and the tool implementations independent of registration.
// Only this module converts their text results to V2's structured tool results.
export type ToolContext = Omit<RuntimeToolContext, "sessionID"> & {
  sessionID: string
  directory: string
  worktree: string
  abort: AbortSignal
}

export function tool<Args extends z.ZodRawShape>(definition: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>
}) {
  return definition
}
tool.schema = z

export type ToolFactory = () => Promise<{
  tool: Record<string, ReturnType<typeof tool<any>>>
  system?: (output: { system: string[] }) => Promise<void>
}>

export function defineToolsPlugin(id: string, create: ToolFactory) {
  return Plugin.define({
    id,
    async setup(ctx) {
      const definitions = await create()
      if (definitions.system) {
        await ctx.session.hook("context", async (event) => {
          const output = { system: [] as string[] }
          await definitions.system!(output)
          event.system.push(...output.system.map((text) => ({ type: "text" as const, text })))
        })
      }
      await ctx.tool.transform((editor) => {
        for (const [name, definition] of Object.entries(definitions.tool)) {
          const schema = z.object(definition.args)
          editor.add({
            name,
            description: definition.description,
            input: z.toJSONSchema(schema),
            // Keep plugin tools in the model's normal tool list. Code Mode is
            // not exposed consistently by every model/client combination,
            // which otherwise makes installed tools appear to be missing.
            options: { codemode: false, permission: name },
            async execute(input, context) {
              // Sessions can move after plugin setup. Resolve paths at execution time.
              const session = await ctx.session.get({ sessionID: context.sessionID })
              const directory = session.location.directory
              const content = await definition.execute(schema.parse(input), {
                ...context,
                directory,
                worktree: directory,
                abort: context.signal,
              })
              return { content }
            },
          })
        }
      })
    },
  })
}
