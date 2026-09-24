# Follow-up issues

Deferred from the initial-commit review:

- Select and add a project license before any public release.
- Pin `XELIS_DAEMON_IMAGE` to a tested release tag and define the upgrade process alongside
  the native hash implementation.
- Add daemon and API healthchecks to Compose, then align the deployment plan with the actual
  services and health behavior.
- Add Stratum connection and rate limits; per-connection request queues are now capped and
  unauthenticated handshakes time out.
- Pass `XELIS_DEFAULT_ADDRESS` and the Stratum limits into a future Compose Stratum service;
  session-level address fallback is implemented.
- Make the data model in `docs/PLAN.md` reference the migration instead of duplicating DDL
  with mismatched identity/count types.
- Reconcile remaining planning details: getwork support, TLS, default vardiff parameters,
  retention, dashboard authentication, and block lifecycle status names.

The API route matcher now uses parsed pathnames; the API service README and duplicate root
`PLAN.md` were corrected/removed as part of the consistency pass.
