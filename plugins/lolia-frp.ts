import { defineToolsPlugin, type ToolFactory, tool } from "./lib/tools.ts"
import { spawn } from "node:child_process"
import { access, constants, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const API_BASE = "https://api.lolia.link/api/v1"
const CLIENT_ID = "goibzooz0s14ntgc"
const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode")
const CONFIG_PATH = path.join(CONFIG_DIR, "lolia-frp.json")
const LOCAL_APPDATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
const LORIA_CLIENT_SETTINGS = path.join(LOCAL_APPDATA, "LoliaFrpClient", "settings.json")
const DEFAULT_FRPC = path.join(LOCAL_APPDATA, "LoliaFrpClient", "frpc", "frpc.exe")
const PS_DIR = path.join(os.tmpdir(), "lolia-frp-ps")
const HTTP_TIMEOUT_MS = 30_000
const PS_TIMEOUT_MS = 20_000

type LoliaConfig = { refresh_token?: string; frpc_path?: string }

type Tunnel = {
  id: number
  name: string
  type: string
  status: string
  remark: string
  custom_domain: string
  local_ip: string
  local_port: number
  remote_port: number
  node_id: number
  node_name?: string
  node_address?: string
  bandwidth_limit: number
  tunnel_token?: string
  created_at?: string
  config?: { auto_tls?: boolean; http_redirect?: boolean }
}

type FrpcProc = { pid: number; tunnel_id: number; uptime_s: number }

let cachedToken: { token: string; exp: number } | null = null

function isWindows() {
  return process.platform === "win32"
}

async function fileExists(p: string) {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function mask(secret: string | undefined | null) {
  if (!secret) return "(none)"
  return `${secret.slice(0, 6)}…(len ${secret.length})`
}

function fmtBytes(n: number | undefined | null) {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return "?"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let x = v
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtUptime(s: number) {
  if (!Number.isFinite(s) || s < 0) return "?"
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(s % 60)}s`
}

async function loadConfig(): Promise<LoliaConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8")
    return JSON.parse(raw) as LoliaConfig
  } catch {
    return {}
  }
}

async function saveConfig(cfg: LoliaConfig) {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8")
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; refresh_token?: string; error?: string }
    | null
  if (!res.ok || !body?.access_token) {
    throw new Error(
      `Token refresh failed (HTTP ${res.status}) ${body?.error ?? ""}. Run lolia_setup action=import_client (or set a fresh refresh_token).`.trim(),
    )
  }
  return body
}

async function getAccessToken(force = false): Promise<string> {
  const cfg = await loadConfig()
  if (!cfg.refresh_token) {
    throw new Error(
      "Lolia FRP is not configured. Run lolia_setup (action=import_client) once, or ask the user to provide a refresh_token.",
    )
  }
  if (!force && cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token
  const r = await refreshAccessToken(cfg.refresh_token)
  cachedToken = { token: r.access_token as string, exp: Date.now() + (Number(r.expires_in) || 86400) * 1000 }
  if (r.refresh_token && r.refresh_token !== cfg.refresh_token) {
    await saveConfig({ ...cfg, refresh_token: r.refresh_token })
  }
  return cachedToken.token
}

async function api(pathname: string, init: RequestInit & { _retry?: boolean } = {}): Promise<any> {
  const token = await getAccessToken()
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (init.body) headers["Content-Type"] = "application/json"
  const res = await fetch(API_BASE + pathname, { ...init, headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (res.status === 401 && !init._retry) {
    cachedToken = null
    return api(pathname, { ...init, _retry: true })
  }
  if (res.status === 401) {
    throw new Error("Unauthorized after token refresh. Run lolia_setup action=import_client to re-import credentials.")
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(body?.msg ?? text).toString().slice(0, 300)}`)
  if (body && typeof body.code === "number" && body.code !== 200) {
    throw new Error(`API code ${body.code}: ${String(body.msg ?? "").slice(0, 300)}`)
  }
  return body
}

async function listTunnels(): Promise<Tunnel[]> {
  const all: Tunnel[] = []
  for (let page = 1; page <= 5; page++) {
    const r = await api(`/user/tunnel?limit=100&page=${page}`)
    const list: Tunnel[] = r?.data?.list ?? []
    all.push(...list)
    const total = Number(r?.data?.total ?? all.length)
    if (all.length >= total || list.length === 0) break
  }
  return all
}

function resolveTunnel(input: string, tunnels: Tunnel[]): Tunnel | undefined {
  const s = input.trim()
  if (/^\d+$/.test(s)) return tunnels.find((t) => t.id === Number(s))
  return tunnels.find((t) => t.name === s) ?? tunnels.find((t) => t.remark === s)
}

async function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false })
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
    child.stdout?.on("data", (chunk: string) => (stdout += chunk))
    child.stderr?.on("data", (chunk: string) => (stderr += chunk))
    child.on("error", (err) => finish({ code: null, stdout, stderr, error: err.message }))
    child.on("close", (code) => finish({ code, stdout, stderr }))
  })
}

async function runPsScript(name: string, content: string, params: string[] = []) {
  await mkdir(PS_DIR, { recursive: true })
  const file = path.join(PS_DIR, name)
  await writeFile(file, content, "utf8")
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...params],
    PS_TIMEOUT_MS,
  )
}

const SCAN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$items = Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | ForEach-Object {
  $m = [regex]::Match($_.CommandLine, '-{1,2}t(?:oken)?[=\s]*(\d+):([^\s"]+)')
  if ($m.Success) {
    [pscustomobject]@{
      pid = $_.ProcessId
      tunnel_id = [int]$m.Groups[1].Value
      uptime_s = [int]((Get-Date) - $_.CreationDate).TotalSeconds
    }
  }
}
if ($items) { @($items) | ConvertTo-Json -Compress } else { '[]' }
`

const START_SCRIPT = `
param([string]$Exe, [string]$FrpcArgs, [string]$WorkDir)
$ErrorActionPreference = 'Stop'
$cmd = '"' + $Exe + '" ' + $FrpcArgs
try {
  $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
  $si.ShowWindow = 0
  $r = ([wmiclass]'Win32_Process').Create($cmd, $WorkDir, $si)
  if ($r.ReturnValue -ne 0) { Write-Output ("ERR " + $r.ReturnValue) } else { Write-Output ("PID " + $r.ProcessId) }
} catch { Write-Output ("ERR " + $_.Exception.Message) }
`

const STOP_SCRIPT = `
param([int]$TunnelId, [switch]$All)
$ErrorActionPreference = 'SilentlyContinue'
$killed = @()
Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | ForEach-Object {
  $m = [regex]::Match($_.CommandLine, '-{1,2}t(?:oken)?[=\s]*(\d+):')
  $take = $false
  if ($All) { $take = $m.Success }
  elseif ($m.Success -and [int]$m.Groups[1].Value -eq $TunnelId) { $take = $true }
  if ($take) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 200
    if (-not (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue)) { $killed += $_.ProcessId }
  }
}
@($killed) | ConvertTo-Json -Compress
`

async function scanFrpcProcesses(): Promise<FrpcProc[]> {
  if (!isWindows()) return []
  const r = await runPsScript("scan.ps1", SCAN_SCRIPT)
  if (r.error) return []
  try {
    const parsed = JSON.parse(r.stdout.trim() || "[]")
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.filter((x: any) => x && Number.isFinite(Number(x.pid)))
  } catch {
    return []
  }
}

async function resolveFrpc(): Promise<{ path: string; version?: string } | null> {
  const cfg = await loadConfig()
  const candidates = [cfg.frpc_path, DEFAULT_FRPC].filter(Boolean) as string[]
  for (const c of candidates) {
    if (await fileExists(c)) {
      const v = await run(c, ["-v"], 10_000)
      return { path: c, version: v.stdout.trim() || undefined }
    }
  }
  if (isWindows()) {
    const w = await run("where.exe", ["frpc"], 5_000)
    const found = w.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (found && (await fileExists(found))) {
      const v = await run(found, ["-v"], 10_000)
      return { path: found, version: v.stdout.trim() || undefined }
    }
  }
  return null
}

function tunnelLine(t: Tunnel, proc?: FrpcProc) {
  const target = t.custom_domain
    ? `${t.custom_domain}:${t.remote_port || 80}`
    : `:${t.remote_port}`
  const local = `${t.local_ip || "127.0.0.1"}:${t.local_port}`
  const tls = t.config?.auto_tls ? " auto_tls" : ""
  const runPart = proc
    ? `RUNNING pid=${proc.pid} up=${fmtUptime(proc.uptime_s)}`
    : "not running locally"
  return `#${t.id} [${t.remark || t.name}] ${t.type}  node=${t.node_name ?? t.node_id}  ${local} -> ${target}${tls}  server=${t.status}  ${runPart}`
}

export const LoliaFrpPlugin: ToolFactory = async () => {
  return {
    tool: {
      lolia_setup: tool({
        description:
          "Configure or verify Lolia FRP (lolia.link) credentials for the other lolia_* tools. " +
          "Actions: import_client (default; imports refresh_token from the LoliaFrpClient desktop app settings), " +
          "set (requires refresh_token arg), test (verify current config), clear (forget credentials; requires confirm=true). " +
          "Tokens are stored in ~/.config/opencode/lolia-frp.json and never echoed in full. " +
          "Run this once before any other lolia_* tool; do not use it for tunnel operations.",
        args: {
          action: tool.schema
            .string()
            .optional()
            .describe("One of: import_client (default), set, test, clear."),
          refresh_token: tool.schema
            .string()
            .optional()
            .describe("Refresh token for action=set. Obtain from the Lolia client settings.json (RefreshToken field)."),
          confirm: tool.schema
            .boolean()
            .optional()
            .describe("Required true for action=clear. User must explicitly agree."),
        },
        async execute(args) {
          const action = args.action ?? "import_client"
          try {
            if (action === "clear") {
              if (!args.confirm) return "Refused: action=clear deletes stored credentials. Ask the user, then pass confirm=true."
              await rm(CONFIG_PATH, { force: true })
              cachedToken = null
              return `Cleared ${CONFIG_PATH}.`
            }
            if (action === "set") {
              if (!args.refresh_token?.trim()) return "Error: action=set requires refresh_token."
              await saveConfig({ ...(await loadConfig()), refresh_token: args.refresh_token.trim() })
              cachedToken = null
            } else if (action === "import_client") {
              let raw: string
              try {
                raw = await readFile(LORIA_CLIENT_SETTINGS, "utf8")
              } catch {
                return [
                  "LoliaFrpClient settings.json not found at:",
                  LORIA_CLIENT_SETTINGS,
                  "Install/start the Lolia client once, or use action=set with a refresh_token",
                  "(the RefreshToken field of that settings.json).",
                ].join("\n")
              }
              const j = JSON.parse(raw) as { RefreshToken?: string }
              if (!j.RefreshToken) return "settings.json found but no RefreshToken field. Use action=set instead."
              await saveConfig({ ...(await loadConfig()), refresh_token: j.RefreshToken })
              cachedToken = null
            }
            const token = await getAccessToken(true)
            const info = await api("/user/info")
            const d = info?.data ?? {}
            return [
              "Lolia FRP configured and verified.",
              `user: ${d.username ?? "?"} (id ${d.id ?? "?"}), tunnels allowed: ${d.max_tunnel_count ?? "?"}`,
              `traffic: ${fmtBytes(d.traffic_used)} / ${fmtBytes(d.traffic_limit)}`,
              `access token: ${mask(token)}`,
              `config file: ${CONFIG_PATH}`,
            ].join("\n")
          } catch (err) {
            return `lolia_setup failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_status: tool({
        description:
          "Show Lolia FRP account status (user info, traffic quota, tunnel count) plus local frpc binary and running frpc processes. " +
          "Read-only. Use as the first diagnostic when tunnel operations misbehave.",
        args: {},
        async execute() {
          const lines: string[] = []
          const frpc = await resolveFrpc()
          lines.push(frpc ? `frpc binary: ${frpc.path} (v${frpc.version ?? "?"})` : "frpc binary: NOT FOUND (install via Lolia client, or set frpc_path in ~/.config/opencode/lolia-frp.json)")
          const procs = await scanFrpcProcesses()
          lines.push(
            procs.length
              ? `running frpc processes (${procs.length}): ${procs.map((p) => `tunnel#${p.tunnel_id} pid=${p.pid} up=${fmtUptime(p.uptime_s)}`).join(", ")}`
              : "running frpc processes: none",
          )
          try {
            const info = await api("/user/info")
            const d = info?.data ?? {}
            const pct = d.traffic_limit ? ((d.traffic_used / d.traffic_limit) * 100).toFixed(1) : "?"
            lines.push(
              `account: ${d.username ?? "?"} (id ${d.id ?? "?"}), tunnels ${d.max_tunnel_count ?? "?"} max, banned=${d.is_banned}`,
              `traffic: ${fmtBytes(d.traffic_used)} / ${fmtBytes(d.traffic_limit)} (${pct}%), checked-in today: ${d.today_checked}`,
              `auth: OK (access token ${mask(cachedToken?.token)})`,
            )
          } catch (err) {
            lines.push(`account: unavailable - ${err instanceof Error ? err.message : String(err)}`)
          }
          return lines.join("\n")
        },
      }),

      lolia_tunnels: tool({
        description:
          "List all tunnels registered in the user's Lolia FRP account, merged with locally running frpc processes (pid/uptime). " +
          "Server status shows whether the tunnel is currently connected on the node (online) or not (inactive). " +
          "Use this before start/stop/delete to pick the right tunnel id.",
        args: {},
        async execute() {
          try {
            const tunnels = await listTunnels()
            const procs = await scanFrpcProcesses()
            const byId = new Map(procs.map((p) => [p.tunnel_id, p]))
            if (tunnels.length === 0) return "No tunnels registered."
            return [`tunnels (${tunnels.length}):`, ...tunnels.map((t) => tunnelLine(t, byId.get(t.id)))].join("\n")
          } catch (err) {
            return `lolia_tunnels failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_tunnel: tool({
        description:
          "Show full detail of one Lolia FRP tunnel by numeric id or tunnel name (from lolia_tunnels). " +
          "The tunnel_token is masked unless reveal_token=true; reveal only when the user explicitly needs the raw token.",
        args: {
          tunnel: tool.schema.string().describe("Tunnel numeric id or tunnel name."),
          reveal_token: tool.schema
            .boolean()
            .optional()
            .describe("Set true only on explicit user request to print the raw tunnel token."),
        },
        async execute(args) {
          try {
            const tunnels = await listTunnels()
            const t = resolveTunnel(args.tunnel, tunnels)
            if (!t) return `Tunnel "${args.tunnel}" not found. Use lolia_tunnels to list ids/names.`
            const detail = await api(`/user/tunnel/${encodeURIComponent(t.name)}`)
            const d = (detail?.data ?? t) as Tunnel & Record<string, unknown>
            const token = typeof d.tunnel_token === "string" ? d.tunnel_token : undefined
            const body: Record<string, unknown> = { ...d }
            body.tunnel_token = args.reveal_token ? token : mask(token)
            return JSON.stringify(body, null, 2)
          } catch (err) {
            return `lolia_tunnel failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_tunnel_start: tool({
        description:
          "Start a Lolia FRP tunnel locally: fetches the tunnel token from the API and launches a DETACHED frpc process " +
          "(via WMI, outside the OpenCode process tree), so it keeps running after OpenCode exits and is equally visible " +
          "to the Lolia desktop client. Refuses if the tunnel already has a running frpc process. " +
          "Do not start tunnels the user did not ask for; one process per tunnel.",
        args: {
          tunnel: tool.schema.string().describe("Tunnel numeric id or name (see lolia_tunnels)."),
        },
        async execute(args) {
          try {
            if (!isWindows()) return "Error: local frpc process management is Windows-only in this plugin."
            const frpc = await resolveFrpc()
            if (!frpc) return "Error: frpc.exe not found. Install it via the Lolia client (Settings -> frpc) or set frpc_path in the plugin config."
            const tunnels = await listTunnels()
            const t = resolveTunnel(args.tunnel, tunnels)
            if (!t) return `Tunnel "${args.tunnel}" not found. Use lolia_tunnels to list ids/names.`
            const procs = await scanFrpcProcesses()
            const existing = procs.find((p) => p.tunnel_id === t.id)
            if (existing) return `Tunnel #${t.id} (${t.remark || t.name}) is already running: pid=${existing.pid}, up=${fmtUptime(existing.uptime_s)}. Nothing to do.`
            const detail = await api(`/user/tunnel/${encodeURIComponent(t.name)}`)
            const token = detail?.data?.tunnel_token
            if (!token) return "Error: tunnel_token unavailable from API (tunnel may be disabled server-side)."
            const workDir = path.dirname(frpc.path)
            const r = await runPsScript("start.ps1", START_SCRIPT, [
              "-Exe", frpc.path,
              "-FrpcArgs", `-t ${t.id}:${token}`,
              "-WorkDir", workDir,
            ])
            const out = (r.stdout || r.stderr).trim()
            const m = /^PID (\d+)$/.exec(out)
            if (!m) return `Failed to start frpc via WMI: ${out || r.error || "unknown error"}`
            const pid = Number(m[1])
            await new Promise((res) => setTimeout(res, 1500))
            const check = await scanFrpcProcesses()
            const alive = check.find((p) => p.pid === pid)
            return [
              `Started tunnel #${t.id} (${t.remark || t.name}) as DETACHED process pid=${pid}.`,
              alive ? `Process alive after 1.5s (up=${fmtUptime(alive.uptime_s)}); frpc fetches its config from the node by token.` : "WARNING: process already exited - check the tunnel config/token (try lolia_tunnel).",
              `target: ${tunnelLine(t)}`,
              `frpc logs are not captured by OpenCode; the Lolia client or server status shows connectivity. Verify with lolia_tunnels.`,
            ].join("\n")
          } catch (err) {
            return `lolia_tunnel_start failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_tunnel_stop: tool({
        description:
          "Stop the local frpc process of a Lolia FRP tunnel (kills the detached OS process matched by '-t <id>:<token>' in its command line). " +
          "Works regardless of whether the process was started by OpenCode or by the Lolia desktop client. " +
          "Use all=true only when the user explicitly wants every tunnel stopped.",
        args: {
          tunnel: tool.schema.string().optional().describe("Tunnel numeric id or name. Omit when all=true."),
          all: tool.schema.boolean().optional().describe("Stop ALL running frpc processes. Requires explicit user request."),
        },
        async execute(args) {
          try {
            if (!isWindows()) return "Error: local frpc process management is Windows-only in this plugin."
            if (args.all) {
              const r = await runPsScript("stop.ps1", STOP_SCRIPT, ["-All"])
              const killed = JSON.parse((r.stdout || "[]").trim() || "[]")
              return Array.isArray(killed) && killed.length
                ? `Stopped frpc processes: ${killed.join(", ")}`
                : "No running frpc processes found."
            }
            if (!args.tunnel) return "Error: provide tunnel (id or name) or all=true."
            const tunnels = await listTunnels()
            const t = resolveTunnel(args.tunnel, tunnels)
            if (!t) return `Tunnel "${args.tunnel}" not found. Use lolia_tunnels to list ids/names.`
            const r = await runPsScript("stop.ps1", STOP_SCRIPT, ["-TunnelId", String(t.id)])
            const killed = JSON.parse((r.stdout || "[]").trim() || "[]")
            return Array.isArray(killed) && killed.length
              ? `Stopped tunnel #${t.id} (${t.remark || t.name}), pid(s): ${killed.join(", ")}.`
              : `Tunnel #${t.id} (${t.remark || t.name}) had no running frpc process.`
          } catch (err) {
            return `lolia_tunnel_stop failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_tunnel_create: tool({
        description:
          "Create a new tunnel in the user's Lolia FRP account. Requires type, node_id (from lolia_nodes) and local_port. " +
          "remote_port: pick a free port from the node's available_ports; some nodes auto-assign when omitted. " +
          "http/https tunnels require a custom_domain verified in the Lolia dashboard. Does NOT start the tunnel - call lolia_tunnel_start after.",
        args: {
          type: tool.schema.string().describe("Tunnel type: tcp | udp | http | https."),
          node_id: tool.schema.number().describe("Node id from lolia_nodes."),
          local_port: tool.schema.number().describe("Local service port on 127.0.0.1."),
          remote_port: tool.schema.number().optional().describe("Remote port on the node (from available_ports)."),
          local_ip: tool.schema.string().optional().describe("Local bind IP, default 127.0.0.1."),
          remark: tool.schema.string().optional().describe("Human-readable name shown in dashboards, e.g. SSH."),
          custom_domain: tool.schema.string().optional().describe("Verified custom domain (required for http/https)."),
          auto_tls: tool.schema.boolean().optional().describe("Request automatic TLS cert for custom domains (https)."),
          http_redirect: tool.schema.boolean().optional().describe("Redirect plain HTTP to HTTPS (https tunnels)."),
        },
        async execute(args) {
          try {
            const body: Record<string, unknown> = {
              type: args.type.trim(),
              node_id: args.node_id,
              local_port: args.local_port,
              local_ip: args.local_ip?.trim() || "127.0.0.1",
            }
            if (args.remote_port != null) body.remote_port = args.remote_port
            if (args.remark?.trim()) body.remark = args.remark.trim()
            if (args.custom_domain?.trim()) body.custom_domain = args.custom_domain.trim()
            if (args.auto_tls != null) body.auto_tls = args.auto_tls
            if (args.http_redirect != null) body.http_redirect = args.http_redirect
            const r = await api("/user/tunnel", { method: "POST", body: JSON.stringify(body) })
            const d = r?.data ?? {}
            if (d.tunnel_token) d.tunnel_token = mask(d.tunnel_token)
            return [`Tunnel created.`, JSON.stringify(d, null, 2), "Start it with lolia_tunnel_start."].join("\n")
          } catch (err) {
            return `lolia_tunnel_create failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_tunnel_delete: tool({
        description:
          "Permanently delete a tunnel from the user's Lolia FRP account (server-side, irreversible). " +
          "Stops the local frpc process first if running. DESTRUCTIVE: requires confirm=true after explicit user agreement.",
        args: {
          tunnel: tool.schema.string().describe("Tunnel numeric id or name."),
          confirm: tool.schema.boolean().optional().describe("Must be true. Confirm with the user first."),
        },
        async execute(args) {
          try {
            if (!args.confirm) return "Refused: deleting a tunnel is irreversible. State exactly which tunnel will be deleted, get user agreement, then pass confirm=true."
            const tunnels = await listTunnels()
            const t = resolveTunnel(args.tunnel, tunnels)
            if (!t) return `Tunnel "${args.tunnel}" not found. Use lolia_tunnels to list ids/names.`
            const stopped = await runPsScript("stop.ps1", STOP_SCRIPT, ["-TunnelId", String(t.id)])
            let stoppedNote = "no local process was running"
            try {
              const killed = JSON.parse((stopped.stdout || "[]").trim() || "[]")
              if (Array.isArray(killed) && killed.length) stoppedNote = `stopped local pid(s): ${killed.join(", ")}`
            } catch {}
            await api(`/user/tunnel/${encodeURIComponent(t.name)}`, { method: "DELETE" })
            return `Deleted tunnel #${t.id} (${t.remark || t.name}); ${stoppedNote}.`
          } catch (err) {
            return `lolia_tunnel_delete failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_tunnel_token_reset: tool({
        description:
          "Reset the Lolia FRP tunnel token (GET /user/tunnel/token shows it, POST resets). Resetting invalidates the old token: " +
          "every running frpc process (here and in the Lolia client) will fail to reconnect until restarted. DESTRUCTIVE: requires confirm=true.",
        args: {
          action: tool.schema
            .string()
            .optional()
            .describe("show (default) returns the current token (masked unless reveal=true); reset rotates it."),
          reveal: tool.schema.boolean().optional().describe("Print the raw token (only on explicit user request)."),
          confirm: tool.schema.boolean().optional().describe("Required true for action=reset after user agreement."),
        },
        async execute(args) {
          try {
            const action = args.action ?? "show"
            if (action === "show") {
              const r = await api("/user/tunnel/token")
              const tok = r?.data?.tunnel_token ?? r?.data?.token
              return `tunnel token: ${args.reveal ? tok : mask(tok)}`
            }
            if (action === "reset") {
              if (!args.confirm) return "Refused: resetting invalidates the token used by all running frpc processes. Confirm with the user, then pass confirm=true."
              const r = await api("/user/tunnel/token/reset", { method: "POST", body: JSON.stringify({}) })
              const tok = r?.data?.tunnel_token ?? r?.data?.token
              const procs = await scanFrpcProcesses()
              return [
                `Token reset. New token: ${mask(tok)}`,
                procs.length
                  ? `WARNING: ${procs.length} frpc process(es) still use the old token; restart them (lolia_tunnel_stop + lolia_tunnel_start) or they will drop on reconnect.`
                  : "No local frpc processes running.",
              ].join("\n")
            }
            return `Unknown action "${action}". Use show or reset.`
          } catch (err) {
            return `lolia_tunnel_token_reset failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_nodes: tool({
        description:
          "List Lolia FRP nodes with id, region, online status, supported protocols, bandwidth, load and available ports. " +
          "Use it to pick node_id (and a free remote_port) for lolia_tunnel_create.",
        args: {
          limit: tool.schema.number().optional().describe("Max nodes per page (default 100)."),
          page: tool.schema.number().optional().describe("Page number (default 1)."),
        },
        async execute(args) {
          try {
            const body = JSON.stringify({ limit: args.limit ?? 100, page: args.page ?? 1 })
            const r = await api("/user/nodes", { method: "POST", body })
            const nodes: any[] = r?.data?.nodes ?? []
            if (!nodes.length) return "No nodes returned."
            const lines = nodes.map((n) => {
              const ports = n.available_ports
              let portInfo = "?"
              if (Array.isArray(ports)) {
                const nums = ports.map((x: any) => Number(x)).filter(Number.isFinite)
                portInfo = nums.length
                  ? `${nums.length} ports (${Math.min(...nums)}-${Math.max(...nums)})`
                  : `${JSON.stringify(ports).slice(0, 60)}`
              }
              return [
                `#${n.id} ${n.name} [${n.region_code ?? "?"}] ${n.status}`,
                `  protocols=${(n.supported_protocols ?? []).join(",") || "?"} bandwidth=${n.bandwidth ?? "?"}Mb load=${n.load ?? "?"}% kyc=${n.need_kyc ? "required" : "no"} beian=${n.beian_required ? "required" : "no"}`,
                `  available: ${portInfo}${n.remark ? `  note: ${String(n.remark).slice(0, 80)}` : ""}`,
              ].join("\n")
            })
            return [`nodes (${nodes.length}, total ${r?.data?.total ?? nodes.length}):`, ...lines].join("\n")
          } catch (err) {
            return `lolia_nodes failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_traffic: tool({
        description:
          "Query Lolia FRP traffic accounting. Actions: stats (account totals), daily (per-day history), tunnels (per-tunnel usage), tunnel (single tunnel by id). " +
          "Read-only. Prefer lolia_status for a quick quota glance.",
        args: {
          action: tool.schema
            .string()
            .optional()
            .describe("stats (default) | daily | tunnels | tunnel."),
          days: tool.schema.number().optional().describe("History window in days for daily/tunnels (default 7)."),
          tunnel_id: tool.schema.number().optional().describe("Tunnel id for action=tunnel."),
        },
        async execute(args) {
          try {
            const action = args.action ?? "stats"
            let r: any
            if (action === "stats") r = await api("/user/traffic/stats")
            else if (action === "daily") r = await api(`/user/traffic/daily?days=${args.days ?? 7}`)
            else if (action === "tunnels") r = await api(`/user/traffic/tunnels?days=${args.days ?? 7}`)
            else if (action === "tunnel") {
              if (!args.tunnel_id) return "Error: action=tunnel requires tunnel_id."
              r = await api(`/user/traffic/tunnel/${args.tunnel_id}`)
            } else return `Unknown action "${action}". Use stats | daily | tunnels | tunnel.`
            const d = r?.data
            if (d && Number.isFinite(Number(d.traffic_used))) {
              return `traffic: ${fmtBytes(d.traffic_used)} / ${fmtBytes(d.traffic_limit)} (remaining ${fmtBytes(d.traffic_remaining)})\nraw: ${JSON.stringify(d).slice(0, 1500)}`
            }
            return JSON.stringify(d ?? r, null, 1).slice(0, 4000)
          } catch (err) {
            return `lolia_traffic failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_config: tool({
        description:
          "Fetch the generated frpc TOML config for tunnels (base64-decoded) from the Lolia API. " +
          "Useful to inspect what frpc runs or to run frpc manually. Provide one tunnel name to scope, or omit for all tunnels.",
        args: {
          tunnel: tool.schema.string().optional().describe("Tunnel name to scope the config to."),
          include_lolia_config: tool.schema
            .boolean()
            .optional()
            .describe("Also return the internal 'lolia_config' variant (default false)."),
        },
        async execute(args) {
          try {
            const q = args.tunnel?.trim() ? `?tunnel=${encodeURIComponent(args.tunnel.trim())}` : ""
            const r = await api(`/user/frpc/config${q}`)
            const d = r?.data ?? {}
            const decode = (b64: string) => {
              try {
                return Buffer.from(b64, "base64").toString("utf8")
              } catch {
                return `(decode failed)`
              }
            }
            const parts: string[] = []
            if (d.config) parts.push(`# config\n${decode(d.config)}`)
            if (args.include_lolia_config && d.lolia_config) parts.push(`# lolia_config\n${decode(d.lolia_config)}`)
            return parts.length ? parts.join("\n\n") : `No config returned. raw: ${JSON.stringify(d).slice(0, 500)}`
          } catch (err) {
            return `lolia_config failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      lolia_checkin: tool({
        description:
          "Perform the daily check-in on Lolia FRP (may grant bonus traffic). Safe to call once per day; the API reports if already checked in. " +
          "Only call when the user asks for it.",
        args: {},
        async execute() {
          try {
            const r = await api("/user/checkin", { method: "POST", body: JSON.stringify({}) })
            return `checkin OK: ${String(r?.msg ?? "")} ${r?.data ? JSON.stringify(r.data).slice(0, 300) : ""}`.trim()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return `checkin: ${msg}`
          }
        },
      }),
    },
  }
}

export default defineToolsPlugin("lolia-frp", LoliaFrpPlugin)
