import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';
import { PanelBleed } from '../../../app/components/DetailPanel';

export type PanelColumn<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Right-aligned numbers. */
  numeric?: boolean;
};

/**
 * A compact, edge-to-edge Carbon table for a detail panel (`.dt--panel` in `.panel__bleed`): no toolbar, sorting or
 * paging; the panel shows the most relevant rows and links to the full list.
 */
export function PanelTable<T extends { id: string }>({
  label,
  columns,
  rows,
  emptyText,
}: {
  label: string;
  columns: PanelColumn<T>[];
  rows: T[];
  emptyText: string;
}) {
  return (
    <PanelBleed>
      <Table size="sm" aria-label={label} className="inv-panel-table">
        <TableHead>
          <TableRow>
            {columns.map((column) => (
              <TableHeader key={column.key} className={column.numeric ? 'inv-numeric' : undefined}>
                {column.header}
              </TableHeader>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="inv-panel-table__empty">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.numeric ? 'inv-numeric' : undefined}>
                    {column.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </PanelBleed>
  );
}
