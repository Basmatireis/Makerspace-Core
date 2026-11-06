import { InlineNotification } from '@carbon/react';
import { ErrorCatalogTable, ErrorCodeSyncCard } from './ErrorCatalogTab';

/** Machines › Printers: the error catalog next to the code list fetch. */
export function PrintersTab() {
  return (
    <div className="mj-two-col mj-two-col--catalog">
      <ErrorCatalogTable />
      <div className="mj-stack">
        <ErrorCodeSyncCard />
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          subtitle="Printer notifications are rules now: Settings › Notification center."
        />
      </div>
    </div>
  );
}
