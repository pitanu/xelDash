# Follow-up issues

Deferred from the initial-commit review:

- Select and add a project license before any public release.
- Pin `XELIS_DAEMON_IMAGE` to a tested release tag and define the upgrade process alongside
  the native hash implementation.
- Add daemon and API healthchecks to Compose, then align the deployment plan with the actual
  services and health behavior.
- Add per-IP connection and invalid-share rate limits; per-connection request queues are
  capped and unauthenticated handshakes time out.
- Add vardiff; Stratum currently uses a fixed configured target capped at network difficulty.
- Verify the native share hash and block submission representation against a real miner and
  devnet daemon before relying on persisted share data.
- Make the data model in `docs/PLAN.md` reference the migration instead of duplicating DDL
  with mismatched identity/count types.
- Reconcile remaining planning details: getwork support, TLS, default vardiff parameters,
  retention, dashboard authentication, and block lifecycle status names.

The API route matcher now uses parsed pathnames; the API service README and duplicate root
`PLAN.md` were corrected/removed as part of the consistency pass.
