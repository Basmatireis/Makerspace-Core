# CI, releases, and container images

## CI

GitHub Actions runs `.github/workflows/ci.yml` for pull requests targeting `main` and pushes to `main`. It verifies committed generated code, Go formatting/vet/tests/build, frontend lint/type checking/tests/build, real-PostgreSQL integration tests, the isolated full-stack Playwright suite, both production Docker images, and the production release bundle. The bundle smoke check starts an extracted deployment with `docker compose up -d`, verifies automatic migration and failure gating, reaches the frontend and proxied readiness endpoint, recreates the backend to verify dynamic nginx resolution, and confirms that only the frontend publishes a port.

CI also runs `make test-migrations` in its own disposable database to exercise goose Up/Down/Up. The production smoke check verifies non-root private-storage writes and that upload envelopes larger than nginx's default reach API authentication. H2D/X1C protocol, reducer, FTPS, archive, and fixture tests use synthetic inputs; private real-fixture replay and read-only printer hardware checks are release evidence recorded separately and must never be inferred from CI. CI uses read-only repository permission. Docker builds use the GitHub Actions BuildKit cache and set `push: false`; a pull request or ordinary commit cannot publish a container image.

## Creating a release

Release only a commit that belongs on `main`:

```sh
git checkout main
git pull
git tag v0.4.0
git push origin v0.4.0
```

The tag starts `.github/workflows/release.yml`. It accepts only stable `vMAJOR.MINOR.PATCH` tags, makes sure the commit was validated by CI (reusing a green run or running the complete CI workflow, see [Release validation](#release-validation)), confirms that neither immutable `0.4.0` image tag already exists, publishes the images with `GITHUB_TOKEN`, verifies that they are anonymously pullable, and creates the `v0.4.0` GitHub Release with that version's notes from `CHANGELOG.md` plus version-pinned Core and printer-connector Compose bundles. Image digests are shown in the publish-job summaries and in GHCR. A failed validation publishes nothing.

Semantic versioning uses:

- **PATCH** for backwards-compatible bug fixes;
- **MINOR** for backwards-compatible functionality;
- **MAJOR** for breaking changes.

Versions in the `0.x.y` range are appropriate while Makerspace Core is in active early development.

## Build speed

Image builds do not run tests: CI validates the commit (and a release only publishes a validated commit, see below), so the Dockerfiles only compile.

- **Cross-compilation instead of emulation.** The Go stages (`backend`, `printer-connector`, `streaming-gateway`) use `FROM --platform=$BUILDPLATFORM` and `GOOS=$TARGETOS GOARCH=$TARGETARCH go build`, so a `linux/amd64,linux/arm64` build compiles natively on the runner. goose, which the backend image ships for migrations, is cross-compiled the same way; `oapi-codegen` and `sqlc` exist only in the `development` stage. The frontend installs dependencies and runs Vite once on the build platform (the output is architecture independent); its `nginx` final stage only copies files. QEMU is registered in the release only for the images whose Alpine final stage runs `apk add`/`adduser` (everything except the frontend).
- **BuildKit cache mounts** hold the Go build cache and the pnpm store for local rebuilds. `go mod download` and `pnpm install` stay separate layers keyed by `go.mod`/`go.sum` and the lockfile, which is what the GitHub Actions layer cache (`type=gha`, one scope per component) reuses. Release builds read the scopes written by CI on `main`.
- **Compose-based CI jobs** (generated code, backend integration, end-to-end, production bundle) build their images through `docker compose`/`docker build`. Those jobs first run `docker/build-push-action` for the same Dockerfile target with the same `type=gha` scope; because `setup-buildx-action` makes that builder the default for Compose too, the later build is a cache hit instead of compiling `sqlc`/`oapi-codegen`/goose again. A cache miss only makes the job slower, never different.
- **End-to-end shards.** The Playwright suite is `fullyParallel`, so three shard jobs each start their own isolated stack and run a third of the specs (`PLAYWRIGHT_SHARD`, read by `scripts/test-e2e.sh`). The `End-to-end` check that the ruleset requires is an aggregate job that fails unless all shards pass.
- **Desktop terminal (macOS).** Rust build artifacts are cached. A pull request skips this job when no changed file is under `desktop-terminal/`, `backend/`, `api/` or is `ci.yml`; a skipped job satisfies a required check, pushes to `main` and releases always run it, and a failure to list the changed files runs it.
- Jobs in `ci.yml` have no `needs:` between them. If a job such as `Backend integration` starts late, that is runner queueing, not workflow ordering.

## Release validation

A release must publish a validated commit. The `Existing CI result` job asks the Actions API for a successful `push` run of `ci.yml` on `main` whose `head_sha` is the tagged commit. If there is one, the `Validate` job is skipped and publishing proceeds; in every other case (CI still running or failed, cancelled, a documentation-only commit that CI ignores, a tag on a commit that was never on `main`, any API error) `Validate` runs the complete `ci.yml` as before. Publishing requires `Validate` to have succeeded or to have been skipped *because* that proof exists, so a failed or cancelled validation can never be bypassed. Tagging right after merging therefore still works, only without the shortcut until CI is green; wait for CI on `main` to get the fast release. The arm64 images are compiled from the same sources but, as before, not executed by CI.

## Published images and tags

Images use the repository owner and name dynamically. For this repository, release `v0.4.0` publishes:

```text
ghcr.io/basmatireis/makerspace-core-backend:0.4.0
ghcr.io/basmatireis/makerspace-core-backend:0.4
ghcr.io/basmatireis/makerspace-core-backend:latest

ghcr.io/basmatireis/makerspace-core-frontend:0.4.0
ghcr.io/basmatireis/makerspace-core-frontend:0.4
ghcr.io/basmatireis/makerspace-core-frontend:latest
```

The full version tag, such as `0.4.0`, is immutable and the release workflow refuses to overwrite it. The minor tag, such as `0.4`, moves to the newest release in that minor line. For versions `1.0.0` and later, the major tag (for example `1`) also moves to the newest release in that major line. A broad `0` tag is deliberately not created. `latest` moves only when an explicit stable version tag is released; ordinary `main` commits do not update it. There is no `edge` image.

Each release attaches four bundles: `makerspace-core-VERSION-compose.tar.gz`, `makerspace-printer-connector-VERSION-compose.tar.gz`, `makerspace-streaming-VERSION-compose.tar.gz` and `makerspace-local-services-VERSION-compose.tar.gz` (see [Hosting](hosting.md)); the release also publishes the `-printer-connector` and `-streaming-gateway` images next to backend and frontend. The Core bundle contains only a `compose.yaml` with the exact immutable application version and a secret-free `.env.example`. Production hosts extract that bundle and do not need a repository checkout. Both GHCR packages must be public before releasing; the unauthenticated image check deliberately blocks the GitHub Release otherwise.

Roll back by selecting an older full version tag, such as `0.3.2`, rather than rebuilding or replacing a published version. Application rollback still requires the older binary to be compatible with the deployed database schema; review [Failure and rollback](operations.md#failure-and-rollback).

## GitHub repository configuration

After the first CI run, create a branch ruleset for `main` that requires pull requests and these exact successful checks:

- `Generated code`
- `Backend`
- `Backend integration`
- `Frontend`
- `End-to-end` (aggregates the three `End-to-end shard N/3` jobs; do not require the shard jobs themselves)
- `Container (backend)`
- `Container (frontend)`
- `Production Compose` (Core, printer connector, streaming gateway and local services bundles)

Also block force pushes and branch deletion. No special administrator-approval policy is required by this project.

GitHub may create GHCR packages as private initially. Set both backend and frontend package visibility to public before the first release. No additional registry secret is required: the publish job alone receives `packages: write`, and the GitHub Release job alone receives `contents: write`.
