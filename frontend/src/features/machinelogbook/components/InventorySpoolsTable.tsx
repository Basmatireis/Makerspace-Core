import { useState, type ReactNode } from 'react';
import { Button, Link as CarbonLink, MenuButton, MenuItem, TableToolbarAction } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { FilamentSpool } from '../../../api/generated/models';
import { ChangeFilamentModal } from '../dialogs/ChangeFilamentModal';
import { CleanupSpoolsModal } from '../dialogs/CleanupSpoolsModal';
import { SpoolFormModal } from '../dialogs/SpoolFormModal';
import { DirectoryTable, useUrlState, type Column, type Option } from '../shared/DirectoryTable';
import { machineLogbookPaths } from '../shared/paths';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useCan } from '../shared/useCan';
import { allSpoolsQuery, filamentMaterialsQuery } from '../spoolData';
import { formatGrams } from './inventoryShared';
import {
  initialOf,
  KindTag,
  kindLabel,
  kindOptions,
  matchesStatus,
  MountLink,
  mountText,
  needsRefill,
  remainingOf,
  spoolIsLow,
  spoolPercent,
  spoolTitle,
  StatusTag,
  statusOptions,
} from './spoolShared';

const mountedOptions: Option[] = [
  { id: 'mounted', label: 'Mounted' },
  { id: 'free', label: 'Not mounted' },
];
const ID = 'spools';

type Props = {
  /** Only the spools of this material; the Material column and filter are dropped. */
  materialId?: string;
  /** Material page presentation: a plain Register spool button, without Change filament or cleanup. Defaults to true when a material is set. */
  compact?: boolean;
  /** Section switcher for the toolbar when the table shares a page with sibling tables. */
  switcher?: ReactNode;
};

/** Spools as a Directory-style table: the full Spools tab of the Inventory page, or a material's compact list. */
export function InventorySpoolsTable({ materialId, compact = Boolean(materialId), switcher }: Props) {
  const can = useCan();
  // Registering, refilling and cleaning up all move stock, so they need both permissions.
  const canRegister = can('filament_spools.manage') && can('inventory.manage');
  const url = useUrlState(ID);
  const showArchived = url.get('archived') === '1';
  const [dialog, setDialog] = useState<'register' | 'refill' | 'cleanup' | null>(null);
  const close = () => setDialog(null);
  // Archived spools are only loaded on request; the other filters work on what is loaded.
  const query = useQuery({
    ...allSpoolsQuery({ materialId, lifecycle: showArchived ? undefined : 'active' }),
    placeholderData: keepPreviousData,
  });
  const materials = useQuery({ ...filamentMaterialsQuery(), enabled: !materialId });

  return (
    <>
      <QueryBoundary query={query} errorMessage="Spools could not be loaded.">
        {(spools) => (
          <SpoolsTable
            spools={spools}
            fixedMaterial={Boolean(materialId)}
            materialOptions={(materials.data ?? []).map((material) => ({ id: material.id, label: material.name }))}
            canRegister={canRegister}
            compact={compact}
            switcher={switcher}
            onRegister={() => setDialog('register')}
            onChangeFilament={() => setDialog('refill')}
            onCleanup={() => setDialog('cleanup')}
          />
        )}
      </QueryBoundary>
      {canRegister && <SpoolFormModal open={dialog === 'register'} onClose={close} initialMaterialId={materialId} />}
      {canRegister && !compact && <ChangeFilamentModal open={dialog === 'refill'} onClose={close} />}
      {canRegister && !compact && <CleanupSpoolsModal open={dialog === 'cleanup'} onClose={close} />}
    </>
  );
}

type TableProps = {
  spools: FilamentSpool[];
  fixedMaterial: boolean;
  materialOptions: Option[];
  canRegister: boolean;
  compact: boolean;
  switcher?: ReactNode;
  onRegister: () => void;
  onChangeFilament: () => void;
  onCleanup: () => void;
};

function SpoolsTable({
  spools,
  fixedMaterial,
  materialOptions,
  canRegister,
  compact,
  switcher,
  onRegister,
  onChangeFilament,
  onCleanup,
}: TableProps) {
  const url = useUrlState(ID);
  const materialIds = url.list('material');
  const statusIds = url.list('status');
  const mountedIds = url.list('mounted');
  const kindIds = url.list('kind');
  const productIds = url.list('product');
  const manufacturerIds = url.list('manufacturer');
  const showArchived = url.get('archived') === '1';

  // A spool's product is its snapshot text (catalog products and fills recorded by hand), so the filter matches on that.
  const productOptions: Option[] = [
    ...new Set(spools.map((spool) => spool.productName).filter((name): name is string => Boolean(name))),
  ]
    .sort()
    .map((name) => ({ id: name, label: name }));
  const manufacturerOptions: Option[] = [
    ...new Set(spools.map((spool) => spool.manufacturer).filter((name): name is string => Boolean(name))),
  ]
    .sort()
    .map((name) => ({ id: name, label: name }));

  const rows = spools.filter(
    (spool) =>
      (showArchived || spool.status !== 'archived') &&
      (kindIds.length === 0 || kindIds.includes(spool.kind)) &&
      (materialIds.length === 0 || materialIds.includes(spool.materialId ?? '')) &&
      (productIds.length === 0 || productIds.includes(spool.productName ?? '')) &&
      (manufacturerIds.length === 0 || manufacturerIds.includes(spool.manufacturer ?? '')) &&
      (statusIds.length === 0 || statusIds.some((id) => matchesStatus(spool, id))) &&
      (mountedIds.length === 0 || mountedIds.includes(spool.mounted ? 'mounted' : 'free')),
  );

  const columns: Column<FilamentSpool>[] = [
    {
      key: 'spool',
      header: 'Spool',
      sortValue: (spool) => spool.displayId,
      render: (spool) => (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={machineLogbookPaths.spool(spool.id)}>
            {spool.displayId}
          </CarbonLink>
          {spool.label && <span className="mj-secondary">{spool.label}</span>}
          {needsRefill(spool) && <span className="mj-secondary">Waiting for a refill</span>}
          {!needsRefill(spool) && (
            <span className="mj-secondary mj-show-narrow">{spoolTitle(spool) || 'No product recorded'}</span>
          )}
          <span className="mj-secondary mj-show-narrow">{kindLabel(spool.kind)}</span>
          {!fixedMaterial && spool.materialName && (
            <span className="mj-secondary mj-show-narrow">{spool.materialName}</span>
          )}
          <span className="mj-secondary mj-show-narrow">
            {[
              spool.storageLocation,
              spool.mounted ? `Mounted${spool.mountedOn ? ` on ${mountText(spool.mountedOn)}` : ''}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Type',
      narrow: true,
      sortValue: (spool) => spool.kind,
      render: (spool) => <KindTag kind={spool.kind} size="sm" />,
    },
    {
      key: 'product',
      header: 'Product',
      narrow: true,
      sortValue: (spool) => `${spool.productName ?? ''} ${spool.manufacturer ?? ''}`.trim(),
      render: (spool) =>
        spool.productName || spool.manufacturer ? (
          <div className="mj-cell-stack">
            <span>{spool.productName ?? spool.manufacturer}</span>
            {spool.productName && spool.manufacturer && <span className="mj-secondary">{spool.manufacturer}</span>}
          </div>
        ) : (
          '—'
        ),
    },
    ...(fixedMaterial
      ? []
      : [
          {
            key: 'material',
            header: 'Material',
            narrow: true,
            sortValue: (spool: FilamentSpool) => spool.materialName ?? '',
            render: (spool: FilamentSpool) => spool.materialName || '—',
          } satisfies Column<FilamentSpool>,
        ]),
    {
      key: 'remaining',
      header: 'Remaining',
      sortValue: (spool) => remainingOf(spool),
      firstDirection: 'DESC',
      render: (spool) =>
        needsRefill(spool) ? (
          <span>Needs refill</span>
        ) : (
          <div className="mj-cell-stack">
            <span>
              {formatGrams(remainingOf(spool))} of {formatGrams(initialOf(spool))}
            </span>
            <span className="mj-secondary">
              {spoolPercent(spool)} %{spoolIsLow(spool) ? ' · low' : ''}
              {spool.status !== 'archived' && remainingOf(spool) <= 0 ? ' · empty, finish the spool' : ''}
            </span>
          </div>
        ),
    },
    {
      key: 'location',
      header: 'Location',
      narrow: true,
      sortValue: (spool) => spool.storageLocation ?? '',
      render: (spool) => spool.storageLocation ?? '—',
    },
    {
      key: 'mounted',
      header: 'Mounted on',
      narrow: true,
      sortValue: (spool) => mountText(spool.mountedOn) ?? '',
      render: (spool) => (spool.mountedOn ? <MountLink mount={spool.mountedOn} /> : spool.mounted ? 'Mounted' : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (spool) => spool.status,
      render: (spool) => <StatusTag spool={spool} size="sm" />,
    },
  ];

  return (
    <DirectoryTable
      id={ID}
      label="Spools"
      columns={columns}
      rows={rows}
      totalCount={spools.length}
      switcher={switcher}
      searchText={(spool) =>
        [
          spool.displayId,
          spool.label,
          spool.manufacturer,
          spool.productName,
          spool.materialName,
          spool.storageLocation,
          spool.acquisitionReference,
          ...spool.identifiers.map((item) => item.value),
        ]
          .filter(Boolean)
          .join(' ')
      }
      defaultSort={{ key: 'spool', direction: 'ASC' }}
      toolbarMenu={
        canRegister && !compact ? (
          <TableToolbarAction onClick={onCleanup}>Clean up archived spools</TableToolbarAction>
        ) : undefined
      }
      toolbarAction={
        canRegister ? (
          !compact ? (
            <MenuButton label="New" kind="primary" size="lg" menuAlignment="bottom-end">
              <MenuItem label="Register spool" onClick={onRegister} />
              <MenuItem label="Change filament" onClick={onChangeFilament} />
            </MenuButton>
          ) : (
            <Button kind="primary" size="lg" onClick={onRegister}>
              Register spool
            </Button>
          )
        ) : undefined
      }
      filterCategories={[
        ...(fixedMaterial ? [] : [{ key: 'material', label: 'Material', options: materialOptions }]),
        { key: 'product', label: 'Product', options: productOptions },
        { key: 'manufacturer', label: 'Manufacturer', options: manufacturerOptions },
        { key: 'kind', label: 'Type', options: kindOptions },
        { key: 'status', label: 'Status', options: statusOptions },
        { key: 'mounted', label: 'Mounted', options: mountedOptions },
        { key: 'archived', label: 'Show', options: [{ id: '1', label: 'Archived spools' }] },
      ]}
      empty={{
        title: 'No spools yet',
        description: 'Register a spool to track filament weight, location and printer slots.',
        action: canRegister ? (
          <Button kind="tertiary" onClick={onRegister}>
            Register spool
          </Button>
        ) : undefined,
      }}
    />
  );
}
