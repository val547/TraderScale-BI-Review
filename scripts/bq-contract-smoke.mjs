import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const credentialPath = process.argv[2];
if (!credentialPath) throw new Error('Credential path is required.');

const credential = JSON.parse(await readFile(credentialPath, 'utf8'));
const routeSource = await readFile(new URL('../app/api/bi/snapshot/route.ts', import.meta.url), 'utf8');
const sqlFor = (name) => {
  const tick = String.fromCharCode(96);
  const match = routeSource.match(new RegExp(`const ${name} = String\\.raw${tick}([\\s\\S]*?)${tick};`));
  if (!match) throw new Error(`Missing ${name}.`);
  return match[1].replaceAll('\\`', '`');
};

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

for (const name of ['ACCOUNTS_SQL', 'PAYOUTS_SQL']) {
  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(credential.project_id)}/queries`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: sqlFor(name),
        useLegacySql: false,
        location: 'europe-west3',
        timeoutMs: 25000,
        maximumBytesBilled: '2000000000',
      }),
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.jobComplete) {
    throw new Error(`${name}: ${payload.errors?.map((error) => error.message).join('; ') || response.status}`);
  }
  console.log(JSON.stringify({ query: name, rows: payload.totalRows ?? payload.rows?.length ?? 0, valid: true }));
}
