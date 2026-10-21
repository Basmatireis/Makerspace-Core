import { useState } from 'react';
import { Button, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { MaterialKind } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { InventoryArticlesTable } from './components/InventoryArticlesTable';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { MaterialTypesTable } from './components/MaterialTypesTable';
import { NoInventoryAccess } from './components/inventoryShared';
import { KindChoiceModal } from './dialogs/KindChoiceModal';
import { MaterialFormModal } from './dialogs/MaterialFormModal';
import { ReceiveStockModal } from './dialogs/ReceiveStockModal';
import { allMaterialsQuery } from './inventoryQueries';
import { formatMoney } from './shared/format';
import { machineLogbookPaths, type InventoryTab } from './shared/paths';
import { useCan } from './shared/useCan';
import './styles/inventory.scss';

const SECTIONS: { id: InventoryTab; label: string }[] = [
  { id: 'materials', label: 'Materials' },
  { id: 'parts', label: 'Parts' },
  { id: 'spools', label: 'Spools' },
  { id: 'types', label: 'Types & categories' },
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
  const totals = useQuery({ ...allMaterialsQuery(), enabled: canRead });

  // Links and bookmarks of the former Filament and Consumables tabs land on Materials.
  if (requested === 'filament' || requested === 'consumables') {
    const next = new URLSearchParams(params);
    next.set('tab', 'materials');
    if (requested === 'filament' && !next.has('process')) next.set('process', 'fdm_printing');
    return <Navigate to={{ search: next.toString() }} replace />;
  }
  // Tab values of the former page (materials, material-types, products) fall back to the first tab.
  const tab = SECTIONS.find((section) => section.id === requested)?.id ?? 'materials';

  // Which kind a new article or a receipt is for: parts are clear, filament follows an FDM-only process filter,
  // and the combined Materials list asks.
  const processFilter = (params.get('process') ?? '').split(',').filter(Boolean);
  const knownKind: MaterialKind | undefined =
    tab === 'parts'
      ? 'part'
      : tab === 'spools' || (processFilter.length === 1 && processFilter[0] === 'fdm_printing')
        ? 'filament'
        : undefined;
  const start = (name: 'receive' | 'new') => setDialog({ name, kind: knownKind });

  const switcher = (
    <SectionSwitcher
      label="Inventory sections"
      selected={tab}
      sections={SECTIONS}
      onChange={(id) => setParams(new URLSearchParams({ tab: id }), { replace: true })}
    />
  );
  const actions =
    canRead && canManage ? (
      <>
        <Button renderIcon={Add} onClick={() => start('receive')}>
          Receive stock
        </Button>
        <OverflowMenu aria-label="More inventory actions" iconDescription="More inventory actions" flipped>
          <OverflowMenuItem itemText="New article" onClick={() => start('new')} />
        </OverflowMenu>
      </>
    ) : undefined;
  const header = {
    title: 'Inventory',
    width: 'wide' as const,
    actions,
    description: totals.data
      ? `Materials, parts, spools, types and categories. Stock value ${formatMoney(totals.data.totalInventoryValue)}.`
      : 'Materials, parts, spools, types and categories.',
    breadcrumbs: [{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Inventory' }],
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
      {tab === 'spools' && <InventorySpoolsTable switcher={switcher} />}
      {tab === 'types' && <MaterialTypesTable canManage={canManage} switcher={switcher} />}
      {(tab === 'materials' || tab === 'parts') && (
        <InventoryArticlesTable
          scope={tab}
          canManage={canManage}
          onReceive={() => start('receive')}
          switcher={switcher}
        />
      )}
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
