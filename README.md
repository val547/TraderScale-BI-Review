# TraderScale BI Review

Private TraderScale business-intelligence application.

The private published UI now loads live Account Analytics and Payouts through a
server-side, read-only BigQuery adapter at `/api/bi/snapshot`. The Google service
account is stored only as a Sites runtime secret. Other screens retain their
embedded demonstration data until their aggregate production contracts are
completed, and the interface labels this state as `LIVE · PARTIAL`.

## Production data

- BigQuery project: `trader-scale-486213`
- Location: `europe-west3`
- Commerce reporting timezone: `UTC`
- Business timezone: `Europe/London`

See [docs/data-connection.md](docs/data-connection.md) for the screen mapping,
API contract, deployment requirements and safety rules.

## Files

- `public/dashboard/index.html` — portable BI application embedded by the Site.
- `public/dashboard/production-connector.js` — production snapshot loader with demo fallback.
- `public/dashboard/data/connection-manifest.json` — machine-readable source mapping.
- `app/api/bi/snapshot/route.ts` — authenticated server-side BigQuery snapshot API.
- `sql/` — read-only GoogleSQL query templates for the first production screens.

## Railway

Railway uses `Dockerfile.railway` and `railway.toml`. Configure these production
variables in the Railway service:

- `GOOGLE_SERVICE_ACCOUNT_JSON` — secret JSON for the read-only warehouse account.
- `BI_ACCESS_EMAIL` — administrator email used on the login page.
- `BI_ACCESS_PASSWORD` — private dashboard password, at least 16 characters.
- `GOOGLE_OAUTH_CLIENT_ID` — Google OAuth web client ID.
- `GOOGLE_OAUTH_CLIENT_SECRET` — Google OAuth web client secret.
- `APP_BASE_URL` — public origin, currently `https://traderscale-bi-review-production.up.railway.app`.

The Google OAuth client must allow this redirect URI:
`https://traderscale-bi-review-production.up.railway.app/auth/google/callback`.

The public health check is `/health`; all dashboard files and the BI snapshot API
are protected by an HttpOnly session cookie.

