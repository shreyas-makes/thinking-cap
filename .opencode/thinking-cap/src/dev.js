#!/usr/bin/env node
import path from "node:path"
import { spawn } from "node:child_process"

const workspaceRoot = process.cwd()
const cliPath = path.join(workspaceRoot, "thinking-cap", "src", "cli.js")

function startProcess(name, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: workspaceRoot,
    stdio: ["inherit", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`)
  })

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`)
  })

  child.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`
    process.stdout.write(`[${name}] exited with ${reason}\n`)
  })

  return child
}

const daemon = startProcess("daemon", ["daemon"])
let sidecar = null

function shutdown() {
  if (sidecar && !sidecar.killed) sidecar.kill("SIGINT")
  if (!daemon.killed) daemon.kill("SIGINT")
}

daemon.stdout.on("data", (chunk) => {
  if (!sidecar && String(chunk).includes("listening on")) {
    sidecar = spawn(process.execPath, [cliPath, "sidecar"], {
      cwd: workspaceRoot,
      stdio: "inherit",
    })

    sidecar.on("exit", () => {
      shutdown()
    })
  }
})

process.on("SIGINT", () => {
  shutdown()
  process.exit(0)
})

process.on("SIGTERM", () => {
  shutdown()
  process.exit(0)
})
