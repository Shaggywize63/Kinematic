# Assistant Connect — ChatGPT / Claude → Kinematic CRM

Let a registered Kinematic user connect their account to an AI assistant
(ChatGPT Apps, Claude connectors) and act on their CRM by chat — **scoped to
exactly what their role already allows**. Built on an OAuth 2.0 authorization
server + an MCP server, both in this repo.

## Endpoints (all under `API_PUBLIC_URL`, e.g. `https://api.kinematicapp.com`)

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 discovery (authorize/token/register URLs) |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 — points MCP clients at the auth server |
| `POST /oauth/register` | RFC 7591 Dynamic Client Registration (connectors self-register) |
| `GET/POST /oauth/authorize` | Login + consent |
| `POST /oauth/token` | `authorization_code` (PKCE) + `refresh_token` |
| `POST /oauth/revoke` | RFC 7009 token revocation |
| `POST /mcp` | The MCP Streamable-HTTP endpoint (OAuth-protected) |

## Connect from Claude

1. In Claude → **Settings → Connectors → Add custom connector**.
2. Server URL: `https://api.kinematicapp.com/mcp`.
3. Claude discovers the auth server, **registers itself** via DCR, and opens the
   Kinematic login/consent page. The user signs in with their Kinematic email +
   password and approves the scopes.
4. Done — the CRM tools appear in Claude.

## Connect from ChatGPT (Apps / connectors)

1. In ChatGPT → **Settings → Connectors → Add** (or the Apps developer flow).
2. MCP server URL: `https://api.kinematicapp.com/mcp`.
3. ChatGPT performs the same discovery → DCR → login/consent flow.

> If Dynamic Client Registration is disabled (`OAUTH_ALLOW_DCR=off`), register the
> client by hand instead (see **Manual client registration** below) and paste the
> returned `client_id` / `client_secret` into the connector.

## Scopes (what the user consents to)

| Scope | Grants the assistant |
|---|---|
| `crm:read` | List/read leads, deals, contacts, activities |
| `leads:write` | Create/update leads (status, owner, notes) |
| `deals:write` | Update deals, move pipeline stages |
| `activities:write` | Log activities / notes |
| `contacts:write` | Create/update contacts |

## Tools

`list_leads`, `get_lead`, `list_deals` (read) · `update_lead`, `create_activity`,
`update_deal_stage` (write). More can be added in `src/mcp/server.ts`.

## Security model

The assistant acts **as the user, never above them**. Every tool call passes:

1. **Scope** — the granted OAuth scope must cover the action.
2. **Role (RBAC)** — `moduleAccessAllowed()` — identical to `requireModuleAccess`
   (read vs write per the user's `org_role`).
3. **Read-only** — writes are blocked entirely for `users.is_read_only` accounts.

…so the effective capability is **granted scope ∩ the user's role**, always
org-scoped (and client-scoped for client-pinned users). Tokens are opaque
(only SHA-256 hashes stored), PKCE is required, authorization codes are
single-use, refresh tokens rotate, and **every write is audited** to
`oauth_action_audit`.

## Manual client registration (when DCR is off)

```sql
-- Run against the DEFAULT project. For a confidential client, generate a secret,
-- store only its SHA-256 hash, and hand the raw secret to the connector.
insert into public.oauth_clients (client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_confidential)
values (
  'kin_<random>',
  encode(digest('<raw-secret>', 'sha256'), 'hex'),   -- requires pgcrypto
  'ChatGPT',
  array['https://chat.openai.com/aip/<id>/oauth/callback'],
  array['crm:read','leads:write','deals:write','activities:write'],
  true
);
```

## Revoking a connection

`POST /oauth/revoke` with `{ "token": "<access-or-refresh-token>" }`, or delete /
set `revoked_at` on the `oauth_access_tokens` rows for that user. (A self-service
"my connections" screen in the dashboard is a good follow-up.)

## Ops

- Set `API_PUBLIC_URL` to the canonical public API URL (used as the OAuth issuer
  + advertised endpoints).
- `OAUTH_ALLOW_DCR=off` disables open client registration.
- Access tokens live 1h, refresh tokens 30d, auth codes 5m (`src/lib/oauth/store.ts`).
