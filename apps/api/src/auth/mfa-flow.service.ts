import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { generateSecret, generateURI, verify } from 'otplib/functional';
import { MfaClock } from './mfa-clock';
import { DB_POOL } from '../database/database.module';

export const mfaDigest = (value: string) => createHash('sha256').update(value).digest('hex');
type Purpose = 'LOGIN' | 'ENROLL';
export interface MfaProof { authVersion: number; mfaVerified: boolean; challengeHash?: string; purpose?: Purpose; timeStep?: number; secretHash?: string; }
export interface MfaStart { mfaToken: string; enrollment?: { secret: string; otpauthUrl: string }; }

@Injectable()
export class MfaFlowService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool, private readonly clock: MfaClock) {}
  private invalid(): never { throw new UnauthorizedException('Verification expired, already used or invalid. Sign in again.'); }
  private async insert(client: PoolClient, user: { id: string; email: string; auth_version: number }, purpose: Purpose): Promise<MfaStart> {
    const token = randomBytes(32).toString('hex'); const secret = purpose === 'ENROLL' ? generateSecret() : null;
    await client.query(`INSERT INTO mfa_challenges(token_hash,user_id,auth_version,purpose,pending_secret,expires_at)
      VALUES ($1,$2,$3,$4,$5,clock_timestamp()+CASE WHEN $4='ENROLL' THEN interval '10 minutes' ELSE interval '5 minutes' END)`,
      [mfaDigest(token), user.id, user.auth_version, purpose, secret]);
    return { mfaToken: token, ...(secret ? { enrollment: { secret, otpauthUrl: generateURI({ secret, label: user.email, issuer: 'Co-opEngine' }) } } : {}) };
  }
  async start(userId: string, authVersion: number, purpose: Purpose): Promise<MfaStart> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = (await client.query("SELECT id,email,auth_version,mfa_enabled FROM users WHERE id=$1 AND status='ACTIVE' FOR NO KEY UPDATE", [userId])).rows[0];
      if (!user || user.auth_version !== authVersion || user.mfa_enabled !== (purpose === 'LOGIN')) this.invalid();
      const n = (await client.query("SELECT count(*)::int AS n FROM mfa_challenges WHERE user_id=$1 AND created_at>clock_timestamp()-interval '15 minutes'", [userId])).rows[0].n;
      if (n >= 5) throw new HttpException('Too many verification requests. Try again in 15 minutes.', 429);
      const result = await this.insert(client, user, purpose);
      await client.query("DELETE FROM mfa_challenges WHERE expires_at<clock_timestamp()-interval '1 day'");
      await client.query('COMMIT'); return result;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  private async attempt(hash: string, purpose: Purpose) {
    // This committed update counts wrong codes across API instances. Consumption
    // is separate and joins session/enrollment changes under the user lock.
    const row = (await this.pool.query(`UPDATE mfa_challenges SET attempts=attempts+1
      WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempts<5
      RETURNING user_id,auth_version,pending_secret`, [hash, purpose])).rows[0];
    if (!row) this.invalid(); return row;
  }
  async verify(token: string, code: string, purpose: Purpose): Promise<{ userId: string; proof: MfaProof }> {
    return this.verifyHash(mfaDigest(token), code, purpose);
  }
  private async verifyHash(hash: string, code: string, purpose: Purpose): Promise<{ userId: string; proof: MfaProof }> {
    const challenge = await this.attempt(hash, purpose);
    const user = (await this.pool.query("SELECT auth_version,mfa_enabled,mfa_secret FROM users WHERE id=$1 AND status='ACTIVE'", [challenge.user_id])).rows[0];
    if (!user || user.auth_version !== challenge.auth_version || user.mfa_enabled !== (purpose === 'LOGIN')) this.invalid();
    const secret = purpose === 'ENROLL' ? challenge.pending_secret : user.mfa_secret;
    const timeStep = secret ? await this.validStep(this.pool, challenge.user_id, secret, code) : null;
    if (timeStep === null) throw new UnauthorizedException('Invalid or already used authenticator code. Wait for the next code.');
    return { userId: challenge.user_id, proof: { authVersion: challenge.auth_version, mfaVerified: true, challengeHash: hash, purpose, timeStep, secretHash: mfaDigest(secret) } };
  }
  private async consumeChallenge(client: PoolClient, userId: string, proof: MfaProof) {
    if (!proof.challengeHash || !proof.purpose) this.invalid();
    const row = (await client.query(`UPDATE mfa_challenges SET consumed_at=clock_timestamp()
      WHERE token_hash=$1 AND user_id=$2 AND auth_version=$3 AND purpose=$4 AND consumed_at IS NULL
        AND expires_at>clock_timestamp() AND attempts BETWEEN 1 AND 5 RETURNING pending_secret`,
      [proof.challengeHash, userId, proof.authVersion, proof.purpose])).rows[0];
    if (!row) this.invalid();
    return row;
  }
  /** Caller holds the user lock; challenge, time-step claim and session commit together. */
  async finalize(client: PoolClient, userId: string, proof: MfaProof): Promise<string[] | undefined> {
    const row = await this.consumeChallenge(client, userId, proof);
    const user = (await client.query("SELECT mfa_secret,auth_version FROM users WHERE id=$1", [userId])).rows[0];
    const secret = proof.purpose === 'ENROLL' ? row.pending_secret : user?.mfa_secret;
    if (!secret || user.auth_version !== proof.authVersion || mfaDigest(secret) !== proof.secretHash ||
        !Number.isSafeInteger(proof.timeStep) || !await this.claimStep(client, userId, secret, proof.timeStep!)) this.invalid();
    if (proof.purpose === 'ENROLL') {
      await client.query('UPDATE users SET mfa_secret=$1,mfa_enabled=true,auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=$2', [row.pending_secret, userId]);
      await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
      await this.audit(client, userId, 'mfa.enabled');
      return this.codes(client, userId);
    }
  }
  private async codes(client: PoolClient, userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex').match(/.{8}/g)!.join('-'));
    await client.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
    for (const code of codes) await client.query('INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES ($1,$2)', [userId, mfaDigest(code.replace(/-/g, ''))]);
    await this.audit(client, userId, 'mfa.recovery_codes.generated'); return codes;
  }
  private async audit(client: PoolClient, userId: string, action: string) {
    await client.query(`INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'user',$1,'{}'::jsonb)`, [userId, action]);
  }
  async recover(token: string, code: string): Promise<MfaStart> {
    const hash = mfaDigest(token); const challenge = await this.attempt(hash, 'LOGIN');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = (await client.query("SELECT id,email,auth_version,mfa_enabled FROM users WHERE id=$1 AND status='ACTIVE' FOR NO KEY UPDATE", [challenge.user_id])).rows[0];
      if (!user || !user.mfa_enabled || user.auth_version !== challenge.auth_version) this.invalid();
      const claimed = await client.query(`UPDATE mfa_recovery_codes SET consumed_at=clock_timestamp()
        WHERE user_id=$1 AND code_hash=$2 AND consumed_at IS NULL RETURNING user_id`, [user.id, mfaDigest(code.replace(/-/g, '').toLowerCase())]);
      if (!claimed.rows[0]) this.invalid();
      // The backup-code claim above authorizes this limited recovery, not a TOTP proof.
      await this.consumeChallenge(client, user.id, { authVersion: user.auth_version, mfaVerified: true, challengeHash: hash, purpose: 'LOGIN' });
      await client.query('UPDATE users SET mfa_enabled=false,mfa_secret=NULL,auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=$1', [user.id]);
      await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [user.id]);
      await this.audit(client, user.id, 'mfa.recovered');
      // Recovery grants enrollment only. It never creates an ordinary session.
      const result = await this.insert(client, { ...user, auth_version: user.auth_version + 1 }, 'ENROLL');
      await client.query('COMMIT'); return result;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async verifyLatestSetup(userId: string, code: string): Promise<void> {
    const row = (await this.pool.query(`SELECT token_hash FROM mfa_challenges WHERE user_id=$1 AND purpose='ENROLL'
      AND consumed_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
    if (!row) this.invalid(); const { proof } = await this.verifyHash(row.token_hash, code, 'ENROLL');
    await this.change(userId, proof, 'enroll');
  }
  async change(userId: string, proof: MfaProof, action: 'codes' | 'disable' | 'enroll'): Promise<string[] | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = (await client.query("SELECT auth_version,mfa_enabled FROM users WHERE id=$1 AND status='ACTIVE' FOR NO KEY UPDATE", [userId])).rows[0];
      if (!user || user.auth_version !== proof.authVersion || user.mfa_enabled !== (action !== 'enroll')) this.invalid();
      const enrolledCodes = await this.finalize(client, userId, proof);
      let codes = enrolledCodes;
      if (action === 'codes') codes = await this.codes(client, userId);
      if (action === 'disable') {
        await client.query('UPDATE users SET mfa_enabled=false,mfa_secret=NULL,auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=$1', [userId]);
        await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
        await client.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
        await this.audit(client, userId, 'mfa.disabled');
      }
      await client.query('COMMIT'); return codes;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  private async validStep(db: Pool | PoolClient, userId: string, secret: string, code: string): Promise<number | null> {
    if (!/^\d{6}$/.test(code)) return null;
    const previous = (await db.query('SELECT last_step FROM mfa_used_steps WHERE user_id=$1 AND secret_hash=$2', [userId, mfaDigest(secret)])).rows[0];
    const result = await verify({ secret, token: code, epoch: this.clock.now(), ...(previous ? { afterTimeStep: Number(previous.last_step) } : {}) });
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  }
  private async claimStep(client: PoolClient, userId: string, secret: string, step: number): Promise<boolean> {
    const result = await client.query(`INSERT INTO mfa_used_steps(user_id,secret_hash,last_step) VALUES($1,$2,$3)
      ON CONFLICT(user_id) DO UPDATE SET secret_hash=EXCLUDED.secret_hash,last_step=EXCLUDED.last_step
      WHERE mfa_used_steps.secret_hash<>EXCLUDED.secret_hash OR mfa_used_steps.last_step<EXCLUDED.last_step RETURNING user_id`,
      [userId, mfaDigest(secret), step]);
    return result.rowCount === 1;
  }
  /** Persist failed attempts and successful claims even when the business action later fails. */
  async stepUp(userId: string, sessionId: string, organizationId: string, code: string, action: string): Promise<void> {
    const client = await this.pool.connect();
    let denial: ForbiddenException | HttpException | undefined;
    try {
      await client.query('BEGIN');
      const user = (await client.query("SELECT mfa_enabled,mfa_secret FROM users WHERE id=$1 AND status='ACTIVE' FOR NO KEY UPDATE", [userId])).rows[0];
      const session = (await client.query(`SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND organization_id=$3
        AND revoked_at IS NULL AND expires_at>clock_timestamp() AND mfa_verified=true`, [sessionId,userId,organizationId])).rows[0];
      if (!user) throw new UnauthorizedException('Session changed. Sign in again.');
      if (!user.mfa_enabled || !user.mfa_secret) throw new ForbiddenException({code:'STEP_UP_ENROLLMENT_REQUIRED',message:'Enable two-step verification before this action.'});
      if (!session) throw new UnauthorizedException('Session changed. Sign in again.');
      const count = (await client.query("SELECT count(*)::int AS n FROM mfa_stepup_failures WHERE user_id=$1 AND attempted_at>clock_timestamp()-interval '15 minutes'", [userId])).rows[0].n;
      if (count >= 5) denial = new HttpException({code:'STEP_UP_RATE_LIMITED',message:'Too many failed verification attempts. Try again in 15 minutes.'},429);
      else {
        const step = await this.validStep(client, userId, user.mfa_secret, code);
        if (step === null || !await this.claimStep(client,userId,user.mfa_secret,step)) {
          await client.query('INSERT INTO mfa_stepup_failures(user_id) VALUES($1)',[userId]);
          denial = new ForbiddenException({code:'STEP_UP_INVALID',message:'Invalid or already used code. Wait for the next authenticator code and try again.'});
        }
      }
      await client.query(`INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'user',$1,$3)`,[userId,denial?'stepup.failed':'stepup.verified',JSON.stringify({action,organizationId})]);
      await client.query("DELETE FROM mfa_stepup_failures WHERE attempted_at<clock_timestamp()-interval '1 day'");
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (denial) throw denial;
  }
  async assertCanSetup(userId: string): Promise<number> {
    const user = (await this.pool.query("SELECT auth_version,mfa_enabled FROM users WHERE id=$1 AND status='ACTIVE'", [userId])).rows[0];
    if (!user) this.invalid(); if (user.mfa_enabled) throw new ConflictException('Two-step verification is already enabled. Use a recovery code to replace the authenticator.');
    return user.auth_version;
  }
}
