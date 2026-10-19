import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { Button, Link as CarbonLink, Tag } from '@carbon/react';
import { Link } from 'react-router-dom';
import { formatMoney } from '../derived';
import { useStore } from '../store';
import type { FilamentProduct } from '../types';
import { DirectoryTable, useUrlState, type Column, type Option } from './DirectoryTable';
import { formatGrams, packagingOptions, PackagingTag, productInUse } from './inventoryShared';

type Row = FilamentProduct & { materialName: string; inUse: number };

type Props = {
  /** Section switcher for the toolbar when the table shares a page with sibling tables. */
  switcher?: ReactNode;
  /** Unique per page. */
  id: string;
  /** Set on a material page: the Material column and filter are dropped. */
  materialId?: string;
  canManage: boolean;
  onAdd: () => void;
  onEdit: (product: FilamentProduct) => void;
};

/** Filament product catalog as a Directory-style table; used on the Inventory page and on a material's page. */
export function ProductsTable({ switcher, id, materialId, canManage, onAdd, onEdit }: Props) {
  const { products, materials, spools } = useStore();
  const url = useUrlState(id);
  const fixedMaterial = materialId != null;
  const manufacturerIds = url.list('manufacturer');
  const materialIds = url.list('material');
  const packagingIds = url.list('packaging');
  const showInactive = url.get('inactive') === '1';

  const scoped = useMemo(() => products.filter((product) => !materialId || product.materialId === materialId), [products, materialId]);
  const all: Row[] = useMemo(() => scoped.map((product) => ({
    ...product, materialName: materials.find((item) => item.id === product.materialId)?.name ?? 'Unknown material', inUse: productInUse(product.id, spools),
  })), [scoped, materials, spools]);
  const manufacturerOptions: Option[] = [...new Set(scoped.map((product) => product.manufacturer))].sort().map((name) => ({ id: name, label: name }));
  const materialOptions: Option[] = materials.filter((material) => scoped.some((product) => product.materialId === material.id)).map((material) => ({ id: material.id, label: material.name }));
  const rows = all.filter((row) => (showInactive || row.active)
    && (manufacturerIds.length === 0 || manufacturerIds.includes(row.manufacturer))
    && (materialIds.length === 0 || materialIds.includes(row.materialId))
    && (packagingIds.length === 0 || packagingIds.includes(row.packaging)));

  const columns: Column<Row>[] = [
    {
      key: 'product', header: 'Product', sortValue: (row) => `${row.name} ${row.manufacturer}`,
      render: (row) => (
        <div className="mj-cell-stack">
          {canManage
            ? <CarbonLink as="button" type="button" className="mj-link-button" onClick={() => onEdit(row)}>{row.name}</CarbonLink>
            : <span>{row.name}</span>}
          <span className="mj-secondary">{row.manufacturer}</span>
          <span className="mj-secondary mj-show-narrow">{[fixedMaterial ? null : row.materialName, formatGrams(row.netWeightG), row.defaultPrice != null ? formatMoney(row.defaultPrice) : null].filter(Boolean).join(' · ')}</span>
          <span className="mj-show-narrow"><PackagingTag packaging={row.packaging} /></span>
        </div>
      ),
    },
    ...(fixedMaterial ? [] : [{
      key: 'material', header: 'Material', narrow: true, sortValue: (row: Row) => row.materialName,
      render: (row: Row) => <CarbonLink as={Link} to={`/inventory/materials/${row.materialId}`}>{row.materialName}</CarbonLink>,
    } satisfies Column<Row>]),
    { key: 'weight', header: 'Net weight', narrow: true, sortValue: (row) => row.netWeightG, firstDirection: 'DESC', render: (row) => formatGrams(row.netWeightG) },
    { key: 'price', header: 'Default price', narrow: true, sortValue: (row) => row.defaultPrice ?? -1, firstDirection: 'DESC', render: (row) => row.defaultPrice != null ? formatMoney(row.defaultPrice) : '—' },
    { key: 'packaging', header: 'Packaging', narrow: true, sortValue: (row) => row.packaging, render: (row) => <PackagingTag packaging={row.packaging} /> },
    { key: 'inUse', header: 'In use', sortValue: (row) => row.inUse, firstDirection: 'DESC', render: (row) => row.inUse },
    { key: 'status', header: 'Status', narrow: true, sortValue: (row) => row.active ? 0 : 1, render: (row) => row.active ? null : <Tag type="gray" size="sm">Inactive</Tag> },
  ];

  return (
    <DirectoryTable
      switcher={switcher} id={id} label="Products" columns={columns} rows={rows} totalCount={scoped.length}
      searchText={(row) => [row.manufacturer, row.name, row.materialName, row.notes].filter(Boolean).join(' ')}
      defaultSort={{ key: 'product', direction: 'ASC' }}
      onRowClick={canManage ? onEdit : undefined}
      toolbarAction={canManage ? <Button kind="primary" size="lg" onClick={onAdd}>Add product</Button> : undefined}
      filterCategories={[
        { key: 'manufacturer', label: 'Manufacturer', options: manufacturerOptions },
        ...(fixedMaterial ? [] : [{ key: 'material', label: 'Material', options: materialOptions }]),
        { key: 'packaging', label: 'Packaging', options: packagingOptions },
        { key: 'inactive', label: 'Show', options: [{ id: '1', label: 'Inactive products' }] },
      ]}
      empty={{
        title: 'No products yet', description: 'Add the filament products the makerspace buys, so a spool can be registered with one choice.',
        action: canManage ? <Button kind="tertiary" onClick={onAdd}>Add product</Button> : undefined,
      }}
    />
  );
}
