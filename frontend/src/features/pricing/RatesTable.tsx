import { Fragment, useState } from 'react';
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableExpandHeader,
  TableExpandRow,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Tag,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import type { PricingGroup } from '../../api/generated/models';
import { rateText } from './pricingShared';
import { SetRateModal } from './SetRateModal';
import { fallbackOf, inheritedOf, RATE_SECTIONS, ruleOf, selectorName, type RateSelector } from './selectors';

function RateValue({
  group,
  selector,
  canEdit,
  onEdit,
}: {
  group: PricingGroup;
  selector: RateSelector;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const rule = ruleOf(group, selector);
  // A row without a rate of its own shows the rate it falls back to: the type rate for an article or a variant.
  const variant = !!selector.materialTypeVariantId;
  const fallback = rule
    ? undefined
    : variant
      ? inheritedOf(group, selector)
      : selector.section === 'article'
        ? fallbackOf(group, selector)
        : undefined;
  const marker = variant ? 'inherited' : 'type rate';
  // The accessible name starts with the visible text and says which row and group the button changes.
  const target = ` for ${selectorName(selector)} in ${group.name}`;
  if (rule || fallback) {
    const text = `${rateText((rule ?? fallback)!.rate)} ${selector.unit}${fallback ? ` · ${marker}` : ''}`;
    const value = (
      <>
        <span className="sales-rate__value">{rateText((rule ?? fallback)!.rate)}</span>{' '}
        <span className="sales-secondary">
          {selector.unit}
          {fallback && ` · ${marker}`}
        </span>
      </>
    );
    return canEdit ? (
      <Button
        kind="ghost"
        size="sm"
        className={`sales-rate${fallback ? ' sales-rate--fallback' : ''}`}
        aria-label={`${text}${target}`}
        onClick={onEdit}
      >
        {value}
      </Button>
    ) : (
      <span className={`sales-rate${fallback ? ' sales-rate--fallback' : ''}`}>{value}</span>
    );
  }
  const article = selector.section === 'article';
  return (
    <span className="sales-rate">
      {article || variant ? (
        <span className="sales-secondary">{variant ? 'No rate' : 'No price'}</span>
      ) : (
        <Tag type="red" size="sm">
          Missing
        </Tag>
      )}
      {canEdit && (
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Add}
          aria-label={`${article ? 'Set price' : 'Set rate'}${target}`}
          onClick={onEdit}
        >
          {article ? 'Set price' : 'Set rate'}
        </Button>
      )}
    </span>
  );
}

/**
 * The rates matrix: one column per active pricing group and rows grouped into machine time, measures, materials used
 * on machines and articles sold from stock. A cell opens the rate dialog for that row and group.
 */
export function RatesTable({
  groups,
  selectors,
  canEdit,
}: {
  groups: PricingGroup[];
  selectors: RateSelector[];
  canEdit: boolean;
}) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<{ group: PricingGroup; selector: RateSelector } | null>(null);
  const active = groups.filter((group) => group.active);
  const term = search.trim().toLowerCase();
  const matches = (selector: RateSelector) => `${selector.label} ${selector.description}`.toLowerCase().includes(term);
  // A type stays visible when one of its variants matches, and then it is expanded to show that variant.
  const matchedParents = new Set(
    term ? selectors.filter((s) => s.parentKey && matches(s)).map((s) => s.parentKey) : [],
  );
  const shown = term
    ? selectors.filter((selector) =>
        selector.parentKey ? matches(selector) : matches(selector) || matchedParents.has(selector.key),
      )
    : selectors;
  const isExpanded = (selector: RateSelector) => expanded.has(selector.key) || matchedParents.has(selector.key);
  const columns = active.length + 2;
  return (
    <TableContainer
      title="Rates"
      description={
        canEdit
          ? 'Each cell is the price of one hour of machine time, a measure block or one unit of material or of an article. Select a rate to change it; an explicit 0 means free.'
          : 'Each cell is the price of one hour of machine time, a measure block or one unit of material or of an article.'
      }
    >
      <TableToolbar aria-label="Rates table toolbar">
        <TableToolbarContent>
          <TableToolbarSearch
            id="rates-search"
            labelText="Search rates"
            placeholder="Search rates"
            persistent
            onChange={(_event, value) => setSearch(value ?? '')}
          />
        </TableToolbarContent>
      </TableToolbar>
      <Table aria-label="Rates" className="sales-rates">
        <TableHead>
          <TableRow>
            <TableExpandHeader aria-label="Variants" />
            <TableHeader>Rate</TableHeader>
            {active.map((group) => (
              <TableHeader key={group.id}>
                {group.name}
                {group.isDefault && (
                  <>
                    {' '}
                    <Tag type="blue" size="sm">
                      Default
                    </Tag>
                  </>
                )}
              </TableHeader>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {selectors.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns}>No machine, material or article to price yet.</TableCell>
            </TableRow>
          )}
          {RATE_SECTIONS.map((section) => {
            const rows = shown.filter((selector) => selector.section === section.id);
            if (rows.length === 0) return null;
            return (
              <Fragment key={section.id}>
                <TableRow className="sales-rates__group">
                  <TableCell colSpan={columns}>
                    <strong>{section.title}</strong>
                  </TableCell>
                </TableRow>
                {rows.flatMap((selector) => {
                  if (selector.parentKey) return [];
                  const variants = rows.filter((row) => row.parentKey === selector.key);
                  const cells = (row: RateSelector) =>
                    active.map((group) => (
                      <TableCell key={group.id}>
                        <RateValue
                          group={group}
                          selector={row}
                          canEdit={canEdit}
                          onEdit={() => setEditing({ group, selector: row })}
                        />
                      </TableCell>
                    ));
                  const name = (row: RateSelector) => (
                    <TableCell>
                      <div className="sales-cell">
                        <strong>{row.label}</strong>
                        <span className="sales-secondary">{row.description}</span>
                      </div>
                    </TableCell>
                  );
                  const head =
                    variants.length > 0 ? (
                      <TableExpandRow
                        key={selector.key}
                        aria-label={`Show variants of ${selector.label}`}
                        isExpanded={isExpanded(selector)}
                        onExpand={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (!next.delete(selector.key)) next.add(selector.key);
                            return next;
                          })
                        }
                      >
                        {name(selector)}
                        {cells(selector)}
                      </TableExpandRow>
                    ) : (
                      <TableRow key={selector.key}>
                        <TableCell />
                        {name(selector)}
                        {cells(selector)}
                      </TableRow>
                    );
                  return [
                    head,
                    ...(isExpanded(selector)
                      ? variants.map((variant) => (
                          <TableRow key={variant.key}>
                            <TableCell />
                            {name(variant)}
                            {cells(variant)}
                          </TableRow>
                        ))
                      : []),
                  ];
                })}
              </Fragment>
            );
          })}
          {selectors.length > 0 && shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns}>No rate matches “{search}”.</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {selectors.some((selector) => selector.section === 'article') && (
        <p className="sales-secondary sales-table-note">
          Articles of material types used on machines sell at the type rate above; only other articles have prices of
          their own, and an article without a price cannot be sold to that group.
        </p>
      )}
      {editing && <SetRateModal group={editing.group} selector={editing.selector} onClose={() => setEditing(null)} />}
    </TableContainer>
  );
}
