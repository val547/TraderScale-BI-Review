-- One latest payout request row for the Payouts screen.
WITH latest_payouts AS (
  SELECT
    payout_id, payout_nr, customer_id, account_id, account_num, payout_type,
    method, LOWER(TRIM(status)) AS status, request_amount, share_amount,
    deduction_amount, deduction_reason, account_currency,
    account_start_balance, account_plan, account_plan_category_name,
    approved_at, created_at, updated_at, processing_duration
  FROM `trader-scale-486213.trader_scale.src_payouts`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY payout_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC
  ) = 1
),
latest_customers AS (
  SELECT customer_id, customer_nr, full_name, country
  FROM `trader-scale-486213.trader_scale.dim_customers`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY customer_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC, created_at DESC
  ) = 1
)
SELECT
  p.payout_id,
  p.payout_nr,
  p.customer_id,
  c.customer_nr,
  c.full_name AS customer_name,
  c.country,
  p.account_id,
  CAST(p.account_num AS STRING) AS account_login,
  p.payout_type,
  p.method,
  p.status,
  p.request_amount,
  p.share_amount,
  p.deduction_amount,
  p.deduction_reason,
  p.account_currency,
  p.account_start_balance,
  p.account_plan,
  p.account_plan_category_name,
  p.created_at AS requested_at,
  p.approved_at,
  p.updated_at,
  p.processing_duration
FROM latest_payouts AS p
LEFT JOIN latest_customers AS c USING (customer_id)
ORDER BY p.created_at DESC
LIMIT 5000;

