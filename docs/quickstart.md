# Quickstart

Run and verify the Worker locally for Protocols: `VLESS / VMess / Trojan` over Transports: `ws / xhttp / httpupgrade`.
Subscription proxy is optional and disabled by default (`SUBSCRIPTION_ENABLED=false`).

## 1) Install dependencies

```bash
npm install
```

## 2) Run local Worker

```bash
BACKEND_URL="http://127.0.0.1:10000" TRANSPORT="xhttp" DEBUG="true" wrangler dev
```

## 3) Minimal checks

Replace placeholders:

- `<worker-domain>`: your Worker URL (for local dev typically `127.0.0.1:8787`)
- `<path>`: backend inbound path

HTTP passthrough:

```bash
curl -i "http://<worker-domain>/<path>?check=1"
```

`ws` upgrade handshake:

```bash
curl -i --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://<worker-domain>/ws/<path>"
```

`xhttp` upgrade handshake:

```bash
curl -i --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://<worker-domain>/xhttp/<path>?mode=auto&ed=0"
```

`httpupgrade` upgrade handshake:

```bash
curl -i --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://<worker-domain>/httpupgrade/<path>"
```

Expected handshake result: `HTTP/1.1 101 Switching Protocols` when backend accepts upgrade.
