# Key management and recovery

`ocsync` encrypts every session blob with a single 256-bit symmetric key. The key is not stored in the data repository. Losing it means losing the ability to decrypt the synced transcripts.

This document describes the supported operational practices and the limits of the current release.

## Key model

- Algorithm: XChaCha20-Poly1305.
- Key size: 32 bytes.
- Storage: `~/.config/ocsync/key` by default, mode `0600`.
- Alternative: `OCSYNC_KEY` environment variable, base64-encoded.
- Each blob uses a random 24-byte nonce; the key is never reused as a nonce.
- The same key must be present on every device that syncs the same data repository.

## Check the key on a machine

```bash
ocsync key show
```

The output includes the key path and a short fingerprint. Compare the fingerprint on every machine:

```text
Key: /home/me/.config/ocsync/key
Fingerprint: 7f3a...
```

A different fingerprint means the machines cannot read each other's new blobs.

## Back up the key

Export the key to a secure offline location:

```bash
ocsync key export > ocsync-key.b64
chmod 600 ocsync-key.b64
```

The output is the raw secret. Do not commit it, paste it into an issue, or store it in the same repository as the encrypted sessions. A password manager or an offline encrypted volume is appropriate.

On a new machine:

```bash
ocsync key import ocsync-key.b64
ocsync key show
```

Then configure the same `remote` and create the machine's own device ID by running `ocsync init` or editing the configuration.

## Recover from a lost key

If every copy of the key is lost, the encrypted blobs cannot be recovered. There is no backdoor and no server-side key escrow.

Recovery is possible only from local OpenCode sessions that still exist on a machine:

1. Install `ocsync` on a machine that still has the sessions locally.
2. Create a new key and a new data repository (or clear the old one).
3. Configure the new key and remote.
4. Run `ocsync push` to publish fresh blobs under the new key.
5. Update the other machines with the new key and repository.

If no machine has the local sessions, the synced history is unrecoverable. This is why the key backup step is mandatory.

## Rotate the key

The current release does not re-encrypt existing blobs in place. Rotation therefore means moving to a new key and a new data repository (or a new branch):

1. Choose a maintenance window and stop automatic sync (remove the plugin or set `pullIntervalSec` to `0`).
2. On one machine, create a new key:

   ```bash
   ocsync key init --force
   ocsync key show
   ```

   Back up the new key immediately.
3. Point the configuration at a new private repository, or archive the old one and initialize a fresh one.
4. Push every local session:

   ```bash
   ocsync push
   ```
5. On every other machine, import the new key and update the remote configuration.
6. Run `ocsync pull` on each machine and verify `ocsync status`.
7. Keep the old key and repository until every machine has migrated; then archive or destroy them according to your retention policy.

A dedicated `ocsync key rotate` command that decrypts and re-encrypts a repository is future work.

## Device identity is not a secret

The device ID (`dev_...`) identifies an index file in the data repository. It is not used as encryption key material. If a device ID is lost or changed, the old index remains in Git history but is no longer updated; the new index becomes authoritative.

## What is not encrypted

- The Git commit history and file names.
- Revision metadata: session IDs, project keys, timestamps, message counts, and last message IDs.
- The device index.
- The configuration file.

Session IDs, titles, and projects can therefore be inferred from the repository. The transcript content, tool output, and attachments are encrypted. Keep the data repository private.

## Incident checklist

If a key is exposed:

1. Treat every blob in the repository as compromised.
2. Rotate the key and move to a new repository as described above.
3. Revoke the exposed storage credentials and Git access.
4. Review OpenCode logs and provider keys that may appear in tool output.
5. Do not delete the old repository before deciding whether an investigation needs it.

If a device is lost:

1. Revoke its GitHub access and any stored Git credentials.
2. Rotate the data-repository access token.
3. If the encryption key was stored on the device without full-disk encryption, rotate the key as well.
4. Remove or archive the lost device's `devices/<id>.json` after confirming no other machine depends on it.
