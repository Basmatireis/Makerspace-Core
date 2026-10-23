import type { ReactNode } from 'react';
import { ActionableNotification } from '@carbon/react';

/**
 * An inline notification whose body may contain links. Carbon's InlineNotification and ToastNotification throw on
 * interactive children, so this uses the actionable variant without an action button; its subtitle takes nodes.
 */
export function RichNotification({
  kind,
  title,
  children,
  className,
}: {
  kind: 'info' | 'warning' | 'error' | 'success';
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ActionableNotification
      inline
      role="status"
      lowContrast
      hideCloseButton
      kind={kind}
      title={title}
      subtitle={children}
      className={className}
    />
  );
}
