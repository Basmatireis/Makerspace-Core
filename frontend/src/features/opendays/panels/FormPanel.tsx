import type { ReactNode } from 'react';
import { Button, ButtonSet, IconButton } from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { DetailPanel, DetailPanelHead } from '../../../app/components/DetailPanel';

/** The panel shell of the edit forms: head, the form, and a Cancel/primary action row pinned to the bottom. */
export function FormPanel({
  title,
  meta,
  secondary,
  formId,
  primaryLabel,
  cancelLabel = 'Cancel',
  onCancel,
  children,
  disabled,
}: {
  title: string;
  meta?: string;
  secondary?: string;
  formId: string;
  primaryLabel: string;
  cancelLabel?: string;
  onCancel: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <DetailPanel className="od-detail od-detail--form">
      <DetailPanelHead
        title={title}
        meta={meta}
        secondary={secondary}
        actions={
          <IconButton kind="ghost" size="md" label="Discard these edits" onClick={onCancel}>
            <Close />
          </IconButton>
        }
      />
      {children}
      <ButtonSet className="od-form__actions">
        <Button kind="secondary" size="xl" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button kind="primary" size="xl" type="submit" form={formId} disabled={disabled}>
          {primaryLabel}
        </Button>
      </ButtonSet>
    </DetailPanel>
  );
}
