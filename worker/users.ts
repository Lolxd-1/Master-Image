/**
 * Hardcoded user accounts (SPEC.md §2 — no signup, no password reset, no email).
 *
 * These are STARTER passwords, meant to be changed immediately after handover.
 * To add or rotate an account:
 *   1. Run: npm run user:add <username> <password> [admin|picker]
 *   2. Paste the printed line into the `users` record below, replacing any
 *      existing entry for that username.
 *   3. Redeploy (`npm run deploy`).
 *
 * Starter accounts (change these!):
 *   admin  / admin123    -> role admin
 *   store1 / store1pass  -> role picker
 *   store2 / store2pass  -> role picker
 *   store3 / store3pass  -> role picker
 *   store4 / store4pass  -> role picker
 */

export type Role = 'admin' | 'picker';

export interface UserRecord {
  /** Base64-encoded random salt (16 bytes), unique per user. */
  salt: string;
  /** Base64-encoded PBKDF2-SHA256 derived key (100000 iterations, 32 bytes). */
  hash: string;
  role: Role;
}

export const users: Record<string, UserRecord> = {
  admin: { salt: '2MqoeTy+MDHL3DWAdtm9Yw==', hash: 'hIVgesccK48iiDP1V4XEL1TFUuhqpjseDtiI2ZiF6+A=', role: 'admin' },
  store1: { salt: '2fEW1FRTYDfzwcDpE0WLWA==', hash: 'a1ii9C8tZwcovSwqDV/AAEaEZBASE7wsQsc5onF5x7g=', role: 'picker' },
  store2: { salt: 'oHPOA1UfbmplwR3N/JsPEw==', hash: 'yXByrX9ka2ErtPWn+xx4KPIpm3E4mbN0/Mp9CF3kCfo=', role: 'picker' },
  store3: { salt: 'i+IiH6tJVxrak44kzF+YVg==', hash: 'zaJOBPQC3iEZZyotpk3+/hD21eZmjZ/JvQ7tMCOSrvI=', role: 'picker' },
  store4: { salt: 'pcpaTv46RGU2kTMRcZRqbA==', hash: 'NbUShGfD7x/Ykex/OZstHu3LPUdleVT70N+2wf2JViM=', role: 'picker' },
};
