import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { PageSectionTabs } from './components/machineParts';
import { InventoryArticlesTable } from './components/InventoryArticlesTable';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { MaterialTypesTable } from './components/MaterialTypesTable';
import { NoInventoryAccess } from './components/inventoryShared';
import { ReceiveStockModal } from './dialogs/ReceiveStockModal';
import { machineLogbookPaths, type InventorySection } from './shared/paths';
import { InventoryRecycleBin } from './components/InventoryRecycleBin';
import { useCan } from './shared/useCan';
import './styles/inventory.scss';

const SECTIONS: { id: InventorySection; label: string }[] = [
  { id: 'articles', label: 'Articles' },
  { id: 'spools', label: 'Spools' },
  { id: 'types', label: 'Categories' },
  { id: 'bin', label: 'Recycle bin' },
];

export function InventoryPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [receiving, setReceiving] = useState(false);
  const requested = params.get('tab');
  const canManage = can('inventory.articles.manage');
  const canReceive = can('inventory.receive');
  const canRead = can('inventory.read');

  // Links and bookmarks of the former Filament, Consumables, Materials and Parts tabs land on Articles.
  if (['filament', 'consumables', 'materials', 'parts'].includes(requested ?? '')) {
    const next = new URLSearchParams(params);
    next.set('tab', 'articles');
    return <Navigate to={{ search: next.toString() }} replace />;
  }
  // Tab values of the former page (materials, material-types, products) fall back to the first tab.
  const tab = SECTIONS.find((section) => section.id === requested)?.id ?? 'articles';

  const start = () => setReceiving(true);

  const tabs = (
    <PageSectionTabs
      label="Inventory sections"
      guide="workshop-inventory-tabs"
      selected={tab}
      sections={SECTIONS}
      onChange={(id) => setParams(new URLSearchParams({ tab: id }), { replace: true })}
    />
  );
  const header = {
    title: 'Inventory',
    width: 'wide' as const,
    tabs,
    breadcrumbs: [{ label: 'Workshop', to: machineLogbookPaths.home() }, { label: 'Inventory' }],
  };
  if (!canRead)
    return (
      <PageShell {...header}>
        <NoInventoryAccess />
      </PageShell>
    );
  const close = () => setReceiving(false);

  return (
    <PageShell {...header}>
      {tab === 'spools' && (
        <div data-guide="workshop-spools-list">
          <InventorySpoolsTable onReceive={canReceive ? start : undefined} />
        </div>
      )}
      {tab === 'bin' && <InventoryRecycleBin />}
      {tab === 'types' && <MaterialTypesTable canManage={canManage} />}
      {tab === 'articles' && (
        <div data-guide="workshop-inventory-list">
          <InventoryArticlesTable onReceive={start} />
        </div>
      )}
      {receiving && <ReceiveStockModal open onClose={close} kind={tab === 'spools' ? 'filament' : undefined} />}
    </PageShell>
  );
}
