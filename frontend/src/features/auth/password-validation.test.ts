import { describe, expect, it } from 'vitest';
import { validatePasswordLength } from './password-validation';

describe('Unicode password length validation', () => {
  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(validatePasswordLength('🔐'.repeat(8))).toBe('Use at least 12 characters.');
    expect(validatePasswordLength('🔐'.repeat(12))).toBe(true);
    expect(validatePasswordLength('🔐'.repeat(100))).toBe(true);
    expect(validatePasswordLength('🔐'.repeat(129))).toBe('Use at most 128 characters.');
  });
});
