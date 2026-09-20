# CI, releases, and container images

## CI

GitHub Actions runs `.github/workflows/ci.yml` for pull requests targeting `main` and pushes to `main`. It verifies committed generated code, Go formatting/vet/tests/build, frontend lint/type checking/tests/build, real-PostgreSQL integration tests, the isolated full-stack Playwright suite, both production Docker images, and the production release bundle. The bundle smoke check starts an extracted deployment with `docker compose up -d`, verifies automatic migration and failure gating, reaches the frontend and proxied readiness endpoint, recreates the backend to verify dynamic nginx resolution, and confirms that only the frontend publishes a port.

CI also runs `make test-migrations` in its own disposable database to exercise goose Up/Down/Up. The production smoke check verifies non-root private-storage writes and that upload envelopes larger than nginx's default reach API authentication. CI uses read-only repository permission. Docker builds use the GitHub Actions BuildKit cache and set `push: false`; a pull request or ordinary commit cannot publish a container image.

## Creating a release

Release only a commit that belongs on `main`:

```sh
git checkout main
git pull
git tag v0.4.0
git push origin v0.4.0
```

The tag starts `.github/workflows/release.yml`. It accepts only stable `vMAJOR.MINOR.PATCH` tags, reruns the complete CI workflow, confirms that neither immutable `0.4.0` image tag already exists, publishes both images with `GITHUB_TOKEN`, verifies that both are anonymously pullable, and creates the `v0.4.0` GitHub Release with generated notes and a version-pinned production Compose bundle. Image digests are shown in the publish-job summaries and in GHCR. A failed validation publishes nothing.

Semantic versioning uses:

- **PATCH** for backwards-compatible bug fixes;
- **MINOR** for backwards-compatible functionality;
- **MAJOR** for breaking changes.

Versions in the `0.x.y` range are appropriate while Makerspace Core is in active early development.

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

Each release attaches `makerspace-core-VERSION-compose.tar.gz`. It contains only a `compose.yaml` with the exact immutable application version and a secret-free `.env.example`. Production hosts extract that bundle and do not need a repository checkout. Both GHCR packages must be public before releasing; the unauthenticated image check deliberately blocks the GitHub Release otherwise.

Roll back by selecting an older full version tag, such as `0.3.2`, rather than rebuilding or replacing a published version. Application rollback still requires the older binary to be compatible with the deployed database schema; review [Failure and rollback](operations.md#failure-and-rollback).

## GitHub repository configuration

After the first CI run, create a branch ruleset for `main` that requires pull requests and these exact successful checks:

- `Generated code`
- `Backend`
- `Backend integration`
- `Frontend`
- `End-to-end`
- `Container (backend)`
- `Container (frontend)`
- `Production Compose`

Also block force pushes and branch deletion. No special administrator-approval policy is required by this project.

GitHub may create GHCR packages as private initially. Set both backend and frontend package visibility to public before the first release. No additional registry secret is required: the publish job alone receives `packages: write`, and the GitHub Release job alone receives `contents: write`.
