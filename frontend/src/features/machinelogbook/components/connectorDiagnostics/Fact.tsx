import { type ReactNode } from 'react';

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mj-metric__label">{label}</div>
      <div className="mj-diag-value">{children}</div>
    </div>
  );
}
