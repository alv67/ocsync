# Contributing to ocsync

Thanks for taking the time to contribute. This project is small, so focused issues and pull requests are more useful than large speculative changes.

## Language

All code, comments, documentation, commit messages, issues, and pull requests are written in English.

## Before you start

- For a bug, open an issue with the bug report template.
- For a feature, open a feature request before writing a large patch.
- For a security issue, **do not** open a public issue. See [SECURITY.md](SECURITY.md).
- For a typo or documentation fix, a pull request is enough.

## Development setup

Requirements:

- Bun 1.4 or newer
- Git
- OpenCode V2 for integration testing (optional for unit tests)

```bash
bun install
bun run check
bun run build
```

`bun run check` runs Biome, TypeScript, and the test suite.

## Branches and commits

- Branch from `develop`.
- Use `feat/`, `fix/`, `docs/`, or `chore/` prefixes.
- Use Conventional Commits, for example `feat(core): add revision ancestry`.
- Keep one logical change per pull request.
- Do not commit generated files, local keys, or session transcripts.

See [docs/github-workflow.md](docs/github-workflow.md) for the full branch and release model.

## Pull requests

A pull request should include:

- a summary of the change;
- a linked issue (`Closes #123`);
- tests for behavior changes;
- documentation updates when user-facing behavior changes;
- a note about risks or migration concerns, if any.

Pull requests target `develop`. `main` is release-only.

## Tests

- Unit tests use `bun:test`.
- Engine tests use a fake OpenCode adapter and a temporary bare Git repository.
- Integration tests against a real OpenCode server are welcome, but must not touch a developer's real sessions or database.
- Run `bun test` before opening a pull request.
- Run `bash scripts/e2e.sh` for a real two-server smoke test. It requires `opencode`, `git`, `jq`, and `bun`, and uses isolated databases and temporary directories.
- With OpenCode V2 on `PATH`, `bash scripts/e2e.sh` exercises two isolated servers and the real HTTP API.

## Code style

Biome handles formatting and linting.

```bash
bun run format
bun run lint
```

Do not disable lint rules without a comment explaining why.

## Review

Maintainers review for correctness, data safety, and test coverage. Changes that affect delete/import behavior, key handling, or Git pushes receive extra scrutiny because they can lose session history.

## License

By contributing, you agree that your contribution is licensed under the MIT License.
