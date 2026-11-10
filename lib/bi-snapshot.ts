type ServiceAccount = {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri: string;
};

type BigQueryResponse = {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  pageToken?: string;
  schema?: { fields?: Array<{ name: string }> };
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  errors?: Array<{ message?: string }>;
  error?: { message?: string; errors?: Array<{ message?: string }> };
};

function base64Url(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemBytes(pem: string) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function accessToken(credential: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: credential.client_email,
    scope: "https://www.googleapis.com/auth/bigquery.readonly",
    aud: credential.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(credential.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const response = await fetch(credential.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(new Uint8Array(signature))}`,
    }),
  });
  if (!response.ok) throw new Error(`Google OAuth returned ${response.status}.`);
  const payload = await response.json<{ access_token?: string }>();
  if (!payload.access_token) throw new Error("Google OAuth returned no access token.");
  return payload.access_token;
}

async function query(credential: ServiceAccount, token: string, sql: string) {
  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(credential.project_id)}/queries`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        location: "europe-west3",
        timeoutMs: 25000,
        maxResults: 10000,
        maximumBytesBilled: "3000000000",
      }),
    },
  );
  const payload = await response.json() as BigQueryResponse;
  if (!response.ok || !payload.jobComplete) {
    const message = [payload.error?.message, ...(payload.error?.errors ?? []).map((error) => error.message),
      ...(payload.errors ?? []).map((error) => error.message)].filter(Boolean).join("; ");
    throw new Error(message || `BigQuery returned ${response.status}.`);
  }
  const fields = payload.schema?.fields ?? [];
  const rows = [...(payload.rows ?? [])];
  let pageToken = payload.pageToken;
  const jobId = payload.jobReference?.jobId;
  const projectId = payload.jobReference?.projectId || credential.project_id;
  const location = payload.jobReference?.location || "europe-west3";
  while (pageToken) {
    if (!jobId) throw new Error("BigQuery returned a page token without a job ID.");
    const pageUrl = new URL(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries/${encodeURIComponent(jobId)}`,
    );
    pageUrl.searchParams.set("location", location);
    pageUrl.searchParams.set("maxResults", "10000");
    pageUrl.searchParams.set("pageToken", pageToken);
    const pageResponse = await fetch(pageUrl, { headers: { authorization: `Bearer ${token}` } });
    const page = await pageResponse.json() as BigQueryResponse;
    if (!pageResponse.ok || !page.jobComplete) {
      const message = [page.error?.message, ...(page.error?.errors ?? []).map((error) => error.message),
        ...(page.errors ?? []).map((error) => error.message)].filter(Boolean).join("; ");
      throw new Error(message || `BigQuery page returned ${pageResponse.status}.`);
    }
    rows.push(...(page.rows ?? []));
    pageToken = page.pageToken;
  }
  return rows.map((row) => Object.fromEntries(
    fields.map((field, index) => [field.name, row.f[index]?.v ?? null]),
  ));
}

async function optionalQuery(credential: ServiceAccount, token: string, label: string, sql: string) {
  try {
    return { rows: await query(credential, token, sql), error: "" };
  } catch (error) {
    return { rows: [] as Array<Record<string, unknown>>, error: `${label}: ${error instanceof Error ? error.message : "query failed"}` };
  }
}

function number(value: unknown) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function optionalNumber(value: unknown) {
  if (value == null || String(value).trim() === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function text(value: unknown, fallback = "") {
  return value == null ? fallback : String(value);
}

function date(value: unknown) {
  const raw = text(value);
  if (/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) {
    const epoch = Number(raw);
    if (Number.isFinite(epoch)) return new Date(epoch * (epoch < 1e12 ? 1000 : 1)).toISOString().slice(0, 10);
  }
  return raw.slice(0, 10);
}

function programmeFamily(row: Record<string, unknown>) {
  const source = `${text(row.plan)} ${text(row.plan_category_name)}`.toLowerCase();
  if (source.includes("instant")) return "Instant";
  if (/\b(?:one|1)[ -]?step\b/.test(source) || source.includes("speedy")) return "Speedy";
  if (/\b(?:two|2)[ -]?step\b/.test(source) || source.includes("pro")) return "Pro";
  if (source.includes("competition")) return "Classic";
  return text(row.plan_category_name, text(row.plan, "Other"));
}

function platform(row: Record<string, unknown>) {
  const source = `${text(row.platform)} ${text(row.plan)}`.toUpperCase();
  const compact = source.replace(/[^A-Z0-9]/g, "");
  if (source.includes("MT5") || source.includes("METATRADER 5")) return "MT5";
  if (compact.includes("METATRADER5")) return "MT5";
  if (source.includes("MT4") || compact.includes("METATRADER4")) return "MT4";
  if (source.includes("MTR") || compact.includes("MATCHTRADER")) return "MatchTrader";
  if (compact.includes("CTRADER")) return "cTrader";
  return text(row.platform).trim();
}

function sizeLabel(value: unknown) {
  const amount = number(value);
  if (!amount) return "";
  if (amount >= 1000 && amount % 1000 === 0) return `${amount / 1000}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount);
}

function productSize(row: Record<string, unknown>, explicit?: unknown) {
  const amount = number(explicit);
  if (amount) return amount;
  const raw = `${text(row.plan)} ${text(row.plan_category_name)}`;
  const match = raw.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*K\b/i);
  return match ? Number(match[1]) * 1000 : 0;
}

function productPlan(row: Record<string, unknown>, accountSize?: unknown) {
  const family = programmeFamily(row);
  const size = sizeLabel(productSize(row, accountSize));
  const venue = platform(row);
  return [family, size, venue].filter(Boolean).join(" · ");
}

function accountStage(row: Record<string, unknown>) {
  const source = `${text(row.status)} ${text(row.plan)} ${text(row.plan_category_name)}`.toLowerCase();
  if (source.includes("breach")) return "Breached";
  if (source.includes("funded") || source.includes("funding") || source.includes("live") || source.includes("instant")) return "Funded";
  if (source.includes("pass")) return "Passed";
  return "Evaluation";
}

function challengeFormat(row: Record<string, unknown>) {
  const family = programmeFamily(row);
  if (family === "Instant") return "instant";
  if (family === "Speedy") return "1-step";
  if (family === "Pro" || family === "Classic") return "2-step";
  return "";
}

function challengePhase(row: Record<string, unknown>, stage: string) {
  if (stage === "Funded") return "funded";
  if (stage === "Passed") return "complete";
  const source = `${text(row.plan)} ${text(row.plan_category_name)}`.toLowerCase();
  if (/\b(?:phase|step)\s*2\b/.test(source)) return 2;
  if (/\b(?:phase|step)\s*1\b/.test(source)) return 1;
  if (challengeFormat(row) === "1-step" && stage === "Evaluation") return 1;
  return null;
}

function accountStatus(row: Record<string, unknown>) {
  const source = text(row.status).toLowerCase();
  if (source.includes("breach")) return "Breached";
  if (source.includes("clos") || source.includes("disable") || source.includes("inactive")) return "Closed";
  return "Active";
}

function payoutStatus(value: unknown) {
  const source = text(value).toLowerCase();
  if (source.includes("paid") || source.includes("complete") || source.includes("processed")) return "Paid";
  if (source.includes("approv")) return "Approved";
  if (source.includes("reject") || source.includes("declin")) return "Rejected";
  return "Under review";
}

const ACCOUNTS_SQL = `
WITH latest_accounts AS (
  SELECT account_id, account_nr, customer_id, status, platform, plan,
    plan_category_name, current_equity, current_balance, profit,
    breached_at, created_at, updated_at,
    COALESCE(etl_updated_at, etl_loaded_at, updated_at, created_at) AS core_clock,
    etl_loaded_at, etl_updated_at
  FROM \`trader-scale-486213.trader_scale.src_prop_accounts\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id
    ORDER BY COALESCE(etl_updated_at, etl_loaded_at, updated_at, created_at) DESC,
      etl_loaded_at DESC, updated_at DESC
  ) = 1
), latest_details AS (
  SELECT account_id, status, current_balance, current_equity, breached_at,
    start_balance, currency, profit_share_percentage, fetched_at
  FROM \`trader-scale-486213.trader_scale.src_prop_accounts_detail\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id ORDER BY fetched_at DESC, updated_at DESC, created_at DESC
  ) = 1
), latest_analytics AS (
  SELECT account_id, first_trade_date,
    SAFE_CAST(total_trades AS INT64) AS total_trades,
    SAFE_CAST(win_rate AS FLOAT64) AS win_rate,
    SAFE_CAST(net_profit AS NUMERIC) AS net_profit,
    SAFE_CAST(consistency_top_day_profit_percentage AS FLOAT64) AS consistency_percentage
  FROM \`trader-scale-486213.trader_scale.fct_account_analytics\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id ORDER BY etl_updated_at DESC, etl_loaded_at DESC
  ) = 1
), latest_customers AS (
  SELECT customer_id, customer_nr, full_name, country
  FROM \`trader-scale-486213.trader_scale.dim_customers\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY customer_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC, created_at DESC
  ) = 1
), latest_payouts AS (
  SELECT payout_id, account_id, LOWER(TRIM(status)) AS payout_status,
    SAFE_CAST(COALESCE(share_amount, request_amount) AS NUMERIC) AS amount
  FROM \`trader-scale-486213.trader_scale.src_payouts\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY payout_id ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC
  ) = 1
), payout_totals AS (
  SELECT account_id,
    SUM(IF(payout_status LIKE '%approved%', amount, 0)) AS approved_unpaid,
    SUM(IF(payout_status LIKE '%paid%' OR payout_status LIKE '%complete%' OR payout_status LIKE '%processed%', amount, 0)) AS paid_total
  FROM latest_payouts GROUP BY account_id
)
SELECT a.account_id, CAST(a.account_nr AS STRING) AS account_login,
  a.customer_id, c.customer_nr, c.full_name AS customer_name, c.country,
  IF(d.fetched_at > a.core_clock, COALESCE(d.status, a.status), a.status) AS status,
  a.platform, a.plan, a.plan_category_name, d.start_balance,
  d.currency, d.profit_share_percentage,
  IF(d.fetched_at > a.core_clock, COALESCE(d.current_balance, a.current_balance), a.current_balance) AS current_balance,
  IF(d.fetched_at > a.core_clock, COALESCE(d.current_equity, a.current_equity), a.current_equity) AS current_equity,
  a.profit, x.first_trade_date, x.total_trades, x.win_rate, x.net_profit, x.consistency_percentage,
  IF(d.fetched_at > a.core_clock, d.breached_at, a.breached_at) AS breached_at,
  a.created_at, a.updated_at,
  GREATEST(a.core_clock, COALESCE(d.fetched_at, TIMESTAMP '1970-01-01')) AS snapshot_at,
  COALESCE(p.approved_unpaid, 0) AS approved_unpaid,
  COALESCE(p.paid_total, 0) AS paid_total
FROM latest_accounts AS a
LEFT JOIN latest_details AS d USING (account_id)
LEFT JOIN latest_analytics AS x USING (account_id)
LEFT JOIN latest_customers AS c USING (customer_id)
LEFT JOIN payout_totals AS p USING (account_id)
ORDER BY a.updated_at DESC
`;

const PAYOUTS_SQL = `
WITH latest_payouts AS (
  SELECT payout_id, payout_nr, customer_id, account_id, account_num,
    LOWER(TRIM(status)) AS status, request_amount, share_amount,
    account_currency, account_plan, account_plan_category_name,
    approved_at, created_at, updated_at
  FROM \`trader-scale-486213.trader_scale.src_payouts\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY payout_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC
  ) = 1
), latest_customers AS (
  SELECT customer_id, full_name, country
  FROM \`trader-scale-486213.trader_scale.dim_customers\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY customer_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC, created_at DESC
  ) = 1
), latest_accounts AS (
  SELECT account_id, platform
  FROM \`trader-scale-486213.trader_scale.src_prop_accounts\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC, created_at DESC
  ) = 1
), latest_details AS (
  SELECT account_id, start_balance
  FROM \`trader-scale-486213.trader_scale.src_prop_accounts_detail\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id ORDER BY fetched_at DESC, updated_at DESC, created_at DESC
  ) = 1
), commerce_customers AS (
  SELECT warehouse_customer_id, commerce_customer_key
  FROM \`trader-scale-486213.trader_scale.dim_commerce_customers\`
  WHERE warehouse_customer_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY warehouse_customer_id ORDER BY refreshed_at DESC, updated_at DESC
  ) = 1
)
SELECT p.payout_id, p.payout_nr, p.customer_id,
  COALESCE(cc.commerce_customer_key, p.customer_id) AS commerce_customer_key,
  c.full_name AS customer_name, c.country, p.account_id,
  CAST(p.account_num AS STRING) AS account_login, p.status,
  p.request_amount, p.share_amount, p.account_currency,
  p.account_plan, p.account_plan_category_name,
  a.platform, d.start_balance,
  p.created_at AS requested_at, p.approved_at, p.updated_at
FROM latest_payouts AS p
LEFT JOIN latest_customers AS c USING (customer_id)
LEFT JOIN latest_accounts AS a USING (account_id)
LEFT JOIN latest_details AS d USING (account_id)
LEFT JOIN commerce_customers AS cc ON cc.warehouse_customer_id = p.customer_id
ORDER BY p.created_at DESC
`;

const ORDERS_SQL = `
WITH primary_product AS (
  SELECT store_id, order_id,
    ARRAY_AGG(product_name IGNORE NULLS ORDER BY ABS(COALESCE(total_usd, 0)) DESC, line_id LIMIT 1)[SAFE_OFFSET(0)] AS product_name
  FROM \`trader-scale-486213.trader_scale.fct_commerce_order_lines\`
  GROUP BY store_id, order_id
), eligible AS (
  SELECT store_id, order_id, order_number, order_reporting_date,
    billing_country, gross_revenue_usd, refunded_usd, net_revenue_usd,
    status, is_revenue_eligible, status_policy_version
  FROM \`trader-scale-486213.trader_scale.fct_commerce_orders\`
), identified AS (
  SELECT o.*,
    COALESCE(NULLIF(b.commerce_customer_key, ''), CONCAT('order:', o.store_id, ':', o.order_id)) AS customer_key
  FROM eligible AS o
  LEFT JOIN \`trader-scale-486213.trader_scale.bridge_commerce_customer_orders\` AS b
    USING (store_id, order_id)
), first_orders AS (
  SELECT *, MIN(order_reporting_date) OVER (PARTITION BY customer_key) AS first_order_date
  FROM identified
)
SELECT store_id, order_id, order_number, order_reporting_date, customer_key,
  billing_country, status, is_revenue_eligible, gross_revenue_usd, refunded_usd, net_revenue_usd,
  p.product_name,
  order_reporting_date = first_order_date AS is_new_customer,
  status_policy_version
FROM first_orders
LEFT JOIN primary_product AS p USING (store_id, order_id)
ORDER BY order_reporting_date DESC, order_id
`;

const PROFITABILITY_SQL = `
SELECT attempt_started_at_date,
  COALESCE(plan, 'Unknown') AS plan,
  COALESCE(
    SAFE_CAST(NULLIF(REGEXP_REPLACE(plan_size, r'[^0-9.]', ''), '') AS NUMERIC)
      * IF(REGEXP_CONTAINS(UPPER(plan_size), r'K'), 1000, 1),
    0
  ) AS plan_size,
  COUNT(*) AS attempts, COUNTIF(reached_funded) AS funded_attempts,
  SUM(COALESCE(revenue, 0)) AS revenue,
  SUM(COALESCE(discount, 0)) AS discount,
  SUM(COALESCE(cnt_payouts, 0)) AS payout_count,
  SUM(COALESCE(payouts, 0)) AS payouts,
  SUM(COALESCE(gross_profit, 0)) AS gross_profit
FROM \`trader-scale-486213.trader_scale.account_profitability\`
GROUP BY 1, 2, 3
ORDER BY revenue DESC
`;

const TRADES_SQL = `
WITH trades AS (
  SELECT account_id, Symbol,
    COALESCE(profit, 0) + COALESCE(costs, 0) AS net_realized,
    close_timestamp
  FROM \`trader-scale-486213.trader_scale.rpt_account_trade_history\`
  WHERE row_type = 'TRADE'
), symbol_counts AS (
  SELECT account_id, Symbol, COUNT(*) AS trade_count
  FROM trades
  WHERE NULLIF(TRIM(Symbol), '') IS NOT NULL
  GROUP BY account_id, Symbol
), top_symbols AS (
  SELECT account_id,
    ARRAY_AGG(Symbol ORDER BY trade_count DESC, Symbol LIMIT 1)[SAFE_OFFSET(0)] AS top_symbol
  FROM symbol_counts
  GROUP BY account_id
)
SELECT t.account_id, COUNT(*) AS trade_count,
  SAFE_MULTIPLY(SAFE_DIVIDE(COUNTIF(t.net_realized > 0), COUNT(*)), 100) AS win_rate,
  MAX(t.net_realized) AS largest_trade,
  SUM(t.net_realized) AS net_realized,
  MIN(t.close_timestamp) AS first_closed_trade_at,
  MAX(t.close_timestamp) AS last_closed_trade_at,
  ANY_VALUE(s.top_symbol) AS top_symbol
FROM trades AS t
LEFT JOIN top_symbols AS s USING (account_id)
GROUP BY t.account_id
`;

const AFFILIATES_SQL = `
WITH eligible_orders AS (
  SELECT store_id, order_id, order_reporting_date, gross_revenue_usd, net_revenue_usd
  FROM \`trader-scale-486213.trader_scale.fct_commerce_orders\`
  WHERE is_revenue_eligible
)
SELECT o.store_id, o.order_id, o.order_reporting_date,
  COALESCE(a.affiliate_id, 'unattributed') AS affiliate_id,
  COALESCE(a.affiliate_name_at_order, 'Unattributed') AS affiliate_name,
  COALESCE(a.attribution_status, 'unattributed') AS attribution_status,
  a.customer_id, a.account_ids, a.is_new_customer_order,
  o.gross_revenue_usd AS gross_revenue,
  o.net_revenue_usd AS net_revenue,
  NULLIF(TRIM(a.conflict_state), '') IS NOT NULL AS has_conflict
FROM eligible_orders AS o
LEFT JOIN \`trader-scale-486213.trader_scale.fct_affiliate_order_attribution\` AS a
  USING (store_id, order_id)
ORDER BY o.order_reporting_date DESC, net_revenue DESC
`;

const AFFILIATE_PNL_SQL = `
WITH primary_product AS (
  SELECT store_id, order_id,
    ARRAY_AGG(product_name IGNORE NULLS ORDER BY ABS(COALESCE(total_usd, 0)) DESC, line_id LIMIT 1)[SAFE_OFFSET(0)] AS product_name
  FROM \`trader-scale-486213.trader_scale.fct_commerce_order_lines\`
  GROUP BY store_id, order_id
), order_dimensions AS (
  SELECT store_id, order_id, billing_country
  FROM \`trader-scale-486213.trader_scale.fct_commerce_orders\`
)
SELECT c.reporting_date, c.component_type, c.allocation_bucket,
  c.store_id, c.order_id, c.affiliate_id, c.affiliate_name,
  c.customer_id, c.customer_type, c.amount_usd, c.recognized_amount_usd,
  c.amount_known, c.completeness_status,
  p.product_name, o.billing_country
FROM \`trader-scale-486213.trader_scale.rpt_affiliate_pnl_components\` AS c
LEFT JOIN primary_product AS p USING (store_id, order_id)
LEFT JOIN order_dimensions AS o USING (store_id, order_id)
ORDER BY c.reporting_date DESC, c.affiliate_id, c.store_id, c.order_id
`;

const CUSTOMERS_SQL = `
WITH latest_axcera AS (
  SELECT customer_id, created_at
  FROM \`trader-scale-486213.trader_scale.dim_customers\`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC) = 1
)
SELECT d.commerce_customer_key, d.warehouse_customer_id, d.warehouse_customer_nr,
  d.woocommerce_customer_id, d.full_name, d.country, d.status, d.identity_source,
  d.account_count, d.order_count, d.completed_order_count, d.first_order_at, d.last_order_at,
  COALESCE(d.registered_at, a.created_at) AS registered_at,
  d.has_guest_order, d.is_woocommerce_registered, d.refreshed_at,
  d.revenue_usd, d.all_status_order_value_usd, d.kyc_verified
FROM \`trader-scale-486213.trader_scale.dim_commerce_customers\` AS d
LEFT JOIN latest_axcera AS a ON a.customer_id = d.warehouse_customer_id
ORDER BY revenue_usd DESC
`;

const REBUY_SQL = `
WITH breaches AS (
  SELECT account_id, CAST(account_nr AS STRING) AS account_nr, customer_id,
    plan, plan_category_name, platform, breached_at,
    COALESCE(etl_updated_at, etl_loaded_at, updated_at, created_at) AS observed_at
  FROM \`trader-scale-486213.trader_scale.src_prop_accounts\`
  WHERE breached_at IS NOT NULL AND customer_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id ORDER BY COALESCE(etl_updated_at, etl_loaded_at, updated_at, created_at) DESC
  ) = 1
), purchases AS (
  SELECT DISTINCT p.customer_id, o.store_id, o.order_id, o.order_created_at,
    o.net_revenue_usd, o.status
  FROM \`trader-scale-486213.trader_scale.fct_commerce_orders\` AS o
  JOIN \`trader-scale-486213.trader_scale.bridge_commerce_prop_orders\` AS p
    USING (store_id, order_id)
  WHERE o.is_net_revenue_eligible AND o.net_revenue_usd > 0
), candidates AS (
  SELECT b.account_id, b.account_nr, b.customer_id, b.plan, b.plan_category_name,
    b.platform, b.breached_at, b.observed_at, p.store_id, p.order_id,
    p.order_created_at AS rebuy_at, p.net_revenue_usd AS rebuy_revenue,
    ROW_NUMBER() OVER (PARTITION BY p.customer_id, p.store_id, p.order_id ORDER BY b.breached_at DESC, b.account_id) AS breach_rank
  FROM purchases AS p
  JOIN breaches AS b ON b.customer_id = p.customer_id AND b.breached_at < p.order_created_at
), cycles AS (
  SELECT * EXCEPT(breach_rank)
  FROM candidates
  WHERE breach_rank = 1
  QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id, breached_at ORDER BY rebuy_at, store_id, order_id) = 1
), details AS (
  SELECT account_id, start_balance, currency, plan_label, fetched_at
  FROM \`trader-scale-486213.trader_scale.src_prop_accounts_detail\`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY fetched_at DESC, updated_at DESC, created_at DESC) = 1
), customers AS (
  SELECT customer_id, full_name, country
  FROM \`trader-scale-486213.trader_scale.dim_customers\`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC) = 1
)
SELECT b.account_id, b.account_nr, b.customer_id, c.full_name AS customer_name,
  c.country, b.plan, b.plan_category_name, b.platform, d.plan_label,
  d.start_balance, d.currency, CAST(b.breached_at AS STRING) AS breached_at,
  CAST(b.observed_at AS STRING) AS observed_at, x.store_id, x.order_id,
  CAST(x.rebuy_at AS STRING) AS rebuy_at, x.rebuy_revenue,
  IF(x.rebuy_at IS NULL, NULL, TIMESTAMP_DIFF(x.rebuy_at, b.breached_at, SECOND)) AS rebuy_seconds
FROM breaches AS b
LEFT JOIN cycles AS x ON x.account_id = b.account_id AND x.breached_at = b.breached_at
LEFT JOIN details AS d ON d.account_id = b.account_id
LEFT JOIN customers AS c ON c.customer_id = b.customer_id
ORDER BY b.breached_at DESC
`;

const THOUGHTMETRIC_CHANNEL_SQL = `
SELECT project_id, CAST(reporting_date AS STRING) AS reporting_date,
  reporting_currency, reporting_timezone, model, channel, paid_channel,
  native_spend, converted_spend, orders, total_sales, net_sales,
  new_customer_orders, new_customer_total_sales, new_customers,
  returning_customer_orders, returning_customer_total_sales, visits,
  conversion_rate, attribution_loaded_at, delivery_loaded_at
FROM \`trader-scale-486213.trader_scale.rpt_thoughtmetric_channel_daily\`
WHERE UPPER(COALESCE(reporting_currency, 'USD')) = 'USD'
ORDER BY reporting_date DESC, channel
`;

const THOUGHTMETRIC_CAMPAIGN_SQL = `
SELECT project_id, CAST(reporting_date AS STRING) AS reporting_date,
  reporting_currency, reporting_timezone, model, campaign_scope, account_id,
  platform, paid_platform, campaign_id, campaign_name,
  native_spend, converted_spend, impressions, clicks, ctr, cpc, cpm,
  visits, total_duration, total_pageviews, avg_duration, avg_pageviews,
  orders, add_to_carts, leads, gross_sales, total_discounts, total_refund,
  total_sales, net_sales, total_shipping, total_tax, net_profit,
  item_quantity, aov, conversion_rate, new_customer_orders,
  new_customer_total_sales, returning_customer_orders,
  returning_customer_total_sales, attribution_loaded_at, delivery_loaded_at
FROM \`trader-scale-486213.trader_scale.rpt_thoughtmetric_campaign_daily\`
WHERE UPPER(COALESCE(reporting_currency, 'USD')) = 'USD'
ORDER BY reporting_date DESC, converted_spend DESC
`;

const THOUGHTMETRIC_ATTRIBUTION_SQL = `
SELECT CAST(conversion_date AS STRING) AS conversion_date, model, channel,
  paid_channel, SUM(COALESCE(channel_credit, 0)) AS conversion_credit,
  SUM(COALESCE(thoughtmetric_order_revenue, 0) * COALESCE(channel_credit, 0)) AS attributed_revenue,
  SUM(COALESCE(actual_matched_revenue, 0) * COALESCE(channel_credit, 0)) AS canonical_matched_revenue,
  COUNT(DISTINCT transaction_id) AS attributed_orders,
  COUNT(DISTINCT IF(warehouse_matched, transaction_id, NULL)) AS matched_orders,
  COUNT(DISTINCT IF(is_new_customer, customer_id, NULL)) AS new_customers
FROM \`trader-scale-486213.trader_scale.rpt_thoughtmetric_order_attribution\`
GROUP BY conversion_date, model, channel, paid_channel
ORDER BY conversion_date DESC, channel
`;

const THOUGHTMETRIC_LTV_SQL = `
SELECT project_id, model, channel, paid_channel,
  CAST(acquisition_date AS STRING) AS acquisition_date, acquisition_order_id,
  customer_id, acquisition_credit, initial_revenue, repeat_revenue,
  total_customer_ltv
FROM \`trader-scale-486213.trader_scale.rpt_paid_customer_ltv\`
ORDER BY acquisition_date DESC
`;

const WITHDRAWABLE_SQL = `
SELECT run_id, policy_version, CAST(calculated_at AS STRING) AS calculated_at,
  CAST(source_as_of AS STRING) AS source_as_of, account_id, account_nr,
  customer_id, customer_nr, customer_name, account_status, is_active,
  is_funded, is_breached, plan_id, product_id, plan_label, raw_plan,
  plan_family, account_size_label, start_balance_usd, currency,
  pending_payout_id, pending_payout_amount_usd, realized_cycle_profit_usd,
  current_balance_usd, current_equity_usd, equity_supported_profit_usd,
  eligible_profit_before_rules_usd, minimum_profit_usd,
  profit_share_percentage, trading_days_actual, trading_days_required,
  consistency_type, consistency_actual_percentage,
  consistency_required_percentage, open_lots, kyc_status, risk_state,
  risk_detection_count, financially_eligible, ready_to_request,
  estimated_withdrawable_profit_usd, primary_status,
  ARRAY_TO_STRING(reason_codes, ', ') AS reason_codes,
  current_affiliate_id, current_affiliate_name, coverage_known,
  ARRAY_TO_STRING(coverage_warnings, ', ') AS coverage_warnings
FROM \`trader-scale-486213.trader_scale.rpt_withdrawable_profit_account_current\`
ORDER BY estimated_withdrawable_profit_usd DESC, account_id
`;

const WITHDRAWABLE_RUN_SQL = `
SELECT run_id, policy_version, status, CAST(completed_at AS STRING) AS completed_at,
  expected_account_count, result_account_count, unknown_account_count,
  financially_eligible_count, ready_account_count, pending_account_count,
  known_withdrawable_profit_usd, pending_overlap_usd, error_message
FROM \`trader-scale-486213.trader_scale.rpt_withdrawable_profit_current_run\`
LIMIT 1
`;

const RISK_FINDINGS_SQL = `
SELECT 'martingale' AS rule, breach_id, IF(sequence_length >= 3, 'Breach', 'Watch') AS severity, CAST(account_nr AS STRING) AS account_nr,
  customer_id, plan, symbol, CAST(wave_open_timestamp AS STRING) AS finding_at,
  CONCAT('Sequence ', CAST(sequence_length AS STRING), ' · risk ', CAST(wave_risk AS STRING)) AS evidence
FROM \`trader-scale-486213.trader_scale.rule04_martingale_daily\`
UNION ALL
SELECT 'loss_chasing', breach_id, 'Warning', CAST(account_nr AS STRING), customer_id, plan, symbol,
  CAST(wave_open_timestamp AS STRING), CONCAT('Sequence ', CAST(sequence_length AS STRING), ' · risk ', CAST(wave_risk AS STRING))
FROM \`trader-scale-486213.trader_scale.rule04b_loss_chasing_daily\`
UNION ALL
SELECT 'grid', breach_id, 'Breach', CAST(account_nr AS STRING), customer_id, plan, symbol,
  CAST(grid_open_timestamp AS STRING), CONCAT(CAST(grid_orders AS STRING), ' grid orders')
FROM \`trader-scale-486213.trader_scale.rule05_grid_daily\`
UNION ALL
SELECT 'adding_in_drawdown', breach_id, 'Breach', CAST(account_nr AS STRING), customer_id, plan, symbol,
  CAST(open_timestamp AS STRING), CONCAT(CAST(adds_in_episode AS STRING), ' adds · risk ', CAST(combined_floating_risk AS STRING))
FROM \`trader-scale-486213.trader_scale.rule06_adding_in_drawdown_daily\`
UNION ALL
SELECT 'one_sided', breach_id, IF(dir_flag OR dispersion_flag, 'Review', 'Watch'), CAST(account_nr AS STRING), customer_id, plan, NULL,
  NULL, CONCAT(CAST(trades AS STRING), ' trades · bias ', CAST(directional_bias AS STRING))
FROM \`trader-scale-486213.trader_scale.rule09_one_sided_daily\`
UNION ALL
SELECT 'expert_advisor', breach_id, 'Breach', CAST(account_nr AS STRING), customer_id, plan, symbol,
  CAST(open_timestamp AS STRING), CONCAT('EA ', CAST(expert_id AS STRING), ' · risk ', CAST(risk_pct AS STRING))
FROM \`trader-scale-486213.trader_scale.rule10_expert_advisor_daily\`
UNION ALL
SELECT 'hedge_trading', CONCAT('hedge:', COALESCE(customer_id, ''), ':', COALESCE(CAST(buy_account AS STRING), ''), ':', COALESCE(CAST(sell_account AS STRING), ''), ':', COALESCE(symbol, ''), ':', COALESCE(CAST(buy_position_id AS STRING), ''), ':', COALESCE(CAST(sell_position_id AS STRING), '')),
  'Breach', CAST(buy_account AS STRING), customer_id, buy_plan, symbol,
  CAST(buy_open_timestamp AS STRING), CONCAT('Overlap ', CAST(overlap_seconds AS STRING), ' sec')
FROM \`trader-scale-486213.trader_scale.rule12_hedge_trading_daily\`
UNION ALL
SELECT 'daily_loss_risk', breach_id, 'Breach', CAST(account_nr AS STRING), customer_id, plan, symbol,
  CAST(open_timestamp AS STRING), CONCAT(trigger, ' · risk ', CAST(risk_pct AS STRING), ' / limit ', CAST(limit_pct AS STRING))
FROM \`trader-scale-486213.trader_scale.rule13_daily_loss_risk_daily\`
UNION ALL
SELECT 'toxic', breach_id,
  CASE WHEN toxic_profit_pct > 60 THEN 'Breach' WHEN toxic_profit_pct > 0 THEN 'Deduction' ELSE 'Watch' END,
  CAST(account_nr AS STRING), customer_id, plan, NULL, NULL,
  CONCAT(CAST(neg_rr_trades AS STRING), ' negative-RR trades · toxic profit ', CAST(toxic_profit_pct AS STRING), '%')
FROM \`trader-scale-486213.trader_scale.rule15_toxic_daily\`
`;

export async function buildSnapshot(serviceAccountJson: string) {
  if (!serviceAccountJson) throw new Error("BigQuery secret is not configured.");
  const credential = JSON.parse(serviceAccountJson) as ServiceAccount;
  if (credential.project_id !== "trader-scale-486213") throw new Error("Unexpected Google Cloud project.");
  const token = await accessToken(credential);
  const [accountRows, payoutRows] = await Promise.all([
    query(credential, token, ACCOUNTS_SQL),
    query(credential, token, PAYOUTS_SQL),
  ]);
  const [orderResult, profitabilityResult, affiliateResult, affiliatePnlResult, customerResult, tradeResult,
    marketingChannelResult, marketingCampaignResult, marketingAttributionResult, marketingLtvResult,
    withdrawableResult, withdrawableRunResult, riskFindingsResult, rebuyResult] = await Promise.all([
    optionalQuery(credential, token, "Canonical orders", ORDERS_SQL),
    optionalQuery(credential, token, "Attempt profitability", PROFITABILITY_SQL),
    optionalQuery(credential, token, "Affiliate attribution", AFFILIATES_SQL),
    optionalQuery(credential, token, "Released affiliate P&L", AFFILIATE_PNL_SQL),
    optionalQuery(credential, token, "Commerce customers", CUSTOMERS_SQL),
    optionalQuery(credential, token, "Account trade history", TRADES_SQL),
    optionalQuery(credential, token, "ThoughtMetric channels", THOUGHTMETRIC_CHANNEL_SQL),
    optionalQuery(credential, token, "ThoughtMetric campaigns", THOUGHTMETRIC_CAMPAIGN_SQL),
    optionalQuery(credential, token, "ThoughtMetric attribution", THOUGHTMETRIC_ATTRIBUTION_SQL),
    optionalQuery(credential, token, "ThoughtMetric customer LTV", THOUGHTMETRIC_LTV_SQL),
    optionalQuery(credential, token, "Withdrawable profit", WITHDRAWABLE_SQL),
    optionalQuery(credential, token, "Withdrawable profit run", WITHDRAWABLE_RUN_SQL),
    optionalQuery(credential, token, "Risk findings", RISK_FINDINGS_SQL),
    optionalQuery(credential, token, "Breach to rebuy", REBUY_SQL),
  ]);
  const orderRows = orderResult.rows;
  const profitabilityRows = profitabilityResult.rows;
  const affiliateRows = affiliateResult.rows;
  const affiliatePnlRows = affiliatePnlResult.rows;
  const customerRows = customerResult.rows;
  const tradeRows = tradeResult.rows;
  const tradeByAccount = new Map(tradeRows.map((row) => [text(row.account_id), row]));
  const queryErrors = [orderResult.error, profitabilityResult.error, affiliateResult.error, affiliatePnlResult.error, customerResult.error, tradeResult.error,
    marketingChannelResult.error, marketingCampaignResult.error, marketingAttributionResult.error, marketingLtvResult.error,
    withdrawableResult.error, withdrawableRunResult.error, riskFindingsResult.error, rebuyResult.error].filter(Boolean);

  const accounts = accountRows.map((row) => {
    const trade = tradeByAccount.get(text(row.account_id));
    const initialBalance = optionalNumber(row.start_balance);
    const balance = optionalNumber(row.current_balance);
    const equity = optionalNumber(row.current_equity) ?? balance;
    const realizedPnl = trade ? optionalNumber(trade.net_realized) : null;
    const stage = accountStage(row);
    const status = accountStatus(row);
    const share = optionalNumber(row.profit_share_percentage);
    const planSize = productSize(row);
    return {
      id: text(row.account_id), login: text(row.account_login), orderId: "",
      customerId: text(row.customer_id),
      customerName: text(row.customer_name, text(row.customer_nr, "Unknown customer")),
      programme: productPlan(row, initialBalance), programmeFamily: programmeFamily(row),
      plan: text(row.plan, text(row.plan_category_name)), planCategory: text(row.plan_category_name), platform: platform(row),
      accountSize: planSize || initialBalance, accountSizeSource: planSize ? "plan-derived" : initialBalance ? "evidenced-start-balance" : "unknown",
      country: text(row.country, "Unknown"), channel: "Unknown",
      openedAt: date(row.created_at), breachedAt: text(row.breached_at), stage, status,
      initialBalance, balance, equity, realizedPnl, openPnl: balance !== null && equity !== null ? equity - balance : null,
      dailyStartEquity: equity, dailyDrawdownUsed: null, dailyDrawdownLimit: null,
      maxDrawdownUsed: null, maxDrawdownLimit: null,
      dailyHeadroom: null, maxHeadroom: null, profitTarget: null, profitTargetRemaining: null,
      rewardShare: share === null ? null : share > 1 ? share / 100 : share,
      payoutAccrued: null as number | null, payoutApproved: number(row.approved_unpaid), payoutPaid: number(row.paid_total),
      eligibleNow: false, riskLevel: stage === "Breached" ? "High" : "Normal",
      riskReason: stage === "Breached" ? "Account is marked breached in the warehouse." : "No live detector severity is joined to this account snapshot.",
      tradeCount: trade ? optionalNumber(trade.trade_count) : null,
      winRate: trade ? optionalNumber(trade.win_rate) : null,
      largestTrade: trade ? number(trade.largest_trade) : 0,
      assetFocus: trade ? text(trade.top_symbol, "—") : "—",
      tradeNetRealized: trade ? number(trade.net_realized) : null,
      firstClosedTradeAt: trade ? date(trade.first_closed_trade_at) : "",
      lastClosedTradeAt: trade ? date(trade.last_closed_trade_at) : "",
      tradeHistoryAvailable: Boolean(trade), consistency: optionalNumber(row.consistency_percentage), profitDays: null as number | null,
      challengeFormat: challengeFormat(row), phase: challengePhase(row, stage), snapshotAt: date(row.snapshot_at),
      daysSinceOpen: Math.max(0, Math.floor((Date.now() - Date.parse(`${date(row.created_at)}T00:00:00Z`)) / 86400000)),
      demoRules: false,
    };
  });

  const payouts = payoutRows.map((row) => {
    const status = payoutStatus(row.status);
    const approvedAt = ["Approved", "Paid"].includes(status) ? date(row.approved_at) : "";
    const rejectedAt = status === "Rejected" ? date(row.updated_at) : "";
    return {
      id: text(row.payout_id, text(row.payout_nr)), customerId: text(row.commerce_customer_key, text(row.customer_id)),
      customerName: text(row.customer_name, "Unknown customer"), account: text(row.account_login),
      accountId: text(row.account_id),
      programme: productPlan({ plan: row.account_plan, plan_category_name: row.account_plan_category_name, platform: row.platform }, row.start_balance),
      programmeFamily: programmeFamily({ plan: row.account_plan, plan_category_name: row.account_plan_category_name }),
      plan: text(row.account_plan, text(row.account_plan_category_name)), platform: platform({ platform: row.platform, plan: row.account_plan }),
      accountSize: number(row.start_balance),
      country: text(row.country, "Unknown"), channel: "Unknown",
      amount: number(row.share_amount || row.request_amount), requestedAt: date(row.requested_at),
      status, method: "Restricted", approvedAt,
      paidAt: status === "Paid" ? date(row.updated_at) : "",
      rejectedAt,
      decisionAt: approvedAt || rejectedAt,
    };
  });

  const orders = orderRows.map((row) => ({
    id: `${text(row.store_id)}:${text(row.order_id)}`,
    orderNumber: text(row.order_number), date: date(row.order_reporting_date),
    customerId: text(row.customer_key), country: text(row.billing_country, "Unknown"),
    status: text(row.status), revenueEligible: row.is_revenue_eligible === true || text(row.is_revenue_eligible) === "true",
    grossRevenue: number(row.gross_revenue_usd), refunded: number(row.refunded_usd),
    netRevenue: number(row.net_revenue_usd), isNewCustomer: row.is_new_customer === true || text(row.is_new_customer) === "true",
    productName: text(row.product_name),
    programme: row.product_name ? productPlan({ plan: row.product_name }) : "Unknown",
    programmeFamily: row.product_name ? programmeFamily({ plan: row.product_name }) : "Unknown",
    platform: row.product_name ? platform({ plan: row.product_name }) : "",
    accountSize: row.product_name ? productSize({ plan: row.product_name }) : 0,
    statusPolicyVersion: text(row.status_policy_version),
  }));

  const eligibleOrders = orders.filter((row) => row.revenueEligible);
  const maxOrderDate = orders.map((row) => row.date).filter(Boolean).sort().at(-1) || "unknown";
  const maxEligibleOrderDate = eligibleOrders.map((row) => row.date).filter(Boolean).sort().at(-1) || "unknown";

  const profitability = profitabilityRows.map((row) => ({
    date: date(row.attempt_started_at_date),
    programme: productPlan(row, row.plan_size), programmeFamily: programmeFamily(row), plan: text(row.plan),
    platform: platform(row), accountSize: number(row.plan_size), attempts: number(row.attempts),
    fundedAttempts: number(row.funded_attempts), revenue: number(row.revenue), discount: number(row.discount),
    payoutCount: number(row.payout_count), payouts: number(row.payouts), grossProfit: number(row.gross_profit),
  }));

  const affiliates = affiliateRows.map((row) => ({
    storeId: text(row.store_id), orderId: text(row.order_id), date: date(row.order_reporting_date),
    id: text(row.affiliate_id).trim(), name: text(row.affiliate_name).trim(), status: text(row.attribution_status).trim().toLowerCase(),
    customerId: text(row.customer_id), isNewCustomer: row.is_new_customer_order === true || text(row.is_new_customer_order) === "true",
    accountIds: Array.isArray(row.account_ids)
      ? row.account_ids.map((value) => text(value && typeof value === "object" && "v" in value ? value.v : value)).filter(Boolean)
      : [],
    grossRevenue: number(row.gross_revenue), netRevenue: number(row.net_revenue),
    hasConflict: row.has_conflict === true || text(row.has_conflict) === "true",
  }));

  const affiliatePnl = affiliatePnlRows.map((row) => {
    const componentType = text(row.component_type).trim().toLowerCase();
    const productName = text(row.product_name);
    return {
      date: date(row.reporting_date), componentType, allocationBucket: text(row.allocation_bucket).trim().toLowerCase(),
      storeId: text(row.store_id), orderId: text(row.order_id),
      affiliateId: text(row.affiliate_id).trim(), affiliateName: text(row.affiliate_name).trim(),
      customerId: text(row.customer_id), customerType: text(row.customer_type).trim().toLowerCase(),
      amount: componentType === "commission" ? number(row.recognized_amount_usd) : number(row.amount_usd),
      amountKnown: row.amount_known === null || row.amount_known === undefined || text(row.amount_known) === ""
        ? null
        : row.amount_known === true || text(row.amount_known).toLowerCase() === "true",
      completenessStatus: text(row.completeness_status),
      productName, programme: productName ? productPlan({ plan: productName }) : "Unknown",
      programmeFamily: productName ? programmeFamily({ plan: productName }) : "Unknown",
      platform: productName ? platform({ plan: productName }) : "",
      accountSize: productName ? productSize({ plan: productName }) : 0,
      country: text(row.billing_country, "Unknown"),
    };
  });

  const customers = customerRows.map((row) => ({
    id: text(row.commerce_customer_key), name: text(row.full_name, "No live data"),
    warehouseCustomerId: text(row.warehouse_customer_id), warehouseCustomerNr: text(row.warehouse_customer_nr),
    woocommerceCustomerId: text(row.woocommerce_customer_id),
    country: text(row.country, "No live data"), status: text(row.status, "No live data"),
    identitySource: text(row.identity_source), accountCount: number(row.account_count),
    orderCount: number(row.order_count), completedOrderCount: number(row.completed_order_count),
    firstOrderAt: date(row.first_order_at), lastOrderAt: date(row.last_order_at),
    registeredAt: text(row.registered_at), hasGuestOrder: row.has_guest_order === true || text(row.has_guest_order) === "true",
    woocommerceRegistered: row.is_woocommerce_registered === true || text(row.is_woocommerce_registered) === "true",
    registrationSource: text(row.warehouse_customer_id) ? "Axcera" : text(row.woocommerce_customer_id) ? "WooCommerce" : "Unknown",
    refreshedAt: text(row.refreshed_at),
    revenue: number(row.revenue_usd), allStatusOrderValue: number(row.all_status_order_value_usd),
    kycVerified: row.kyc_verified === true || text(row.kyc_verified) === "true",
  }));

  const marketingModels = Array.from(new Set([
    ...marketingChannelResult.rows, ...marketingCampaignResult.rows,
    ...marketingAttributionResult.rows, ...marketingLtvResult.rows,
  ].map((row) => text(row.model).trim()).filter(Boolean)));
  const marketingModel = marketingModels.find((value) => /^mixed$/i.test(value))
    || marketingModels.find((value) => /mixed|multi|fraction/i.test(value))
    || marketingModels[0] || "mixed";
  const selectedMarketingRows = <T extends Record<string, unknown>>(rows: T[]) => rows.filter((row) => text(row.model) === marketingModel);
  const attributionRows = selectedMarketingRows(marketingAttributionResult.rows).map((row) => ({
    date: date(row.conversion_date), model: text(row.model), channel: text(row.channel, "Unknown"),
    paidChannel: text(row.paid_channel, "other"), conversionCredit: number(row.conversion_credit),
    attributedRevenue: number(row.attributed_revenue), canonicalMatchedRevenue: number(row.canonical_matched_revenue),
    attributedOrders: number(row.attributed_orders), matchedOrders: number(row.matched_orders),
    newCustomers: number(row.new_customers),
  }));
  const attributionByDateChannel = new Map<string, typeof attributionRows[number]>();
  attributionRows.forEach((row) => {
    const key = `${row.date}|${row.channel}`;
    const current = attributionByDateChannel.get(key);
    attributionByDateChannel.set(key, current ? {
      ...current,
      conversionCredit: current.conversionCredit + row.conversionCredit,
      attributedRevenue: current.attributedRevenue + row.attributedRevenue,
      canonicalMatchedRevenue: current.canonicalMatchedRevenue + row.canonicalMatchedRevenue,
      attributedOrders: current.attributedOrders + row.attributedOrders,
      matchedOrders: current.matchedOrders + row.matchedOrders,
      newCustomers: current.newCustomers + row.newCustomers,
    } : row);
  });
  const marketingChannels = selectedMarketingRows(marketingChannelResult.rows).map((row) => {
    const actual = attributionByDateChannel.get(`${date(row.reporting_date)}|${text(row.channel, "Unknown")}`);
    const spend = number(row.converted_spend);
    const conversions = number(row.orders);
    const newCustomers = number(row.new_customers);
    const revenue = actual ? actual.canonicalMatchedRevenue : 0;
    return {
      projectId: text(row.project_id), date: date(row.reporting_date), currency: text(row.reporting_currency, "USD"),
      timezone: text(row.reporting_timezone), model: text(row.model), channel: text(row.channel, "Unknown"),
      paidChannel: text(row.paid_channel, "other"), nativeSpend: optionalNumber(row.native_spend), spend,
      conversions, newCustomers, vendorNewCustomerOrders: number(row.new_customer_orders),
      vendorRevenue: number(row.net_sales), canonicalMatchedRevenue: revenue,
      visits: number(row.visits), conversionRate: optionalNumber(row.conversion_rate),
      roas: spend ? revenue / spend : null, cpa: spend && conversions ? spend / conversions : null,
      ncac: spend && newCustomers ? spend / newCustomers : null,
      attributionLoadedAt: text(row.attribution_loaded_at), deliveryLoadedAt: text(row.delivery_loaded_at),
      matchedOrders: actual ? actual.matchedOrders : 0, attributedOrders: actual ? actual.attributedOrders : 0,
    };
  });
  const marketingCampaigns = selectedMarketingRows(marketingCampaignResult.rows).map((row) => {
    const spend = number(row.converted_spend), leads = number(row.leads), conversions = number(row.orders);
    const vendorRevenue = number(row.net_sales), newCustomerOrders = number(row.new_customer_orders);
    return {
      projectId: text(row.project_id), date: date(row.reporting_date), currency: text(row.reporting_currency, "USD"),
      timezone: text(row.reporting_timezone), model: text(row.model), campaignScope: text(row.campaign_scope),
      accountId: text(row.account_id), platform: text(row.platform, "unknown"), paidPlatform: text(row.paid_platform, "other"),
      campaignId: text(row.campaign_id), campaignName: text(row.campaign_name, "Unnamed campaign"),
      nativeSpend: optionalNumber(row.native_spend), spend, impressions: number(row.impressions), clicks: number(row.clicks),
      ctr: optionalNumber(row.ctr), cpc: optionalNumber(row.cpc), cpm: optionalNumber(row.cpm), visits: number(row.visits),
      totalDuration: number(row.total_duration), totalPageviews: number(row.total_pageviews),
      averageDuration: optionalNumber(row.avg_duration), averagePageviews: optionalNumber(row.avg_pageviews),
      conversions, addToCarts: number(row.add_to_carts), leads, cpl: spend && leads ? spend / leads : null,
      grossSales: number(row.gross_sales), discounts: number(row.total_discounts), refunds: number(row.total_refund),
      totalSales: number(row.total_sales), vendorRevenue, shipping: number(row.total_shipping), tax: number(row.total_tax),
      netProfit: number(row.net_profit), itemsSold: number(row.item_quantity), averageOrderValue: optionalNumber(row.aov),
      conversionRate: optionalNumber(row.conversion_rate), newCustomerOrders,
      newCustomerRevenue: number(row.new_customer_total_sales), returningCustomerOrders: number(row.returning_customer_orders),
      returningCustomerRevenue: number(row.returning_customer_total_sales),
      cpa: spend && conversions ? spend / conversions : null,
      ncac: spend && newCustomerOrders ? spend / newCustomerOrders : null,
      vendorRoas: spend ? vendorRevenue / spend : null,
      attributionLoadedAt: text(row.attribution_loaded_at), deliveryLoadedAt: text(row.delivery_loaded_at),
    };
  });
  const marketingLtv = selectedMarketingRows(marketingLtvResult.rows).map((row) => ({
    projectId: text(row.project_id), model: text(row.model), channel: text(row.channel, "Unknown"),
    paidChannel: text(row.paid_channel, "other"), acquisitionDate: date(row.acquisition_date),
    acquisitionOrderId: text(row.acquisition_order_id), customerId: text(row.customer_id),
    acquisitionCredit: number(row.acquisition_credit), initialRevenue: number(row.initial_revenue),
    repeatRevenue: number(row.repeat_revenue), totalCustomerLtv: number(row.total_customer_ltv),
  }));
  const marketingDates = marketingChannels.map((row) => row.date).filter(Boolean).sort();
  const marketing = {
    provider: "ThoughtMetric", model: marketingModel, availableModels: marketingModels,
    currency: "USD", revenueBasis: "Canonical matched revenue",
    coverageStart: marketingDates[0] || "", coverageEnd: marketingDates.at(-1) || "",
    channels: marketingChannels, campaigns: marketingCampaigns,
    attribution: attributionRows, customerLtv: marketingLtv,
  };

  const liveAccountById = new Map(accounts.map((row) => [row.id, row]));
  const liveAccountByLogin = new Map(accounts.map((row) => [String(row.login), row]));
  const withdrawableAccounts = withdrawableResult.rows.map((row) => {
    const account = liveAccountById.get(text(row.account_id)) || liveAccountByLogin.get(text(row.account_nr));
    return {
      runId: text(row.run_id), policyVersion: text(row.policy_version), calculatedAt: text(row.calculated_at),
      sourceAsOf: text(row.source_as_of), accountId: text(row.account_id), accountNr: text(row.account_nr),
      customerId: text(row.customer_id), customerNr: text(row.customer_nr), customerName: text(row.customer_name, "Unknown customer"),
      accountStatus: text(row.account_status), active: row.is_active === true || text(row.is_active) === "true",
      funded: row.is_funded === true || text(row.is_funded) === "true", breached: row.is_breached === true || text(row.is_breached) === "true",
      programme: account?.programme || text(row.plan_family, "Unknown"), plan: text(row.plan_label, text(row.raw_plan)),
      accountSize: optionalNumber(row.start_balance_usd) ?? optionalNumber(row.account_size_label) ?? account?.accountSize ?? 0,
      country: account?.country || "Unknown", channel: account?.channel || "Unknown",
      currency: text(row.currency, "USD"), pendingPayoutId: text(row.pending_payout_id), pendingPayout: number(row.pending_payout_amount_usd),
      realizedProfit: number(row.realized_cycle_profit_usd), balance: optionalNumber(row.current_balance_usd),
      equity: optionalNumber(row.current_equity_usd), equitySupportedProfit: number(row.equity_supported_profit_usd),
      eligibleProfitBeforeRules: number(row.eligible_profit_before_rules_usd), minimumProfit: number(row.minimum_profit_usd),
      profitSharePercentage: optionalNumber(row.profit_share_percentage), tradingDaysActual: number(row.trading_days_actual),
      tradingDaysRequired: number(row.trading_days_required), consistencyType: text(row.consistency_type),
      consistencyActual: optionalNumber(row.consistency_actual_percentage), consistencyRequired: optionalNumber(row.consistency_required_percentage),
      openLots: number(row.open_lots), kycStatus: text(row.kyc_status), riskState: text(row.risk_state, "Unknown"),
      riskDetectionCount: number(row.risk_detection_count), financiallyEligible: row.financially_eligible === true || text(row.financially_eligible) === "true",
      readyToRequest: row.ready_to_request === true || text(row.ready_to_request) === "true",
      estimatedWithdrawable: number(row.estimated_withdrawable_profit_usd), primaryStatus: text(row.primary_status),
      reasonCodes: text(row.reason_codes), affiliateId: text(row.current_affiliate_id), affiliateName: text(row.current_affiliate_name),
      coverageKnown: row.coverage_known === true || text(row.coverage_known) === "true", coverageWarnings: text(row.coverage_warnings),
    };
  });
  const runRow = withdrawableRunResult.rows[0] || {};
  const withdrawableRun = {
    runId: text(runRow.run_id), policyVersion: text(runRow.policy_version), status: text(runRow.status), completedAt: text(runRow.completed_at),
    expectedAccounts: number(runRow.expected_account_count), resultAccounts: number(runRow.result_account_count), unknownAccounts: number(runRow.unknown_account_count),
    financiallyEligibleAccounts: number(runRow.financially_eligible_count), readyAccounts: number(runRow.ready_account_count), pendingAccounts: number(runRow.pending_account_count),
    knownWithdrawableProfit: number(runRow.known_withdrawable_profit_usd), pendingOverlap: number(runRow.pending_overlap_usd), error: text(runRow.error_message),
  };
  withdrawableAccounts.forEach((row) => {
    const account = liveAccountById.get(row.accountId) || liveAccountByLogin.get(row.accountNr);
    if (!account) return;
    account.consistency = row.consistencyActual;
    account.profitDays = row.tradingDaysActual;
    account.payoutAccrued = row.estimatedWithdrawable;
    account.eligibleNow = row.readyToRequest;
    account.riskLevel = row.riskDetectionCount > 0 || !["", "normal", "clear", "none"].includes(row.riskState.toLowerCase()) ? "High" : "Normal";
    account.riskReason = row.riskDetectionCount > 0
      ? `${row.riskDetectionCount} live detector finding${row.riskDetectionCount === 1 ? "" : "s"}; state ${row.riskState}.`
      : `Released risk state: ${row.riskState}.`;
  });
  const mappedRiskFindings = riskFindingsResult.rows.map((row) => {
    const account = liveAccountByLogin.get(text(row.account_nr));
    return {
      id: text(row.breach_id), rule: text(row.rule), severity: text(row.severity, "Review"), accountNr: text(row.account_nr),
      accountId: account?.id || "", customerId: text(row.customer_id, account?.customerId || ""),
      customerName: account?.customerName || "Unknown customer", programme: account?.programme || text(row.plan, "Unknown"),
      accountSize: account?.accountSize || 0, country: account?.country || "Unknown", channel: account?.channel || "Unknown",
      symbol: text(row.symbol), findingAt: text(row.finding_at), evidence: text(row.evidence),
    };
  });
  const riskFindings = Array.from(new Map(mappedRiskFindings.map((row) => [`${row.rule}|${row.id}`, row])).values());
  const rebuy = rebuyResult.rows.map((row) => {
    const account = liveAccountById.get(text(row.account_id)) || liveAccountByLogin.get(text(row.account_nr));
    const seconds = optionalNumber(row.rebuy_seconds);
    return {
      accountId: text(row.account_id), accountNr: text(row.account_nr), customerId: text(row.customer_id),
      customerName: text(row.customer_name, account?.customerName || "Unknown customer"), country: text(row.country, account?.country || "Unknown"),
      programme: account?.programme || productPlan({ plan: row.plan, plan_category_name: row.plan_category_name, platform: row.platform }, row.start_balance),
      plan: text(row.plan_label, text(row.plan)), platform: platform({ platform: row.platform, plan: row.plan }),
      accountSize: optionalNumber(row.start_balance) ?? account?.accountSize ?? 0, currency: text(row.currency, "USD"),
      breachedAt: text(row.breached_at), observedAt: text(row.observed_at),
      rebuyStoreId: text(row.store_id), rebuyOrderId: text(row.order_id), rebuyAt: text(row.rebuy_at),
      rebuyRevenue: number(row.rebuy_revenue), rebuySeconds: seconds, rebuyDays: seconds === null ? null : seconds / 86400,
    };
  });

  const latestAffiliateRowDate = affiliates.map((row) => row.date).filter(Boolean).sort().at(-1) || "unknown";
  const latestAttributedAffiliateDate = affiliates.filter((row) => row.status === "attributed" && row.id !== "unattributed")
    .map((row) => row.date).filter(Boolean).sort().at(-1) || "unknown";

  return {
    schemaVersion: 1, mode: "production",
    asOf: new Date().toISOString().slice(0, 10), currency: "USD",
    quality: {
      profitabilityReady: !affiliatePnlResult.error || !profitabilityResult.error, revenueReady: !orderResult.error,
      affiliatesReady: !affiliateResult.error && !affiliatePnlResult.error,
      affiliatePnlReady: !affiliatePnlResult.error, customersReady: !customerResult.error,
      tradesReady: !tradeResult.error,
      marketingReady: !marketingChannelResult.error && !marketingCampaignResult.error && !marketingAttributionResult.error,
      withdrawableReady: !withdrawableResult.error,
      riskFindingsReady: !riskFindingsResult.error,
      journeyReady: !customerResult.error,
      rebuyReady: !rebuyResult.error,
      partial: queryErrors.length > 0,
      warnings: [
        "Live canonical orders, attempt profitability, affiliates, customers, accounts, payouts, account trades, ThoughtMetric paid marketing, withdrawable profit, customer journey, breach-to-rebuy and nine current risk detector snapshots are enabled.",
        `Loaded ${orders.length} canonical orders (${eligibleOrders.length} revenue eligible), ${customers.length} commerce customers, ${accounts.length} current account records, ${payouts.length} payout records and ${tradeRows.length} account trade aggregates.`,
        `Latest canonical order date: ${maxOrderDate}; latest revenue-eligible order date: ${maxEligibleOrderDate}.`,
        `Latest affiliate-source order date: ${latestAffiliateRowDate}; latest attributed affiliate order date: ${latestAttributedAffiliateDate}.`,
        `Loaded ${affiliatePnl.length} released Affiliate P&L component rows using accrued commission recognition.`,
        "Pricing and business-change screens remain unavailable because no complete approved production contracts exist.",
        ...queryErrors,
      ],
    },
    data: { accounts, payouts, orders, profitability, affiliates, affiliatePnl, customers, marketing,
      withdrawable: { accounts: withdrawableAccounts, run: withdrawableRun }, riskFindings, rebuy },
  };
}

export function affiliateSnapshotDiagnostics(snapshot: unknown) {
  const payload = snapshot as { quality?: unknown; data?: { affiliates?: Array<{ date?: string; status?: string; id?: string }> } };
  const rows = payload.data?.affiliates ?? [];
  const statusCounts: Record<string, number> = {};
  rows.forEach((row) => {
    const status = text(row.status, "unknown").trim().toLowerCase() || "unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });
  const latest = (source: typeof rows) => source.map((row) => text(row.date)).filter(Boolean).sort().at(-1) || "unknown";
  const attributed = rows.filter((row) => text(row.status).trim().toLowerCase() === "attributed" && text(row.id) !== "unattributed");
  const afterOctober21 = rows.filter((row) => text(row.date) > "2026-10-21");
  const afterStatusCounts: Record<string, number> = {};
  afterOctober21.forEach((row) => {
    const status = text(row.status, "unknown").trim().toLowerCase() || "unknown";
    afterStatusCounts[status] = (afterStatusCounts[status] || 0) + 1;
  });
  return {
    generatedAt: new Date().toISOString(), totalRows: rows.length,
    latestSourceOrderDate: latest(rows), latestAttributedOrderDate: latest(attributed),
    statusCounts, rowsAfterOctober21: afterOctober21.length, afterOctober21StatusCounts: afterStatusCounts,
    quality: payload.quality ?? {},
  };
}
