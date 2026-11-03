import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';

export type StatsColumn = { key: string; header: string; numeric?: boolean };
export type StatsRow = { id: string; cells: ReactNode[] };

/** A compact read-only Carbon table inside a statistics card, edge to edge, with numbers aligned at the end. */
export function StatsTable({
  label,
  columns,
  rows,
  total,
}: {
  label: string;
  columns: StatsColumn[];
  rows: StatsRow[];
  /** A last row in bold, e.g. the sum of every row. */
  total?: ReactNode[];
}) {
  const cellClass = (index: number) => (columns[index]?.numeric ? 'stats-table__number' : undefined);
  return (
    // The wrapper scrolls a wide table sideways, so keyboard users can focus it to scroll.
    <div className="stats-table" role="region" aria-label={label} tabIndex={0}>
      <Table aria-label={label} size="md" useZebraStyles={false}>
        <TableHead>
          <TableRow>
            {columns.map((column, index) => (
              <TableHeader key={column.key} className={cellClass(index)}>
                {column.header}
              </TableHeader>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              {row.cells.map((cell, index) => (
                <TableCell key={columns[index]?.key ?? index} className={cellClass(index)}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {total && (
            <TableRow className="stats-table__total">
              {total.map((cell, index) => (
                <TableCell key={columns[index]?.key ?? index} className={cellClass(index)}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
