import { Plugin } from "@opencode/plugin"
import { type LoadedConfig, loadConfig } from "./core/config.js"
import { isPathWithin } from "./core/project.js"

const PUSH_TRIGGERS = new Set([
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
])

function debug(message: string): void {
  if (process.env.OCSYNC_DEBUG === "1") process.stderr.write(`[ocsync] ${message}\n`)
}

function isIdleStatus(type: string, data: unknown): boolean {
  if (type !== "session.status") return false
  if (typeof data !== "object" || data === null) return false
  const status = (data as { status?: { type?: unknown } }).status
  return status?.type === "idle"
}

export default Plugin.define({
  id: "ocsync",
  async setup(ctx) {
    let config: LoadedConfig
    try {
      config = loadConfig()
    } catch (error) {
      debug(`disabled: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const directory = ctx.location.directory
    const debounceMs = Math.max(0, config.pushDebounceSec * 1000)
    const binary = process.env.OCSYNC_BIN ?? "ocsync"
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval: ReturnType<typeof setInterval> | undefined
    let running = false
    let pending = false

    const run = async (command: "sync" | "pull"): Promise<void> => {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        const proc = Bun.spawn([binary, command, "--quiet", "--project", directory], {
          stdout: "ignore",
          stderr: "ignore",
          env: process.env,
        })
        const code = await proc.exited
        if (code !== 0) debug(`${command} exited with code ${code}`)
      } catch (error) {
        debug(`${command} failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        running = false
        if (pending) {
          pending = false
          void run(command)
        }
      }
    }

    const schedule = (): void => {
      if (debounceMs === 0) {
        void run("sync")
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void run("sync")
      }, debounceMs)
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const location = event.location?.directory
          if (location && location !== directory && !isPathWithin(location, directory)) continue
          if (PUSH_TRIGGERS.has(event.type) || isIdleStatus(event.type, event.data)) schedule()
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          debug(`event stream ended: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()

    // Pull when the location opens. This is the safe moment: no session is active yet.
    void run("pull")

    if (config.pullIntervalSec > 0) {
      interval = setInterval(() => void run("pull"), config.pullIntervalSec * 1000)
    }

    debug(`enabled for ${directory}`)

    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
      if (interval) clearInterval(interval)
      debug("stopped")
    }
  },
})
