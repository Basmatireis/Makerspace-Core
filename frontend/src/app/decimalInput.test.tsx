import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DecimalField } from './DecimalField';
import { decimalNumber, decimalText, decimalValidator, parseDecimalText } from './decimalInput';

describe('parseDecimalText', () => {
  it('reads comma and dot as the decimal separator', () => {
    expect(parseDecimalText('1,5')).toBe('1.5');
    expect(parseDecimalText('1.5')).toBe('1.5');
    expect(parseDecimalText('0,25')).toBe('0.25');
    expect(parseDecimalText('.5')).toBe('0.5');
    expect(parseDecimalText('12.')).toBe('12');
    expect(parseDecimalText(' 007,50 ')).toBe('7.50');
    expect(decimalNumber('12,5')).toBe(12.5);
  });

  it('rejects thousands separators, signs, exponents and text', () => {
    for (const text of ['1.234,5', '1,234.5', '1 234', '-1', '1e3', 'abc', '', '1,2,3', ',']) expect(parseDecimalText(text)).toBeNull();
  });

  it('limits fraction digits and whole-number fields', () => {
    expect(parseDecimalText('1,234', { places: 2 })).toBeNull();
    expect(parseDecimalText('1,5', { integer: true })).toBeNull();
    expect(parseDecimalText('15', { integer: true })).toBe('15');
  });

  it('formats stored numbers for the input', () => {
    expect(decimalText('12.500000')).toBe('12.5');
    expect(decimalText(null)).toBe('');
  });
});

describe('decimalValidator', () => {
  it('explains what is wrong', () => {
    const quantity = decimalValidator({ positive: true });
    expect(quantity('1,5')).toBe(true);
    expect(quantity('0')).toBe('Enter a number above zero.');
    expect(quantity('')).toBe('Enter a number.');
    expect(quantity('1.234,5')).toBe('Enter the number without thousands separators, e.g. 1234,5.');
    expect(decimalValidator({ integer: true })('1,5')).toBe('Enter a whole number.');
    expect(decimalValidator({ optional: true })('')).toBe(true);
    expect(decimalValidator({ places: 2 })('1,234')).toBe('Use at most 2 decimal places.');
  });
});

describe('DecimalField', () => {
  function Harness() {
    const [value, setValue] = useState('');
    return <><DecimalField id="amount" labelText="Amount" value={value} onChange={setValue} /><output>{parseDecimalText(value) ?? 'invalid'}</output></>;
  }

  it('keeps every intermediate state as typed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Amount');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    await user.type(input, '12.');
    expect(input).toHaveValue('12.');
    await user.type(input, '5');
    expect(input).toHaveValue('12.5');
    expect(screen.getByRole('status')).toHaveTextContent('12.5');
    await user.clear(input);
    await user.type(input, '0,0');
    expect(input).toHaveValue('0,0');
    await user.type(input, '25');
    expect(input).toHaveValue('0,025');
    await user.clear(input);
    await user.type(input, '1,5');
    expect(input).toHaveValue('1,5');
    expect(screen.getByRole('status')).toHaveTextContent('1.5');
    await user.clear(input);
    await user.type(input, '1.234,5');
    expect(input).toHaveValue('1.234,5');
    expect(screen.getByRole('status')).toHaveTextContent('invalid');
  });
});
