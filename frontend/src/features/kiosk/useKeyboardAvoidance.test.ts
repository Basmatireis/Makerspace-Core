import { describe, expect, it } from 'vitest';
import { isKeyboardOpen } from './useKeyboardAvoidance';

describe('on-screen keyboard detection', () => {
  it('needs a focused text field and a clearly smaller visual viewport', () => {
    expect(isKeyboardOpen(768, 420, true)).toBe(true);
    expect(isKeyboardOpen(768, 420, false)).toBe(false);
    // Browser chrome and pinch-zoom changes are not a keyboard.
    expect(isKeyboardOpen(768, 700, true)).toBe(false);
  });
});
