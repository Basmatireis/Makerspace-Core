import { useState, type Ref } from 'react';
import './code-digits.scss';

/**
 * A fixed-length numeric code shown as one box per digit. Carbon has no one-time-code input, so this is a single real
 * text input laid transparently over the boxes: typing, pasting, one-time-code autofill and screen readers all work on
 * that input, and the boxes only draw its value. The kiosk keypad sets the value from outside.
 */
export function CodeDigits({
  id,
  label = 'Code',
  length,
  value,
  invalid = false,
  invalidText,
  inputRef,
  onChange,
}: {
  id: string;
  label?: string;
  length: number;
  value: string;
  invalid?: boolean;
  invalidText?: string;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const errorId = `${id}-error`;
  return (
    <div className={invalid ? 'code-digits code-digits--invalid' : 'code-digits'}>
      <label htmlFor={id} className="cds--label">
        {label}
      </label>
      <div className="code-digits__boxes">
        {Array.from({ length }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={
              focused && index === Math.min(value.length, length - 1)
                ? 'code-digits__box code-digits__box--active'
                : 'code-digits__box'
            }
          >
            {value[index] ?? ''}
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          className="code-digits__input"
          // The keypad enters the digits on the tablet, so its own keyboard stays closed.
          inputMode="none"
          pattern="[0-9]*"
          maxLength={length}
          autoComplete="one-time-code"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid && invalidText ? errorId : undefined}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, length))}
        />
      </div>
      {invalid && invalidText && (
        <p id={errorId} className="code-digits__error" role="alert">
          {invalidText}
        </p>
      )}
    </div>
  );
}
