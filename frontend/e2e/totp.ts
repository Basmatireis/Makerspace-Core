import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

// Test-only authenticator secret of the bootstrapped master; keep it equal to masterTOTPSecret in
// backend/tests/e2e/bootstrap/main.go.
export const masterTotpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const stepSeconds = 30;

function decodeBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | base32Alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 code (HMAC-SHA1, 30 s, 6 digits) for the time step containing nowMs. */
export function totpCode(secret: string, nowMs = Date.now()): string {
  const counter = Math.floor(nowMs / 1000 / stepSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

// The backend accepts each time step once per account. Workers run in separate processes, so the last used step and
// a lock live in the temp directory and one second-factor submission is in flight at a time.
const stateFile = join(tmpdir(), 'makerspace-e2e-totp-step');
const lockDir = join(tmpdir(), 'makerspace-e2e-totp-lock');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const currentStep = () => Math.floor(Date.now() / 1000 / stepSeconds);

async function acquireLock() {
  for (;;) {
    try {
      mkdirSync(lockDir);
      return;
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 90_000) rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // released between the two calls
      }
      await sleep(200);
    }
  }
}

function lastUsedStep(): number {
  try {
    return Number(readFileSync(stateFile, 'utf8')) || -1;
  } catch {
    return -1;
  }
}

/**
 * Signs in on /login with email and password and, when the account answers with the second-factor step, completes it
 * with the authenticator code of the master fixture.
 */
export async function signInWithPassword(page: Page, email: string, password: string, secret = masterTotpSecret) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const codeField = page.getByLabel('Authentication code');
  const outcome = async () =>
    /\/dashboard$/.test(page.url()) ? 'dashboard' : (await codeField.isVisible()) ? 'second-factor' : 'pending';
  await expect.poll(outcome).not.toBe('pending');
  if ((await outcome()) === 'second-factor') {
    await acquireLock();
    try {
      while (currentStep() <= lastUsedStep()) await sleep(500);
      const step = currentStep();
      await codeField.fill(totpCode(secret, step * stepSeconds * 1000));
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      writeFileSync(stateFile, String(step));
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  await expect(page).toHaveURL(/\/dashboard$/);
}
