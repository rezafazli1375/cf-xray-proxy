# Documentation

This documentation set covers deployment and operations for `cf-xray-proxy`.
Protocols: `VLESS / VMess / Trojan`; Transports: `ws / xhttp / httpupgrade`.
Subscription proxy is optional and disabled by default (`SUBSCRIPTION_ENABLED=false`).

## Guides

- [Configuration](configuration.md) - Runtime variables, defaults, health visibility, and common setups.
- [Multi-backend setup](multi-backend-setup.md) - Weighted backend pools, sticky behavior, and failover notes.
- [Rate limiting](rate-limiting.md) - Connection-based limits and practical defaults.
- [Subscription proxy](subscription-proxy.md) - Optional subscription routing, formats, and limits.
- [Quickstart](quickstart.md) - Local run commands and minimal transport checks.
- [Deployment guide](deployment-guide.md) - Wrangler/dashboard deployment, troubleshooting, and security notes.
