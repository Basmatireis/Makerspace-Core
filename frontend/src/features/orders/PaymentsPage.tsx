import { useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { PageSectionTabs } from '../machinelogbook/components/machineParts';
import { CashbookTab } from './CashbookTab';
import { CashRegisterTab } from './CashRegisterTab';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';

type PaymentsTab = 'register' | 'cashbook';
const TABS: { id: PaymentsTab; label: string }[] = [
  { id: 'register', label: 'Cash register' },
  { id: 'cashbook', label: 'Cashbook' },
];

/**
 * Payments: the cash register (what should be in it, every cash entry with its running balance, counts) and the
 * cashbook of all payments. The register needs the cash movement permission as well; without it only the cashbook shows.
 */
export function PaymentsPage() {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const sections = hasPermission(user, PermissionId.cash_movementsread) ? TABS : TABS.slice(1);
  const tab = sections.find((section) => section.id === params.get('tab'))?.id ?? sections[0].id;
  return (
    <PageShell
      className="sales-page"
      title="Payments"
      width="wide"
      breadcrumbs={[{ label: 'Sales & payments', to: '/orders' }, { label: 'Payments' }]}
      tabs={
        sections.length > 1 ? (
          <PageSectionTabs
            label="Payments sections"
            sections={sections}
            selected={tab}
            // A new tab starts without the other tab's period, filters, search and selection.
            onChange={(id) => setParams(id === sections[0].id ? {} : { tab: id }, { replace: true })}
          />
        ) : undefined
      }
    >
      <div data-guide="payments-content">
        {tab === 'register' ? <CashRegisterTab key="register" /> : <CashbookTab key="cashbook" />}
      </div>
    </PageShell>
  );
}
