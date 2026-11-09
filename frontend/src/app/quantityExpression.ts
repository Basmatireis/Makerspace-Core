/**
 * Basic arithmetic in quantity fields: "20*30*2", "12,5 + 3", "(40-2)/4". Numbers use comma or dot as the decimal
 * separator like `parseDecimalText`; `*`, `x` and `×` multiply, `/` and `:` divide. No `eval`: a small parser that
 * accepts nothing else.
 */

const OPERATOR = /[-+*/:x×()]/i;

type Token = { kind: 'number'; value: number } | { kind: 'op'; value: string };

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let rest = text.replace(/\s+/g, '');
  while (rest) {
    const number = /^(\d+[.,]?\d*|[.,]\d+)/.exec(rest);
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0].replace(',', '.')) });
      rest = rest.slice(number[0].length);
      continue;
    }
    const op = rest[0].toLowerCase();
    if (!'+-*/:x×()'.includes(op)) return null;
    tokens.push({ kind: 'op', value: op === 'x' || op === '×' ? '*' : op === ':' ? '/' : op });
    rest = rest.slice(1);
  }
  return tokens;
}

/** The value of an arithmetic expression, or null when the text is not one or does not compute to a finite number. */
export function evaluateExpression(text: string | null | undefined): number | null {
  const tokens = tokenize(text ?? '');
  if (!tokens || tokens.length === 0) return null;
  let position = 0;
  const peek = () => tokens[position];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()?.value === value;

  const factor = (): number | null => {
    if (isOp('-')) {
      position += 1;
      const value = factor();
      return value === null ? null : -value;
    }
    if (isOp('(')) {
      position += 1;
      const value = sum();
      if (value === null || !isOp(')')) return null;
      position += 1;
      return value;
    }
    const token = peek();
    if (token?.kind !== 'number') return null;
    position += 1;
    return token.value;
  };
  const product = (): number | null => {
    let value = factor();
    while (value !== null && (isOp('*') || isOp('/'))) {
      const op = peek()!.value;
      position += 1;
      const right = factor();
      if (right === null) return null;
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };
  const sum = (): number | null => {
    let value = product();
    while (value !== null && (isOp('+') || isOp('-'))) {
      const op = peek()!.value;
      position += 1;
      const right = product();
      if (right === null) return null;
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };

  const value = sum();
  return value !== null && position === tokens.length && Number.isFinite(value) ? value : null;
}

/** Whether the text is meant as a calculation rather than a plain number. */
export const isExpression = (text: string | null | undefined) => OPERATOR.test((text ?? '').trim());

/**
 * The text a quantity field stands for: the result of a calculation, rounded to `places` fraction digits, or the
 * text itself when it is a plain number or cannot be computed (validation then reports it).
 */
export function resolveQuantityText(text: string, places = 6): string {
  if (!isExpression(text)) return text;
  const value = evaluateExpression(text);
  if (value === null) return text;
  const factor = 10 ** places;
  return String(Math.round(value * factor) / factor);
}
