# Releasing

How to ship new versions of the digital-me-os packages.

The repo is a polyglot monorepo. Today it produces:

- **TypeScript packages** under `packages/{cli,plugins,runtimes,transport,shared}/` — pnpm workspaces, npm distribution (not yet published).
- **One Python package**: `packages/services/dream-cycle/` → published to PyPI as `digital-me-dream-cycle`.

This doc covers the Python publish flow. The TS publish flow is TODO.

## Rollback — dashboard DB cutover

The dashboard schema cutover is destructive (it `DROP`s the legacy tables in
favour of the 4-metric schema). Two backups make it reversible:

1. **The legacy store is copied, not moved.** On first boot/install past the
   cutover, `~/.local/share/digital-me/dashboard/data/system_monitor.db` is
   *copied* to the canonical `~/digital-me/.data/dashboard.db` and left in
   place. To roll back, stop the dashboard and restore it:

   ```bash
   # stop the dashboard first, then:
   cp ~/.local/share/digital-me/dashboard/data/system_monitor.db \
      ~/digital-me/.data/dashboard.db
   ```

2. **A pre-cutover snapshot is taken before any DROP.** When `migrate.ts` runs
   against a DB that still carries legacy tables, it writes a consistent
   `~/digital-me/.data/dashboard.db.pre-cutover.bak` (via `VACUUM INTO`) before
   dropping anything. Restore with:

   ```bash
   cp ~/digital-me/.data/dashboard.db.pre-cutover.bak \
      ~/digital-me/.data/dashboard.db
   ```

If you set `$DASHBOARD_DB` explicitly, substitute that path. The dashboard
re-derives every metric from primary sources on the next intake tick, so a
fresh (empty) DB is also a safe state — it backfills on the next cron run.

## Versioning policy

While the monorepo is pre-1.0:

- Every package keeps its version in lockstep with `digital-me-os` itself (e.g. `0.1.x` across the board).
- Bump versions in the same commit that lands a release-worthy change.
- After 1.0, packages may diverge — until then, the simpler rule wins.

## Python package: `digital-me-dream-cycle`

Location: [`packages/services/dream-cycle/`](../packages/services/dream-cycle/).
Build backend: `hatchling`. Build dep: `build` (PEP 517 frontend).

### One-time setup (Trusted Publishing — no token)

The tag-driven workflow (`.github/workflows/publish-dream-cycle.yml`) publishes
via PyPI **Trusted Publishing** (OIDC) — no API token/secret to manage.

1. Reserve the project name on PyPI (`digital-me-dream-cycle`).
2. On PyPI → the project → **Publishing** → add a **trusted publisher**:
   - Owner/repo: `Amyssjj/digital-me`
   - Workflow filename: `publish-dream-cycle.yml`
   - Environment: `pypi`
3. (First publish only, before the project exists: use PyPI's "pending publisher"
   form with the same values, or do one manual token upload to create it.)

That's it — no `~/.pypirc`, no `TWINE_PASSWORD`. Manual `twine` upload (below)
remains available as a fallback.

### Cut a release (automated — preferred)

Once the trusted publisher is configured, releasing is just a version bump + a tag:

```bash
$EDITOR packages/services/dream-cycle/pyproject.toml   # version = "X.Y.Z"
git commit -am "release: dream-cycle vX.Y.Z" && git push   # land on main first
git tag dream-cycle-vX.Y.Z && git push origin dream-cycle-vX.Y.Z
```

`publish-dream-cycle.yml` then builds sdist+wheel, **verifies the tag matches
`pyproject.toml`'s version**, and publishes to PyPI via OIDC. (You can also run
it from the Actions tab via `workflow_dispatch`.)

### Cut a release (manual fallback)

All steps assume a venv — Homebrew Python (and most modern Linux
distros) reject system-wide pip per PEP 668.

```bash
# 0. One-time release-tooling venv
python3 -m venv ~/.venvs/dream-cycle-release
~/.venvs/dream-cycle-release/bin/pip install build twine

cd packages/services/dream-cycle

# 1. Bump the version
$EDITOR pyproject.toml           # update `version = "X.Y.Z"`

# 2. Build sdist + wheel (clean dist/ first if you've built locally before)
rm -rf dist/
~/.venvs/dream-cycle-release/bin/python -m build

# 3. Verify the artifact in a fresh throwaway venv
python3 -m venv /tmp/dc-release-check
/tmp/dc-release-check/bin/pip install "dist/digital_me_dream_cycle-X.Y.Z-py3-none-any.whl"
/tmp/dc-release-check/bin/digital-me-dream-cycle --help
/tmp/dc-release-check/bin/python -c "import dream_cycle.run"

# 4. Upload (token in ~/.pypirc or $TWINE_PASSWORD)
~/.venvs/dream-cycle-release/bin/python -m twine upload dist/*

# 5. Tag the commit (after the pyproject bump has landed on main)
git tag dream-cycle-vX.Y.Z
git push origin dream-cycle-vX.Y.Z
```

### Smoke-check the published package

After upload, in a clean venv anywhere:

```bash
python3 -m venv /tmp/dc-pypi-smoke
/tmp/dc-pypi-smoke/bin/pip install digital-me-dream-cycle==X.Y.Z
/tmp/dc-pypi-smoke/bin/digital-me-dream-cycle --help
```

### CI does the build automatically

`.github/workflows/ci.yml`'s `dream-cycle-python` job runs `python -m build` on every PR and uploads the resulting `dist/` as the `dream-cycle-dist` artifact. You can pull the artifact from a green CI run rather than rebuilding locally — same wheel, same SHA. (Upload to PyPI is still manual; CI does not hold the API token.)

### What's NOT automated yet

- Changelog generation. Add release notes by hand under `CHANGELOG.md` (repo root).

## TypeScript CLI — published as `digital-me` (npm)

The workspace package is named `@digital-me/cli`, but it ships to npm under the
**unscoped `digital-me`** name (`scripts/build-cli-bundle.mjs` rewrites the
manifest name in `packages/cli/npm-dist/`). The CLI depends on sibling
`workspace:*` packages that are **not** published individually; the bundler
esbuild-inlines every workspace dep (only `esbuild` stays external — it ships a
platform binary and is used at runtime) and emits a trimmed, registry-ready
package under `packages/cli/npm-dist/`. So `npm i -g digital-me` works with no
monorepo checkout.

### One-time setup

1. Reserve/own the unscoped **`digital-me`** name on npm.
2. Create an npm **automation token** (or granular token with Bypass-2FA) with
   publish rights to `digital-me`, and add it as the repo secret **`NPM_TOKEN`**
   (Settings → Secrets → Actions).

### Cut a release (automated — preferred)

```bash
$EDITOR packages/cli/package.json     # version = "X.Y.Z"
git commit -am "release: cli vX.Y.Z" && git push   # land on main first
git tag cli-vX.Y.Z && git push origin cli-vX.Y.Z
```

`.github/workflows/publish-cli.yml` builds the workspace, runs
`pnpm build:cli-bundle`, **verifies the tag matches the bundle's version**, and
`npm publish --provenance` from `npm-dist/`.

### Local dry-run / smoke

```bash
pnpm build && pnpm build:cli-bundle
cd packages/cli/npm-dist && npm pack          # → digital-me-X.Y.Z.tgz
# install the tarball into a throwaway project and run it:
d=$(mktemp -d); (cd "$d" && npm init -y >/dev/null && npm i "$OLDPWD"/digital-me-*.tgz \
  && ./node_modules/.bin/digital-me help)
```
