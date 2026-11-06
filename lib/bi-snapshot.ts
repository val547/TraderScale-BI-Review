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
        maximumBytesBilled: "2000000000",
      }),
    },
  );
  const payload = await response.json() as BigQueryResponse;
  if (!response.ok || !payload.jobComplete) {
    const message = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
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
      const message = page.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(message || `BigQuery page returned ${pageResponse.status}.`);
    }
    rows.push(...(page.rows ?? []));
    pageToken = page.pageToken;
  }
  return rows.map((row) => Object.fromEntries(
    fields.map((field, index) => [field.name, row.f[index]?.v ?? null]),
  ));
}

function number(value: unknown) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function text(value: unknown, fallback = "") {
  return value == null ? fallback : String(value);
}

function date(value: unknown) {
  return text(value).slice(0, 10);
}

function programme(row: Record<string, unknown>) {
  const source = `${text(row.plan)} ${text(row.plan_category_name)}`.toLowerCase();
  if (source.includes("one step") || source.includes("speedy")) return "Speedy";
  if (source.includes("two step") || source.includes("pro")) return "Pro";
  if (source.includes("instant")) return "Instant";
  if (source.includes("competition")) return "Classic";
  return text(row.plan_category_name, text(row.plan, "Other"));
}

function accountStage(row: Record<string, unknown>) {
  const source = `${text(row.status)} ${text(row.plan)} ${text(row.plan_category_name)}`.toLowerCase();
  if (row.breached_at || source.includes("breach")) return "Breached";
  if (source.includes("funded") || source.includes("live")) return "Funded";
  if (source.includes("pass")) return "Passed";
  return "Evaluation";
}

function accountStatus(row: Record<string, unknown>) {
  const source = text(row.status).toLowerCase();
  if (row.breached_at || source.includes("breach")) return "Breached";
  if (source.includes("clos") || source.includes("disable") || source.includes("inactive")) return "Closed";
  return "Active";
}

function payoutStatus(value: unknown) {
  const source = text(value).toLowerCase();
  if (source.includes("paid") || source.includes("complete") || source.includes("processed")) return "Paid";
  if (source.includes("approv")) return "Approved";
  return "Under review";
}

const ACCOUNTS_SQL = `
WITH latest_accounts AS (
  SELECT account_id, account_nr, customer_id, status, platform, plan,
    plan_category_name, current_equity, current_balance, profit,
    breached_at, created_at, updated_at
  FROM \`trader-scale-486213.trader_scale.src_prop_accounts\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id
    ORDER BY etl_updated_at DESC, etl_loaded_at DESC, updated_at DESC, created_at DESC
  ) = 1
), latest_details AS (
  SELECT account_id, start_balance, currency, profit_share_percentage
  FROM \`trader-scale-486213.trader_scale.src_prop_accounts_detail\`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY account_id ORDER BY fetched_at DESC, updated_at DESC, created_at DESC
  ) = 1
), latest_analytics AS (
  SELECT account_id, first_trade_date,
    SAFE_CAST(total_trades AS INT64) AS total_trades,
    SAFE_CAST(win_rate AS FLOAT64) AS win_rate,
    SAFE_CAST(net_profit AS NUMERIC) AS net_profit
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
  a.status, a.platform, a.plan, a.plan_category_name, d.start_balance,
  d.currency, d.profit_share_percentage, a.current_balance, a.current_equity,
  a.profit, x.first_trade_date, x.total_trades, x.win_rate, x.net_profit,
  a.breached_at, a.created_at, a.updated_at,
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
)
SELECT p.payout_id, p.payout_nr, p.customer_id,
  c.full_name AS customer_name, c.country, p.account_id,
  CAST(p.account_num AS STRING) AS account_login, p.status,
  p.request_amount, p.share_amount, p.account_currency,
  p.account_plan, p.account_plan_category_name,
  p.created_at AS requested_at, p.approved_at, p.updated_at
FROM latest_payouts AS p
LEFT JOIN latest_customers AS c USING (customer_id)
ORDER BY p.created_at DESC
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

  const accounts = accountRows.map((row) => {
    const initialBalance = number(row.start_balance);
    const balance = number(row.current_balance);
    const equity = number(row.current_equity || row.current_balance);
    const realizedPnl = number(row.net_profit || row.profit);
    const stage = accountStage(row);
    const status = accountStatus(row);
    const share = number(row.profit_share_percentage);
    return {
      id: text(row.account_id), login: text(row.account_login), orderId: "",
      customerId: text(row.customer_id),
      customerName: text(row.customer_name, text(row.customer_nr, "Unknown customer")),
      programme: programme(row), accountSize: initialBalance,
      country: text(row.country, "Unknown"), channel: "Unknown",
      openedAt: date(row.created_at), stage, status,
      initialBalance, balance, equity, realizedPnl, openPnl: equity - balance,
      dailyStartEquity: equity, dailyDrawdownUsed: 0, dailyDrawdownLimit: 0,
      maxDrawdownUsed: Math.max(0, initialBalance - equity), maxDrawdownLimit: 0,
      dailyHeadroom: 0, maxHeadroom: 0, profitTarget: 0, profitTargetRemaining: 0,
      rewardShare: share > 1 ? share / 100 : share,
      payoutAccrued: 0, payoutApproved: number(row.approved_unpaid), payoutPaid: number(row.paid_total),
      eligibleNow: false, riskLevel: stage === "Breached" ? "High" : "Normal",
      riskReason: stage === "Breached" ? "Account is marked breached in the warehouse." : "No live detector severity is joined to this account snapshot.",
      tradeCount: number(row.total_trades), winRate: number(row.win_rate), largestTrade: 0,
      assetFocus: "—", consistency: 0, profitDays: 0,
      daysSinceOpen: Math.max(0, Math.floor((Date.now() - Date.parse(`${date(row.created_at)}T00:00:00Z`)) / 86400000)),
      demoRules: false,
    };
  });

  const payouts = payoutRows.map((row) => ({
    id: text(row.payout_id, text(row.payout_nr)), customerId: text(row.customer_id),
    customerName: text(row.customer_name, "Unknown customer"), account: text(row.account_login),
    accountId: text(row.account_id),
    programme: programme({ plan: row.account_plan, plan_category_name: row.account_plan_category_name }),
    country: text(row.country, "Unknown"), channel: "Unknown",
    amount: number(row.share_amount || row.request_amount), requestedAt: text(row.requested_at),
    status: payoutStatus(row.status), method: "Restricted",
  }));

  return {
    schemaVersion: 1, mode: "production",
    asOf: new Date().toISOString().slice(0, 10), currency: "USD",
    quality: {
      profitabilityReady: false, partial: true,
      warnings: [
        "Live Account Analytics and Payouts are enabled.",
        `Loaded all ${accounts.length} current account records and all ${payouts.length} payout records returned by the warehouse.`,
        "Screens without a validated live source return No live data; demo and fallback values are disabled.",
      ],
    },
    data: { accounts, payouts },
  };
}
