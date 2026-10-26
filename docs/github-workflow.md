# GitHub workflow

`ocsync` uses a protected two-branch model.

## Branches

- **`main`** — releases only. Protected. Changes arrive through a pull request from `develop` or a `release/*` branch. No direct pushes, no force pushes, linear history.
- **`develop`** — integration branch. Features, fixes, documentation, and chores merge here through pull requests.
- **`feat/<scope>-<short-name>`** — new behavior.
- **`fix/<scope>-<short-name>`** — bug fix.
- **`docs/<short-name>`** — documentation only.
- **`chore/<short-name>`** — tooling, CI, dependencies.
- **`release/<version>`** — release stabilization, merged into `main` and back into `develop`.
- **`hotfix/<version>`** — emergency fix from `main`, merged into `main` and back into `develop`.

The repository bootstrap is the only direct commit to `main`. Every subsequent change follows the pull-request flow.

## Commits

Use Conventional Commits in English:

```text
feat(core): add revision ancestry
fix(plugin): debounce duplicate idle events
docs: describe the conflict model
chore(ci): add Windows to the matrix
```

Scopes: `core`, `cli`, `plugin`, `tui`, `crypto`, `docs`, `ci`.

## Pull requests

- Target `develop`, except `release/*` and `hotfix/*`.
- Use squash merge.
- CI must pass on Linux, macOS, and Windows.
- Include tests for behavior changes.
- Update documentation when public behavior changes.
- Do not commit secrets, keys, or session transcripts.
- All text is in English.
- Maintainers may self-merge a green PR; external contributions require a maintainer review.

## Issue triage

External issues do not become work items automatically. They must be evaluated.

1. New external issues receive the `needs-triage` label and enter the **Triage** stage of the project.
2. A maintainer checks reproducibility, scope, duplicates, and security impact.
3. The maintainer assigns `Kind` and `Area`.
4. The issue is either:
   - **accepted**: remove `needs-triage`, add `accepted`, set `Priority`, and move it to **Backlog** or **Ready**; or
   - **rejected**: close it with `duplicate`, `invalid`, or `wontfix`.
5. Only accepted issues are considered work items.

Security reports must not be filed as public issues. See [SECURITY.md](../SECURITY.md).

## Project fields

| Field    | Values                                               |
| -------- | ---------------------------------------------------- |
| Stage    | Triage, Backlog, Ready, In Progress, In Review, Done |
| Kind     | Bug, Feature, Chore, Docs, Spike, Security           |
| Priority | P0, P1, P2, P3                                       |
| Area     | Core, CLI, Plugin, Crypto, Docs, CI                  |
| Size     | XS, S, M, L, XL                                      |

## Labels

- Triage: `needs-triage`, `accepted`
- Type: `type: bug`, `type: feature`, `type: chore`, `type: docs`, `type: spike`, `type: security`
- Priority: `priority: p0` through `priority: p3`
- Area: `area: core`, `area: cli`, `area: plugin`, `area: crypto`, `area: docs`, `area: ci`
- Community: `good first issue`, `help wanted`, `dependencies`
- Resolution: `duplicate`, `invalid`, `wontfix`

## Releases

1. Create `release/<version>` from `develop`.
2. Update `package.json` and `CHANGELOG.md`.
3. Open a PR to `main`.
4. Merge after CI passes.
5. Tag the merge commit (`v<version>`) and create a GitHub Release.
6. Merge `main` back into `develop`.
7. Publish the package from the release commit.

`main` must always be releasable. Fix broken releases with a `hotfix/*` branch; do not force-push `main`.
