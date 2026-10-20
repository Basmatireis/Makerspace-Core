/**
 * Typed decimal numbers. Fields keep the raw text the person typed ("12.", "12,", "0,0") in their state and convert
 * only for validation and submission. Comma and dot both mean the decimal separator; thousands separators are not
 * supported, so "1.234,5" is invalid rather than guessed.
 */

export type DecimalOptions = {
  /** Maximum number of fraction digits; defaults to 6, the precision of API decimals. */
  places?: number;
  /** Whole numbers only. */
  integer?: boolean;
};

const SHAPE = /^(\d+[.,]?\d*|[.,]\d+)$/;

/** The API decimal string ("1.5") for typed text, or null when empty or not a valid number. */
export function parseDecimalText(
  text: string | null | undefined,
  { places = 6, integer = false }: DecimalOptions = {},
): string | null {
  const value = (text ?? '').trim();
  if (!SHAPE.test(value)) return null;
  const [whole = '', fraction = ''] = value.replace(',', '.').split('.');
  if (integer && fraction !== '') return null;
  if (fraction.length > places) return null;
  const digits = whole.replace(/^0+(?=\d)/, '') || '0';
  return fraction ? `${digits}.${fraction}` : digits;
}

/** Typed text as a number, or null when empty or invalid. */
export function decimalNumber(text: string | null | undefined, options?: DecimalOptions): number | null {
  const parsed = parseDecimalText(text, options);
  return parsed === null ? null : Number(parsed);
}

type ValidationOptions = DecimalOptions & {
  /** An empty field is valid (optional field). */
  optional?: boolean;
  /** Zero is not allowed. */
  positive?: boolean;
  max?: number;
  /** Message for a missing value. */
  requiredMessage?: string;
};

/** A react-hook-form `validate` function: true or a message. */
export function decimalValidator(options: ValidationOptions = {}) {
  const { optional = false, positive = false, integer = false, places = 6, max, requiredMessage } = options;
  return (text: string | null | undefined): true | string => {
    const value = (text ?? '').trim();
    if (!value) return optional ? true : (requiredMessage ?? 'Enter a number.');
    if (integer && /[.,]/.test(value) && SHAPE.test(value)) return 'Enter a whole number.';
    if (/^\d{1,3}(\.\d{3})+,\d*$/.test(value)) return 'Enter the number without thousands separators, e.g. 1234,5.';
    const parsed = parseDecimalText(value, { places, integer });
    if (parsed === null)
      return SHAPE.test(value)
        ? `Use at most ${places} decimal places.`
        : integer
          ? 'Enter a whole number.'
          : 'Enter a number, e.g. 12,5 or 12.5.';
    const number = Number(parsed);
    if (positive && number <= 0) return 'Enter a number above zero.';
    if (max !== undefined && number > max) return `Enter a number of at most ${max}.`;
    return true;
  };
}

/** Text for a stored number, shown in an input as the starting value. */
export const decimalText = (value: number | string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '' : String(Number(value));
