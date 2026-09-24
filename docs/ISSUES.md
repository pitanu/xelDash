# Follow-up issues

Deferred from the initial-commit review:

- Select and add a project license before any public release.
- Pin `XELIS_DAEMON_IMAGE` to a tested release tag and define the upgrade process alongside
  the native hash implementation.
- Add daemon and API healthchecks to Compose, then align the deployment plan with the actual
  services and health behavior.
- Parse API request URLs before matching routes so query strings do not turn valid paths
  into 404 responses.
- Bound per-connection request queues and add a Stratum handshake timeout, connection
  limits, and rate limits.
- Implement and pass `XELIS_DEFAULT_ADDRESS` as the authorization fallback for miners that
  do not provide an address.
- Make the data model in `docs/PLAN.md` reference the migration instead of duplicating DDL
  with mismatched identity/count types.
- Reconcile remaining planning details: getwork support, TLS, default vardiff parameters,
  retention, dashboard authentication, and block lifecycle status names.

The API service README and duplicate root `PLAN.md` were corrected/removed as part of the
initial consistency pass.
