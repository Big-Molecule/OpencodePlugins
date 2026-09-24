import { defineToolsPlugin, type ToolFactory, tool } from "./lib/tools.ts"
import { spawn } from "node:child_process"
import { access, constants, stat } from "node:fs/promises"
import path from "node:path"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

const ACTIONS = [
  "status",
  "compress",
  "extract",
  "test",
  "add",
  "delete",
  "batch_compress",
  "batch_extract",
  "open",
] as const

type Action = (typeof ACTIONS)[number]

const FORMATS = ["zip", "zipx", "exe", "tar", "tgz", "lzh", "iso", "7z", "gz", "xz"] as const
const OVERWRITE = ["aoa", "aos", "aou"] as const

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
      // Hide console window; bc/bz are console tools and stay headless with this.
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: false,
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (result: {
      code: number | null
      stdout: string
      stderr: string
      error?: string
    }) => {
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

async function readRegistryProgramFolder(): Promise<string | null> {
  if (!isWindows()) return null
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$paths = @(",
        "  'HKLM:\\SOFTWARE\\Bandizip',",
        "  'HKLM:\\SOFTWARE\\WOW6432Node\\Bandizip',",
        "  'HKCU:\\SOFTWARE\\Bandizip'",
        ")",
        "foreach ($p in $paths) {",
        "  try {",
        "    $v = (Get-ItemProperty -LiteralPath $p -ErrorAction Stop).ProgramFolder",
        "    if ($v) { Write-Output $v; break }",
        "  } catch {}",
        "}",
      ].join(" "),
    ],
    8000,
  )
  const line = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean)
  return line || null
}

type ResolvedBandizip = {
  dir: string | null
  cli: string | null
  gui: string | null
}

async function resolveBandizip(): Promise<ResolvedBandizip> {
  const envPath = process.env.BANDIZIP_PATH?.trim()
  const envDir = process.env.BANDIZIP_DIR?.trim()
  const envCli = process.env.BANDIZIP_CLI_PATH?.trim()

  let dir: string | null = null
  let cli: string | null = null
  let gui: string | null = null

  if (envCli && (await fileExists(envCli))) cli = envCli
  if (envPath && (await fileExists(envPath))) {
    const base = path.basename(envPath).toLowerCase()
    if (base === "bc.exe" || base === "bz.exe") cli = envPath
    else if (base === "bandizip.exe") gui = envPath
    dir = path.dirname(envPath)
  }
  if (envDir && (await fileExists(envDir))) dir = envDir

  if (!dir) {
    const reg = await readRegistryProgramFolder()
    if (reg && (await fileExists(reg))) dir = reg
  }

  const pathCandidates = [
    "bc.exe",
    "bc",
    "bz.exe",
    "bz",
    "Bandizip.exe",
    "bandizip.exe",
    "Bandizip",
    "bandizip",
  ]
  for (const name of pathCandidates) {
    const found = await commandOnPath(name)
    if (!found) continue
    const base = path.basename(found).toLowerCase()
    if (!cli && (base === "bc.exe" || base === "bz.exe" || base === "bc" || base === "bz")) {
      cli = found
      dir = dir || path.dirname(found)
    }
    if (!gui && (base === "bandizip.exe" || base === "bandizip")) {
      gui = found
      dir = dir || path.dirname(found)
    }
  }

  const searchDirs = [
    dir,
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Bandizip"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Bandizip"),
    path.join(process.env.LOCALAPPDATA ?? "", "Bandizip"),
  ].filter(Boolean) as string[]

  for (const d of searchDirs) {
    if (!(await fileExists(d))) continue
    if (!cli) {
      for (const name of ["bc.exe", "bz.exe"]) {
        const p = path.join(d, name)
        if (await fileExists(p)) {
          cli = p
          break
        }
      }
    }
    if (!gui) {
      const p = path.join(d, "Bandizip.exe")
      if (await fileExists(p)) gui = p
    }
    if (!dir && (cli || gui)) dir = d
  }

  return { dir, cli, gui }
}

function preferredExe(
  resolved: ResolvedBandizip,
  mode: "cli" | "gui" = "cli",
): string | null {
  if (mode === "gui") return resolved.gui || resolved.cli
  // Silent ops MUST use console CLI (bc.exe / bz.exe). Bandizip.exe always flashes UI.
  return resolved.cli
}

function splitPaths(value?: string): string[] {
  if (!value?.trim()) return []
  return value
    .split(/[|\n]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

function parseFilesJson(value?: string): string[] {
  if (!value?.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x).trim()).filter(Boolean)
    }
  } catch {
    // fall through to pipe/newline split
  }
  return splitPaths(value)
}

function buildSwitches(input: {
  level?: number
  password?: string
  destination?: string
  overwrite?: string
  recurse?: boolean
  format?: string
  exclude?: string
  volume?: string
  sfx?: boolean
  sfx_stub?: string
  threads?: number
  codepage?: number
  target?: string
  storeroot?: string
  root?: string
  comment?: string
  yes?: boolean
  silentDefaults?: boolean
}) {
  const args: string[] = []
  // -y: answer yes + close progress UI when done (mainly for GUI; CLI is already headless)
  if (input.yes !== false) args.push("-y")

  if (input.level !== undefined && input.level !== null) {
    const level = Math.min(9, Math.max(0, Math.floor(input.level)))
    args.push(`-l:${level}`)
  }
  if (input.password) args.push(`-p:${input.password}`)
  if (input.destination) args.push(`-o:${input.destination}`)

  // Default overwrite-all so CLI never blocks on prompts
  const overwrite =
    input.overwrite ||
    (input.silentDefaults !== false ? "aoa" : undefined)
  if (overwrite === "aoa") args.push("-aoa")
  if (overwrite === "aos") args.push("-aos")
  if (overwrite === "aou") args.push("-aou")
  if (input.recurse === true) args.push("-r")
  if (input.recurse === false) args.push("-r-")
  if (input.format) args.push(`-fmt:${input.format}`)
  if (input.exclude) args.push(`-ex:${input.exclude}`)
  if (input.volume) args.push(`-v:${input.volume}`)
  if (input.sfx) {
    if (input.sfx_stub) args.push(`-sfx:${input.sfx_stub}`)
    else args.push("-sfx:")
  }
  if (input.threads !== undefined && input.threads !== null) {
    args.push(`-t:${Math.max(0, Math.floor(input.threads))}`)
  }
  if (input.codepage !== undefined && input.codepage !== null) {
    args.push(`-cp:${Math.floor(input.codepage)}`)
  }
  if (input.target) args.push(`-target:${input.target}`)
  if (input.storeroot === "yes" || input.storeroot === "no") {
    args.push(`-storeroot:${input.storeroot}`)
  }
  if (input.root) args.push(`-root:${input.root}`)
  if (input.comment) args.push(`-cmt:${input.comment}`)
  return args
}

async function pathInfo(p: string) {
  try {
    const s = await stat(p)
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other"
  } catch {
    return "missing"
  }
}

function formatRunResult(
  title: string,
  exe: string,
  args: string[],
  result: { code: number | null; stdout: string; stderr: string; error?: string },
  redactedArgs?: string[],
) {
  const shown = (redactedArgs || args).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")
  const lines = [
    title,
    `exe: ${exe}`,
    `cmd: ${path.basename(exe)} ${shown}`,
    result.error ? `error: ${result.error}` : `exit: ${result.code ?? "null"}`,
  ]
  const out = result.stdout.trim()
  const err = result.stderr.trim()
  if (out) lines.push("", "stdout:", out)
  if (err) lines.push("", "stderr:", err)
  if (!result.error && result.code === 0) lines.push("", "OK")
  else if (!result.error && result.code !== 0) lines.push("", "FAILED (non-zero exit)")
  return lines.join("\n")
}

function redactArgs(args: string[]) {
  return args.map((a) => (a.startsWith("-p:") ? "-p:***" : a))
}

export const BandizipPlugin: ToolFactory = async () => {
  return {
    tool: {
      bandizip: tool({
        description: [
          "PRIMARY tool for archive compress AND extract on this Windows machine (zip/7z/tar/iso/zipx/gz/xz/etc).",
          "ALWAYS prefer this over inventing bash/PowerShell zip commands (Expand-Archive, Compress-Archive, tar, 7z) — fewer tokens, fewer wrong flags, silent CLI via bc.exe/bz.exe.",
          "Common recipes:",
          '1) compress folder: action=compress archive="D:\\\\out\\\\a.zip" files="D:\\\\src\\\\folder"',
          '2) compress multi: action=compress archive="D:\\\\out\\\\a.zip" files_json=["D:\\\\a.txt","D:\\\\b"]',
          '3) extract here: action=extract archive="D:\\\\a.zip" destination="D:\\\\out"',
          '4) extract smart: action=extract archive="D:\\\\a.zip" destination="D:\\\\out" target=auto',
          "5) test: action=test archive=...  |  add: action=add archive=... files=...  |  delete member: action=delete archive=... files=inner.txt",
          "6) batch: action=batch_compress files=f1|f2 destination=...  |  action=batch_extract files=a.zip|b.zip destination=...",
          "7) password: password=...  |  format=7z  |  level=0..9  |  exclude=*.bak;*.tmp",
          "Defaults: silent CLI, -y, overwrite=aoa. Do NOT set use_gui unless user wants BandiZip GUI windows.",
          "Do NOT use for ordinary non-archive file ops. If unsure CLI path: action=status.",
        ].join(" "),
        args: {
          action: tool.schema
            .string()
            .describe(
              "Required. compress=create archive | extract=unpack | test | add | delete | batch_compress | batch_extract | open | status",
            ),
          archive: tool.schema
            .string()
            .optional()
            .describe(
              "Archive path. Required for compress/extract/test/add/delete/open. Example: C:\\\\work\\\\out.zip",
            ),
          files: tool.schema
            .string()
            .optional()
            .describe(
              "Sources or member names. Pipe/newline-separated. compress/add: file/folder paths. delete: names inside archive. batch_*: many paths.",
            ),
          files_json: tool.schema
            .string()
            .optional()
            .describe(
              'Preferred multi-path form: JSON array string, e.g. ["C:\\\\a.txt","C:\\\\dir"]. Overrides files when set.',
            ),
          destination: tool.schema
            .string()
            .optional()
            .describe(
              "Output folder for extract / batch_extract / batch_compress (-o). Example: C:\\\\work\\\\unpacked",
            ),
          password: tool.schema
            .string()
            .optional()
            .describe("Archive password (-p). Redacted in tool output."),
          format: tool.schema
            .string()
            .optional()
            .describe("compress format: zip (default) | zipx | 7z | tar | tgz | lzh | iso | gz | xz | exe"),
          level: tool.schema
            .number()
            .optional()
            .describe("Compression level 0-9 (0=store/fastest, 5=default, 9=max)."),
          overwrite: tool.schema
            .string()
            .optional()
            .describe("aoa=overwrite all (default) | aos=skip existing | aou=auto-rename extracted"),
          recurse: tool.schema
            .boolean()
            .optional()
            .describe("true=-r recurse when matching names; false=-r- (default off)"),
          exclude: tool.schema
            .string()
            .optional()
            .describe('compress exclude list, e.g. "*.bak;*.tmp" or *\\\\.git'),
          volume: tool.schema
            .string()
            .optional()
            .describe("Split volume size for compress, e.g. 100MB or 1440k"),
          sfx: tool.schema.boolean().optional().describe("true = create self-extracting archive"),
          sfx_stub: tool.schema
            .string()
            .optional()
            .describe("Optional full path to SFX stub when sfx=true"),
          threads: tool.schema.number().optional().describe("CPU threads for compress (-t)"),
          codepage: tool.schema
            .number()
            .optional()
            .describe("Code page for extract/open: 936=简中 950=繁中 932=日 949=韩 65001=UTF-8"),
          target: tool.schema
            .string()
            .optional()
            .describe("extract layout: auto=Extract Here Smart | name=into archive-name subfolder"),
          storeroot: tool.schema
            .string()
            .optional()
            .describe("compress: yes=keep top folder | no=omit top folder"),
          root: tool.schema
            .string()
            .optional()
            .describe("compress: force root folder name inside archive (-root)"),
          comment: tool.schema.string().optional().describe("ZIP comment (-cmt)"),
          timeout_ms: tool.schema
            .number()
            .optional()
            .describe(`Timeout ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
          use_gui: tool.schema
            .boolean()
            .optional()
            .describe(
              "Default false (silent bc/bz). true = Bandizip.exe GUI windows. Only for open or explicit user request.",
            ),
        },
        async execute(args) {
          if (!isWindows()) {
            return "Error: bandizip plugin currently supports Windows only (BandiZip CLI)."
          }

          const action = String(args.action || "")
            .trim()
            .toLowerCase() as Action
          if (!ACTIONS.includes(action)) {
            return `Error: invalid action "${args.action}". Use one of: ${ACTIONS.join(", ")}`
          }

          const resolved = await resolveBandizip()
          const timeout = Math.min(
            Math.max(1000, Math.floor(args.timeout_ms ?? DEFAULT_TIMEOUT_MS)),
            MAX_TIMEOUT_MS,
          )

          if (action === "status") {
            return [
              "BandiZip resolution:",
              `dir: ${resolved.dir || "(not found)"}`,
              `cli (bc/bz): ${resolved.cli || "(not found)"}`,
              `gui (Bandizip.exe): ${resolved.gui || "(not found)"}`,
              "",
              "Silent mode: all actions except open use bc.exe/bz.exe only (no GUI).",
              "Env overrides: BANDIZIP_CLI_PATH (preferred), BANDIZIP_PATH, BANDIZIP_DIR",
              resolved.cli
                ? "Ready for silent compress/extract/test via CLI."
                : resolved.gui
                  ? "GUI found but CLI (bc.exe/bz.exe) missing — silent ops unavailable. Set BANDIZIP_CLI_PATH to bc.exe next to Bandizip.exe."
                  : "Not found. Install BandiZip or set BANDIZIP_CLI_PATH to bc.exe.",
            ].join("\n")
          }

          const wantGui = args.use_gui === true || action === "open"
          const exe = preferredExe(resolved, wantGui ? "gui" : "cli")
          if (!exe) {
            if (!wantGui && resolved.gui && !resolved.cli) {
              return [
                "Error: BandiZip GUI found, but console CLI (bc.exe / bz.exe) is missing.",
                "Silent (no-window) operations require the CLI next to Bandizip.exe.",
                `gui: ${resolved.gui}`,
                "Fix: set BANDIZIP_CLI_PATH to full path of bc.exe (v6) or bz.exe (newer), e.g.",
                `  ${path.join(path.dirname(resolved.gui), "bc.exe")}`,
                "Or pass use_gui=true only if you accept GUI progress windows.",
              ].join("\n")
            }
            return [
              "Error: BandiZip not found.",
              "Install BandiZip, or set BANDIZIP_CLI_PATH / BANDIZIP_DIR / BANDIZIP_PATH.",
              "Then call action=status to verify.",
            ].join("\n")
          }

          if (!wantGui) {
            const base = path.basename(exe).toLowerCase()
            if (base === "bandizip.exe") {
              return [
                "Refusing to run Bandizip.exe for silent ops (it opens GUI windows).",
                "Use bc.exe / bz.exe. Set BANDIZIP_CLI_PATH if auto-detect fails.",
              ].join("\n")
            }
          }

          const archive = args.archive?.trim()
          const files = parseFilesJson(args.files_json).length
            ? parseFilesJson(args.files_json)
            : splitPaths(args.files)
          const destination = args.destination?.trim() || undefined
          const format = args.format?.trim().toLowerCase() || undefined
          if (format && !FORMATS.includes(format as (typeof FORMATS)[number])) {
            return `Error: unsupported format "${format}". Use: ${FORMATS.join(", ")}`
          }
          const overwrite = args.overwrite?.trim().toLowerCase() || undefined
          if (overwrite && !OVERWRITE.includes(overwrite as (typeof OVERWRITE)[number])) {
            return `Error: overwrite must be one of: ${OVERWRITE.join(", ")}`
          }

          const switches = buildSwitches({
            level: args.level,
            password: args.password,
            destination,
            overwrite,
            recurse: args.recurse,
            format,
            exclude: args.exclude?.trim() || undefined,
            volume: args.volume?.trim() || undefined,
            sfx: args.sfx,
            sfx_stub: args.sfx_stub?.trim() || undefined,
            threads: args.threads,
            codepage: args.codepage,
            target: args.target?.trim() || undefined,
            storeroot: args.storeroot?.trim().toLowerCase() || undefined,
            root: args.root?.trim() || undefined,
            comment: args.comment?.trim() || undefined,
            yes: true,
            silentDefaults: !wantGui,
          })

          let cmd: string
          let argv: string[]

          if (action === "open") {
            if (!archive) return "Error: archive is required for open."
            cmd = resolved.gui || exe
            argv = [archive]
          } else if (action === "compress") {
            if (!archive) return "Error: archive is required for compress."
            if (files.length === 0) return "Error: files/files_json required for compress (sources to pack)."
            // c = create new (overwrite same name); better default for "compress"
            cmd = exe
            argv = ["c", ...switches, archive, ...files]
          } else if (action === "add") {
            if (!archive) return "Error: archive is required for add."
            if (files.length === 0) return "Error: files/files_json required for add."
            cmd = exe
            argv = ["a", ...switches, archive, ...files]
          } else if (action === "extract") {
            if (!archive) return "Error: archive is required for extract."
            cmd = exe
            // extract specific members if provided
            argv = ["x", ...switches, archive, ...files]
          } else if (action === "test") {
            if (!archive) return "Error: archive is required for test."
            cmd = exe
            argv = ["t", ...switches.filter((s) => !s.startsWith("-o:")), archive, ...files]
          } else if (action === "delete") {
            if (!archive) return "Error: archive is required for delete."
            if (files.length === 0) {
              return "Error: files/files_json required for delete (member names inside archive)."
            }
            cmd = exe
            argv = ["d", ...switches.filter((s) => !s.startsWith("-o:")), archive, ...files]
          } else if (action === "batch_compress") {
            if (files.length === 0) {
              return "Error: files/files_json required for batch_compress (each item becomes its own archive)."
            }
            cmd = exe
            argv = ["bc", ...switches, ...files]
          } else if (action === "batch_extract") {
            if (files.length === 0 && !archive) {
              return "Error: provide archive and/or files/files_json (archives to extract) for batch_extract."
            }
            const archives = [...(archive ? [archive] : []), ...files]
            cmd = exe
            argv = ["bx", ...switches, ...archives]
          } else {
            return `Error: unhandled action "${action}"`
          }

          // Preflight existence for sources (compress/add/batch_compress)
          if (action === "compress" || action === "add" || action === "batch_compress") {
            const missing: string[] = []
            for (const f of files) {
              if ((await pathInfo(f)) === "missing") missing.push(f)
            }
            if (missing.length) {
              return `Error: source path(s) not found:\n${missing.map((m) => `  - ${m}`).join("\n")}`
            }
          }
          // extract/test/delete/open need an existing archive; add may create one.
          if (
            (action === "extract" || action === "test" || action === "delete" || action === "open") &&
            archive &&
            (await pathInfo(archive)) === "missing"
          ) {
            return `Error: archive not found: ${archive}`
          }
          if (action === "batch_extract") {
            const archives = [...(archive ? [archive] : []), ...files]
            const missing = []
            for (const a of archives) {
              if ((await pathInfo(a)) === "missing") missing.push(a)
            }
            if (missing.length) {
              return `Error: archive(s) not found:\n${missing.map((m) => `  - ${m}`).join("\n")}`
            }
          }

          const result = await run(cmd, argv, timeout)
          const title = `BandiZip ${action}`
          let summary = formatRunResult(title, cmd, argv, result, redactArgs(argv))

          // Post-check for compress/extract
          if (!result.error && result.code === 0) {
            if (action === "compress" && archive) {
              const info = await pathInfo(archive)
              summary += `\narchive: ${archive} (${info})`
            }
            if (action === "extract" && destination) {
              const info = await pathInfo(destination)
              summary += `\ndestination: ${destination} (${info})`
            }
          }

          return summary
        },
      }),
    },
  }
}

export default defineToolsPlugin("bandizip", BandizipPlugin)
