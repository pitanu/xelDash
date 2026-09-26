# Contributing

Thanks for helping with xelDash. Bug reports, miner compatibility results and pull requests
are all welcome.

## Before you start

- For a bug, open an issue with the bug template; it asks for the details that are usually
  needed (miner software, daemon version, network, logs).
- For a larger change, open an issue first so the approach can be agreed before you write
  much code. Planned work and decisions are in [docs/PLAN.md](docs/PLAN.md),
  [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/ISSUES.md](docs/ISSUES.md).

## Development setup

You need Docker (with Compose) and Node.js 22.

```sh
cp .env.example .env        # then set POSTGRES_PASSWORD
docker compose up -d --build
npm ci
npm run typecheck
```

The stack runs on a private devnet by default. [docs/DEVNET.md](docs/DEVNET.md) shows how to
mine the first blocks and check that Stratum produces blocks the daemon accepts; run that
check for any change to jobs, hashing, shares or block submission.

The dashboard lives in `web/` and has its own dependencies:

```sh
cd web
npm ci
npm run dev    # proxies /api to the API on 127.0.0.1:8081
```

Service code is JavaScript with JSDoc types checked by TypeScript (`npm run typecheck`).
The hash addon is Rust (`packages/xelis-hash`); it is built inside the Stratum image.

## Pull requests

- Keep each pull request to one change, and update the docs it affects in the same pull
  request (`docs/`, the service READMEs, `.env.example`).
- Add a line to the "Unreleased" section of [CHANGELOG.md](CHANGELOG.md) for anything a
  user would notice. Mark breaking changes **Breaking**.
- Commit messages: a short, plain summary line in the imperative ("Add worker page"), with
  a body only when the reason is not obvious.
- CI must pass: typecheck, dashboard build, Compose validation and image builds.
- Database changes go in a new numbered file in `packages/db/migrations/`. Never edit a
  migration that has been released.

## Releases

Versions follow [Semantic Versioning](https://semver.org/). To release, move the
"Unreleased" changelog entries under the new version, bump the `version` fields in the
`package.json` files, and push a `vX.Y.Z` tag; the release workflow publishes the images.

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
