# Subscription Proxy

Subscription proxy is optional and disabled by default (`SUBSCRIPTION_ENABLED=false`).
For most tunnel deployments, keep it disabled and use core Transports: `ws / xhttp / httpupgrade`.

## When to use it

Enable this feature when you need to serve subscription endpoints through the Worker without exposing subscription backends directly.

## How to enable

```toml
[vars]
SUBSCRIPTION_ENABLED = "true"
SUBSCRIPTION_TARGETS = "alpha|https://sub1.example|443|/sub,beta|https://sub2.example:2096|2096|/sub,node|http://10.0.0.8|4005|/subscribe"
# Optional:
# SUBSCRIPTION_TRANSFORM = "true"
# SUBSCRIPTION_CACHE_TTL_MS = "300000"
```

## Supported target formats

Delimited format:

```text
name|url|port|path,name2|url2|port2|path2
```

JSON format:

```json
[
  { "name": "alpha", "url": "https://sub1.example", "port": 443, "path": "/sub" },
  { "name": "beta", "url": "https://sub2.example:2096", "port": 2096, "path": "/sub" }
]
```

## Routes

- `/sub/:token` -> uses default/fallback target selection.
- `/:service/sub/:token` -> uses named target (falls back to first configured target if name is not found).

## Limits and behavior

- Upstream timeout: 10 seconds.
- Max upstream response size: 10 MB.
- Cache: in-memory, successful (`200`) responses only.
- When `SUBSCRIPTION_ENABLED=false`, subscription routing is bypassed.
