import { describe, expect, it } from 'vitest';
import { evaluateExpression, isExpression, resolveQuantityText } from './quantityExpression';

describe('quantity calculations', () => {
  it('computes the basic operations with precedence, brackets and both decimal separators', () => {
    expect(evaluateExpression('20*30*2')).toBe(1200);
    expect(evaluateExpression('12,5 + 3.5')).toBe(16);
    expect(evaluateExpression('2+3*4')).toBe(14);
    expect(evaluateExpression('(2+3)*4')).toBe(20);
    expect(evaluateExpression('20x30')).toBe(600);
    expect(evaluateExpression('20 × 30 : 4')).toBe(150);
    expect(evaluateExpression('-2+5')).toBe(3);
  });

  it('refuses incomplete or foreign input and division by zero', () => {
    for (const text of ['20*', '(2+3', '2+abc', 'alert(1)', '1/0', '', '*3']) {
      expect(evaluateExpression(text)).toBeNull();
    }
  });

  it('resolves a calculation to its rounded result and leaves plain numbers alone', () => {
    expect(isExpression('12,5')).toBe(false);
    expect(isExpression('12*2')).toBe(true);
    expect(resolveQuantityText('12,5')).toBe('12,5');
    expect(resolveQuantityText('10/3')).toBe('3.333333');
    expect(resolveQuantityText('20*')).toBe('20*');
  });
});
