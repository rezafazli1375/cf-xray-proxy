# Deployment Guide

Deploy `cf-xray-proxy` with Wrangler or the Cloudflare dashboard, then validate tunnel paths and observability.
Protocols: `VLESS / VMess / Trojan`; Transports: `ws / xhttp / httpupgrade`.

## Wrangler CLI deployment

1. Authenticate:

```bash
wrangler login
```

2. Confirm Worker settings in `wrangler.toml`:
   - `name`
   - `main`
   - `compatibility_date`
   - `[vars]` values (backend pool, retries, limits, transport, debug settings, and `HIDE_BACKEND_URLS`)

3. Deploy:

```bash
wrangler deploy
```

4. Verify:
   - open the deployed Worker URL in a browser for the landing page (`/`),
   - run the [Quickstart](quickstart.md) transport checks against the deployed domain.

## Cloudflare Dashboard deployment

1. Go to **Workers & Pages** and create/import the Worker.
2. Ensure the main script entry maps to this repository Worker.
3. In **Settings -> Variables and Secrets**, add runtime variables.
4. Deploy from the dashboard.
5. Test:
   - `GET /` for the landing page,
   - transport checks (`/ws/<path>`, `/xhttp/<path>`, `/httpupgrade/<path>`).

## Troubleshooting

Use the checks below to isolate the issue quickly.

### 502 backend unreachable

```bash
ss -ltnp | grep -E '(:10000|:443|:80)'
lsof -iTCP -sTCP:LISTEN -n -P
curl -i --http1.1 "http://<backend-host>:<backend-port>/<path>"
```

### Upgrade not returning 101

```bash
curl -i --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://<backend-host>:<backend-port>/<path>"
```

### Host/SNI/path mismatch

| Field | Where to set | Must align with |
| --- | --- | --- |
| Host | Client URI/headers | Worker domain and backend expectations |
| SNI | Client TLS config | Worker certificate domain |
| Path | Client `path` | Backend inbound path |
| Transport type | Client config | Worker route selection and backend inbound type |

Use matching transports on both client and backend (`ws`, `xhttp`, `httpupgrade`).

### Debug mode

```bash
DEBUG="true" wrangler dev
wrangler tail
```

Look for handler prefixes: `[cf-xray-proxy]`, `[ws]`, `[xhttp]`, `[httpupgrade]`.

## Security considerations

- Backend Xray/sing-box remains the authority for authentication and protocol policy.
- Enable `RATE_LIMIT_ENABLED=true` to reduce abusive connection churn without limiting normal tunnel payload traffic.
- Use `UUID_MAX_CONNECTIONS` to cap concurrent usage per UUID (`0` keeps the feature disabled).
- Prefer private/internal backend addresses and restrict backend ingress to expected sources.
- Use `BACKEND_LIST` to isolate failure domains across backend instances.
- Keep `DEBUG=false` in normal production operation.

## Landing page behavior

When `SUBSCRIPTION_ENABLED=false`:

- `GET /` and `GET /index.html` document requests are served by `src/landing.ts` with:

```text
Cache-Control: public, max-age=3600
```

When `SUBSCRIPTION_ENABLED=true`:

- root requests return subscription info text instead of the HTML landing page.

## License

[MIT](../LICENSE)
