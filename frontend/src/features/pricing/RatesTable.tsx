import { Fragment, useState } from 'react';
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
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
import { fallbackOf, RATE_SECTIONS, ruleOf, type RateSelector } from './selectors';

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
  const fallback = !rule && selector.section === 'article' ? fallbackOf(group, selector) : undefined;
  // The accessible name starts with the visible text and says which row and group the button changes.
  const target = ` for ${selector.label} in ${group.name}`;
  if (rule || fallback) {
    const text = `${rateText((rule ?? fallback)!.rate)} ${selector.unit}${fallback ? ' · type rate' : ''}`;
    const value = (
      <>
        <span className="sales-rate__value">{rateText((rule ?? fallback)!.rate)}</span>{' '}
        <span className="sales-secondary">
          {selector.unit}
          {fallback && ' · type rate'}
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
      {article ? (
        <span className="sales-secondary">No price</span>
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
  const [editing, setEditing] = useState<{ group: PricingGroup; selector: RateSelector } | null>(null);
  const active = groups.filter((group) => group.active);
  const term = search.trim().toLowerCase();
  const shown = term
    ? selectors.filter((selector) => `${selector.label} ${selector.description}`.toLowerCase().includes(term))
    : selectors;
  const columns = active.length + 1;
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
                {rows.map((selector) => (
                  <TableRow key={selector.key}>
                    <TableCell>
                      <div className="sales-cell">
                        <strong>{selector.label}</strong>
                        <span className="sales-secondary">{selector.description}</span>
                      </div>
                    </TableCell>
                    {active.map((group) => (
                      <TableCell key={group.id}>
                        <RateValue
                          group={group}
                          selector={selector}
                          canEdit={canEdit}
                          onEdit={() => setEditing({ group, selector })}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
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
          Articles whose material type is used on machines are priced by the type rate until they get a price of their
          own; articles without any price cannot be sold to that group.
        </p>
      )}
      {editing && <SetRateModal group={editing.group} selector={editing.selector} onClose={() => setEditing(null)} />}
    </TableContainer>
  );
}
