/* eslint-disable react-refresh/only-export-components -- the picker and its catalog helpers belong together */
import { useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  ComposedModal,
  DataTable,
  InlineNotification,
  ModalBody,
  ModalHeader,
  Search,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableSelectRow,
  TextInput,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { Material, MaterialType, MaterialUnit, Process } from '../../../api/generated/models';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { fuzzyScore } from '../../../app/fuzzy';
import { allMaterialsQuery, materialTypesQuery } from '../inventoryQueries';
import { materialsForProcess, unitText } from '../processConfig';
import { articleUnitLabel } from '../units';
import { formatQuantity } from '../shared/format';
import '../styles/jobs.scss';
import '../jobs/jobs.scss';

/** What the picker hands back: an article of the stock, or material the recipient brought. */
export type PickedMaterial =
  { kind: 'stock'; material: Material } | { kind: 'own'; label: string; materialType: MaterialType | null };

const rateFormat = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

/** The sale price per unit over the active pricing groups: one rate, or the lowest and highest. */
export function priceRange(material: Pick<Material, 'prices' | 'unit' | 'countLabel'>): string {
  const rates = material.prices.map((price) => Number(price.rate)).filter((rate) => Number.isFinite(rate));
  if (rates.length === 0) return '—';
  const low = Math.min(...rates);
  const high = Math.max(...rates);
  const unit = articleUnitLabel(material.unit, material.countLabel);
  return low === high
    ? `${rateFormat.format(low)} / ${unit}`
    : `${rateFormat.format(low)}–${rateFormat.format(high)} / ${unit}`;
}

/** The material types a machine's process uses, or every machine-use type without a process. */
export const typesForProcess = (types: MaterialType[] | undefined, process: Pick<Process, 'id'> | undefined) =>
  (types ?? []).filter((type) => type.active && type.machineUse && (!process || type.processIds.includes(process.id)));

export function stockText(material: Pick<Material, 'quantity' | 'unit' | 'countLabel'>) {
  return `${formatQuantity(material.quantity)} ${articleUnitLabel(material.unit as MaterialUnit, material.countLabel)}`;
}

/** The stock of an article; `loose` (selling) counts only what is on no spool. */
function StockCell({ material, loose }: { material: Material; loose: boolean }) {
  const quantity = loose ? material.unassignedQuantity : material.quantity;
  const empty = Number(quantity) <= 0;
  return (
    <div className="mj-cell-stack">
      <span className={empty ? 'jobs-picker__out' : undefined}>
        {empty ? 'Out of stock' : stockText({ ...material, quantity })}
      </span>
      {!empty && material.stockState === 'low_stock' && <span className="mj-secondary">Low stock</span>}
    </div>
  );
}

const headers = [
  { key: 'category', header: 'Category' },
  { key: 'name', header: 'Name' },
  { key: 'manufacturer', header: 'Manufacturer' },
  { key: 'stock', header: 'Stock' },
  { key: 'location', header: 'Location' },
  { key: 'price', header: 'Price' },
  { key: 'unit', header: 'Unit' },
];

function PickerBody({
  process,
  selectedMaterialId,
  own,
  sale,
  onPick,
}: {
  process?: Process;
  selectedMaterialId?: string;
  own?: { label: string; materialTypeId: string };
  sale: boolean;
  onPick: (picked: PickedMaterial) => void;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [ownLabel, setOwnLabel] = useState(own?.label ?? '');
  const [ownType, setOwnType] = useState<string | null>(own?.materialTypeId || null);
  const materials = useQuery(allMaterialsQuery());
  const types = useQuery(materialTypesQuery());
  const usable = typesForProcess(types.data, process);
  const usableIds = new Set(usable.map((type) => type.id));
  // Selling offers every active article; a machine run only the machine-use articles of its process.
  const articles = sale
    ? (materials.data?.items ?? []).filter((material) => material.active)
    : materialsForProcess(materials.data?.items ?? [], types.data, process).filter(
        (material) => material.active && (!types.data || usableIds.has(material.materialTypeId)),
      );
  const noun = sale ? 'article' : 'material';
  const categories = [...new Map(articles.map((item) => [item.materialTypeId, item.materialTypeName])).entries()].map(
    ([id, label]) => ({ id, label }),
  );
  const visible = articles
    .filter((item) => !category || item.materialTypeId === category)
    .map((item) => ({
      item,
      score: fuzzyScore(
        search,
        [item.name, item.materialTypeName, item.manufacturer, item.variant, item.colorName, item.storageLocation]
          .filter(Boolean)
          .join(' '),
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
  const rows = visible.map((item) => ({ id: item.id }));
  const typeOptions = usable.map((type) => ({ id: type.id, label: `${type.name} (${unitText(type.unit)})` }));
  const canUseOwn = Boolean(ownLabel.trim() || ownType);

  return (
    <div className="jobs-picker__body">
      {(materials.isError || types.isError) && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Inventory could not be loaded"
          subtitle="Close the picker and try again."
        />
      )}
      <div className="jobs-picker__bar">
        <Search
          id="material-picker-search"
          size="lg"
          labelText={`Search ${noun}`}
          placeholder={`Search ${noun}, colour, manufacturer, location`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoComplete="off"
        />
        <FuzzySelectField
          id="material-picker-category"
          titleText="Category"
          placeholder="All categories"
          options={categories}
          value={category}
          onChange={setCategory}
        />
      </div>
      <DataTable rows={rows} headers={headers} size="md" radio>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer className="jobs-picker__table">
            <Table {...getTableProps()} aria-label={sale ? 'Articles in stock' : 'Materials in stock'}>
              <TableHead>
                <TableRow>
                  <th scope="col" className="cds--table-column-checkbox">
                    <span className="cds--visually-hidden">Select</span>
                  </th>
                  {tableHeaders.map((header) => {
                    const { key, ...props } = getHeaderProps({ header });
                    return (
                      <TableHeader key={key} {...props}>
                        {header.header}
                      </TableHeader>
                    );
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const material = visible.find((item) => item.id === row.id);
                  if (!material) return null;
                  const { key, ...rowProps } = getRowProps({ row });
                  const selected = material.id === selectedMaterialId;
                  const pick = () => onPick({ kind: 'stock', material });
                  return (
                    <TableRow
                      key={key}
                      {...rowProps}
                      isSelected={selected}
                      data-guide="material-picker-row"
                      className="mj-row-clickable"
                      onClick={(event: MouseEvent<HTMLElement>) => {
                        if (!(event.target as HTMLElement).closest('input, label')) pick();
                      }}
                    >
                      <TableSelectRow
                        radio
                        id={`material-picker-${material.id}`}
                        name="material-picker"
                        aria-label={`Select ${material.name}`}
                        checked={selected}
                        onSelect={pick}
                      />
                      <TableCell className="mj-secondary">{material.materialTypeName}</TableCell>
                      <TableCell>
                        <span className="mj-inline jobs-picker__name">
                          {material.colorHex && (
                            <span
                              className="mj-swatch"
                              style={{ backgroundColor: material.colorHex }}
                              role="img"
                              aria-label={`Colour ${material.colorName ?? material.colorHex}`}
                            />
                          )}
                          <span>{material.name}</span>
                        </span>
                      </TableCell>
                      <TableCell>{material.manufacturer || '—'}</TableCell>
                      <TableCell>
                        <StockCell material={material} loose={sale} />
                      </TableCell>
                      <TableCell>{material.storageLocation || '—'}</TableCell>
                      <TableCell className="jobs-picker__nowrap">{priceRange(material)}</TableCell>
                      <TableCell>{articleUnitLabel(material.unit, material.countLabel)}</TableCell>
                    </TableRow>
                  );
                })}
                {!materials.isPending && visible.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={headers.length + 1}>
                      {articles.length > 0
                        ? `No ${noun} matches.`
                        : sale
                          ? 'No article in the inventory.'
                          : 'No material of this machine’s process in stock.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>
      {!sale && (
        <section className="jobs-picker__own" aria-labelledby="material-picker-own-title">
          <div>
            <h3 id="material-picker-own-title" className="jobs-picker__own-title">
              Recipient’s own material
            </h3>
            <p className="mj-secondary">
              Brought along by the recipient; recorded for the run, never booked from stock or charged.
            </p>
          </div>
          <div className="jobs-picker__own-form">
            <TextInput
              id="material-picker-own-label"
              labelText="Label"
              placeholder="For example PLA · Sunlu"
              maxLength={200}
              value={ownLabel}
              onChange={(event) => setOwnLabel(event.target.value)}
            />
            <FuzzySelectField
              id="material-picker-own-type"
              titleText="Category"
              placeholder="Select a category"
              options={typeOptions}
              value={ownType}
              onChange={setOwnType}
            />
            <Button
              kind="tertiary"
              size="md"
              disabled={!canUseOwn}
              onClick={() =>
                onPick({
                  kind: 'own',
                  label: ownLabel.trim(),
                  materialType: usable.find((type) => type.id === ownType) ?? null,
                })
              }
            >
              Use
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The catalog picker of the material usage editor: a wide modal with search, category, the machine-use articles of
 * the machine's process with stock, unit and sale prices, and a block for material the recipient brought. With
 * `sale` (an order's stock item) it lists every active article with its loose stock and no such block. It is
 * rendered into the document body so it can show while the form dialog that opened it is hidden.
 */
export function MaterialPickerModal({
  open,
  process,
  selectedMaterialId,
  own,
  sale = false,
  label,
  onClose,
  onPick,
}: {
  open: boolean;
  process?: Process;
  selectedMaterialId?: string;
  own?: { label: string; materialTypeId: string };
  sale?: boolean;
  /** The modal label above the title; by default the process or "Materials in stock". */
  label?: string;
  onClose: () => void;
  onPick: (picked: PickedMaterial) => void;
}) {
  if (!open) return null;
  return createPortal(
    <ComposedModal
      open
      size="lg"
      className="jobs-picker"
      preventCloseOnClickOutside
      selectorPrimaryFocus="#material-picker-search"
      aria-label={sale ? 'Select article' : 'Select material'}
      onClose={() => {
        onClose();
        return false;
      }}
    >
      <ModalHeader
        title={sale ? 'Select article' : 'Select material'}
        label={label ?? (process ? `${process.name} · materials in stock` : 'Materials in stock')}
      />
      <ModalBody hasScrollingContent>
        <PickerBody process={process} selectedMaterialId={selectedMaterialId} own={own} sale={sale} onPick={onPick} />
      </ModalBody>
    </ComposedModal>,
    document.body,
  );
}
