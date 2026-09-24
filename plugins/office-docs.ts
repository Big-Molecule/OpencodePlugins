/**
 * OpenCode documents plugin (Codex-style golden path, simplified).
 *
 * Flow: edit with dedicated venv python-docx → render via Word COM → inspect PNGs → iterate.
 * Config: ~/.config/opencode/office-docs.json
 * Runtime: %LOCALAPPDATA%/opencode-office/venv + scripts
 * Job cache: <workdir>/.opencode-office/cache/<jobId>/
 */

import { defineToolsPlugin, type ToolFactory, tool } from "./lib/tools.ts"
import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs"
import { join, dirname, isAbsolute, resolve, basename } from "node:path"
import { homedir, tmpdir } from "node:os"
import { randomBytes } from "node:crypto"

const CONFIG_PATH = join(homedir(), ".config", "opencode", "office-docs.json")
const RUNTIME_ROOT = join(process.env.LOCALAPPDATA || join(homedir(), ".opencode-office"), "opencode-office")
const DEFAULT_VENV = join(RUNTIME_ROOT, "venv")
const DEFAULT_SCRIPTS = join(RUNTIME_ROOT, "scripts")

type OfficeConfig = {
  python?: string
  venv?: string
  scriptsDir?: string
  systemPython?: string
  wordOk?: boolean
  packages?: string[]
  updatedAt?: string
}

function loadConfig(): OfficeConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as OfficeConfig
  } catch {
    return null
  }
}

function saveConfig(cfg: OfficeConfig) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8")
}

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* */
      }
      resolvePromise({ code: null, stdout, stderr: stderr + `\nTimed out after ${opts.timeoutMs || 120000}ms` })
    }, opts.timeoutMs ?? 120_000)

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (c: string) => {
      stdout += c
    })
    child.stderr?.on("data", (c: string) => {
      stderr += c
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: null, stdout, stderr: String(err.message || err) })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

function resolvePath(p: string, cwd: string) {
  if (!p) return p
  return isAbsolute(p) ? p : resolve(cwd, p)
}

function jobDir(workdir: string, jobId?: string) {
  const id = jobId?.trim() || randomBytes(4).toString("hex")
  const dir = join(workdir, ".opencode-office", "cache", id)
  mkdirSync(dir, { recursive: true })
  return { id, dir }
}

function scriptsDir(cfg: OfficeConfig | null) {
  const candidates = [
    cfg?.scriptsDir,
    DEFAULT_SCRIPTS,
    // dev repo fallback (when working inside OpenCodePlugins)
    join(process.cwd(), "scripts", "office"),
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (existsSync(join(c, "render-docx.ps1")) || existsSync(join(c, "export-docx-pdf.vbs"))) {
      return c
    }
  }
  return cfg?.scriptsDir || DEFAULT_SCRIPTS
}

function venvPython(cfg: OfficeConfig | null) {
  if (cfg?.python && existsSync(cfg.python)) return cfg.python
  const fallback = join(DEFAULT_VENV, "Scripts", "python.exe")
  if (existsSync(fallback)) return fallback
  return null
}

function setupGuide(reason: string) {
  return [
    "Office Docs setup required",
    reason,
    "",
    `Config file: ${CONFIG_PATH}`,
    `Runtime:     ${RUNTIME_ROOT}`,
    "",
    "You may cancel setup anytime (退出配置 / cancel) and pause document work.",
    "",
    "Step 1 — ensure system Python >= 3.10 and Microsoft Word are installed.",
    "Step 2 — run setup (creates dedicated venv, does NOT touch project venv):",
    "  office_setup",
    "  optional: office_setup python_path=C:\\\\Path\\\\to\\\\python.exe",
    "",
    "Step 3 — office_status / office_verify",
    "Step 4 — golden path:",
    "  office_docx_info / office_docx_create / office_docx_edit  (python-docx in venv)",
    "  office_render docx=... all_pages=true   (Word COM preview PNGs)",
    "  inspect PNGs, fix, re-render until clean, then deliver DOCX only",
    "",
    "Job temp files live under: <workdir>/.opencode-office/cache/<jobId>/",
  ].join("\n")
}

function requireReady(cfg: OfficeConfig | null) {
  const py = venvPython(cfg)
  if (!py) {
    return setupGuide("Dedicated venv Python not configured.")
  }
  return null
}

async function runVenvPython(
  cfg: OfficeConfig | null,
  scriptRel: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
) {
  const py = venvPython(cfg)
  if (!py) return { code: 1, stdout: "", stderr: setupGuide("No venv python") }
  const sd = scriptsDir(cfg)
  const script = join(sd, "py", scriptRel)
  if (!existsSync(script)) {
    return {
      code: 1,
      stdout: "",
      stderr: `Script missing: ${script}\nRun office_setup to sync scripts to ${DEFAULT_SCRIPTS}`,
    }
  }
  return run(py, [script, ...args], { cwd, timeoutMs })
}

async function probeWord(): Promise<boolean> {
  const vbs = `
On Error Resume Next
Set w = CreateObject("Word.Application")
If Err.Number <> 0 Then
  WScript.Quit 1
End If
w.Quit
WScript.Quit 0
`
  const dir = join(tmpdir(), "opencode-office-probe")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "probe-word.vbs")
  writeFileSync(path, vbs, "utf-8")
  const r = await run("cscript.exe", ["//nologo", path], { timeoutMs: 30_000 })
  return r.code === 0
}

export const OfficeDocsPlugin: ToolFactory = async () => {
  return {
    tool: {
      office_status: tool({
        description: [
          "Show Office Docs plugin status (venv python, Word COM, scripts).",
          "Call first when creating/editing/reviewing DOCX/XLSX with office tools.",
          "If not ready, follow office_setup. User may cancel setup anytime.",
        ].join(" "),
        args: {},
        async execute(_args, ctx) {
          const cfg = loadConfig()
          const py = venvPython(cfg)
          const sd = scriptsDir(cfg)
          const wordOk = cfg?.wordOk
          const lines = [
            "Office Docs - status",
            "",
            `Config:      ${CONFIG_PATH}`,
            `Exists:      ${existsSync(CONFIG_PATH) ? "yes" : "no"}`,
            `Venv python: ${py || "NOT SET"}`,
            `Scripts:     ${sd} (${existsSync(join(sd, "render-docx.ps1")) ? "render ok" : "missing render-docx.ps1"})`,
            `Word (cfg):  ${wordOk === undefined ? "unknown" : wordOk ? "ok" : "missing"}`,
            `Workdir:     ${ctx.directory}`,
            `Job cache:   ${join(ctx.directory, ".opencode-office", "cache")}`,
            "",
          ]
          if (!py) {
            lines.push(setupGuide("Not configured yet."))
          } else {
            const imp = await run(
              py,
              ["-c", "import docx, openpyxl, lxml, pypdf; print('ok')"],
              { timeoutMs: 20_000 },
            )
            lines.push(`Imports:     ${imp.code === 0 ? "ok" : "FAIL " + (imp.stderr || imp.stdout).trim()}`)
            lines.push("")
            lines.push("Golden path: edit (office_docx_*) → office_render all_pages → inspect PNGs → fix → deliver DOCX")
          }
          return lines.join("\n")
        },
      }),

      office_setup: tool({
        description: [
          "One-time setup for Office Docs: detect system Python, create dedicated venv under",
          "%LOCALAPPDATA%\\opencode-office\\venv, pip install python-docx/openpyxl/lxml,",
          "probe Word COM, sync scripts. Does NOT modify project venv.",
          "Call only when user agrees to setup. Allow cancel/exit setup.",
        ].join(" "),
        args: {
          python_path: tool.schema
            .string()
            .optional()
            .describe("Optional absolute path to system python.exe (>=3.10)"),
        },
        async execute(args, ctx) {
          // Prefer setup-venv.ps1 from repo scripts or already-synced scripts
          const candidates = [
            join(ctx.worktree || ctx.directory, "scripts", "office", "setup-venv.ps1"),
            join(DEFAULT_SCRIPTS, "setup-venv.ps1"),
            join(process.cwd(), "scripts", "office", "setup-venv.ps1"),
          ]
          let setupPs1 = candidates.find((p) => existsSync(p))
          if (!setupPs1) {
            // bootstrap: write minimal inline setup if scripts not present
            return [
              "ERR: setup-venv.ps1 not found.",
              "Expected at OpenCodePlugins/scripts/office/setup-venv.ps1",
              "or after first manual copy under %LOCALAPPDATA%\\opencode-office\\scripts\\",
              "",
              "Manual:",
              `  powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\\scripts\\office\\setup-venv.ps1`,
            ].join("\n")
          }

          // Ensure scripts are available under runtime before/after setup
          const srcOffice = dirname(setupPs1)
          mkdirSync(DEFAULT_SCRIPTS, { recursive: true })
          // shallow copy key files via powershell
          const copy = await run(
            "powershell.exe",
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              `Copy-Item -Path '${srcOffice.replace(/'/g, "''")}\\*' -Destination '${DEFAULT_SCRIPTS.replace(/'/g, "''")}' -Recurse -Force`,
            ],
            { timeoutMs: 30_000 },
          )

          const psArgs = [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(DEFAULT_SCRIPTS, "setup-venv.ps1"),
          ]
          if (args.python_path?.trim()) {
            psArgs.push("-Python", args.python_path.trim())
          }
          const r = await run("powershell.exe", psArgs, { timeoutMs: 300_000 })
          const body = [r.stdout, r.stderr].filter(Boolean).join("\n").trim()
          if (r.code !== 0) {
            return `Setup failed.\n${body}\n\nUser may cancel and install Python/Office, then retry.`
          }

          // re-probe word and refresh config wordOk
          const wordOk = await probeWord()
          const cfg = loadConfig() || {}
          cfg.wordOk = wordOk
          if (!cfg.scriptsDir) cfg.scriptsDir = DEFAULT_SCRIPTS
          saveConfig(cfg)

          return [
            body,
            "",
            `Word COM re-probe: ${wordOk ? "ok" : "MISSING — render will fail until Office Word is available"}`,
            `Config: ${CONFIG_PATH}`,
            copy.code === 0 ? "Scripts synced." : `Script sync warn: ${copy.stderr || copy.stdout}`,
            "",
            "Next: office_status, then edit → office_render all_pages → inspect PNGs.",
          ].join("\n")
        },
      }),

      office_verify: tool({
        description: "Re-check venv imports and Word COM. Use after setup or when tools fail.",
        args: {},
        async execute() {
          const cfg = loadConfig()
          const py = venvPython(cfg)
          if (!py) return setupGuide("No venv python — run office_setup.")
          const imp = await run(
            py,
            ["-c", "import docx, openpyxl, lxml, pypdf; print('imports-ok')"],
            { timeoutMs: 30_000 },
          )
          const wordOk = await probeWord()
          const next = loadConfig() || {}
          next.wordOk = wordOk
          next.python = py
          saveConfig(next)
          return [
            `Python:  ${py}`,
            `Imports: ${imp.code === 0 ? "ok" : "FAIL"}`,
            imp.code === 0 ? "" : (imp.stderr || imp.stdout).trim(),
            `Word:    ${wordOk ? "ok" : "MISSING"}`,
            `Scripts: ${scriptsDir(next)}`,
            "",
            imp.code === 0 && wordOk
              ? "Ready for golden path."
              : "Fix missing pieces, or cancel document work.",
          ]
            .filter((l) => l !== undefined)
            .join("\n")
        },
      }),

      office_docx_info: tool({
        description: [
          "Inspect a DOCX: paragraph index/style/text preview and tables (JSON).",
          "Use before edits. Requires office_setup. Does not render pages.",
        ].join(" "),
        args: {
          path: tool.schema.string().describe("DOCX path (absolute or relative to workdir)"),
          max_paras: tool.schema.number().optional().describe("Max non-empty paragraphs (default 80)"),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          if (!existsSync(path)) return `Error: file not found: ${path}`
          const r = await runVenvPython(
            cfg,
            "docx_info.py",
            [path, "--max-paras", String(Math.max(1, Math.floor(args.max_paras ?? 80)))],
            ctx.directory,
          )
          return (r.stdout || r.stderr || `exit ${r.code}`).trim()
        },
      }),

      office_docx_create: tool({
        description: "Create a simple DOCX (title + paragraphs) via python-docx in dedicated venv.",
        args: {
          path: tool.schema.string().describe("Output DOCX path"),
          title: tool.schema.string().optional(),
          paragraphs: tool.schema
            .string()
            .optional()
            .describe('JSON array of paragraph strings, e.g. ["a","b"]'),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          mkdirSync(dirname(path), { recursive: true })
          const paras = args.paragraphs?.trim() || "[]"
          const r = await runVenvPython(
            cfg,
            "docx_create.py",
            [path, "--title", args.title || "", "--paragraphs", paras],
            ctx.directory,
          )
          const out = (r.stdout || r.stderr).trim()
          if (r.code !== 0) return `Create failed.\n${out}`
          return [
            out,
            "",
            "After meaningful edits, run office_render with all_pages=true and inspect PNGs before delivery.",
          ].join("\n")
        },
      }),

      office_docx_edit: tool({
        description: [
          "Edit DOCX paragraphs via python-docx.",
          "action=set_paragraph | add_paragraph | replace_text.",
          "Then office_render all_pages and inspect PNGs (Codex golden path).",
        ].join(" "),
        args: {
          path: tool.schema.string(),
          action: tool.schema.enum(["set_paragraph", "add_paragraph", "replace_text"]),
          index: tool.schema.number().optional().describe("Paragraph index for set_paragraph"),
          text: tool.schema.string().optional().describe("New text (set/add)"),
          old_text: tool.schema.string().optional().describe("For replace_text"),
          new_text: tool.schema.string().optional().describe("For replace_text"),
          heading_level: tool.schema
            .number()
            .optional()
            .describe("For add_paragraph: 0=body, 1-3=heading"),
          out: tool.schema.string().optional().describe("Optional output path (default overwrite)"),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          if (!existsSync(path)) return `Error: not found: ${path}`
          const out = args.out?.trim() ? resolvePath(args.out, ctx.directory) : ""
          const nextHint = "\n\nNext: office_render path=... all_pages=true and inspect PNGs."

          if (args.action === "replace_text") {
            if (!args.old_text) return "Error: old_text required for replace_text"
            const a = [path, "--old", args.old_text, "--new", args.new_text ?? ""]
            if (out) a.push("--out", out)
            const r = await runVenvPython(cfg, "docx_replace.py", a, ctx.directory)
            const body = (r.stdout || r.stderr).trim()
            return r.code !== 0 ? body : body + nextHint
          }

          if (args.action === "set_paragraph") {
            if (args.index === undefined || args.index === null) {
              return "Error: index required for set_paragraph (use office_docx_info)."
            }
            if (args.text === undefined) return "Error: text required"
            const a = [path, "--index", String(Math.floor(args.index)), "--text", args.text]
            if (out) a.push("--out", out)
            const r = await runVenvPython(cfg, "docx_set_paragraph.py", a, ctx.directory)
            const body = (r.stdout || r.stderr).trim()
            return r.code !== 0 ? body : body + nextHint
          }

          if (args.text === undefined) return "Error: text required"
          const a = [path, "--text", args.text, "--heading-level", String(args.heading_level ?? 0)]
          if (out) a.push("--out", out)
          const r = await runVenvPython(cfg, "docx_add_paragraph.py", a, ctx.directory)
          const body = (r.stdout || r.stderr).trim()
          return r.code !== 0 ? body : body + nextHint
        },
      }),

      office_docx_table: tool({
        description:
          "DOCX tables: action=add | set_cell | to_csv. Use after office_docx_info for table indices.",
        args: {
          path: tool.schema.string(),
          action: tool.schema.enum(["add", "set_cell", "to_csv"]),
          rows: tool.schema.number().optional(),
          cols: tool.schema.number().optional(),
          data: tool.schema.string().optional().describe('JSON 2D array for add'),
          table_index: tool.schema.number().optional(),
          row: tool.schema.number().optional(),
          col: tool.schema.number().optional(),
          text: tool.schema.string().optional(),
          csv_out: tool.schema.string().optional(),
          out: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          if (!existsSync(path)) return `Error: not found: ${path}`
          const a = [path, "--action", args.action]
          if (args.rows != null) a.push("--rows", String(args.rows))
          if (args.cols != null) a.push("--cols", String(args.cols))
          if (args.data) a.push("--data", args.data)
          if (args.table_index != null) a.push("--table-index", String(args.table_index))
          if (args.row != null) a.push("--row", String(args.row))
          if (args.col != null) a.push("--col", String(args.col))
          if (args.text != null) a.push("--text", args.text)
          if (args.csv_out) a.push("--csv-out", resolvePath(args.csv_out, ctx.directory))
          if (args.out) a.push("--out", resolvePath(args.out, ctx.directory))
          const r = await runVenvPython(cfg, "docx_table.py", a, ctx.directory)
          const body = (r.stdout || r.stderr).trim()
          if (r.code !== 0) return body
          return body + "\n\nNext: office_render all_pages=true after layout-sensitive table edits."
        },
      }),

      office_docx_format: tool({
        description:
          "DOCX page setup / header / footer. action=page_setup | header_footer. Then re-render.",
        args: {
          path: tool.schema.string(),
          action: tool.schema.enum(["page_setup", "header_footer"]),
          top: tool.schema.number().optional().describe("Margin inches"),
          bottom: tool.schema.number().optional(),
          left: tool.schema.number().optional(),
          right: tool.schema.number().optional(),
          orientation: tool.schema.enum(["portrait", "landscape"]).optional(),
          header: tool.schema.string().optional(),
          footer: tool.schema.string().optional(),
          out: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          if (!existsSync(path)) return `Error: not found: ${path}`
          const out = args.out ? resolvePath(args.out, ctx.directory) : ""
          if (args.action === "page_setup") {
            const a = [path]
            if (args.top != null) a.push("--top", String(args.top))
            if (args.bottom != null) a.push("--bottom", String(args.bottom))
            if (args.left != null) a.push("--left", String(args.left))
            if (args.right != null) a.push("--right", String(args.right))
            if (args.orientation) a.push("--orientation", args.orientation)
            if (out) a.push("--out", out)
            const r = await runVenvPython(cfg, "docx_page_setup.py", a, ctx.directory)
            return (r.stdout || r.stderr).trim() + "\n\nNext: office_render all_pages=true"
          }
          const a = [path, "--header", args.header ?? "", "--footer", args.footer ?? ""]
          if (out) a.push("--out", out)
          const r = await runVenvPython(cfg, "docx_header_footer.py", a, ctx.directory)
          return (r.stdout || r.stderr).trim() + "\n\nNext: office_render all_pages=true"
        },
      }),

      office_docx_merge: tool({
        description: "Append other DOCX files onto a base DOCX (simple body merge).",
        args: {
          base: tool.schema.string(),
          append: tool.schema
            .string()
            .describe('JSON array of docx paths, e.g. ["a.docx","b.docx"]'),
          out: tool.schema.string(),
          page_break: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const base = resolvePath(args.base, ctx.directory)
          let list: string[] = []
          try {
            list = JSON.parse(args.append)
          } catch {
            return "Error: append must be JSON array of paths"
          }
          const a = [base, "--out", resolvePath(args.out, ctx.directory)]
          if (args.page_break) a.push("--page-break")
          for (const p of list) a.push("--append", resolvePath(p, ctx.directory))
          const r = await runVenvPython(cfg, "docx_merge.py", a, ctx.directory)
          return (r.stdout || r.stderr).trim()
        },
      }),

      office_docx_meta: tool({
        description: "Get or scrub DOCX core properties (author, etc.). action=get|scrub.",
        args: {
          path: tool.schema.string(),
          action: tool.schema.enum(["get", "scrub"]),
          out: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          const a = [path, "--action", args.action]
          if (args.out) a.push("--out", resolvePath(args.out, ctx.directory))
          const r = await runVenvPython(cfg, "docx_meta.py", a, ctx.directory)
          return (r.stdout || r.stderr).trim()
        },
      }),

      office_docx_comments: tool({
        description: "List Word comments from OOXML (structural; may not appear in page PNGs).",
        args: { path: tool.schema.string() },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          const r = await runVenvPython(cfg, "docx_comments.py", [path], ctx.directory)
          return (r.stdout || r.stderr).trim()
        },
      }),

      office_xlsx: tool({
        description:
          "Excel XLSX ops: action=info|read|write_cell|create via openpyxl in dedicated venv.",
        args: {
          path: tool.schema.string(),
          action: tool.schema.enum(["info", "read", "write_cell", "create"]),
          sheet: tool.schema.string().optional(),
          cell: tool.schema.string().optional().describe("e.g. B2"),
          value: tool.schema.string().optional().describe("string or JSON-encoded number/bool"),
          max_rows: tool.schema.number().optional(),
          max_cols: tool.schema.number().optional(),
          out: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          const a = [path, "--action", args.action]
          if (args.sheet) a.push("--sheet", args.sheet)
          if (args.cell) a.push("--cell", args.cell)
          if (args.value != null) a.push("--value", args.value)
          if (args.max_rows != null) a.push("--max-rows", String(args.max_rows))
          if (args.max_cols != null) a.push("--max-cols", String(args.max_cols))
          if (args.out) a.push("--out", resolvePath(args.out, ctx.directory))
          const r = await runVenvPython(cfg, "xlsx_ops.py", a, ctx.directory)
          return (r.stdout || r.stderr).trim()
        },
      }),

      office_pdf_text: tool({
        description: "Extract text from PDF pages (pypdf). page=0 means all pages.",
        args: {
          path: tool.schema.string(),
          page: tool.schema.number().optional().describe("1-based; 0 or omit for all"),
          max_chars: tool.schema.number().optional(),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const missing = requireReady(cfg)
          if (missing) return missing
          const path = resolvePath(args.path, ctx.directory)
          const a = [path, "--page", String(args.page ?? 0)]
          if (args.max_chars != null) a.push("--max-chars", String(args.max_chars))
          const r = await runVenvPython(cfg, "pdf_text.py", a, ctx.directory)
          return (r.stdout || r.stderr).trim()
        },
      }),

      office_render: tool({
        description: [
          "Render DOCX pages to PNG via Microsoft Word COM + pdftoppm (Codex-style visual QA).",
          "Use after every meaningful edit batch. Prefer all_pages=true before delivery.",
          "Writes under <workdir>/.opencode-office/cache/<job_id>/ (not plugin dir).",
          "Requires Word + pdftoppm. PNGs are for agent inspection; deliver DOCX unless user wants images.",
        ].join(" "),
        args: {
          path: tool.schema.string().describe("DOCX path"),
          page: tool.schema.number().optional().describe("1-based page (ignored if all_pages)"),
          all_pages: tool.schema.boolean().optional().describe("Render every page (recommended)"),
          dpi: tool.schema.number().optional().describe("Default 144"),
          job_id: tool.schema.string().optional().describe("Optional cache job id"),
          keep_pdf: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          const cfg = loadConfig()
          const sd = scriptsDir(cfg)
          const renderPs1 = join(sd, "render-docx.ps1")
          if (!existsSync(renderPs1)) {
            return setupGuide(`render-docx.ps1 missing at ${renderPs1}. Run office_setup.`)
          }
          if (cfg && cfg.wordOk === false) {
            return "Word COM marked missing in config. Install Microsoft Word, then office_verify."
          }
          const path = resolvePath(args.path, ctx.directory)
          if (!existsSync(path)) return `Error: not found: ${path}`

          const { id, dir } = jobDir(ctx.directory, args.job_id)
          const psArgs = [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            renderPs1,
            "-InputDocx",
            path,
            "-OutputDir",
            dir,
            "-Dpi",
            String(Math.min(300, Math.max(72, Math.floor(args.dpi ?? 144)))),
          ]
          if (args.all_pages) {
            psArgs.push("-AllPages")
          } else {
            psArgs.push("-Page", String(Math.max(1, Math.floor(args.page ?? 1))))
          }
          if (args.keep_pdf) psArgs.push("-KeepPdf")

          const r = await run("powershell.exe", psArgs, {
            cwd: ctx.directory,
            timeoutMs: 180_000,
          })
          const log = [r.stdout, r.stderr].filter(Boolean).join("\n").trim()
          if (r.code !== 0) {
            return [
              "Render failed.",
              log,
              "",
              "Check: Microsoft Word installed; pdftoppm available; file not locked.",
              "Editing can continue, but do NOT claim visual QA passed.",
            ].join("\n")
          }

          let pngs: string[] = []
          try {
            pngs = readdirSync(dir)
              .filter((n) => /^page-\d+\.png$/i.test(n))
              .sort()
              .map((n) => join(dir, n))
          } catch {
            /* */
          }

          return [
            "Render OK (Word COM pipeline).",
            `Job:  ${id}`,
            `Dir:  ${dir}`,
            `DOCX: ${path}`,
            `Pages rendered: ${pngs.length}`,
            "",
            ...pngs.map((p, i) => `${i + 1}. ${p}`),
            "",
            "Inspect each PNG for clipping, overlap, broken tables, spacing.",
            "If issues: edit with office_docx_* then office_render again.",
            "Deliver final DOCX only unless user asked for page images.",
          ].join("\n")
        },
      }),
    },
  }
}

export default defineToolsPlugin("office-docs", OfficeDocsPlugin)
