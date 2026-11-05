-- Point-in-time affiliate performance at canonical order grain.
-- Parameters: @period_start TIMESTAMP, @period_end TIMESTAMP.
WITH eligible_orders AS (
  SELECT
    store_id, order_id, order_created_at, gross_revenue_usd,
    net_revenue_usd, billing_country
  FROM `trader-scale-486213.trader_scale.fct_commerce_orders`
  WHERE order_created_at >= @period_start
    AND order_created_at < @period_end
    AND is_revenue_eligible
),
attributed AS (
  SELECT
    store_id, order_id, customer_id, affiliate_id,
    affiliate_name_at_order, attribution_status, attribution_method,
    is_new_customer_order, conflict_state, attribution_version,
    resolver_version, calculated_at
  FROM `trader-scale-486213.trader_scale.fct_affiliate_order_attribution`
)
SELECT
  a.attribution_status,
  a.affiliate_id,
  COALESCE(a.affiliate_name_at_order, 'Unattributed') AS affiliate_name,
  a.attribution_method,
  COUNT(*) AS orders,
  COUNT(DISTINCT a.customer_id) AS customers,
  COUNTIF(a.is_new_customer_order) AS new_customer_orders,
  SUM(o.gross_revenue_usd) AS gross_revenue_usd,
  SUM(o.net_revenue_usd) AS net_revenue_usd,
  COUNTIF(a.conflict_state IS NOT NULL) AS conflict_orders,
  ANY_VALUE(a.attribution_version) AS attribution_version,
  ANY_VALUE(a.resolver_version) AS resolver_version,
  MAX(a.calculated_at) AS calculated_at
FROM eligible_orders AS o
LEFT JOIN attributed AS a USING (store_id, order_id)
GROUP BY
  a.attribution_status, a.affiliate_id, affiliate_name, a.attribution_method
ORDER BY net_revenue_usd DESC
LIMIT 500;

