/* eslint-disable react-refresh/only-export-components -- the table and its URL-state hooks belong together */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Button, DataTable, Pagination, Table, TableBatchActions, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableSelectAll, TableSelectRow, TableToolbar, TableToolbarContent,
  TableToolbarMenu, TableToolbarSearch,
} from '@carbon/react';
import { useSearchParams } from 'react-router-dom';
import { BatchFilter, toPatch, type FilterCategory, type FilterValues } from '../../../app/BatchFilter';
import { EmptyState } from '../../../app/PageState';
import { useLatestCallback } from '../../../app/useLatestCallback';
import './shared.scss';

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Makes the column sortable. In client mode this orders the rows; in server mode it only enables the header. */
  sortValue?: (row: T) => string | number;
  /** First sort direction when the column is chosen. */
  firstDirection?: 'ASC' | 'DESC';
  /** Hidden below 42rem; the first column repeats such details as secondary lines. */
  narrow?: boolean;
};

export type Option = { id: string; label: string };
export type Sort = { key: string; direction: 'ASC' | 'DESC' };
export const selectedOptions = (options: Option[], ids: string[]) => options.filter((option) => ids.includes(option.id));

/** Filter, search and page state of one table, kept in URL parameters under a prefix so several tables can share a page. */
export function useUrlState(prefix: string) {
  const [params, setParams] = useSearchParams();
  const name = (key: string) => `${prefix}${key}`;
  const get = (key: string) => params.get(name(key)) ?? '';
  const list = (key: string) => get(key).split(',').filter(Boolean);
  const set = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(name(key), value); else next.delete(name(key)); }
    if (!('page' in patch)) next.delete(name('page'));
    return next;
  }, { replace: true });
  const setList = (key: string, items: Option[] | null | undefined) => set({ [key]: (items ?? []).map((item) => item.id).join(',') || null });
  const clear = (keys: string[]) => set(Object.fromEntries(keys.map((key) => [key, null])));
  return { get, list, set, setList, clear, params };
}

const DEFAULT_PAGE_SIZES = [10, 25, 50];

/**
 * Search, page and sort of a server-side table, read from the same URL parameters `DirectoryTable` writes
 * (`q`, `page`, `pageSize`, `sort` as "key:ASC"). Use the values to build the query; pass `sort` and `setSort`
 * to the table.
 */
export function useServerTableState(prefix: string, defaultSort: Sort, pageSizes: number[] = DEFAULT_PAGE_SIZES, defaultPageSize: number = pageSizes[0]) {
  const url = useUrlState(prefix);
  const [sortKey, sortDirection] = url.get('sort').split(':');
  const sort: Sort = sortKey && (sortDirection === 'ASC' || sortDirection === 'DESC') ? { key: sortKey, direction: sortDirection } : defaultSort;
  const pageSize = pageSizes.includes(Number(url.get('pageSize'))) ? Number(url.get('pageSize')) : defaultPageSize;
  const page = Math.max(1, Math.floor(Number(url.get('page'))) || 1);
  const setSort = (next: Sort) => url.set({ sort: `${next.key}:${next.direction}` });
  return { url, search: url.get('q'), page, pageSize, sort, setSort };
}

/**
 * Row selection with batch actions. The table owns the checkboxes and the Carbon batch-action bar; the page owns the
 * selected rows (so they survive paging and sorting) and the actions.
 */
export type Selection<T extends { id: string }> = {
  /** The selected rows, including rows of other pages. */
  selected: T[];
  onChange: (rows: T[]) => void;
  /** `TableBatchAction` elements shown while rows are selected. */
  actions: ReactNode;
  /** Accessible name of a row's checkbox, e.g. `Select J-2026-000001`. */
  rowLabel: (row: T) => string;
};

type CommonProps<T extends { id: string }> = {
  /** Unique per page: element ids, aria labels and (unless `urlPrefix` is set) the URL parameter prefix. */
  id: string;
  label: string;
  columns: Column<T>[];
  /** Columns of the batch filter panel. Each category key is also the URL parameter (under the table prefix) that stores its applied choices. */
  filterCategories?: FilterCategory[];
  /** Section switcher shown at the start of the toolbar when sibling tables share a page. */
  switcher?: ReactNode;
  /** Runs when filters are reset (panel or empty state), in addition to clearing the `filterCategories` URL parameters. */
  onClearFilters?: () => void;
  toolbarAction?: ReactNode;
  /** Overflow items (`TableToolbarAction`) shown in a menu before the primary action. */
  toolbarMenu?: ReactNode;
  empty: { title: string; description: string; action?: ReactNode };
  pageSizes?: number[];
  /** Page size when the URL names none; defaults to the first of `pageSizes`. Use the same value for `useServerTableState`. */
  defaultPageSize?: number;
  /** Makes whole rows clickable (mouse convenience); the row must also offer a keyboard-reachable control that does the same. */
  onRowClick?: (row: T) => void;
  /** URL parameter prefix when it should differ from `id`; `''` gives plain `q`, `page`, `pageSize` parameters. */
  urlPrefix?: string;
  /** Extra class on the toolbar. */
  toolbarClassName?: string;
  /** Set to false for a server table whose query has no search parameter: the toolbar then has no search field. */
  searchable?: boolean;
  /** Adds a checkbox column and a batch-action bar to the toolbar. */
  selection?: Selection<T>;
};

type ClientProps<T extends { id: string }> = {
  mode?: 'client';
  /** Rows after the filter panel's filters; search, sort and paging happen here. */
  rows: T[];
  /** Rows before any filter or search, to tell "nothing yet" from "nothing found". */
  totalCount: number;
  searchText: (row: T) => string;
  defaultSort: Sort;
};

type ServerProps<T extends { id: string }> = {
  mode: 'server';
  /** The current page, already searched, filtered, sorted and paged by the server. */
  rows: T[];
  /** All rows matching the current search and filters. */
  total: number;
  /** True when nothing exists at all, to tell "nothing yet" from "nothing found". Defaults to "no search or filter is active". */
  isEmptyDataset?: boolean;
  sort?: Sort;
  onSortChange?: (sort: Sort) => void;
  /** Milliseconds to wait after typing before the search reaches the URL (and so the query). */
  searchDebounceMs?: number;
};

type Props<T extends { id: string }> = CommonProps<T> & (ClientProps<T> | ServerProps<T>);

/**
 * Directory-style table shared by every list: expandable search, a batch filter panel (staged choices applied at once),
 * an optional section switcher, primary action in the toolbar, sorting and pagination in the container. Client mode sorts and pages the full
 * filtered list; server mode renders one page and reports sort, page and search through URL parameters.
 */
export function DirectoryTable<T extends { id: string }>(props: Props<T>) {
  const {
    id, label, columns, filterCategories, switcher, onClearFilters, toolbarAction, toolbarMenu, empty, pageSizes = DEFAULT_PAGE_SIZES, defaultPageSize = pageSizes[0], onRowClick, urlPrefix = id, toolbarClassName, searchable = true, selection,
  } = props;
  const server = props.mode === 'server';
  const url = useUrlState(urlPrefix);
  const filterKeys = (filterCategories ?? []).flatMap((category) => category.keys ?? [category.key]);
  const applied: FilterValues = Object.fromEntries(filterKeys.map((key) => [key, url.list(key)]));
  const hasActiveFilters = filterKeys.some((key) => url.get(key));
  const [searchKey, setSearchKey] = useState(0);
  const [clientSort, setClientSort] = useState<Sort>(server ? { key: '', direction: 'ASC' } : props.defaultSort);
  const sort = server ? props.sort ?? clientSort : clientSort;
  const search = url.get('q');
  const searchTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  const clientRows = server ? null : props.rows;
  const searchText = server ? null : props.searchText;
  // Filters and sorts the whole client-side table, so it is recomputed only when rows, sort or search change.
  const clientVisible = useMemo(() => {
    if (!clientRows || !searchText) return [];
    const column = columns.find((item) => item.key === clientSort.key);
    const direction = clientSort.direction === 'ASC' ? 1 : -1;
    const term = search.toLowerCase();
    const filtered = term ? clientRows.filter((row) => searchText(row).toLowerCase().includes(term)) : [...clientRows];
    if (!column?.sortValue) return filtered;
    const value = column.sortValue;
    return filtered.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * direction;
    });
  }, [clientRows, columns, clientSort, search, searchText]);

  const matching = server ? props.total : clientVisible.length;
  const pageSize = pageSizes.includes(Number(url.get('pageSize'))) ? Number(url.get('pageSize')) : defaultPageSize;
  const lastPage = Math.ceil(matching / pageSize) || 1;
  const requestedPage = Math.max(1, Math.floor(Number(url.get('page'))) || 1);
  const page = Math.min(requestedPage, lastPage);
  // A server page that no longer exists (rows were removed, filters narrowed) falls back to the last one.
  const pageGone = server && matching > 0 && requestedPage > lastPage;
  const setUrlPage = useLatestCallback(url.set);
  useEffect(() => { if (pageGone) setUrlPage({ page: String(lastPage) }); }, [pageGone, lastPage, setUrlPage]);
  const pageRows = server ? props.rows : clientVisible.slice((page - 1) * pageSize, page * pageSize);
  const rowsById = new Map(pageRows.map((row) => [row.id, row]));
  const tableRows = pageRows.map((row) => ({ id: row.id }));
  const headers = columns.map(({ key, header }) => ({ key, header }));
  const sortBy = (column: Column<T>) => {
    const next: Sort = sort.key === column.key
      ? { key: column.key, direction: sort.direction === 'ASC' ? 'DESC' : 'ASC' }
      : { key: column.key, direction: column.firstDirection ?? 'ASC' };
    if (server && props.onSortChange) props.onSortChange(next); else setClientSort(next);
  };
  const clearAll = () => { onClearFilters?.(); window.clearTimeout(searchTimer.current); url.clear(['q', ...filterKeys]); setSearchKey((key) => key + 1); };
  const onSearch = (value: string) => {
    window.clearTimeout(searchTimer.current);
    if (server && props.searchDebounceMs !== 0) searchTimer.current = window.setTimeout(() => url.set({ q: value }), props.searchDebounceMs ?? 300);
    else url.set({ q: value });
  };
  const selectedIds = new Set((selection?.selected ?? []).map((row) => row.id));
  const pageSelected = pageRows.filter((row) => selectedIds.has(row.id)).length;
  const toggleRow = (row: T) => selection?.onChange(selectedIds.has(row.id) ? selection.selected.filter((item) => item.id !== row.id) : [...selection.selected, row]);
  const togglePage = () => {
    if (!selection) return;
    const pageIds = new Set(pageRows.map((row) => row.id));
    selection.onChange(pageSelected === pageRows.length
      ? selection.selected.filter((row) => !pageIds.has(row.id))
      : [...selection.selected.filter((row) => !pageIds.has(row.id)), ...pageRows]);
  };
  const nothingYet = server ? (props.isEmptyDataset ?? (!search && !hasActiveFilters)) : (props.totalCount === 0);

  return (
    <DataTable key={`${page}-${pageSize}-${sort.key}-${sort.direction}`} rows={tableRows} headers={headers}>
      {({ rows: dataRows, headers: tableHeaders, getRowProps, getTableProps }) => (
        <TableContainer className="mj-table-container">
          <TableToolbar className={toolbarClassName} aria-label={`${label} table toolbar`}>
            {selection && (
              <TableBatchActions shouldShowBatchActions={selection.selected.length > 0} totalSelected={selection.selected.length} onCancel={() => selection.onChange([])}>
                {selection.actions}
              </TableBatchActions>
            )}
            {switcher}
            <TableToolbarContent>
              {searchable && <TableToolbarSearch
                key={searchKey}
                id={`${id}-search`}
                labelText={`Search ${label.toLowerCase()}`}
                placeholder={`Search ${label.toLowerCase()}`}
                defaultValue={search}
                onChange={(_event, value) => onSearch(value ?? '')}
                onClear={() => { window.clearTimeout(searchTimer.current); url.set({ q: null }); }}
              />}
              {filterCategories && filterCategories.length > 0 && (
                <BatchFilter
                  id={id} label={label} categories={filterCategories} applied={applied}
                  onApply={(values) => url.set(toPatch(values, filterKeys))} onReset={() => { onClearFilters?.(); url.clear(filterKeys); }}
                />
              )}
              {toolbarMenu && <TableToolbarMenu iconDescription="More actions">{toolbarMenu}</TableToolbarMenu>}
              {toolbarAction}
            </TableToolbarContent>
          </TableToolbar>
          <Table {...getTableProps()} aria-label={label}>
            <TableHead>
              <TableRow>
                {selection && (
                  <TableSelectAll
                    id={`${id}-select-all`} name={`${id}-select-all`} aria-label={`Select all ${label.toLowerCase()} on this page`}
                    checked={pageRows.length > 0 && pageSelected === pageRows.length} indeterminate={pageSelected > 0 && pageSelected < pageRows.length} onSelect={togglePage}
                  />
                )}
                {tableHeaders.map((header) => {
                  const column = columns.find((item) => item.key === header.key);
                  if (!column) return null;
                  const className = column.narrow ? 'mj-hide-narrow' : undefined;
                  return column.sortValue ? (
                    <TableHeader
                      key={header.key} className={className} isSortable isSortHeader={sort.key === column.key}
                      sortDirection={sort.key === column.key ? sort.direction : 'NONE'} onClick={() => sortBy(column)}
                    >
                      {header.header}
                    </TableHeader>
                  ) : <TableHeader key={header.key} className={className}>{header.header}</TableHeader>;
                })}
              </TableRow>
            </TableHead>
            <TableBody>
              {dataRows.map((tableRow) => {
                const row = rowsById.get(tableRow.id);
                if (!row) return null;
                const { key, ...rowProps } = getRowProps({ row: tableRow });
                return (
                  <TableRow
                    key={key} {...rowProps} isSelected={selectedIds.has(row.id)} className={onRowClick ? 'mj-row-clickable' : undefined}
                    onClick={onRowClick ? (event: MouseEvent<HTMLElement>) => { if (!(event.target as HTMLElement).closest('a, button, input, label')) onRowClick(row); } : undefined}
                  >
                    {selection && (
                      <TableSelectRow
                        id={`${id}-select-${row.id}`} name={`${id}-select-${row.id}`} aria-label={selection.rowLabel(row)}
                        checked={selectedIds.has(row.id)} onSelect={() => toggleRow(row)}
                      />
                    )}
                    {columns.map((column) => (
                      <TableCell key={column.key} className={column.narrow ? 'mj-hide-narrow' : undefined}>{column.render(row)}</TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {matching === 0 && (nothingYet
            ? <EmptyState title={empty.title} description={empty.description} action={empty.action} />
            : <EmptyState title={`No ${label.toLowerCase()} found`} description="Try different search terms or filters." action={<Button kind="tertiary" onClick={clearAll}>Clear filters</Button>} />)}
          <Pagination
            page={page} pageSize={pageSize} pageSizes={pageSizes} totalItems={matching}
            onChange={({ page: nextPage, pageSize: nextSize }) => url.set({ page: String(nextPage), pageSize: String(nextSize) })}
          />
        </TableContainer>
      )}
    </DataTable>
  );
}
