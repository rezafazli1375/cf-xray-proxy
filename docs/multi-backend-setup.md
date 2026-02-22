# Multi-backend Setup

Use multiple backend instances for weighted balancing and failover.
Protocols: `VLESS / VMess / Trojan`; Transports: `ws / xhttp / httpupgrade`.

## Configure multiple backends

Use `BACKEND_LIST` as comma-separated entries:

- Format: `url` or `url|weight`
- Weight defaults to `1` when omitted
- `BACKEND_URL` remains available for single-backend compatibility

```bash
BACKEND_LIST="http://be1.internal:10000|3,http://be2.internal:10000|1,http://be3.internal:10000"
```

## Load balancing and failover behavior

- Weighted selection is used by default.
- Set `BACKEND_STICKY_SESSION=true` to prefer the first healthy backend in list order.
- Unhealthy backends are skipped while healthy backends are available.
- On backend failure, the Worker retries another backend up to `MAX_RETRIES`.
- Retry waits use exponential backoff with jitter.
- Health checks run every `BACKEND_HEALTH_CHECK_INTERVAL` and recover backends automatically when they respond.
- If all backends are unhealthy, the manager falls back to any available backend to avoid total blackhole behavior.
