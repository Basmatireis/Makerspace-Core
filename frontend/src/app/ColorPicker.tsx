import type { ReactNode } from 'react';

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The browser's native colour picker as a square swatch beside a Carbon text input. Carbon has no colour picker, so
 * the hex value stays editable in the text field and the swatch opens the system picker. `value` may be partial or
 * empty while typing; the swatch then shows `fallback`. The picker always reports lowercase `#rrggbb`.
 */
export function ColorPicker({
  label,
  value,
  fallback = '#000000',
  disabled,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  fallback?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const valid = !!value && HEX.test(value.trim());
  return (
    <input
      type="color"
      className={`app-color-picker${valid ? '' : ' app-color-picker--empty'}`}
      aria-label={`Choose ${label.toLowerCase()}`}
      title={`Choose ${label.toLowerCase()}`}
      value={valid ? value.trim().toLowerCase() : fallback}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

/** Lays out a Carbon text input with the colour picker swatch aligned to the input row. */
export function ColorFieldRow({ children }: { children: ReactNode }) {
  return <div className="app-color-field">{children}</div>;
}
