import { useMemo } from 'react';
import { Button, Link as CarbonLink, MenuButton, MenuItem, MultiSelect, TableToolbarAction, Toggle } from '@carbon/react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import type { Spool } from '../types';
import { DirectoryTable, selectedOptions, useUrlState, type Column, type Option } from './DirectoryTable';
import {
  formatGrams, KindTag, kindOptions, LifecycleTag, lifecycleOptions, mountedOn, needsRefill, spoolIsLow, spoolPercent, spoolTitle, type MountedOn,
} from './inventoryShared';

const mountedOptions: Option[] = [{ id: 'mounted', label: 'Mounted' }, { id: 'free', label: 'Not mounted' }];

type Props = {
  /** Unique per page. */
  id: string;
  spools: Spool[];
  /** Set on a material page: the Material column and filter are dropped. */
  fixedMaterial?: boolean;
  canRegister: boolean;
  onRegister: () => void;
  /** Opens the Change filament dialog without a preselected spool. */
  onChangeFilament?: () => void;
  /** Opens the cleanup dialog for archived single-use spools. */
  onCleanup?: () => void;
};

/** Spools as a Directory-style table; used on the Inventory page and on a material's page. */
export function InventorySpoolsTable({ id, spools, fixedMaterial = false, canRegister, onRegister, onChangeFilament, onCleanup }: Props) {
  const { machines, printerProfiles, materials } = useStore();
  const url = useUrlState(id);
  const materialIds = url.list('material');
  const lifecycleIds = url.list('lifecycle');
  const mountedIds = url.list('mounted');
  const kindIds = url.list('kind');
  const productIds = url.list('product');
  const manufacturerIds = url.list('manufacturer');
  const showArchived = url.get('archived') === '1';
  const filterKeys = fixedMaterial ? ['product', 'manufacturer', 'kind', 'lifecycle', 'mounted', 'archived'] : ['material', 'product', 'manufacturer', 'kind', 'lifecycle', 'mounted', 'archived'];

  const mounts = useMemo(() => new Map<string, MountedOn | null>(spools.map((spool) => [spool.id, spool.mounted ? mountedOn(spool.id, printerProfiles, machines) : null])), [spools, printerProfiles, machines]);
  // Catalog products plus fills recorded by hand; a spool's product is its snapshot text, so the filter matches on that.
  const productOptions: Option[] = [...new Set(spools.map((spool) => spool.productName).filter((name): name is string => Boolean(name)))].sort().map((name) => ({ id: name, label: name }));
  const manufacturerOptions: Option[] = [...new Set(spools.map((spool) => spool.manufacturer).filter((name): name is string => Boolean(name)))].sort().map((name) => ({ id: name, label: name }));
  const materialOptions: Option[] = materials.filter((material) => material.category === 'Filament').map((material) => ({ id: material.id, label: material.name }));

  const rows = useMemo(() => spools.filter((spool) => (
    (showArchived || spool.lifecycle !== 'archived')
    && (kindIds.length === 0 || kindIds.includes(spool.kind))
    && (materialIds.length === 0 || materialIds.includes(spool.materialId))
    && (productIds.length === 0 || productIds.includes(spool.productName ?? ''))
    && (manufacturerIds.length === 0 || manufacturerIds.includes(spool.manufacturer ?? ''))
    && (lifecycleIds.length === 0 || lifecycleIds.includes(spool.lifecycle))
    && (mountedIds.length === 0 || mountedIds.includes(mounts.get(spool.id) ? 'mounted' : 'free'))
  )), [spools, mounts, showArchived, kindIds.join(','), materialIds.join(','), productIds.join(','), manufacturerIds.join(','), lifecycleIds.join(','), mountedIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const mountLink = (mount: MountedOn) => (
    <CarbonLink as={Link} to={`/machines/${mount.machineId}?tab=printer`}>{mount.machineName} · {mount.slotName}</CarbonLink>
  );

  const columns: Column<Spool>[] = [
    {
      key: 'spool', header: 'Spool', sortValue: (spool) => spool.displayId,
      render: (spool) => {
        const mount = mounts.get(spool.id);
        return (
          <div className="mj-cell-stack">
            <CarbonLink as={Link} to={`/inventory/spools/${spool.id}`}>{spool.displayId}</CarbonLink>
            {spool.label && <span className="mj-secondary">{spool.label}</span>}
            {needsRefill(spool) && <span className="mj-secondary">Waiting for a refill</span>}
            {!needsRefill(spool) && <span className="mj-secondary mj-show-narrow">{spoolTitle(spool) || 'No product recorded'}</span>}
            <span className="mj-secondary mj-show-narrow">{kindOptions.find((item) => item.id === spool.kind)?.label}</span>
            {!fixedMaterial && spool.materialName && <span className="mj-secondary mj-show-narrow">{spool.materialName}</span>}
            <span className="mj-secondary mj-show-narrow">{[spool.storageLocation, mount ? `On ${mount.machineName}` : null].filter(Boolean).join(' · ')}</span>
          </div>
        );
      },
    },
    { key: 'kind', header: 'Type', narrow: true, sortValue: (spool) => spool.kind, render: (spool) => <KindTag kind={spool.kind} size="sm" /> },
    {
      key: 'product', header: 'Product', narrow: true, sortValue: (spool) => `${spool.productName ?? ''} ${spool.manufacturer ?? ''}`.trim(),
      render: (spool) => spool.productName || spool.manufacturer ? (
        <div className="mj-cell-stack">
          <span>{spool.productName ?? spool.manufacturer}</span>
          {spool.productName && spool.manufacturer && <span className="mj-secondary">{spool.manufacturer}</span>}
        </div>
      ) : '—',
    },
    ...(fixedMaterial ? [] : [{ key: 'material', header: 'Material', narrow: true, sortValue: (spool: Spool) => spool.materialName, render: (spool: Spool) => spool.materialName || '—' } satisfies Column<Spool>]),
    {
      key: 'remaining', header: 'Remaining', sortValue: (spool) => spool.remainingQuantity, firstDirection: 'DESC',
      render: (spool) => needsRefill(spool) ? <span>Needs refill</span> : (
        <div className="mj-cell-stack">
          <span>{formatGrams(spool.remainingQuantity)} of {formatGrams(spool.initialNetWeightG)}</span>
          <span className="mj-secondary">{spoolPercent(spool)} %{spoolIsLow(spool) ? ' · low' : ''}{spool.lifecycle === 'active' && spool.remainingQuantity <= 0 ? ' · empty, finish the spool' : ''}</span>
        </div>
      ),
    },
    { key: 'location', header: 'Location', narrow: true, sortValue: (spool) => spool.storageLocation ?? '', render: (spool) => spool.storageLocation ?? '—' },
    {
      key: 'mounted', header: 'Mounted on', narrow: true, sortValue: (spool) => mounts.get(spool.id)?.machineName ?? '',
      render: (spool) => { const mount = mounts.get(spool.id); return mount ? mountLink(mount) : '—'; },
    },
    { key: 'lifecycle', header: 'Status', sortValue: (spool) => spool.lifecycle, render: (spool) => <LifecycleTag spool={spool} size="sm" /> },
  ];

  return (
    <DirectoryTable
      id={id} label="Spools" columns={columns} rows={rows} totalCount={spools.length}
      searchText={(spool) => [spool.displayId, spool.label, spool.manufacturer, spool.productName, spool.materialName, spool.storageLocation, spool.acquisitionReference, mounts.get(spool.id)?.machineName, ...spool.identifiers.map((item) => item.value)].filter(Boolean).join(' ')}
      defaultSort={{ key: 'spool', direction: 'ASC' }}
      hasActiveFilters={filterKeys.some((key) => url.get(key))} onClearFilters={() => url.clear(filterKeys)}
      toolbarMenu={canRegister && onCleanup ? <TableToolbarAction onClick={onCleanup}>Clean up archived spools</TableToolbarAction> : undefined}
      toolbarAction={canRegister ? (onChangeFilament ? (
        <MenuButton label="New" kind="primary" size="lg" menuAlignment="bottom-end">
          <MenuItem label="Register spool" onClick={onRegister} />
          <MenuItem label="Change filament" onClick={onChangeFilament} />
        </MenuButton>
      ) : <Button kind="primary" size="lg" onClick={onRegister}>Register spool</Button>) : undefined}
      filterFields={(
        <>
          {!fixedMaterial && (
            <MultiSelect
              id={`${id}-material-filter`} className="mj-filter-panel__field" titleText="Material" label="All materials" items={materialOptions}
              itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(materialOptions, materialIds)} onChange={({ selectedItems }) => url.setList('material', selectedItems)}
            />
          )}
          <MultiSelect
            id={`${id}-product-filter`} className="mj-filter-panel__field" titleText="Product" label="All products" items={productOptions}
            itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(productOptions, productIds)} onChange={({ selectedItems }) => url.setList('product', selectedItems)}
          />
          <MultiSelect
            id={`${id}-manufacturer-filter`} className="mj-filter-panel__field" titleText="Manufacturer" label="All manufacturers" items={manufacturerOptions}
            itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(manufacturerOptions, manufacturerIds)} onChange={({ selectedItems }) => url.setList('manufacturer', selectedItems)}
          />
          <MultiSelect
            id={`${id}-kind-filter`} className="mj-filter-panel__field" titleText="Type" label="All types" items={kindOptions}
            itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(kindOptions, kindIds) as typeof kindOptions} onChange={({ selectedItems }) => url.setList('kind', selectedItems)}
          />
          <MultiSelect
            id={`${id}-lifecycle-filter`} className="mj-filter-panel__field" titleText="Status" label="All statuses" items={lifecycleOptions}
            itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(lifecycleOptions, lifecycleIds) as typeof lifecycleOptions} onChange={({ selectedItems }) => url.setList('lifecycle', selectedItems)}
          />
          <MultiSelect
            id={`${id}-mounted-filter`} className="mj-filter-panel__field" titleText="Mounted" label="Any" items={mountedOptions}
            itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(mountedOptions, mountedIds)} onChange={({ selectedItems }) => url.setList('mounted', selectedItems)}
          />
          <div className="mj-filter-panel__field">
            <Toggle id={`${id}-archived-filter`} size="sm" labelText="Show archived" labelA="Hidden" labelB="Shown" toggled={showArchived} onToggle={(checked) => url.set({ archived: checked ? '1' : null })} />
          </div>
        </>
      )}
      empty={{
        title: 'No spools yet', description: 'Register a spool to track filament weight, location and printer slots.',
        action: canRegister ? <Button kind="tertiary" onClick={onRegister}>Register spool</Button> : undefined,
      }}
    />
  );
}
