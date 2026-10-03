import { pathToFileURL } from 'node:url';
export function validateStaging(env) {
  if (env.COOPENGINE_ENVIRONMENT !== 'isolated-staging') throw new Error('Explicit isolated-staging marker required');
  const db = new URL(env.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.hostname !== 'postgres' || db.port !== '5432' || db.pathname !== '/coopengine_staging' || !['staging_owner','staging_app'].includes(db.username)) throw new Error('Only the dedicated staging database/roles are allowed');
  for (const name of ['TERMII_API_KEY','SMTP_HOST','SMTP_USER','SMTP_PASS','SMILE_ID_API_KEY','MONNIFY_API_KEY','MONNIFY_CONTRACT_CODE','PAYSTACK_SECRET_KEY']) {
    if (env[name]) throw new Error(`External provider configuration is forbidden: ${name}`);
  }
  if (env.MEMBER_OTP_PROVIDER && env.MEMBER_OTP_PROVIDER !== 'dev') throw new Error('Only simulated OTP allowed');
  if (env.MONNIFY_PROVIDER && env.MONNIFY_PROVIDER !== 'dev') throw new Error('Only simulated payments allowed');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { validateStaging(process.env); console.log('Isolated staging configuration accepted'); }
  catch (error) { console.error(error.message); process.exit(1); }
}
