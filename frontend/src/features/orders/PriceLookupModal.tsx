import { useState } from 'react';
import {
  ContentSwitcher,
  InlineNotification,
  Modal,
  SkeletonText,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
} from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { GetPriceQuoteParams, Material, PriceQuote, PriceQuoteGroup } from '../../api/generated/models';
import { FuzzyComboBox } from '../../app/components/FuzzyComboBox';
import { parseDecimalText } from '../../app/decimalInput';
import { useStableItems } from '../../app/useStableItems';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { allMaterialsQuery } from '../machinelogbook/inventoryQueries';
import { machinesQuery } from '../machinelogbook/queries';
import { formatMoney } from './formatting';
import { priceQuoteQuery } from './queries';
import { articleUnitLabel, unitSymbol } from '../machinelogbook/units';

type Mode = 'machine' | 'item';
type Option = { id: string; label: string };

const positive = (text: string) => {
  const value = parseDecimalText(text);
  return value !== null && Number(value) > 0 ? value : null;
};

function Rate({
  amount,
  rate,
  unit,
  source,
}: {
  amount: string | null;
  rate: string | null;
  unit: string;
  source?: PriceQuoteGroup['materialPriceSource'];
}) {
  if (amount === null || rate === null) return <Tag size="sm">No rate</Tag>;
  return (
    <span className="mj-cell-stack">
      <strong>{formatMoney(amount)}</strong>
      <span className="mj-secondary">
        {rate} € / {unit}
        {source === 'stock_article' ? ' · article price' : source === 'material_type' ? ' · material type rate' : ''}
      </span>
    </span>
  );
}

function QuoteTable({ quote }: { quote: PriceQuote }) {
  return (
    <Table aria-label="Prices by pricing group" size="md">
      <TableHead>
        <TableRow>
          <TableHeader>Pricing group</TableHeader>
          {quote.machine && <TableHeader>Machine · {quote.machine.name}</TableHeader>}
          {quote.material && (
            <TableHeader>
              {quote.machine ? 'Material' : 'Article'} · {quote.material.displayId} {quote.material.name}
            </TableHeader>
          )}
          <TableHeader>Total</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {quote.groups.map((group: PriceQuoteGroup) => (
          <TableRow key={group.pricingGroupId}>
            <TableCell>
              {group.name}{' '}
              {group.isDefault && (
                <Tag type="blue" size="sm">
                  Default
                </Tag>
              )}
            </TableCell>
            {quote.machine && (
              <TableCell>
                <Rate amount={group.machineAmount} rate={group.machineRate} unit="h" />
              </TableCell>
            )}
            {quote.material && (
              <TableCell>
                <Rate
                  amount={group.materialAmount}
                  rate={group.materialRate}
                  unit={unitSymbol(quote.material.unit)}
                  source={group.materialPriceSource}
                />
              </TableCell>
            )}
            <TableCell>{group.total === null ? '—' : <strong>{formatMoney(group.total)}</strong>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Read-only price lookup: a machine run, an inventory article, or both, priced for every pricing group. */
export function PriceLookupModal({ onClose }: { onClose: () => void }) {
  const user = useCurrentUser();
  const canMachines = hasPermission(user, PermissionId.machinesread);
  const canItems = hasPermission(user, PermissionId.inventoryread);
  const modes: Mode[] = [...(canMachines ? (['machine'] as const) : []), ...(canItems ? (['item'] as const) : [])];
  const [chosen, setChosen] = useState<Mode>('machine');
  const mode = modes.includes(chosen) ? chosen : modes[0];
  const [machine, setMachine] = useState<Option | null>(null);
  const [article, setArticle] = useState<Option | null>(null);
  const [hours, setHours] = useState('');
  const [quantity, setQuantity] = useState('');

  const machines = useQuery({ ...machinesQuery({ pageSize: 100 }), enabled: canMachines });
  const materials = useQuery({ ...allMaterialsQuery(), enabled: canItems });
  const machineOptions = useStableItems<Option>(
    (machines.data?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
  );
  const materialList: Material[] = materials.data?.items ?? [];
  const articleOptions = useStableItems<Option>(
    // A machine run only uses articles whose material type is used on machines.
    materialList
      .filter((item) => item.active && (mode !== 'machine' || item.machineUse))
      .map((item) => ({
        id: item.id,
        label: `${item.displayId} · ${item.name} (${articleUnitLabel(item.unit, item.countLabel)})`,
      })),
  );
  const unitArticle = materialList.find((item) => item.id === article?.id);
  const unit = unitArticle ? articleUnitLabel(unitArticle.unit, unitArticle.countLabel) : undefined;

  const hoursValue = positive(hours);
  const quantityValue = positive(quantity);
  const params: GetPriceQuoteParams | null = (() => {
    if (mode === 'machine') {
      if (!machine || !hoursValue) return null;
      if (!article) return { machineId: machine.id, hours: hoursValue };
      if (!quantityValue) return null;
      return { machineId: machine.id, hours: hoursValue, materialId: article.id, quantity: quantityValue };
    }
    return article && quantityValue ? { materialId: article.id, quantity: quantityValue } : null;
  })();
  const quote = useQuery({
    ...priceQuoteQuery(params ?? {}),
    enabled: params !== null,
    placeholderData: keepPreviousData,
  });

  const quantityField = (
    <TextInput
      id="price-lookup-quantity"
      labelText={unit ? `Quantity (${unit})` : 'Quantity'}
      inputMode="decimal"
      value={quantity}
      invalid={quantity.trim() !== '' && quantityValue === null}
      invalidText="Enter an amount greater than zero."
      onChange={(event) => setQuantity(event.target.value)}
    />
  );
  const articleField = (
    <FuzzyComboBox<Option>
      autoAlign
      id="price-lookup-article"
      titleText={mode === 'machine' ? 'Material article (optional)' : 'Inventory article'}
      placeholder="Search articles"
      items={articleOptions}
      itemToString={(item) => item?.label ?? ''}
      selectedItem={article}
      onChange={({ selectedItem }) => setArticle(selectedItem ?? null)}
    />
  );
  const result = params !== null ? quote.data : undefined;

  return (
    <Modal
      open
      passiveModal
      modalHeading="Price lookup"
      modalLabel="Sales & payments"
      onRequestClose={onClose}
      size="lg"
    >
      <Stack gap={5}>
        {modes.length === 0 ? (
          <InlineNotification
            kind="info"
            hideCloseButton
            lowContrast
            title="Nothing to look up"
            subtitle="You need access to machines or the inventory to price them."
          />
        ) : (
          <>
            {modes.length > 1 && (
              <ContentSwitcher
                size="md"
                aria-label="Lookup type"
                selectedIndex={modes.indexOf(mode)}
                onChange={({ name }) => {
                  setChosen(name as Mode);
                  setArticle(null);
                  setQuantity('');
                }}
              >
                {modes.map((item) => (
                  <Switch key={item} name={item} text={item === 'machine' ? 'Machine run' : 'Inventory item'} />
                ))}
              </ContentSwitcher>
            )}
            {mode === 'machine' && (
              <>
                <FuzzyComboBox<Option>
                  autoAlign
                  id="price-lookup-machine"
                  titleText="Machine"
                  placeholder="Search machines"
                  items={machineOptions}
                  itemToString={(item) => item?.label ?? ''}
                  selectedItem={machine}
                  onChange={({ selectedItem }) => setMachine(selectedItem ?? null)}
                />
                <TextInput
                  id="price-lookup-hours"
                  labelText="Hours"
                  inputMode="decimal"
                  value={hours}
                  invalid={hours.trim() !== '' && hoursValue === null}
                  invalidText="Enter a duration greater than zero."
                  onChange={(event) => setHours(event.target.value)}
                />
                {canItems && (
                  <>
                    {articleField}
                    {article && quantityField}
                  </>
                )}
              </>
            )}
            {mode === 'item' && (
              <>
                {articleField}
                {quantityField}
              </>
            )}
            {(machines.isError || materials.isError) && (
              <InlineNotification
                kind="error"
                hideCloseButton
                lowContrast
                title="The lists could not be loaded."
                subtitle="Close this dialog and try again."
              />
            )}
            {params === null && (
              <p className="mj-secondary">
                {mode === 'machine'
                  ? 'Pick a machine and enter the hours to see the price for every pricing group.'
                  : 'Pick an article and enter a quantity to see the price for every pricing group.'}
              </p>
            )}
            {params !== null && quote.isPending && <SkeletonText paragraph lineCount={3} />}
            {params !== null && quote.isError && (
              <InlineNotification
                kind="error"
                hideCloseButton
                lowContrast
                title="The price could not be calculated."
                subtitle="Check the inputs and try again."
              />
            )}
            {result && <QuoteTable quote={result} />}
            {result && mode === 'item' && (
              <p className="mj-secondary">
                Sold from stock, an article costs its own price per group; without one, the rate of its material type
                applies when the type is used on machines.
              </p>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}
