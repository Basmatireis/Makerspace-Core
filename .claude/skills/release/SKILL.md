---
name: release
description: Procedure for cutting a Makerspace Core release or release candidate (vX.Y.Z or vX.Y.Z-rc.N) — readiness checks, CHANGELOG, release pull request, tag, release workflow, and the hand-off to the makerspace-infra deployment. Use when the user asks to release, tag, ship or prepare a version.
---

# Release Makerspace Core

Releases are tag-driven: pushing `vX.Y.Z` or `vX.Y.Z-rc.N` runs `.github/workflows/release.yml`, which validates the commit (or reuses a green CI run on `main` for that exact SHA), builds the four images, and creates the GitHub Release with both Compose bundles. See `docs/ci-cd.md`. Confirm the version and scope with the user before tagging; tags are public and image tags are immutable.

## 1. Readiness

- `git fetch` and work from an up-to-date `main`; nothing unrelated uncommitted.
- CI on the head of `main` is green: `gh run list --workflow ci.yml --branch main --limit 3`.
- List the migrations since the last tag: `git diff --name-only <last-tag>..main -- backend/migrations`. Note them for the release notes and the deploy.
- New or changed endpoints have Playwright mock entries (`frontend/e2e/*-api.ts`); a missing mock fails the end-to-end job.
- Locally, when the change set is large: `make check` and `make test-integration`.

## 2. CHANGELOG

- Turn `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty `[Unreleased]`, and update the compare links at the bottom. A release candidate leaves `[Unreleased]` in place; its notes are taken from it.
- Open a pull request with only this change (`Release X.Y.Z`), let CI pass and merge it. Docs-only changes skip the heavy jobs; the release workflow validates the tagged commit itself.

## 3. Tag

- Tag the merge commit on `main`: `git tag -a vX.Y.Z -m "vX.Y.Z" <sha> && git push origin vX.Y.Z`.
- Watch the release run: `gh run list --workflow release.yml --limit 1`, then `gh run watch <id>`. On failure, fix on a branch through a pull request; moving a published tag needs the user's explicit OK.

## 4. Deploy (makerspace-infra)

- Release candidates go to staging, releases to production, through `~/git/makerspace-infra` (Renovate merge requests or version bumps there). Upgrade Core before the printer connector.
- After the deploy, check `/api/v1/health/ready` and that goose reached the newest migration.

## 5. Record

- Report the release commit, CI and release run IDs, migrations, what was deployed and anything left unverified.
