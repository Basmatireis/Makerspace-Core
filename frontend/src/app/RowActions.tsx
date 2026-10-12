import type { ReactNode } from 'react';

export type RowActionsProps = {
  label: string;
  children: ReactNode;
  className?: string;
};

export function RowActions({
  label,
  children,
  className,
}: RowActionsProps) {
  const classes = ['row-actions', className].filter(Boolean).join(' ');

  return (
    <div
      role="group"
      aria-label={label}
      className={classes}
    >
      {children}
    </div>
  );
}
