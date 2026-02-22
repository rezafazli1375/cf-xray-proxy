# Configuration

Use these runtime variables to control routing, retries, observability, and optional features.
Protocols: `VLESS / VMess / Trojan`; Transports: `ws / xhttp / httpupgrade`.
Subscription proxy is optional and disabled by default (`SUBSCRIPTION_ENABLED=false`).

## Runtime variables and defaults

| Name | Default | Description | Examples |
| --- | --- | --- | --- |
| `BACKEND_URL` | `http://127.0.0.1:10000` | Backward-compatible single backend origin | `http://127.0.0.1:10000` |
| `BACKEND_LIST` | `http://127.0.0.1:10000` | Comma-separated backend list, supports optional weights via `url\|weight` | `http://be1:10000\|2,http://be2:10000\|1` |
| `BACKEND_HEALTH_CHECK_INTERVAL` | `30000` | Backend health-check interval in milliseconds | `10000`, `30000` |
| `BACKEND_STICKY_SESSION` | `false` | When `true`, prefer the first healthy backend in list order; when `false`, use weighted selection | `true`, `false` |
| `MAX_RETRIES` | `3` | Maximum retry attempts for backend failover paths | `1`, `3`, `5` |
| `RATE_LIMIT_ENABLED` | `false` | Enables connection-based per-IP rate limiting | `true`, `false` |
| `RATE_LIMIT_MAX_CONN_PER_IP` | `5` | Maximum concurrent upgraded connections per IP | `3`, `5`, `20` |
| `RATE_LIMIT_MAX_CONN_PER_MIN` | `10` | Maximum new upgraded connections per IP per minute | `10`, `30`, `60` |
| `UUID_MAX_CONNECTIONS` | `0` | Maximum active connections per UUID (`0` disables feature) | `0`, `1`, `2` |
| `SUBSCRIPTION_ENABLED` | `false` | Enables subscription proxy routes | `true`, `false` |
| `SUBSCRIPTION_PRESERVE_DOMAIN` | `false` | Rewrites upstream subscription domains back to configured target domain | `true`, `false` |
| `SUBSCRIPTION_TARGETS` | empty | Subscription backend mapping, JSON array or `name\|url\|port\|path` format | `alpha\|https://sub1.example\|443\|/sub,beta\|https://sub2.example:2096\|2096\|/sub` |
| `SUBSCRIPTION_TRANSFORM` | `false` | Enables response link transformation for subscription proxy responses | `true`, `false` |
| `SUBSCRIPTION_CACHE_TTL_MS` | `300000` | In-memory subscription cache TTL in milliseconds | `60000`, `300000` |
| `TRANSPORT` | `xhttp` | Default transport when no query/header/path selector matches | `xhttp`, `httpupgrade`, `ws` |
| `DEBUG` | `false` | Enables debug logs and `GET /status` endpoint | `true`, `false` |
| `HIDE_BACKEND_URLS` | `true` | Controls backend address visibility in `GET /health`; `true` (or unset) redacts backend URLs/addresses, `false` includes backend URLs in `backends` | `true`, `false` |
| `BACKEND_ORIGIN` (code constant) | `http://127.0.0.1:10000` | Fallback backend origin defined in `src/config.ts` (not an env var) | `http://127.0.0.1:10000` |

## Health visibility (`/health`)

- `HIDE_BACKEND_URLS=true` (or unset): returns redacted, aggregated backend health data.
- `HIDE_BACKEND_URLS=false`: returns backend details, including backend URLs, in `backends`.

## Common setups

### 1) Single backend basic tunneling

```toml
[vars]
BACKEND_URL = "http://127.0.0.1:10000"
TRANSPORT = "xhttp"
HIDE_BACKEND_URLS = "true"
```

### 2) Multi-backend with weights

```toml
[vars]
BACKEND_LIST = "http://be1.internal:10000|3,http://be2.internal:10000|1"
MAX_RETRIES = "3"
BACKEND_STICKY_SESSION = "false"
```

### 3) Debug-mode troubleshooting

```toml
[vars]
DEBUG = "true"
```

`GET /status` is available only when `DEBUG=true`.

## Local `wrangler dev`

Use one command invocation:

```bash
BACKEND_LIST="http://127.0.0.1:10000|2,http://127.0.0.1:10001|1" \
BACKEND_HEALTH_CHECK_INTERVAL="30000" \
BACKEND_STICKY_SESSION="false" \
MAX_RETRIES="3" \
RATE_LIMIT_ENABLED="true" \
RATE_LIMIT_MAX_CONN_PER_IP="5" \
RATE_LIMIT_MAX_CONN_PER_MIN="10" \
UUID_MAX_CONNECTIONS="2" \
SUBSCRIPTION_ENABLED="false" \
SUBSCRIPTION_PRESERVE_DOMAIN="false" \
TRANSPORT="xhttp" \
DEBUG="true" \
HIDE_BACKEND_URLS="true" \
wrangler dev
```

Or keep defaults in `wrangler.toml` under `[vars]` and run:

```bash
wrangler dev
```

## Deploy variables (`wrangler.toml`)

```toml
[vars]
BACKEND_LIST = "http://127.0.0.1:10000|2,http://127.0.0.1:10001|1"
BACKEND_HEALTH_CHECK_INTERVAL = "30000"
BACKEND_STICKY_SESSION = "false"
MAX_RETRIES = "3"
RATE_LIMIT_ENABLED = "true"
RATE_LIMIT_MAX_CONN_PER_IP = "5"
RATE_LIMIT_MAX_CONN_PER_MIN = "10"
UUID_MAX_CONNECTIONS = "2"
SUBSCRIPTION_ENABLED = "false"
SUBSCRIPTION_PRESERVE_DOMAIN = "false"
TRANSPORT = "xhttp"
DEBUG = "false"
HIDE_BACKEND_URLS = "true"
# BACKEND_URL remains supported for single-backend compatibility
# SUBSCRIPTION_TARGETS = "alpha|https://sub1.example|443|/sub,beta|https://sub2.example:2096|2096|/sub"
```

## Cloudflare Dashboard variables

Add the same variables in **Workers & Pages -> Settings -> Variables and Secrets**:

- `BACKEND_URL`
- `BACKEND_LIST`
- `BACKEND_HEALTH_CHECK_INTERVAL`
- `BACKEND_STICKY_SESSION`
- `MAX_RETRIES`
- `RATE_LIMIT_ENABLED`
- `RATE_LIMIT_MAX_CONN_PER_IP`
- `RATE_LIMIT_MAX_CONN_PER_MIN`
- `UUID_MAX_CONNECTIONS`
- `SUBSCRIPTION_ENABLED`
- `SUBSCRIPTION_PRESERVE_DOMAIN`
- `SUBSCRIPTION_TARGETS`
- `TRANSPORT`
- `DEBUG`
- `HIDE_BACKEND_URLS`
