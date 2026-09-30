import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

const originalHome = process.env.USERPROFILE
const originalFetch = globalThis.fetch
const home = await mkdtemp(path.join(os.tmpdir(), "lolia-plugin-test-"))
process.env.USERPROFILE = home
await mkdir(path.join(home, ".config", "opencode"), { recursive: true })
await writeFile(path.join(home, ".config", "opencode", "lolia-frp.json"), JSON.stringify({ refresh_token: "fake-token" }))
const { LoliaFrpPlugin } = await import("../plugins/lolia-frp.ts")
const { tool: tools } = await LoliaFrpPlugin()

after(async () => {
  globalThis.fetch = originalFetch
  if (originalHome === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalHome
  await rm(home, { recursive: true, force: true })
})

function mockApi(responses) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "fake-access", expires_in: 3600 }), { status: 200 })
    }
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body && JSON.parse(init.body) })
    const { code = 200, data = {}, msg = "success" } = responses.shift() ?? {}
    return new Response(JSON.stringify({ code, data, msg }), { status: code })
  }
  return calls
}

test("create accepts 201 and configures HTTPS via subsequent PUT", async () => {
  const calls = mockApi([
    { code: 201, data: { id: 42, name: "tunnel42", token: "secret-token", config: { auto_tls: false } } },
    { data: { config: { auto_tls: true, http_redirect: true }, status: "inactive" } },
  ])
  const result = await tools.lolia_tunnel_create.execute({
    type: "https", node_id: 34, local_port: 2540, custom_domain: "test.example.com",
    auto_tls: true, http_redirect: true,
  })
  assert.match(result, /Tunnel created/)
  assert.match(result, /"auto_tls": true/)
  assert.doesNotMatch(result, /secret-token/)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, "POST")
  assert.equal(calls[0].body.auto_tls, undefined)
  assert.equal(calls[1].method, "PUT")
  assert.match(calls[1].url, /\/user\/tunnel\/tunnel42$/)
  assert.deepEqual(calls[1].body, { config: { auto_tls: true, http_redirect: true } })
})

test("edit targets the resolved tunnel name and sends nested config", async () => {
  const calls = mockApi([
    { data: { list: [{ id: 42, name: "tunnel42", remark: "OpenChamber", type: "https" }], total: 1 } },
    { data: { status: "inactive", config: { auto_tls: true } }, msg: "updated" },
  ])
  const result = await tools.lolia_tunnel_edit.execute({ tunnel: "42", local_port: 2540, auto_tls: true })
  assert.match(result, /restart its local frpc process/)
  assert.deepEqual(calls[1].body, { local_port: 2540, config: { auto_tls: true } })
  assert.match(calls[1].url, /\/user\/tunnel\/tunnel42$/)
})

test("create reports partial success without inviting a duplicate", async () => {
  const calls = mockApi([
    { code: 201, data: { id: 43, name: "tunnel43" } },
    { code: 400, msg: "invalid config" },
  ])
  const result = await tools.lolia_tunnel_create.execute({
    type: "https", node_id: 34, local_port: 2540, custom_domain: "test.example.com", auto_tls: true,
  })
  assert.match(result, /was created, but configuring TLS\/redirect failed/)
  assert.match(result, /Do not create a duplicate/)
  assert.equal(calls.length, 2)
})

test("PowerShell process scripts match -t id:token and stop only the requested tunnel", { skip: process.platform !== "win32" }, async () => {
  const source = await readFile(new URL("../plugins/lolia-frp.ts", import.meta.url), "utf8")
  const script = (name) => {
    const match = source.match(new RegExp(`const ${name} = String\\.raw\x60([\\s\\S]*?)\x60`))
    assert.ok(match, name)
    return match[1]
  }
  const processes = `
function Get-CimInstance {
  @(
    [pscustomobject]@{ ProcessId=101; CommandLine='"C:\\frpc.exe" -t 22429:secret'; CreationDate=(Get-Date).AddMinutes(-2) },
    [pscustomobject]@{ ProcessId=102; CommandLine='"C:\\frpc.exe" -t 22430:secret'; CreationDate=(Get-Date).AddMinutes(-2) }
  )
}
`
  const run = (body) => {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", body], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  assert.deepEqual(JSON.parse(run(processes + script("SCAN_SCRIPT"))).map((p) => p.tunnel_id), [22429, 22430])
  const stops = run(processes + `
function Stop-Process { param($Id, $Force) $global:stopped += $Id }
function Get-Process { param($Id) $null }
function Start-Sleep { param($Milliseconds) }
` + script("STOP_SCRIPT").replace("param([int]$TunnelId, [switch]$All)", "$TunnelId = 22429") + "\n'ACTUAL ' + ($global:stopped -join ',')")
  assert.match(stops, /^\[101\]/)
  assert.match(stops, /ACTUAL 101$/)
})
