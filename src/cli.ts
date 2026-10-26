import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  ConfigError,
  type DeviceIndex,
  decodeKey,
  defaultConfigPath,
  defaultKeyPath,
  encodeKey,
  GitStore,
  generateKey,
  keyFingerprint,
  type LoadedConfig,
  loadConfig,
  loadKey,
  OpenCodeClient,
  OpenCodeError,
  projectKey,
  SyncEngine,
  saveKey,
  storeRoot,
  writeDefaultConfig,
} from "./core/index.js"
import { VERSION } from "./version.js"

const HELP = `ocsync — Git-backed session sync for OpenCode V2

Usage:
  ocsync <command> [options]

Commands:
  init --remote <url>       Create a configuration and encryption key
  status                    Show local sessions and sync state
  sync                      Push local changes, then pull remote changes
  resolve <session>          Resolve a conflict with --keep local|remote|both
  push                      Push local session changes
  pull                      Pull remote session changes
  key init                  Generate the local encryption key
  key show                  Print the key path and fingerprint
  key export                Print the encryption key (base64)
  key import <file>         Import an encryption key from a file
  doctor                    Check the local setup
  version                   Print the version
  help                      Show this help

Options:
  --config <path>           Configuration file (default: ~/.config/ocsync/config.jsonc)
  --project <dir>           Project directory (default: current directory)
  --server <url>            OpenCode server URL (default: local background service)
  --password <password>     OpenCode server password
  --key-file <path>         Encryption key path for init and key commands
  --keep <mode>             Conflict resolution: local, remote, or both
  --dry-run                 Show what would happen without writing
  --json                    Print machine-readable JSON
  --quiet                   Suppress progress messages
  --force                   Overwrite an existing key or configuration
  --help, -h                Show help
  --version, -v             Print the version

Repository:
  https://github.com/alv67/ocsync
`

interface CliOptions {
  config?: string
  project?: string
  server?: string
  password?: string
  keyFile?: string
  keep?: string
  dryRun: boolean
  json: boolean
  quiet: boolean
  force: boolean
  remote?: string
  help: boolean
  version: boolean
}

function parseCli(argv: string[]): { command: string[]; options: CliOptions } {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      project: { type: "string" },
      server: { type: "string" },
      password: { type: "string" },
      "key-file": { type: "string" },
      keep: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      quiet: { type: "boolean" },
      force: { type: "boolean" },
      remote: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })

  const values = parsed.values
  return {
    command: parsed.positionals,
    options: {
      config: values.config,
      project: values.project,
      server: values.server,
      password: values.password,
      keyFile: values["key-file"],
      keep: values.keep,
      dryRun: values["dry-run"] === true,
      json: values.json === true,
      quiet: values.quiet === true,
      force: values.force === true,
      remote: values.remote,
      help: values.help === true,
      version: values.version === true,
    },
  }
}

function configPath(options: CliOptions): string {
  return options.config ? resolve(options.config) : defaultConfigPath()
}

function projectDirectory(options: CliOptions): string {
  return resolve(options.project ?? process.cwd())
}

function createEngine(options: CliOptions, config = loadConfig(configPath(options))): SyncEngine {
  const key = loadKey(config.keyFile)
  const adapter = OpenCodeClient.discover({ server: options.server, password: options.password })
  const store = new GitStore({ root: storeRoot(), remote: config.remote, branch: config.branch })
  const directory = projectDirectory(options)

  return new SyncEngine({
    config,
    store,
    adapter,
    projectKey: projectKey(directory),
    projectDirectory: directory,
    key,
    log: options.quiet ? undefined : (message) => process.stderr.write(`${message}\n`),
  })
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printLines(lines: string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`)
}

async function commandInit(options: CliOptions): Promise<void> {
  const path = configPath(options)
  if (existsSync(path) && !options.force) {
    throw new ConfigError(`Configuration already exists at ${path}. Use --force to overwrite it.`)
  }
  if (!options.remote) {
    throw new ConfigError('Run "ocsync init --remote <git-url>" to create a configuration.')
  }

  const keyPath = options.keyFile ?? defaultKeyPath()
  writeDefaultConfig(path, options.remote, keyPath)

  let createdKey = false
  if (!existsSync(keyPath) || options.force) {
    const key = generateKey()
    saveKey(keyPath, key)
    createdKey = true
  }

  const config = loadConfig(path)
  printLines([
    `Configuration: ${path}`,
    `Encryption key: ${config.keyFile}${createdKey ? " (created)" : " (existing)"}`,
    `Key fingerprint: ${keyFingerprint(loadKey(config.keyFile))}`,
    `Device: ${config.device}`,
    `Remote: ${config.remote} (${config.branch})`,
    "",
    "Next steps:",
    "  1. Back up the encryption key. Without it, synced sessions cannot be decrypted.",
    '  2. Add the plugin to OpenCode: "plugins": ["ocsync"]',
    '  3. Run "ocsync sync" once to create the first revision.',
  ])
}

async function commandKey(command: string[], options: CliOptions): Promise<void> {
  const subcommand = command[1] ?? "show"
  const config = loadConfig(configPath(options))
  const keyPath = config.keyFile

  if (subcommand === "init") {
    if (existsSync(keyPath) && !options.force) {
      throw new ConfigError(`Encryption key already exists at ${keyPath}. Use --force to overwrite it.`)
    }
    const key = generateKey()
    saveKey(keyPath, key)
    printLines([`Key written to ${keyPath}`, `Fingerprint: ${keyFingerprint(key)}`])
    return
  }

  if (subcommand === "show") {
    const key = loadKey(keyPath)
    printLines([`Key: ${keyPath}`, `Fingerprint: ${keyFingerprint(key)}`])
    return
  }

  if (subcommand === "export") {
    const key = loadKey(keyPath)
    process.stderr.write("Warning: the following value decrypts every synced session. Store it securely.\n")
    process.stdout.write(`${encodeKey(key)}\n`)
    return
  }

  if (subcommand === "import") {
    const file = command[2]
    if (!file) throw new ConfigError("Usage: ocsync key import <file>")
    const encoded = readFileSync(resolve(file), "utf8").trim()
    const key = decodeKey(encoded)
    saveKey(keyPath, key)
    printLines([`Key imported into ${keyPath}`, `Fingerprint: ${keyFingerprint(key)}`])
    return
  }

  throw new ConfigError(`Unknown key subcommand: ${subcommand}`)
}

async function commandStatus(options: CliOptions): Promise<void> {
  const config = loadConfig(configPath(options))
  const client = OpenCodeClient.discover({ server: options.server, password: options.password })
  const info = await client.info()
  const sessions = await client.listSessions()
  const directory = projectDirectory(options)
  const project = projectKey(directory)
  const rootSessions = sessions.filter(
    (session) => !session.parentID && projectKey(session.location.directory) === project,
  )
  const active = await client.activeSessions()

  let index: DeviceIndex | null = null
  try {
    const store = new GitStore({ root: storeRoot(), remote: config.remote, branch: config.branch })
    store.ensure()
    index = store.readDeviceIndex(config.device)
  } catch {
    index = null
  }

  const rows = rootSessions.map((session) => {
    const state = index?.sessions[session.id]
    return {
      id: session.id,
      title: session.title ?? null,
      directory: session.location.directory,
      active: active.has(session.id),
      head: state?.revision ?? null,
      tracked: state !== undefined,
      children: sessions.filter((candidate) => candidate.parentID === session.id).length,
    }
  })

  if (options.json) {
    printJson({
      version: VERSION,
      opencode: { url: client.endpoint.url, version: info.version },
      project,
      directory,
      device: config.device,
      remote: config.remote,
      branch: config.branch,
      config: config.configPath,
      sessions: rows,
    })
    return
  }

  printLines([
    `ocsync ${VERSION}`,
    `OpenCode: ${client.endpoint.url} (${info.version})`,
    `Project: ${project}`,
    `Directory: ${directory}`,
    `Device: ${config.device}`,
    `Remote: ${config.remote} (${config.branch})`,
    `Sessions: ${rows.length} root session(s), ${rows.filter((row) => row.active).length} active`,
    "",
    ...rows.map((row) => {
      const flags = [row.active ? "active" : "idle", row.tracked ? "tracked" : "new"]
      if (row.children > 0) flags.push(`${row.children} child`)
      return `${row.id}  ${row.title ?? "(untitled)"}  [${flags.join(", ")}]`
    }),
  ])
}

function printPush(
  result: { pushed: string[]; tombstoned: string[]; skipped: { id: string; reason: string }[] },
  options: CliOptions,
): void {
  if (options.json) {
    printJson(result)
    return
  }
  const lines = [`Pushed: ${result.pushed.length}`]
  for (const id of result.pushed) lines.push(`  ${id}`)
  if (result.tombstoned.length > 0) {
    lines.push(`Deletions propagated: ${result.tombstoned.length}`)
    for (const id of result.tombstoned) lines.push(`  ${id}`)
  }
  if (result.skipped.length > 0) {
    lines.push("Skipped:")
    for (const item of result.skipped) lines.push(`  ${item.id}: ${item.reason}`)
  }
  printLines(lines)
}

function printPull(
  result: {
    pulled: string[]
    deleted: string[]
    skipped: { id: string; reason: string }[]
    conflicts: { id: string; remoteTip: string | null; state: string }[]
  },
  options: CliOptions,
): void {
  if (options.json) {
    printJson(result)
    return
  }
  const lines = [`Pulled: ${result.pulled.length}`]
  for (const id of result.pulled) lines.push(`  ${id}`)
  if (result.deleted.length > 0) {
    lines.push(`Deleted locally: ${result.deleted.length}`)
    for (const id of result.deleted) lines.push(`  ${id}`)
  }
  if (result.skipped.length > 0) {
    lines.push("Skipped:")
    for (const item of result.skipped) lines.push(`  ${item.id}: ${item.reason}`)
  }
  if (result.conflicts.length > 0) {
    lines.push("Conflicts:")
    for (const conflict of result.conflicts) {
      lines.push(`  ${conflict.id}: remote ${conflict.remoteTip ?? "unknown"} (${conflict.state})`)
    }
    lines.push("", "No session was overwritten. Resolve the conflict manually before syncing again.")
  }
  printLines(lines)
  if (result.conflicts.length > 0) process.exitCode = 2
}

async function commandDoctor(options: CliOptions): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = []

  try {
    const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim()
    checks.push({ name: "git", ok: true, detail: version })
  } catch {
    checks.push({ name: "git", ok: false, detail: "git is not available on PATH" })
  }

  const path = configPath(options)
  let config: LoadedConfig | undefined
  try {
    config = loadConfig(path)
    checks.push({ name: "configuration", ok: true, detail: path })
  } catch (error) {
    checks.push({ name: "configuration", ok: false, detail: errorMessage(error) })
  }

  if (config) {
    try {
      const key = loadKey(config.keyFile)
      checks.push({ name: "encryption key", ok: true, detail: `${config.keyFile} (${keyFingerprint(key)})` })
    } catch (error) {
      checks.push({ name: "encryption key", ok: false, detail: errorMessage(error) })
    }

    try {
      const client = OpenCodeClient.discover({ server: options.server, password: options.password })
      const info = await client.info()
      checks.push({ name: "OpenCode", ok: true, detail: `${client.endpoint.url} (${info.version})` })
    } catch (error) {
      checks.push({ name: "OpenCode", ok: false, detail: errorMessage(error) })
    }

    try {
      const store = new GitStore({ root: storeRoot(), remote: config.remote, branch: config.branch })
      store.ensure()
      checks.push({ name: "git store", ok: true, detail: storeRoot() })
    } catch (error) {
      checks.push({ name: "git store", ok: false, detail: errorMessage(error) })
    }
  }

  if (options.json) {
    printJson(checks)
  } else {
    printLines(checks.map((check) => `${check.ok ? "ok  " : "fail"} ${check.name}: ${check.detail}`))
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1
}

function errorMessage(error: unknown): string {
  if (error instanceof OpenCodeError || error instanceof Error) return error.message
  return String(error)
}

async function main(): Promise<void> {
  const { command, options } = parseCli(process.argv.slice(2))
  const name = command[0] ?? (options.version ? "version" : "help")

  if (options.help || name === "help") {
    process.stdout.write(HELP)
    return
  }
  if (options.version || name === "version") {
    process.stdout.write(`ocsync ${VERSION}\n`)
    return
  }

  if (name === "init") return commandInit(options)
  if (name === "status") return commandStatus(options)
  if (name === "doctor") return commandDoctor(options)
  if (name === "key") return commandKey(command, options)

  if (name === "push" || name === "pull" || name === "sync") {
    const engine = createEngine(options)
    if (name === "push") {
      printPush(await engine.push({ dryRun: options.dryRun }), options)
      return
    }
    if (name === "pull") {
      printPull(await engine.pull({ dryRun: options.dryRun }), options)
      return
    }
    const result = await engine.sync({ dryRun: options.dryRun })
    printPush(result.push, options)
    printPull(result.pull, options)
    return
  }

  if (name === "resolve") {
    const sessionID = command[1]
    if (!sessionID) throw new ConfigError("Usage: ocsync resolve <session-id> --keep local|remote|both")
    if (options.keep !== "local" && options.keep !== "remote" && options.keep !== "both") {
      throw new ConfigError("--keep must be one of: local, remote, both.")
    }
    const engine = createEngine(options)
    const result = await engine.resolve(sessionID, options.keep)
    if (options.json) {
      printJson(result)
    } else {
      const lines = [`Resolved ${result.sessionID}: ${result.mode}`, `Revision: ${result.revision}`]
      if (result.copySessionID) lines.push(`Remote copy: ${result.copySessionID}`)
      if (result.backup) lines.push(`Local backup: ${result.backup}`)
      printLines(lines)
    }
    return
  }

  throw new ConfigError(`Unknown command: ${name}. Run "ocsync help" for usage.`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`)
  process.exitCode = 1
})
