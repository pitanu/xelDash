# Stratum TLS certificate

Put `cert.pem` (certificate chain) and `key.pem` (private key) here, then set
`STRATUM_TLS_ENABLED=true` in `.env` and restart Stratum. Miners connect with
`stratum+ssl://<host>:3334` (or `XELDASH_STRATUM_TLS_PORT`). The directory is mounted
read-only; `*.pem` files are ignored by git.

For a LAN, a self-signed certificate works if your miners can skip verification or trust it:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
  -subj "/CN=xeldash" -addext "subjectAltName=DNS:xeldash,IP:192.168.1.10" \
  -keyout key.pem -out cert.pem
```

Replace the IP with the address miners use. Restart Stratum after replacing the files.
