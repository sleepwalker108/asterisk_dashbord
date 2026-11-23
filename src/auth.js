// Паролі зберігаються в конфігу лише як scrypt-хеш: scrypt$<salt>$<hash>
import crypto from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// короткий відбиток хешу: якщо пароль у конфігу змінили — старі сесії недійсні
export function fingerprint(stored) {
  return crypto.createHash('sha256').update(String(stored)).digest('hex').slice(0, 16);
}

// простий ліміт спроб входу з однієї IP-адреси
export class LoginLimiter {
  constructor(max = 10, windowMs = 5 * 60e3) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  allowed(ip) {
    const t = Date.now();
    const arr = (this.hits.get(ip) || []).filter((x) => t - x < this.windowMs);
    this.hits.set(ip, arr);
    return arr.length < this.max;
  }
  fail(ip) {
    const arr = this.hits.get(ip) || [];
    arr.push(Date.now());
    this.hits.set(ip, arr);
  }
  reset(ip) { this.hits.delete(ip); }
}
