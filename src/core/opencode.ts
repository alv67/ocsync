import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "./config.js"
import type { SessionInfo, SessionSnapshot } from "./types.js"

export interface ServiceEndpoint {
  url: string
  password?: string
  version?: string
}

export interface OpenCodeOptions {
  /** Explicit server URL. When omitted, the local background service is used. */
  server?: string
  /** Server password. Falls back to OPENCODE_PASSWORD. */
  password?: string
  /** Request timeout in milliseconds. */
  timeoutMs?: number
}

export class OpenCodeError extends Error {
  override readonly name: string = "OpenCodeError"
  readonly status: number
  readonly body: string

  constructor(message: string, status = 0, body = "") {
    super(message)
    this.status = status
    this.body = body
  }
}

export class SessionExistsError extends OpenCodeError {
  override readonly name: string = "SessionExistsError"
  readonly sessionID: string

  constructor(sessionID: string, body = "") {
    super(`Session already exists: ${sessionID}`, 409, body)
    this.sessionID = sessionID
  }
}

export function serviceFilePath(): string {
  return join(stateDir(), "..", "opencode", "service.json")
}

interface ServiceFile {
  url?: unknown
  password?: unknown
  version?: unknown
}

export function readLocalService(): ServiceEndpoint | null {
  const path = serviceFilePath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ServiceFile
    if (typeof parsed.url !== "string" || parsed.url.length === 0) return null
    return {
      url: parsed.url,
      password: typeof parsed.password === "string" ? parsed.password : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    }
  } catch {
    return null
  }
}

export function resolveEndpoint(options: OpenCodeOptions = {}): ServiceEndpoint {
  const local = readLocalService()
  const url = options.server ?? local?.url
  if (!url) {
    throw new OpenCodeError(`OpenCode service not found at ${serviceFilePath()}. Start OpenCode or pass --server.`)
  }

  const password =
    options.password ??
    process.env.OPENCODE_PASSWORD ??
    (local && sameOrigin(local.url, url) ? local.password : undefined)

  return {
    url,
    password,
    version: local && sameOrigin(local.url, url) ? local.version : undefined,
  }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.protocol === b.protocol && a.host === b.host
  } catch {
    return false
  }
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

export class OpenCodeClient {
  readonly endpoint: ServiceEndpoint
  readonly timeoutMs: number

  constructor(endpoint: ServiceEndpoint, options: OpenCodeOptions = {}) {
    this.endpoint = endpoint
    this.timeoutMs = options.timeoutMs ?? 120_000
  }

  static discover(options: OpenCodeOptions = {}): OpenCodeClient {
    return new OpenCodeClient(resolveEndpoint(options), options)
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (this.endpoint.password) {
      const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
      headers.authorization = basicAuth(username, this.endpoint.password)
    }
    return headers
  }

  private url(path: string): URL {
    const base = this.endpoint.url.endsWith("/") ? this.endpoint.url : `${this.endpoint.url}/`
    return new URL(path.replace(/^\//, ""), base)
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: {
        ...this.headers(),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      if (response.status === 409) {
        const sessionID = extractSessionID(body)
        if (sessionID) throw new SessionExistsError(sessionID, body)
      }
      throw new OpenCodeError(
        `OpenCode request failed (${response.status} ${response.statusText}): ${body}`,
        response.status,
        body,
      )
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  async info(): Promise<{ version: string; pid: number; urls: string[] }> {
    return this.request("/api/info")
  }

  async listSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = []
    let cursor: string | undefined

    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ limit: "100", order: "asc" })
      if (cursor) query.set("cursor", cursor)
      const response = await this.request<{
        data: SessionInfo[]
        cursor?: { next?: string | null }
      }>(`/api/session?${query.toString()}`)

      sessions.push(...response.data)
      const next = response.cursor?.next
      if (!next) break
      cursor = next
    }

    return sessions
  }

  async getSession(sessionID: string): Promise<SessionInfo> {
    const response = await this.request<{ data: SessionInfo }>(`/api/session/${encodeURIComponent(sessionID)}`)
    return response.data
  }

  async exportSession(sessionID: string): Promise<SessionSnapshot> {
    const response = await this.request<{ data: SessionSnapshot }>(
      `/api/experimental/session/${encodeURIComponent(sessionID)}/export?sanitize=false`,
    )
    return response.data
  }

  async importSession(snapshot: SessionSnapshot, directory: string): Promise<SessionInfo> {
    const response = await this.request<{ data: SessionInfo }>("/api/experimental/session/import", {
      method: "POST",
      body: JSON.stringify({
        info: snapshot.info,
        messages: snapshot.messages,
        location: { directory },
      }),
    })
    return response.data
  }

  async deleteSession(sessionID: string): Promise<void> {
    try {
      await this.request<void>(`/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) return
      throw error
    }
  }

  async activeSessions(): Promise<Set<string>> {
    const response = await this.request<{ data: Record<string, unknown> }>("/api/session/active")
    return new Set(Object.keys(response.data))
  }
}

function extractSessionID(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { sessionID?: unknown; data?: { sessionID?: unknown } }
    const value = parsed.sessionID ?? parsed.data?.sessionID
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}
