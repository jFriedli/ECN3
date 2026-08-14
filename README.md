# ECN3

ECN3 is a Node.js calendar frontend for Bexio timesheets.

## Setup

Copy `.env.example` to `.env`, configure Bexio OAuth, then run:

```sh
npm ci
npm start
```

The server binds to `127.0.0.1:3000` by default. Set `HOST` or `PORT` only when the deployment requires a different listener.

## Caddy HTTPS deployment

The supported production path is:

```text
browser https://localhost:8443 -> Caddy HTTPS termination -> Node http://127.0.0.1:3000
```

Configure Caddy to proxy the HTTPS listener on port 8443 to `127.0.0.1:3000`, then configure ECN3 with:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_BASE_URL=https://localhost:8443
TRUST_PROXY=true
SESSION_IDLE_TIMEOUT_MS=1800000
SESSION_ABSOLUTE_TIMEOUT_MS=43200000
```

Set `SESSION_SECRET`, `BEXIO_CLIENT_ID`, and `BEXIO_CLIENT_SECRET` separately. Register this exact callback URI with Bexio:

```text
https://localhost:8443/auth/callback
```

## Security and configuration

Production (`NODE_ENV=production`) requires:

- `SESSION_SECRET`: a high-entropy value of at least 32 characters.
- `BEXIO_CLIENT_ID` and `BEXIO_CLIENT_SECRET`: Bexio OAuth configuration. The redirect URI is derived from `APP_BASE_URL`.
- An explicit HTTPS `APP_BASE_URL`, representing the origin visible in the browser.

OAuth sessions use signed, opaque cookies with `HttpOnly`, `SameSite=Lax`, an idle timeout (30 minutes by default), and an absolute timeout (12 hours by default). `POST /logout` deletes the server-side session and clears the cookie. `SESSION_IDLE_TIMEOUT_MS` and `SESSION_ABSOLUTE_TIMEOUT_MS` tune the timeouts in milliseconds; the absolute timeout must exceed the idle timeout. Cookie `Secure` is determined only by the `APP_BASE_URL` scheme: HTTPS enables it and HTTP disables it.

Sessions are stored only in process memory. This is appropriate for the initial single-process, SSH-tunnel deployment, but sessions are lost on restart and are not shared between instances. A production-grade shared session store is required before scaling to multiple processes or hosts.

`BEXIO_TOKEN` is retained only for trusted local development compatibility. Production startup rejects this shared-token mode because it does not provide per-user authentication or meaningful logout.

Set `TRUST_PROXY=true` only for this topology: Node is bound exclusively to `127.0.0.1`, Caddy is the only proxy able to reach it, and Caddy supplies the forwarded protocol headers. ECN3 rejects `TRUST_PROXY=true` with any other `HOST`. Do not expose the Node listener directly to the internet.

Never commit `.env`, tokens, OAuth client secrets, session secrets, SSH keys, or Azure credentials.

## Verification

```sh
npm test
npm audit
npm outdated
```

Use `npm ci` in CI and deployment for deterministic installation. Do not apply forced audit upgrades without reviewing compatibility.
