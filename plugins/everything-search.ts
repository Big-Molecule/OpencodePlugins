import { defineToolsPlugin, type ToolFactory, tool } from "./lib/tools.ts"
import { spawn } from "node:child_process"
import { mkdirSync, createWriteStream } from "node:fs"
import { access, constants } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_TIMEOUT_MS = 15_000
const FALLBACK_TIMEOUT_MS = 20_000
const ES_DIR = path.join(process.env.LOCALAPPDATA ?? process.env.HOME ?? ".", "opencode-everything")
const ES_MANAGED = path.join(ES_DIR, "es.exe")
const ES_VERSION = "1.1.0.38"

const ES_CANDIDATES = [
  process.env.EVERYTHING_ES_PATH,
  ES_MANAGED,
  "es",
  "es.exe",
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Everything", "es.exe"),
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Everything", "es.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Everything", "es.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "es.exe"),
].filter(Boolean) as string[]

function isWindows() {
  return process.platform === "win32"
}

async function fileExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (result: { code: number | null; stdout: string; stderr: string; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout, stderr, error: `Timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", (err) => {
      finish({ code: null, stdout, stderr, error: err.message })
    })
    child.on("close", (code) => {
      finish({ code, stdout, stderr })
    })
  })
}

async function commandOnPath(name: string): Promise<string | null> {
  if (!isWindows()) {
    const which = await run("which", [name], 3000)
    const line = which.stdout.trim().split(/\r?\n/).find(Boolean)
    return line || null
  }
  const result = await run("where.exe", [name], 5000)
  if (result.error || result.code !== 0) return null
  const line = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !s.toLowerCase().includes("could not find"))
  return line || null
}

async function resolveEs(): Promise<string | null> {
  for (const candidate of ES_CANDIDATES) {
    if (candidate.includes(path.sep) || candidate.includes("/")) {
      if (await fileExists(candidate)) return candidate
      continue
    }
    const found = await commandOnPath(candidate)
    if (found) return found
  }
  return null
}

async function isEverythingDetected(): Promise<boolean> {
  if (!isWindows()) return false

  const byProcess = await run("tasklist.exe", ["/FI", "IMAGENAME eq Everything.exe", "/NH"], 5000)
  if (!byProcess.error && /Everything\.exe/i.test(byProcess.stdout)) return true

  const byService = await run("sc.exe", ["query", "Everything"], 5000)
  if (!byService.error && /RUNNING/i.test(byService.stdout)) return true

  const common = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Everything", "Everything.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Everything", "Everything.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Everything", "Everything.exe"),
  ]
  for (const p of common) {
    if (await fileExists(p)) return true
  }
  return false
}

function getEsZipUrl(): string | null {
  const archiveByArch: Record<string, string> = {
    arm: "ARM",
    arm64: "ARM64",
    ia32: "x86",
    x64: "x64",
  }
  const archiveArch = archiveByArch[process.arch]
  return archiveArch ? `https://www.voidtools.com/ES-${ES_VERSION}.${archiveArch}.zip` : null
}

function buildEsArgs(input: {
  query: string
  limit: number
  path?: string
  filesOnly?: boolean
  foldersOnly?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  matchPath?: boolean
  regex?: boolean
  sort?: string
}) {
  const args: string[] = ["-n", String(input.limit)]
  if (input.path) args.push("-path", input.path)
  if (input.filesOnly) args.push("/a-d")
  if (input.foldersOnly) args.push("/ad")
  if (input.caseSensitive) args.push("-i")
  if (input.wholeWord) args.push("-w")
  if (input.matchPath) args.push("-p")
  if (input.sort) args.push("-sort", input.sort)
  if (input.regex) args.push("-r", input.query)
  else args.push(input.query)
  return args
}

function formatResults(title: string, lines: string[], limit: number) {
  if (lines.length === 0) return `${title}\nNo results.`
  return [`${title} (${lines.length} hit(s), limit ${limit}):`, ...lines].join("\n")
}

function parseLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

async function fallbackSearch(query: string, root: string | undefined, limit: number) {
  const searchRoot = root?.trim() || (isWindows() ? "C:\\" : "/")
  const safeQuery = query.replace(/["\r\n]/g, "")

  if (isWindows()) {
    // where /r is available on Windows for recursive filename search
    const result = await run("where.exe", ["/R", searchRoot, safeQuery], FALLBACK_TIMEOUT_MS)
    if (!result.error) {
      const lines = parseLines(result.stdout).slice(0, limit)
      if (lines.length > 0) {
        return formatResults(
          `Everything unavailable. Fallback search via where.exe under ${searchRoot}`,
          lines,
          limit,
        )
      }
    }

    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$root='${searchRoot.replace(/'/g, "''")}'`,
      `$q='${safeQuery.replace(/'/g, "''")}'`,
      `$limit=${limit}`,
      "Get-ChildItem -LiteralPath $root -Recurse -Force -Filter $q -ErrorAction SilentlyContinue |",
      "  Select-Object -First $limit -ExpandProperty FullName",
    ].join("; ")

    const psResult = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      FALLBACK_TIMEOUT_MS,
    )
    const lines = parseLines(psResult.stdout).slice(0, limit)
    return formatResults(
      `Everything unavailable. Fallback PowerShell search under ${searchRoot} (slow, may be incomplete)`,
      lines,
      limit,
    )
  }

  const result = await run("find", [searchRoot, "-name", safeQuery], FALLBACK_TIMEOUT_MS)
  const lines = parseLines(result.stdout).slice(0, limit)
  return formatResults(`Everything unavailable. Fallback find under ${searchRoot}`, lines, limit)
}

async function downloadEs(): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  if (!isWindows()) {
    return { ok: false, message: "Automatic es install is only supported on Windows." }
  }

  const zipUrl = getEsZipUrl()
  if (!zipUrl) {
    return { ok: false, message: `Automatic es install does not support ${process.arch}.` }
  }

  try {
    mkdirSync(ES_DIR, { recursive: true })
    const zipPath = path.join(ES_DIR, "es.zip")

    const response = await fetch(zipUrl)
    if (!response.ok || !response.body) {
      return {
        ok: false,
        message: `Failed to download es from ${zipUrl} (HTTP ${response.status}). Install manually from https://www.voidtools.com/downloads/`,
      }
    }

    // Node/Bun ReadableStream to file
    const file = createWriteStream(zipPath)
    const readable = response.body as unknown as NodeJS.ReadableStream
    await pipeline(readable as any, file)

    // Prefer PowerShell Expand-Archive (available on modern Windows)
    const expand = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${ES_DIR.replace(/'/g, "''")}' -Force`,
      ],
      60_000,
    )
    if (expand.error || (expand.code !== 0 && expand.code !== null)) {
      return {
        ok: false,
        message: [
          "Downloaded es zip but failed to extract.",
          expand.stderr || expand.error || "",
          `Zip left at: ${zipPath}`,
          "Manual install: https://www.voidtools.com/downloads/ (Command-line Interface / ES)",
        ]
          .filter(Boolean)
          .join("\n"),
      }
    }

    // zip may contain es.exe at root or in a subfolder
    const direct = path.join(ES_DIR, "es.exe")
    if (await fileExists(direct)) {
      return { ok: true, path: direct }
    }

    const locate = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-ChildItem -LiteralPath '${ES_DIR.replace(/'/g, "''")}' -Recurse -Filter es.exe | Select-Object -First 1 -ExpandProperty FullName`,
      ],
      15_000,
    )
    const found = parseLines(locate.stdout)[0]
    if (found && (await fileExists(found))) {
      // copy path into managed location if needed
      if (path.resolve(found) !== path.resolve(ES_MANAGED)) {
        await run("cmd.exe", ["/c", "copy", "/Y", found, ES_MANAGED], 10_000)
        if (await fileExists(ES_MANAGED)) return { ok: true, path: ES_MANAGED }
      }
      return { ok: true, path: found }
    }

    return {
      ok: false,
      message: `Extracted zip but es.exe not found under ${ES_DIR}. Install manually: https://www.voidtools.com/downloads/`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      message: `Failed to install es: ${message}\nManual install: https://www.voidtools.com/downloads/ (ES command-line interface)`,
    }
  }
}

export const EverythingSearchPlugin: ToolFactory = async () => {
  return {
    system: async (output) => {
      if (!isWindows()) return
      output.system.push([
        "Windows program discovery: when a required command is not on PATH, or an installed program's location is unknown, use everything_search to locate it across indexed drives before guessing common installation directories or proposing/downloading/installing another copy.",
        "A failed Get-Command/where lookup means the command is not on PATH; it does not establish that the program is not installed.",
        "Search first for the executable name (for example ffmpeg.exe, pdftoppm.exe, or inkscape.exe) with files_only=true and omit path for cross-drive discovery. If necessary, try the product name or a filename wildcard.",
        "Inspect candidate paths and verify the intended executable/version using a documented non-interactive check before invoking it by absolute path. Search hits may be installers, backups, or unrelated files.",
        "If Everything reports IPC failure or an incomplete fallback, do not treat that as proof of absence; resolve the search failure or use another local discovery method before concluding the program is missing.",
        "Use project Glob/Grep for ordinary project files. Honor explicit requests for a fresh installation or a specific version.",
      ].join(" "))
    },
    tool: {
      everything_search: tool({
        description: [
          "PREFERRED Windows tool for locating installed programs/executables that are missing from PATH or whose installation path is unknown.",
          "After Get-Command/where fails, use this BEFORE guessing common install paths or proposing/downloading/installing another copy. Not on PATH does not mean not installed.",
          "Search the executable filename with files_only=true and omit path to search across indexed drives; broaden to a product name or wildcard if needed. Verify candidate identity/version before use.",
          "Also use for global, cross-drive filename lookup and locating files outside the current project.",
          "Do NOT use for ordinary in-project search — prefer built-in Glob/Grep/Bash there.",
          "Supports Everything query syntax (ext:ts;tsx, *.pdf, folder:src).",
          "If Everything is missing, falls back to slow OS search and explains that.",
          "If Everything exists but es.exe is missing, explains why es is needed; pass install_es=true only after the user agrees to install es.",
        ].join(" "),
        args: {
          query: tool.schema
            .string()
            .describe(
              'Search query / filename. For installed programs: "ffmpeg.exe", "pdftoppm.exe", "inkscape*.exe" (use files_only=true, omit path). Other examples: "notes.md", "ext:pdf report", "*.tsx".',
            ),
          path: tool.schema
            .string()
            .optional()
            .describe("Optional root path limit (Everything -path). OMIT when locating a program with an unknown install location to search across indexed drives. For fallback search this is the recurse root."),
          limit: tool.schema
            .number()
            .optional()
            .describe(`Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
          files_only: tool.schema.boolean().optional().describe("Files only."),
          folders_only: tool.schema.boolean().optional().describe("Folders only."),
          case_sensitive: tool.schema.boolean().optional().describe("Match case."),
          whole_word: tool.schema.boolean().optional().describe("Whole word match."),
          match_path: tool.schema.boolean().optional().describe("Match full path."),
          regex: tool.schema.boolean().optional().describe("Treat query as regex."),
          sort: tool.schema
            .string()
            .optional()
            .describe("Sort: name, path, size, date-modified, name-descending, etc."),
          install_es: tool.schema
            .boolean()
            .optional()
            .describe(
              "Set true ONLY after the user explicitly agrees to install Everything CLI (es.exe). Downloads official ES zip into %LOCALAPPDATA%\\opencode-everything\\.",
            ),
        },
        async execute(args) {
          const query = args.query?.trim()
          if (!query) return "Error: query is required."
          if (args.files_only && args.folders_only) {
            return "Error: files_only and folders_only cannot both be true."
          }

          const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
          const root = args.path?.trim() || undefined

          if (!isWindows()) {
            const fallback = await fallbackSearch(query, root, limit)
            return [
              "everything_search is optimized for Windows Everything.",
              "Using ordinary filesystem search instead.",
              fallback,
            ].join("\n")
          }

          // Detection only confirms an installation, service, or process. A successful es query
          // below is the authoritative check that the user-session search client exposes IPC.
          const everythingDetected = await isEverythingDetected()
          let esPath = await resolveEs()

          // User agreed to install es
          if (!esPath && args.install_es) {
            if (!everythingDetected) {
              return [
                "Cannot install only es usefully: Everything itself is not detected.",
                "Install Everything first from https://www.voidtools.com/",
                "Then re-run with install_es=true if es.exe is still missing.",
                "",
                await fallbackSearch(query, root, limit),
              ].join("\n")
            }

            const installed = await downloadEs()
            if (!installed.ok) {
              return [
                "User approved es install, but automatic install failed:",
                installed.message,
                "",
                await fallbackSearch(query, root, limit),
              ].join("\n")
            }
            esPath = installed.path
          }

          // Everything missing → fallback
          if (!everythingDetected && !esPath) {
            return [
              "Everything is not installed (or not running).",
              "For whole-disk instant search, install Everything: https://www.voidtools.com/",
              "Falling back to ordinary OS search (slower, may be incomplete / permission-limited).",
              "",
              await fallbackSearch(query, root, limit),
            ].join("\n")
          }

          // Everything present but es missing → ask (do not install without consent)
          if (everythingDetected && !esPath) {
            return [
              "Everything appears installed/running, but the CLI (es.exe) was not found.",
              "",
              "Why es is needed:",
              "- Everything's GUI index is not directly callable by OpenCode.",
              "- es.exe is the official command-line interface that queries Everything's index instantly.",
              "",
              "What to do:",
              "1) Ask the user whether they allow installing es.exe automatically, OR",
              "2) User installs ES manually from https://www.voidtools.com/downloads/ and adds it to PATH,",
              "   or set env EVERYTHING_ES_PATH to the full path of es.exe.",
              "",
              "If the user agrees, call this tool again with the same query and install_es=true.",
              "",
              "Temporary fallback (slow):",
              await fallbackSearch(query, root, limit),
            ].join("\n")
          }

          // es found but Everything may not be running - still try because the query is authoritative.
          if (!esPath) {
            return [
              "es.exe not found.",
              await fallbackSearch(query, root, limit),
            ].join("\n")
          }

          const esArgs = buildEsArgs({
            query,
            limit,
            path: root,
            filesOnly: args.files_only,
            foldersOnly: args.folders_only,
            caseSensitive: args.case_sensitive,
            wholeWord: args.whole_word,
            matchPath: args.match_path,
            regex: args.regex,
            sort: args.sort?.trim() || undefined,
          })

          const result = await run(esPath, esArgs, DEFAULT_TIMEOUT_MS)
          if (result.error) {
            return [
              `Failed to run es at "${esPath}": ${result.error}`,
              everythingDetected
                ? "Ensure the Everything search client is running in this Windows user session."
                : "Everything may not be installed. Install or start Everything, then retry.",
              "",
              await fallbackSearch(query, root, limit),
            ].join("\n")
          }

          if (result.code === 7 || result.code === 8) {
            const detail = result.stderr.trim()
            const summary =
              result.code === 8
                ? "Everything IPC is unavailable (es exit 8)."
                : "The Everything IPC query failed (es exit 7)."
            return [
              summary,
              ...(detail ? [detail] : []),
              "Start the Everything search client in the same signed-in Windows session as OpenCode, then retry.",
              "The Windows Everything service only helps the client index NTFS volumes; it does not provide the search IPC used by es.exe.",
              "If both programs are open, ensure they run at the same privilege level and use the same Everything instance.",
              "",
              await fallbackSearch(query, root, limit),
            ].join("\n")
          }

          if (result.code !== 0) {
            return [
              `Everything CLI failed with exit ${result.code ?? "unknown"}.`,
              result.stderr.trim(),
            ]
              .filter(Boolean)
              .join("\n")
          }

          const lines = parseLines(result.stdout)
          if (lines.length === 0) {
            return "No results via Everything (es)."
          }

          return formatResults(`Everything search via ${esPath}`, lines, limit)
        },
      }),
    },
  }
}

export default defineToolsPlugin("everything-search", EverythingSearchPlugin)
