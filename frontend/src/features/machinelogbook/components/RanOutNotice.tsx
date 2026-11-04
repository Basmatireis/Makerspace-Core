import { ActionableNotification, Button } from '@carbon/react';
import type { FilamentSpool } from '../../../api/generated/models';
import { spoolActionsFor, useSpoolPermissions, type SpoolDialog } from './spoolActions';

/**
 * The suggestion that a spool ran out during a print: Core's message names the run and the grams it still holds.
 * Weigh and Retire reuse the spool dialogs and appear only for people who may use them. Passive (`role="status"`).
 */
export function RanOutNotice({ spool, onAction }: { spool: FilamentSpool; onAction: (dialog: SpoolDialog) => void }) {
  const allowed = useSpoolPermissions();
  const flag = spool.attention.find((item) => item.code === 'ran_out_during_run');
  if (!flag) return null;
  const offered = spoolActionsFor(spool, allowed).filter((item) => item.id === 'weigh' || item.id === 'retire');
  return (
    <ActionableNotification
      kind="warning"
      lowContrast
      hideCloseButton
      inline
      role="status"
      title="Ran out during a print"
      subtitle={flag.message}
    >
      {offered.length > 0 && (
        <div className="mj-inline">
          {offered.map((item) => (
            <Button key={item.id} kind="tertiary" size="sm" onClick={() => onAction(item.id)}>
              {item.label}
            </Button>
          ))}
        </div>
      )}
    </ActionableNotification>
  );
}
