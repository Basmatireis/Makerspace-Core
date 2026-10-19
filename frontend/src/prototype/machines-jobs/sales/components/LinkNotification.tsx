import { ActionableNotification } from '@carbon/react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/** A notification with one follow-up link. Carbon's plain inline notification may not contain links, so this uses the actionable one. */
export function LinkNotification({ kind = 'info', title, subtitle, label, to, onFollow }: {
  kind?: 'info' | 'warning' | 'error' | 'success'; title: string; subtitle?: ReactNode; label: string; to: string; onFollow?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <ActionableNotification inline lowContrast hideCloseButton kind={kind} title={title} subtitle={subtitle} actionButtonLabel={label} onActionButtonClick={() => { onFollow?.(); navigate(to); }} />
  );
}
