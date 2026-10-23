import {
  Button,
  DataTable,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
  Pagination,
  ProgressBar,
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
import { useNavigate } from 'react-router-dom';
import type { StaffingStatus, SupervisorRow } from '../../api/generated/models';
import { BatchFilter, type FilterCategory, type FilterValues } from '../../app/BatchFilter';
import { formatDate } from '../../app/dateTime';
import { KIND_OPTIONS, LAB_RULES_OPTIONS, PHOTO_OPTIONS, STATUS_OPTIONS, labRulesLabel } from './staffing';

const PAGE_SIZES = [10, 25, 50, 100];

const HEADERS = [
  { key: 'name', header: 'Member' },
  { key: 'kind', header: 'Role' },
  { key: 'labRules', header: 'Lab Rules' },
  { key: 'openDays', header: 'Open days this semester' },
  { key: 'status', header: 'Status' },
  { key: 'last', header: 'Last open day' },
  { key: 'actions', header: '' },
];

const CATEGORIES: FilterCategory[] = [
  { key: 'status', label: 'Semester status', options: STATUS_OPTIONS },
  { key: 'kind', label: 'Role', options: KIND_OPTIONS },
  { key: 'labRules', label: 'Lab Rules', options: LAB_RULES_OPTIONS },
  { key: 'photo', label: 'Profile picture', options: PHOTO_OPTIONS },
];

const STATUS_TAG: Record<StaffingStatus, { label: (row: SupervisorRow) => string; type: 'green' | 'red' | 'purple' }> =
  {
    fulfilled: { label: () => 'Minimum reached', type: 'green' },
    missing: { label: (row) => `${row.missing} missing`, type: 'red' },
    ready: { label: () => 'Ready for supervisor', type: 'purple' },
  };

type Props = {
  /** Rows after search and filters; the table slices out the current page. */
  rows: SupervisorRow[];
  traineeThreshold: number;
  search: string;
  filters: FilterValues;
  page: number;
  pageSize: number;
  canOpenPeople: boolean;
  /** Why "Make supervisor" is unavailable, or null when it is available. */
  promoteBlockedReason: string | null;
  hasAnyRows: boolean;
  onSearch: (value: string) => void;
  onFilters: (values: FilterValues) => void;
  onPage: (page: number, pageSize: number) => void;
  onPromote: (row: SupervisorRow) => void;
};

export function StaffingTable({
  rows,
  traineeThreshold,
  search,
  filters,
  page,
  pageSize,
  canOpenPeople,
  promoteBlockedReason,
  hasAnyRows,
  onSearch,
  onFilters,
  onPage,
  onPromote,
}: Props) {
  const navigate = useNavigate();
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const byId = new Map(pageRows.map((row) => [row.personId, row]));
  const filtered = search.trim() !== '' || Object.values(filters).some((values) => values.length > 0);

  return (
    <DataTable rows={pageRows.map((row) => ({ id: row.personId }))} headers={HEADERS}>
      {({ rows: tableRows, headers, getTableProps, getHeaderProps, getRowProps }) => (
        <TableContainer className="people-table-container supervisor-staffing-table">
          <TableToolbar aria-label="Members table toolbar">
            <TableToolbarContent>
              <TableToolbarSearch
                id="members-search"
                labelText="Search members"
                placeholder="Search members"
                value={search}
                onChange={(_event, value) => onSearch(value ?? '')}
                onClear={() => onSearch('')}
              />
              <BatchFilter
                id="members"
                label="Members"
                categories={CATEGORIES}
                applied={filters}
                onApply={onFilters}
                onReset={() => onFilters({})}
              />
              {canOpenPeople && (
                <Button kind="tertiary" onClick={() => navigate('/people')}>
                  People
                </Button>
              )}
            </TableToolbarContent>
          </TableToolbar>
          <Table {...getTableProps()}>
            <TableHead>
              <TableRow>
                {headers.map((header) => (
                  <TableHeader {...getHeaderProps({ header })} key={header.key}>
                    {header.header}
                  </TableHeader>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {tableRows.map((tableRow) => {
                // Carbon's DataTable adopts new rows one render late; skip rows that just left the page.
                const row = byId.get(tableRow.id);
                if (!row) return null;
                const signedUp = row.staffed + row.booked;
                const tag = STATUS_TAG[row.status];
                const trainee = row.kind === 'trainee';
                return (
                  <TableRow {...getRowProps({ row: tableRow })} key={tableRow.id}>
                    <TableCell>
                      <div className="staffing-cell-stack">
                        {canOpenPeople ? (
                          <CarbonLink
                            href={`/people/${row.personId}`}
                            onClick={(event) => {
                              event.preventDefault();
                              navigate(`/people/${row.personId}`);
                            }}
                          >
                            {row.name}
                          </CarbonLink>
                        ) : (
                          <span>{row.name}</span>
                        )}
                        {!row.hasProfileImage && <span className="staffing-secondary">No profile picture</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="staffing-cell-stack">
                        <Tag type={trainee ? 'teal' : 'cool-gray'} size="sm">
                          {trainee ? 'Trainee' : 'Supervisor'}
                        </Tag>
                        {trainee && (
                          <span className="staffing-secondary">
                            {row.staffedAsTrainee} of {traineeThreshold} as trainee
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Tag
                        type={
                          row.laborordnungState === 'current' || row.laborordnungState === 'not_required'
                            ? 'green'
                            : 'red'
                        }
                        size="sm"
                      >
                        {labRulesLabel(row.laborordnungState)}
                      </Tag>
                    </TableCell>
                    <TableCell>
                      <div className="staffing-progress">
                        <span>
                          {signedUp} of {row.minimum}
                          <span className="staffing-secondary">
                            {' '}
                            · {row.staffed} staffed, {row.booked} booked
                          </span>
                        </span>
                        <ProgressBar
                          label={`${row.name}: signed up for ${signedUp} of ${row.minimum} open days`}
                          hideLabel
                          size="small"
                          value={Math.min(signedUp, row.minimum)}
                          max={Math.max(row.minimum, 1)}
                          status={signedUp >= row.minimum ? 'finished' : 'active'}
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Tag type={tag.type} size="sm">
                        {tag.label(row)}
                      </Tag>
                    </TableCell>
                    <TableCell>
                      {row.lastOpenDayAt ? (
                        formatDate(row.lastOpenDayAt)
                      ) : (
                        <span className="staffing-secondary">None yet</span>
                      )}
                    </TableCell>
                    <TableCell className="cds--table-column-menu">
                      {trainee && (
                        <OverflowMenu iconDescription={`Actions for ${row.name}`} size="sm" flipped>
                          <OverflowMenuItem
                            itemText="Make supervisor"
                            disabled={promoteBlockedReason !== null}
                            title={promoteBlockedReason ?? undefined}
                            onClick={() => onPromote(row)}
                          />
                        </OverflowMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <div className="empty-state">
              <h2>{filtered ? 'No members found' : 'No members with a staffing level'}</h2>
              <p>
                {filtered
                  ? 'Try different search terms or filters.'
                  : hasAnyRows
                    ? 'Nothing to show.'
                    : 'Give a role the supervisor or trainee staffing level to include its members here.'}
              </p>
            </div>
          )}
          <Pagination
            page={currentPage}
            pageSize={pageSize}
            totalItems={rows.length}
            pageSizes={PAGE_SIZES}
            onChange={({ page: nextPage, pageSize: nextPageSize }) => onPage(nextPage, nextPageSize)}
          />
        </TableContainer>
      )}
    </DataTable>
  );
}
