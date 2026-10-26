import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decodeKey,
  decrypt,
  decryptJson,
  encodeKey,
  encrypt,
  encryptJson,
  generateKey,
  keyFingerprint,
  loadKey,
  newDeviceID,
  saveKey,
} from "../src/core/crypto.js"

describe("crypto", () => {
  test("encrypts and decrypts bytes", () => {
    const key = generateKey()
    const plaintext = new TextEncoder().encode("hello ocsync")
    const payload = encrypt(key, plaintext)

    expect(new TextDecoder().decode(decrypt(key, payload))).toBe("hello ocsync")
  })

  test("rejects the wrong key", () => {
    const payload = encrypt(generateKey(), new TextEncoder().encode("secret"))

    expect(() => decrypt(generateKey(), payload)).toThrow()
  })

  test("round-trips JSON", () => {
    const key = generateKey()
    const value = { sessionID: "ses_x", messages: [1, 2, 3] }

    expect(decryptJson<typeof value>(key, encryptJson(key, value))).toEqual(value)
  })

  test("stores keys as base64", () => {
    const key = generateKey()

    expect(decodeKey(encodeKey(key))).toEqual(key)
    expect(keyFingerprint(key)).toHaveLength(16)
    expect(newDeviceID()).toStartWith("dev_")
  })

  test("writes and reads a key file", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocsync-key-"))
    try {
      const path = join(directory, "key")
      const key = generateKey()
      saveKey(path, key)

      expect(loadKey(path, "")).toEqual(key)
      expect(readFileSync(path, "utf8").trim()).toBe(encodeKey(key))
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
