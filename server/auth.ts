import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'persona_session';
const OWNER_ID = 'owner';
const SCRYPT_BYTES = 64;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;
const MAX_LOGIN_ADDRESSES = 2048;
const MAX_SESSIONS = 100;

export type AuthUser = { id: string; username: string };
export type AuthOptions = { username: string; password: string };
export type LoginResult = { user: AuthUser; cookie: string } | { throttled: true; retryAfter: number } | null;

type LoginAttempt = { startedAt: number; count: number };

export class AuthService {
  readonly ready: Promise<void>;
  private readonly attempts = new Map<string, LoginAttempt>();
  private readonly username: string;
  private credentialFingerprint = '';
  private expectedPasswordHash!: Buffer;
  private passwordSalt!: Buffer;

  constructor(private readonly db: DatabaseSync, credentials: AuthOptions) {
    if (typeof credentials.username !== 'string' || credentials.username.length < 1 || credentials.username.length > 128 ||
        credentials.username.trim() !== credentials.username || typeof credentials.password !== 'string' ||
        credentials.password.length < 1 || credentials.password.length > 1024) {
      throw new Error('AUTH_USERNAME must be 1-128 characters without surrounding whitespace and AUTH_PASSWORD must be 1-1024 characters');
    }
    this.username = credentials.username;
    db.exec(`CREATE TABLE IF NOT EXISTS auth_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        credential_fingerprint TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );`);
    this.ready = this.initialize(credentials.password);
    void this.ready.catch(() => {});
  }

  user(): AuthUser { return { id: OWNER_ID, username: this.username }; }

  async login(username: unknown, password: unknown, address: string, secureCookie: boolean): Promise<LoginResult> {
    await this.ready;
    const now = Date.now();
    this.pruneAttempts(now);
    if (!this.attempts.has(address)) {
      while (this.attempts.size >= MAX_LOGIN_ADDRESSES) {
        const oldest = this.attempts.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.attempts.delete(oldest);
      }
    }
    const attempt = this.attempts.get(address);
    if (attempt && now - attempt.startedAt < LOGIN_WINDOW_MS && attempt.count >= LOGIN_LIMIT) {
      return { throttled: true, retryAfter: Math.max(1, Math.ceil((attempt.startedAt + LOGIN_WINDOW_MS - now) / 1000)) };
    }
    if (!attempt || now - attempt.startedAt >= LOGIN_WINDOW_MS) this.attempts.set(address, { startedAt: now, count: 1 });
    else attempt.count++;

    const boundedUsername = typeof username === 'string' && username.length <= 128 ? username : '';
    const boundedPassword = typeof password === 'string' && password.length <= 1024 ? password : '';
    const [actualHash, expectedHash] = await Promise.all([
      this.derive(boundedUsername, boundedPassword),
      Promise.resolve(this.expectedPasswordHash),
    ]);
    const validPassword = timingSafeEqual(actualHash, expectedHash);
    const suppliedUsername = Buffer.from(boundedUsername);
    const configuredUsername = Buffer.from(this.username);
    const usernameMatches = suppliedUsername.length === configuredUsername.length && timingSafeEqual(
      suppliedUsername.length === configuredUsername.length ? suppliedUsername : Buffer.alloc(configuredUsername.length), configuredUsername);
    if (!validPassword || !usernameMatches || typeof username !== 'string' || typeof password !== 'string') return null;

    this.attempts.delete(address);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (
      SELECT token_hash FROM auth_sessions WHERE subject_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`).run(OWNER_ID, MAX_SESSIONS - 1);
    this.db.prepare('INSERT INTO auth_sessions (token_hash, subject_id, credential_fingerprint, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, OWNER_ID, this.credentialFingerprint, expiresAt, now);
    return { user: this.user(), cookie: serializeCookie(token, expiresAt, secureCookie) };
  }

  async authenticate(cookieHeader: string | undefined): Promise<AuthUser | null> {
    await this.ready;
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    const token = parseCookie(cookieHeader, SESSION_COOKIE);
    if (!token || token.length > 100) return null;
    const tokenHash = hashToken(token);
    const row = this.db.prepare(`SELECT subject_id AS subjectId FROM auth_sessions
      WHERE token_hash = ? AND credential_fingerprint = ? AND expires_at > ?`).get(tokenHash, this.credentialFingerprint, Date.now()) as { subjectId: string } | undefined;
    if (!row || row.subjectId !== OWNER_ID) return null;
    return this.user();
  }

  async logout(cookieHeader: string | undefined): Promise<void> {
    await this.ready;
    const token = parseCookie(cookieHeader, SESSION_COOKIE);
    if (token && token.length <= 100) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  expiredCookie(secureCookie: boolean): string { return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`; }

  private async initialize(password: string): Promise<void> {
    const saltRow = this.db.prepare("SELECT value FROM auth_metadata WHERE key = 'credential_salt'").get() as { value: string } | undefined;
    this.passwordSalt = saltRow ? Buffer.from(saltRow.value, 'base64') : randomBytes(16);
    if (this.passwordSalt.length !== 16) throw new Error('Stored authentication metadata is invalid');
    if (!saltRow) this.db.prepare("INSERT INTO auth_metadata (key, value) VALUES ('credential_salt', ?)").run(this.passwordSalt.toString('base64'));
    this.expectedPasswordHash = await this.derive(this.username, password);
    this.credentialFingerprint = this.expectedPasswordHash.toString('hex');
    const storedFingerprint = this.db.prepare("SELECT value FROM auth_metadata WHERE key = 'credential_fingerprint'").get() as { value: string } | undefined;
    if (storedFingerprint?.value !== this.credentialFingerprint) {
      this.db.exec('DELETE FROM auth_sessions');
      this.db.prepare("INSERT INTO auth_metadata (key, value) VALUES ('credential_fingerprint', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(this.credentialFingerprint);
    }
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
  }

  private derive(username: string, password: string): Promise<Buffer> {
    return scrypt(`${username}\0${password}`, this.passwordSalt, SCRYPT_BYTES).then((hash) => Buffer.from(hash as Buffer));
  }

  private pruneAttempts(now: number): void {
    for (const [address, attempt] of this.attempts) {
      if (now - attempt.startedAt >= LOGIN_WINDOW_MS) this.attempts.delete(address);
    }
  }
}

export function serializeCookie(token: string, expiresAt: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${secure ? '; Secure' : ''}`;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0 || part.slice(0, equals).trim() !== name) continue;
    return part.slice(equals + 1).trim();
  }
  return null;
}

function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
