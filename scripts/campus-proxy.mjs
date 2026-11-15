// Minimal forward proxy (HTTP + CONNECT) for using a campus-network machine as an egress hop.
//
// Run on the machine that is physically inside the campus network:
//   node campus-proxy.mjs
//   node campus-proxy.mjs --port 8899 --host 100.89.105.117 --verbose
//
// Safety:
//   - Binds to the Tailscale address by default, never 0.0.0.0.
//   - Forwards only an allowlist of Elsevier hosts, so it cannot become an open proxy.
//
// Uses only Node.js built-ins (Node 18+).

import http from "node:http"
import net from "node:net"
import os from "node:os"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8899" },
    host: { type: "string", default: "" },
    allow: { type: "string", default: "" },
    verbose: { type: "boolean", default: false },
  },
})

const PORT = Number.parseInt(values.port, 10)

const DEFAULT_ALLOW = [
  "api.elsevier.com",
  "sciencedirect.com",
  "elsevier.com",
  "linkinghub.elsevier.com",
  "dev.elsevier.com",
]

const ALLOW_EXTRA = values.allow
  ? values.allow.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  : []

const ALLOW = new Set([...DEFAULT_ALLOW, ...ALLOW_EXTRA])

export function isAllowed(hostname) {
  const h = (hostname || "").toLowerCase().replace(/\.$/, "")
  if (!h) return false
  for (const allowed of ALLOW) {
    if (h === allowed || h.endsWith("." + allowed)) return true
  }
  return false
}

function pickBindHost() {
  if (values.host) return values.host
  const nets = Object.values(os.networkInterfaces()).flat()
  const ts = nets.find(
    (n) => n && n.family === "IPv4" && !n.internal && n.address.startsWith("100."),
  )
  return ts ? ts.address : "127.0.0.1"
}

function log(...args) {
  if (values.verbose) console.log(new Date().toISOString(), ...args)
}

const server = http.createServer((req, res) => {
  let target
  try {
    target = new URL(req.url)
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" })
    res.end("bad request")
    return
  }
  if (!isAllowed(target.hostname)) {
    res.writeHead(403, { "Content-Type": "text/plain" })
    res.end("host not allowed: " + target.hostname)
    return
  }
  log("HTTP", req.method, target.hostname)

  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers: req.headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "text/plain" })
    res.end("upstream error: " + err.message)
  })
  req.pipe(upstream)
})

server.on("connect", (req, clientSocket, head) => {
  const [hostname, portRaw] = (req.url || "").split(":")
  const port = Number.parseInt(portRaw || "443", 10)

  if (!isAllowed(hostname)) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    log("DENY", hostname)
    return
  }
  log("CONNECT", hostname + ":" + port)

  const upstream = net.connect(port, hostname, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  upstream.on("error", () => {
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
  })
  clientSocket.on("error", () => upstream.destroy())
})

const isEntryPoint = process.argv[1] && process.argv[1].endsWith("campus-proxy.mjs")

if (isEntryPoint) {
  const bind = pickBindHost()
  server.listen(PORT, bind, () => {
    console.log(`campus-proxy listening on http://${bind}:${PORT}`)
    console.log(`allowed hosts: ${[...ALLOW].join(", ")}`)
    console.log("")
    console.log("On the other machine, configure the ScienceDirect plugin only:")
    console.log(`  sciencedirect_configure action=set_proxy proxy=http://${bind}:${PORT}`)
  })
}

export { server }
