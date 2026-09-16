# Session cookies

A session token in `localStorage` is readable by any JavaScript running on the page, so one
cross-site scripting bug anywhere in the portal or the member app is enough to walk away with a
staff session. Access and refresh tokens now live in **httpOnly cookies** instead, and no token is
visible to browser JavaScript at all.

## What changed

| | Before | Now |
|---|---|---|
| Where the token lives | `localStorage`, readable by scripts | httpOnly cookie, invisible to scripts |
| How requests authenticate | `Authorization` header added by the app | the browser attaches the cookie |
| On refresh | the app read the stored refresh token | `POST /auth/refresh` uses the refresh cookie, rotates, and re-sets both cookies |
| On sign-out | the app deleted its copy | cookies are cleared **and** the session is revoked server-side |
| Cross-site scripting | a lifted token is a working session | nothing to lift |

The API still accepts a bearer token. Scripts, tests, the reconciliation tooling and provider
callbacks are not browsers, and removing that path would break them for no security gain — the
cookie is an addition, not a replacement.

## Cookie flags

```
ce_at  HttpOnly; Secure; SameSite=Lax; Path=/
ce_rt  HttpOnly; Secure; SameSite=Lax; Path=/
```

- **HttpOnly** — not readable by JavaScript.
- **Secure** — only ever sent over HTTPS. Set when `NODE_ENV=production`, which the API's own
  environment file now does; a Secure cookie is dropped by browsers over plain http, which is the
  behaviour we want.
- **SameSite=Lax** — the portal and the API share a site (`app.` and `api.` under the same
  domain), so the cookie rides along on same-site requests, but a cross-site page cannot make a
  state-changing request with the session attached. Together with `credentials: true` restricted to
  the known portal origins, that is the CSRF control.
- No `Domain` attribute: these are host-only cookies for the API.

## Access token lifetime

The access cookie lives as long as the access token (15 minutes by default,
`JWT_ACCESS_TTL_SECONDS`); the refresh cookie lives 30 days (`REFRESH_TOKEN_TTL_DAYS`) and is
rotated on every use, so a stolen refresh token is single-use and its reuse kills the session.

## Upgrading a running deployment

An older build left a token in `localStorage`. Both front-ends delete it on sight and keep only a
marker saying *who* is signed in. Nothing else is needed: the next sign-in sets the cookies.

## For the operator

- If the portal suddenly behaves as though nobody is signed in after this change, sign out and back
  in once — the old stored token is gone by design.
- `Secure` requires HTTPS. The API is served over HTTPS by Caddy; if it is ever exposed over plain
  http, cookies will be dropped (that is the point, but it looks like "login does nothing").
