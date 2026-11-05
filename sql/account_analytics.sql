-- One current account row for Account Analytics.
-- Parameters: none. Validate physical fct_account_analytics types before release.
WITH latest_accounts AS (
  SELECT
    account_id, account_nr, customer_id, status, platform, plan,
    plan_category_name, current_equity, current_balance, profit,
    breached_at, created_at, updated_at
  FROM `trader-scale-486213.trader_scale.src_prop_accounts`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC, created_at DESC
  ) = 1
),
latest_details AS (
  SELECT
    account_id, start_balance, currency, leverage, profit_target_percentage,
    profit_share_percentage, consistency_percentage, soft_breach_limit,
    first_withdrawal_days, subsequent_withdrawal_days
  FROM `trader-scale-486213.trader_scale.src_prop_accounts_detail`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id
    ORDER BY fetched_at DESC, updated_at DESC, created_at DESC
  ) = 1
),
latest_analytics AS (
  SELECT
    account_id, first_trade_date,
    SAFE_CAST(trades_placed AS INT64) AS trades_placed,
    SAFE_CAST(total_trades AS INT64) AS total_trades,
    SAFE_CAST(winning_trades AS INT64) AS winning_trades,
    SAFE_CAST(losing_trades AS INT64) AS losing_trades,
    SAFE_CAST(win_rate AS FLOAT64) AS win_rate,
    SAFE_CAST(profit_factor AS FLOAT64) AS profit_factor,
    SAFE_CAST(net_profit AS NUMERIC) AS net_profit,
    SAFE_CAST(profit_percentage AS FLOAT64) AS profit_percentage
  FROM `trader-scale-486213.trader_scale.fct_account_analytics`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC
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
  a.account_id,
  CAST(a.account_nr AS STRING) AS account_login,
  a.customer_id,
  c.customer_nr,
  c.full_name AS customer_name,
  c.country,
  a.status,
  a.platform,
  a.plan,
  a.plan_category_name,
  d.start_balance,
  d.currency,
  d.leverage,
  a.current_balance,
  a.current_equity,
  a.profit,
  d.profit_target_percentage,
  d.profit_share_percentage,
  d.consistency_percentage,
  d.soft_breach_limit,
  d.first_withdrawal_days,
  d.subsequent_withdrawal_days,
  x.first_trade_date,
  x.trades_placed,
  x.total_trades,
  x.winning_trades,
  x.losing_trades,
  x.win_rate,
  x.profit_factor,
  x.net_profit,
  x.profit_percentage,
  a.breached_at,
  a.created_at,
  a.updated_at
FROM latest_accounts AS a
LEFT JOIN latest_details AS d USING (account_id)
LEFT JOIN latest_analytics AS x USING (account_id)
LEFT JOIN latest_customers AS c USING (customer_id)
ORDER BY a.updated_at DESC
LIMIT 5000;

