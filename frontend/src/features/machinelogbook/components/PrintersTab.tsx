import { ErrorCatalogTable, ErrorCodeSyncCard } from './ErrorCatalogTab';
import { PrinterNotificationsCard } from './PrinterNotificationsTab';

/** Machines › Printers: the error catalog next to the code list fetch and the printer notification rules. */
export function PrintersTab() {
  return (
    <div className="mj-two-col mj-two-col--catalog">
      <ErrorCatalogTable />
      <div className="mj-stack">
        <ErrorCodeSyncCard />
        <PrinterNotificationsCard />
      </div>
    </div>
  );
}
