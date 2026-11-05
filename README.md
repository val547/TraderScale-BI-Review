# TraderScale BI Review

Private TraderScale business-intelligence application.

The published UI currently uses its embedded demonstration dataset. A production
data adapter is included and probes `/api/bi/snapshot`; it switches compatible
datasets in place only when a validated snapshot is returned. Until the API is
available, the interface clearly remains in demo-fallback mode.

## Production data

- BigQuery project: `trader-scale-486213`
- Location: `europe-west3`
- Commerce reporting timezone: `UTC`
- Business timezone: `Europe/London`

See [docs/data-connection.md](docs/data-connection.md) for the screen mapping,
API contract, deployment requirements and safety rules.

## Files

- `dist/index.html` — portable BI application.
- `dist/production-connector.js` — production snapshot loader with demo fallback.
- `dist/data/connection-manifest.json` — machine-readable source mapping.
- `sql/` — read-only GoogleSQL query templates for the first production screens.

