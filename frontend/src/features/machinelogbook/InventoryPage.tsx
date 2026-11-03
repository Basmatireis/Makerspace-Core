import { useState } from 'react';
import { Button } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { MaterialKind } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { PageSectionTabs } from './components/machineParts';
import { InventoryArticlesTable } from './components/InventoryArticlesTable';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { MaterialTypesTable } from './components/MaterialTypesTable';
import { NoInventoryAccess } from './components/inventoryShared';
import { KindChoiceModal } from './dialogs/KindChoiceModal';
import { MaterialFormModal } from './dialogs/MaterialFormModal';
import { ReceiveStockModal } from './dialogs/ReceiveStockModal';
import { isFdm } from './processConfig';
import { processesQuery } from './queries';
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
const materialKinds: MaterialKind[] = ['filament', 'consumable'];

type Dialog = { name: 'receive' | 'new'; kind?: MaterialKind } | null;

export function InventoryPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const requested = params.get('tab');
  const canManage = can('inventory.manage');
  const canRead = can('inventory.read');
  const processes = useQuery({ ...processesQuery(), enabled: can('machines.read') });

  // Links and bookmarks of the former Filament, Consumables, Materials and Parts tabs land on Articles.
  if (['filament', 'consumables', 'materials', 'parts'].includes(requested ?? '')) {
    const next = new URLSearchParams(params);
    next.set('tab', 'articles');
    return <Navigate to={{ search: next.toString() }} replace />;
  }
  // Tab values of the former page (materials, material-types, products) fall back to the first tab.
  const tab = SECTIONS.find((section) => section.id === requested)?.id ?? 'articles';

  // Which kind a new article or a receipt is for: parts are clear, filament follows a process filter that only
  // names FDM printer processes, and the combined Materials list asks.
  const processFilter = (params.get('process') ?? '').split(',').filter(Boolean);
  const fdmOnly =
    processFilter.length > 0 &&
    processFilter.every((id) => isFdm((processes.data?.items ?? []).find((item) => item.id === id)));
  const knownKind: MaterialKind | undefined = tab === 'spools' || fdmOnly ? 'filament' : undefined;
  const start = (name: 'receive' | 'new') => setDialog({ name, kind: knownKind });

  const tabs = (
    <PageSectionTabs
      label="Inventory sections"
      selected={tab}
      sections={SECTIONS}
      onChange={(id) => setParams(new URLSearchParams({ tab: id }), { replace: true })}
    />
  );
  const actions =
    canRead && canManage ? (
      <Button kind="secondary" renderIcon={Add} onClick={() => start('new')}>
        New article
      </Button>
    ) : undefined;
  const header = {
    title: 'Inventory',
    width: 'wide' as const,
    actions,
    tabs,
    breadcrumbs: [{ label: 'Workshop', to: machineLogbookPaths.home() }, { label: 'Inventory' }],
  };
  if (!canRead)
    return (
      <PageShell {...header}>
        <NoInventoryAccess />
      </PageShell>
    );
  const close = () => setDialog(null);

  return (
    <PageShell {...header}>
      {tab === 'spools' && <InventorySpoolsTable onReceive={canManage ? () => start('receive') : undefined} />}
      {tab === 'bin' && <InventoryRecycleBin />}
      {tab === 'types' && <MaterialTypesTable canManage={canManage} />}
      {tab === 'articles' && <InventoryArticlesTable onReceive={() => start('receive')} />}
      {dialog && !dialog.kind && (
        <KindChoiceModal
          heading={dialog.name === 'receive' ? 'Receive stock for' : 'New article'}
          kinds={materialKinds}
          onClose={close}
          onChoose={(kind) => setDialog({ ...dialog, kind })}
        />
      )}
      {dialog?.name === 'receive' && dialog.kind && <ReceiveStockModal open onClose={close} kind={dialog.kind} />}
      {dialog?.name === 'new' && dialog.kind && <MaterialFormModal open onClose={close} kind={dialog.kind} />}
    </PageShell>
  );
}
