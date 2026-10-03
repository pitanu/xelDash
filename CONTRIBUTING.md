# Contributing

Thanks for helping with xelDash. Bug reports, miner compatibility results and pull requests
are all welcome.

## Before you start

- For a bug, open an issue with the bug template; it asks for the details that are usually
  needed (miner software, daemon version, network, logs).
- For a larger change, open an issue first so the approach can be agreed before you write
  much code. How it is built is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

## Tests

```sh
npm test
```

Node's built-in test runner, no extra packages. Tests live next to what they test (`services/*/test`, `packages/*/test`,
`web/test`) and in `test/` for the launcher, the documentation and the Compose files. Without anything else running, the
database tests are skipped; to run them, start a throwaway PostgreSQL and point `TEST_DATABASE_URL` at it (the tests add rows
with random addresses and do not clean up, so never use a database you care about):

```sh
docker run -d --name xeldash-test-db -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
```

`npm run e2e` is the end-to-end check: it starts the real stack in Docker on a private devnet (its own project and ports, so a stack
that is already running is left alone), mines real blocks through Stratum and through the official miner's getwork, stops the
database and Stratum in the middle, and runs a front door (HAProxy) through a failover and back. It needs Docker, takes about five
minutes once the images are built, and also runs weekly and on demand in GitHub Actions. It is not part of `npm test`.

The launcher tests need `bash`, the Compose tests need Docker Compose; each is skipped when missing. A test that fixes a bug
should fail without the fix. They check logic and the pieces that are easy to get wrong; what only real hardware can show (two
computers, a Raspberry Pi, a real miner) is in [docs/PRE-RELEASE-TESTING.md](docs/PRE-RELEASE-TESTING.md).

Service code is JavaScript with JSDoc types checked by TypeScript (`npm run typecheck`).
The hash addon is Rust (`packages/xelis-hash`); it is built inside the Stratum image.

## Pull requests

- Keep each pull request to one change, and update the docs it affects in the same pull
  request (`docs/`, the service READMEs, `.env.example`).
- Add a line to the "Unreleased" section of [CHANGELOG.md](CHANGELOG.md) for anything a
  user would notice. Mark breaking changes **Breaking**.
- Commit messages: a short, plain summary line in the imperative ("Add worker page"), with
  a body only when the reason is not obvious.
- CI must pass: typecheck, dashboard build, tests, Compose validation and image builds. Add a test with a fix or a new behaviour.
- Database changes go in a new numbered file in `packages/db/migrations/`. Never edit a
  migration that has been released.

## Releases

Versions follow [Semantic Versioning](https://semver.org/). To release, move the
"Unreleased" changelog entries under the new version, bump the `version` fields in the
`package.json` files, and push a `vX.Y.Z` tag; the release workflow publishes the images.

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
