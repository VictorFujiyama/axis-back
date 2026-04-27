import { hash, verify } from '@node-rs/argon2';

// Argon2id = 2 (numeric value of @node-rs/argon2's const enum).
// Avoid importing the const enum itself — incompatible with isolatedModules.
const hashOptions = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: 2,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, hashOptions);
}

// verify() reads parameters from the encoded hash itself — don't pass hashOptions.
export function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  return verify(hashed, plain);
}

// Pre-computed dummy hash, built at module load (async lazy).
// Used in login to equalize response time when user doesn't exist,
// preventing email-enumeration via timing side-channel.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('__blossom_dummy__');
  }
  return dummyHashPromise;
}

export async function equalizeTiming(plain: string): Promise<void> {
  const dummy = await getDummyHash();
  await verify(dummy, plain).catch(() => false);
}
