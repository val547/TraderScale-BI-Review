# TraderScale BI production data connection

## Current state

The application is prepared to load a same-origin JSON snapshot from
`GET /api/bi/snapshot`. No BigQuery credentials or Warehouse API URL are stored
in this repository. If the endpoint is absent, slow, invalid, or reports demo
data, the embedded fictional dataset stays active.

The provider-native BigQuery connector is currently disabled by the workspace
administrator. Deployment therefore needs one of these read-only paths:

1. a Warehouse API that returns the snapshot contract below; or
2. a server-side service account with BigQuery Job User and dataset read access.

Never put a service-account key, access token, customer PII, raw payout method
JSON, IP address, address or phone number in frontend code or Git.

## First screen mapping

| Screen | Production source | Connection state |
| --- | --- | --- |
| Account Analytics | latest `src_prop_accounts`, `src_prop_accounts_detail`, `fct_account_analytics` | Query ready; API credentials missing |
| Payouts | latest `src_payouts`, latest customer/account dimensions | Query ready; API credentials missing |
| Affiliates | `fct_affiliate_order_attribution` + `fct_commerce_orders` | Query ready; API credentials missing |
| Customer value | canonical commerce bridges/orders + latest payouts | Contract mapped |
| Risk Radar | rule detector tables + `breach_reviews/actions/hidden` | Contract mapped; detector schemas must be validated live |
| Owner Overview | canonical orders, payouts, ThoughtMetric | Revenue ready; full direct-cost profit is blocked |
| Profitability | `account_profitability` plus direct cost ledger | Blocked on canonical PSP/platform/acquisition cost coverage |

`account_profitability.gross_profit` means commerce revenue minus approved trader
payouts. It must not be relabelled as the prototype's broader “profit before
overheads” until PSP fees, platform costs, acquisition costs and commissions are
covered on the same grain.

## Snapshot contract

```json
{
  "schemaVersion": 1,
  "mode": "production",
  "asOf": "2026-11-05",
  "currency": "USD",
  "quality": {
    "profitabilityReady": false,
    "warnings": []
  },
  "data": {
    "accounts": [],
    "payouts": [],
    "affiliates": [],
    "customers": [],
    "riskCases": [],
    "orders": []
  }
}
```

Arrays may be omitted. The browser replaces only arrays explicitly returned.
`orders` is rejected unless `quality.profitabilityReady` is true, preventing an
incomplete cost model from silently changing owner profit and profitability.

## Required API behavior

- Authenticate users before returning business data.
- Execute read-only parameterized GoogleSQL.
- Use inclusive lower and exclusive upper timestamp bounds.
- Deduplicate versioned sources before joins.
- Pre-aggregate independent one-to-many facts before joining.
- Return no restricted PII or raw source payloads.
- Include data-as-of time and coverage warnings.
- Enforce a bounded response and short cache lifetime.

## Safe keys

```text
Commerce order: (store_id, order_id)
Customer:       customer_id through bridge_commerce_customer_orders
Account:        account_id
MT5 login:      CAST(account_nr AS STRING) = CAST(Login AS STRING)
Affiliate:      (store_id, order_id) through fct_affiliate_order_attribution
Risk review:    (rule, breach_id)
```

