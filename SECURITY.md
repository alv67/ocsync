# Security policy

## Supported versions

`ocsync` is pre-alpha. There are no supported release branches yet. Security fixes are applied to `main` and released as soon as possible.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting:

**https://github.com/alv67/ocsync/security/advisories/new**

Include:

- the affected version or commit;
- the impact;
- reproduction steps or a proof of concept;
- whether the issue requires a malicious Git remote, local access, or a compromised OpenCode server;
- a suggested fix, if you have one.

Do not include real session transcripts, API keys, or encryption keys. Use synthetic data.

## Scope

Security-sensitive areas include:

- encryption and key handling;
- path traversal in the Git store;
- command injection through the plugin subprocess;
- Git remote authentication and credential exposure;
- plaintext leakage of session content;
- delete/import behavior that could destroy local sessions;
- plugin code execution inside the OpenCode server.

## Threat model

`ocsync` assumes:

- the local machine and the OpenCode server are trusted;
- the data repository is private but is not trusted with plaintext;
- the encryption key is stored separately from the data repository;
- a malicious repository or remote should not achieve code execution or plaintext disclosure.

## Disclosure

We will acknowledge a report as soon as possible, investigate it, and coordinate a disclosure date. Please allow reasonable time for a fix before publishing details.
