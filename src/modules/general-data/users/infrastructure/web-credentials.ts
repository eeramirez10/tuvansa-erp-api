import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

const scryptKey = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key));
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scryptKey(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  const [, salt = '0'.repeat(32), expected = '0'.repeat(128)] = hash?.split(':') ?? [];
  const actual = await scryptKey(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && Boolean(hash);
}
