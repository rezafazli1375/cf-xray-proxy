# Rate Limiting

Connection-based limiting controls abusive churn while preserving normal tunnel traffic.
Applies across Protocols: `VLESS / VMess / Trojan` and Transports: `ws / xhttp / httpupgrade`.

## How it works

- Limiting is connection-based, not packet/message-based.
- It applies to new upgrade attempts only.
- Two limits are enforced per IP:
  - concurrent upgraded connections (`RATE_LIMIT_MAX_CONN_PER_IP`)
  - new upgraded connections per minute (`RATE_LIMIT_MAX_CONN_PER_MIN`)
- Blocked requests return `429 Too Many Requests` with `Retry-After`.

## Why it does not break VPN traffic

- No message count limits.
- No bandwidth throttling.
- Long-lived connections remain allowed.
- Disabled by default (`RATE_LIMIT_ENABLED=false`) for minimal overhead when not needed.

## Example

```toml
[vars]
RATE_LIMIT_ENABLED = "true"
RATE_LIMIT_MAX_CONN_PER_IP = "5"
RATE_LIMIT_MAX_CONN_PER_MIN = "10"
```
