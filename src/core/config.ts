import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser"
import { newDeviceID } from "./crypto.js"
import { expandHome } from "./project.js"

export interface ProjectSettings {
  /** Local directories that belong to this project on this machine. */
  directories?: string[]
}

export interface OcsyncConfig {
  /** Git remote used as the sync transport. */
  remote: string
  /** Branch of the data repository. Defaults to main. */
  branch?: string
  /** Device identifier. Generated on first use when omitted. */
  device?: string
  /** Path to the 32-byte symmetric key. */
  keyFile?: string
  /** Optional project settings keyed by canonical project key. */
  projects?: Record<string, ProjectSettings>
  /** Pull interval used by the server plugin, in seconds. 0 disables it. */
  pullIntervalSec?: number
  /** Debounce for event-driven pushes, in seconds. */
  pushDebounceSec?: number
  /** Sessions larger than this are skipped by push. */
  maxSessionBytes?: number
}

export interface LoadedConfig {
  remote: string
  branch: string
  device: string
  keyFile: string
  projects: Record<string, ProjectSettings>
  pullIntervalSec: number
  pushDebounceSec: number
  maxSessionBytes: number
  configPath: string
}

export class ConfigError extends Error {
  override readonly name = "ConfigError"
}

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "ocsync")
}

export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(base, "ocsync")
}

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
  return join(base, "ocsync")
}

export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "ocsync")
}

export function storeRoot(): string {
  return join(dataDir(), "store")
}

export function defaultConfigPath(): string {
  return process.env.OCSYNC_CONFIG ?? join(configDir(), "config.jsonc")
}

export function defaultKeyPath(): string {
  return join(configDir(), "key")
}

export function devicePath(): string {
  return join(stateDir(), "device")
}

export function loadConfig(path = defaultConfigPath()): LoadedConfig {
  if (!existsSync(path)) {
    throw new ConfigError(`Configuration not found at ${path}. Run "ocsync init" first.`)
  }

  const text = readFileSync(path, "utf8")
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })

  if (errors.length > 0) {
    const detail = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
    throw new ConfigError(`Invalid JSONC in ${path}: ${detail}`)
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`Configuration in ${path} must be a JSON object.`)
  }

  const remote = requireString(parsed, "remote")
  const branch = optionalString(parsed, "branch") ?? "main"
  const keyFileValue = optionalString(parsed, "keyFile") ?? defaultKeyPath()
  const keyFile = isAbsolute(keyFileValue) ? keyFileValue : resolve(dirname(path), expandHome(keyFileValue))
  const device = optionalString(parsed, "device") ?? loadOrCreateDeviceID()
  const projects = optionalProjects(parsed)
  const pullIntervalSec = optionalNumber(parsed, "pullIntervalSec", 120)
  const pushDebounceSec = optionalNumber(parsed, "pushDebounceSec", 30)
  const maxSessionBytes = optionalNumber(parsed, "maxSessionBytes", 20 * 1024 * 1024)

  return {
    remote,
    branch,
    device,
    keyFile: expandHome(keyFile),
    projects,
    pullIntervalSec,
    pushDebounceSec,
    maxSessionBytes,
    configPath: path,
  }
}

export function loadOrCreateDeviceID(): string {
  const path = devicePath()
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim()
    if (value.length > 0) return value
  }
  const device = newDeviceID()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${device}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return device
}

export function writeDefaultConfig(path: string, remote: string, keyFile = defaultKeyPath()): void {
  const config: OcsyncConfig = {
    remote,
    branch: "main",
    keyFile,
    pullIntervalSec: 120,
    pushDebounceSec: 30,
    maxSessionBytes: 20 * 1024 * 1024,
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`Configuration field "${key}" must be a non-empty string.`)
  }
  return value.trim()
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`Configuration field "${key}" must be a non-empty string when present.`)
  }
  return value.trim()
}

function optionalNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`Configuration field "${key}" must be a non-negative number.`)
  }
  return value
}

function optionalProjects(record: Record<string, unknown>): Record<string, ProjectSettings> {
  const value = record.projects
  if (value === undefined) return {}
  if (!isRecord(value)) throw new ConfigError('Configuration field "projects" must be an object.')
  const result: Record<string, ProjectSettings> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) throw new ConfigError(`Configuration field "projects.${key}" must be an object.`)
    const directories = entry.directories
    if (directories === undefined) {
      result[key] = {}
      continue
    }
    if (!Array.isArray(directories) || directories.some((item) => typeof item !== "string")) {
      throw new ConfigError(`Configuration field "projects.${key}.directories" must be an array of strings.`)
    }
    result[key] = { directories: directories.map(expandHome) }
  }
  return result
}
