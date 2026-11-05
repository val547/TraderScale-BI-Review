import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const credentialPath = process.argv[2];
if (!credentialPath) throw new Error('Credential path is required.');

const credential = JSON.parse(await readFile(credentialPath, 'utf8'));
const now = Math.floor(Date.now() / 1000);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
  iss: credential.client_email,
  scope: 'https://www.googleapis.com/auth/bigquery.readonly',
  aud: credential.token_uri,
  iat: now,
  exp: now + 3600,
})}`;
const signer = createSign('RSA-SHA256');
signer.update(unsigned);
signer.end();
const assertion = `${unsigned}.${signer.sign(credential.private_key, 'base64url')}`;

const tokenResponse = await fetch(credential.token_uri, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }),
});
if (!tokenResponse.ok) throw new Error(`OAuth failed: ${tokenResponse.status}`);
const { access_token: accessToken } = await tokenResponse.json();

const queryResponse = await fetch(
  `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(credential.project_id)}/queries`,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: `SELECT
        (SELECT COUNT(*) FROM \`${credential.project_id}.trader_scale.src_prop_accounts\`) AS accounts,
        (SELECT COUNT(*) FROM \`${credential.project_id}.trader_scale.src_payouts\`) AS payouts,
        (SELECT COUNT(*) FROM \`${credential.project_id}.trader_scale.fct_commerce_orders\`) AS orders`,
      useLegacySql: false,
      location: 'europe-west3',
      timeoutMs: 20000,
    }),
  },
);
if (!queryResponse.ok) throw new Error(`BigQuery failed: ${queryResponse.status} ${await queryResponse.text()}`);
const result = await queryResponse.json();
if (!result.jobComplete) throw new Error('BigQuery smoke query did not complete synchronously.');
const values = result.rows?.[0]?.f?.map((cell) => Number(cell.v)) ?? [];
console.log(JSON.stringify({
  project: credential.project_id,
  serviceAccount: credential.client_email,
  tablesReadable: true,
  rowCounts: { accounts: values[0] ?? 0, payouts: values[1] ?? 0, orders: values[2] ?? 0 },
}));
