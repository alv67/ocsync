import { randomBytes as nodeRandomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import type { SessionSnapshot } from "./types.js"

export class CryptoError extends Error {
  override readonly name = "CryptoError"
}

const KEY_BYTES = 32
const NONCE_BYTES = 24

export function generateKey(): Uint8Array {
  return new Uint8Array(nodeRandomBytes(KEY_BYTES))
}

export function encodeKey(key: Uint8Array): string {
  return Buffer.from(key).toString("base64")
}

export function decodeKey(encoded: string): Uint8Array {
  const key = new Uint8Array(Buffer.from(encoded.trim(), "base64"))
  if (key.byteLength !== KEY_BYTES) {
    throw new CryptoError(`Encryption key must be ${KEY_BYTES} bytes, got ${key.byteLength}.`)
  }
  return key
}

export function loadKey(path: string, env = process.env.OCSYNC_KEY): Uint8Array {
  if (env) return decodeKey(env)
  if (!existsSync(path)) {
    throw new CryptoError(`Encryption key not found at ${path}. Run "ocsync key init" first.`)
  }
  return decodeKey(readFileSync(path, "utf8"))
}

export function saveKey(path: string, key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) throw new CryptoError("Invalid key length.")
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${encodeKey(key)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function encrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.byteLength !== KEY_BYTES) throw new CryptoError("Invalid key length.")
  const nonce = new Uint8Array(nodeRandomBytes(NONCE_BYTES))
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext)
  const output = new Uint8Array(NONCE_BYTES + ciphertext.byteLength)
  output.set(nonce, 0)
  output.set(ciphertext, NONCE_BYTES)
  return output
}

export function decrypt(key: Uint8Array, payload: Uint8Array): Uint8Array {
  if (payload.byteLength <= NONCE_BYTES) throw new CryptoError("Encrypted payload is too short.")
  const nonce = payload.subarray(0, NONCE_BYTES)
  const ciphertext = payload.subarray(NONCE_BYTES)
  return xchacha20poly1305(key, nonce).decrypt(ciphertext)
}

export function encryptSnapshot(key: Uint8Array, snapshot: SessionSnapshot): Uint8Array {
  return encrypt(key, new Uint8Array(gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"))))
}

export function decryptSnapshot(key: Uint8Array, payload: Uint8Array): SessionSnapshot {
  return JSON.parse(gunzipSync(Buffer.from(decrypt(key, payload))).toString("utf8")) as SessionSnapshot
}

export function encryptJson(key: Uint8Array, value: unknown): Uint8Array {
  return encrypt(key, new Uint8Array(gzipSync(Buffer.from(JSON.stringify(value), "utf8"))))
}

export function decryptJson<T>(key: Uint8Array, payload: Uint8Array): T {
  return JSON.parse(gunzipSync(Buffer.from(decrypt(key, payload))).toString("utf8")) as T
}

export function newDeviceID(): string {
  return `dev_${Buffer.from(nodeRandomBytes(16)).toString("hex")}`
}

export function newSessionID(): string {
  return `ses_${Buffer.from(nodeRandomBytes(13)).toString("hex")}`
}

export function keyFingerprint(key: Uint8Array): string {
  return Buffer.from(key.subarray(0, 8)).toString("hex")
}
