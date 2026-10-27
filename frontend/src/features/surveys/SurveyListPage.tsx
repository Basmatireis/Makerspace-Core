import { Button, Link as CarbonLink, Tag } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ListSurveysParams, Survey, SurveyStatus } from '../../api/generated/models';
import type { FilterCategory } from '../../app/BatchFilter';
import { formatDate } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, useServerTableState, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { SettingsPageLayout } from '../settings/SettingsPageLayout';
import { surveysQuery } from './queries';
import { statusLabels, statusTagTypes } from './presentation';

const statuses: SurveyStatus[] = ['draft', 'published', 'closed'];
const sortKeys = ['name', 'status', 'updatedAt', 'responseCount'] as const;

const columns: Column<Survey>[] = [
  {
    key: 'name',
    header: 'Name',
    sortValue: (survey) => survey.name,
    render: (survey) => (
      <div className="mj-cell-stack">
        <CarbonLink as={Link} to={`/settings/surveys/${survey.id}`}>
          {survey.name}
        </CarbonLink>
        <span className="mj-secondary">{survey.title}</span>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    sortValue: (survey) => survey.status,
    render: (survey) => (
      <Tag size="sm" type={statusTagTypes[survey.status]}>
        {statusLabels[survey.status]}
      </Tag>
    ),
  },
  {
    key: 'responseCount',
    header: 'Responses',
    sortValue: (survey) => survey.responseCount,
    firstDirection: 'DESC',
    render: (survey) => survey.responseCount,
  },
  { key: 'links', header: 'Links', narrow: true, render: (survey) => survey.linkCount },
  {
    key: 'trigger',
    header: 'After-visit invitation',
    narrow: true,
    render: (survey) => (
      <Tag size="sm" type={survey.trigger?.enabled ? 'green' : 'gray'}>
        {survey.trigger?.enabled ? 'On' : 'Off'}
      </Tag>
    ),
  },
  {
    key: 'updatedAt',
    header: 'Updated',
    narrow: true,
    sortValue: (survey) => survey.updatedAt,
    firstDirection: 'DESC',
    render: (survey) => formatDate(survey.updatedAt),
  },
];

export function SurveyListPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const canManage = hasPermission(currentUser, PermissionId.surveysmanage);
  const table = useServerTableState('', { key: 'updatedAt', direction: 'DESC' });
  const status = table.url.get('status');
  const sort = sortKeys.find((key) => key === table.sort.key) ?? 'updatedAt';
  const params: ListSurveysParams = {
    search: table.search || undefined,
    status: statuses.find((item) => item === status),
    sort,
    order: table.sort.direction === 'ASC' ? 'asc' : 'desc',
    limit: table.pageSize,
    offset: (table.page - 1) * table.pageSize,
  };
  const query = useQuery(surveysQuery(params));
  const filterCategories: FilterCategory[] = [
    {
      key: 'status',
      label: 'Status',
      single: true,
      options: statuses.map((item) => ({ id: item, label: statusLabels[item] })),
    },
  ];
  const create = canManage ? (
    <Button kind="primary" size="lg" onClick={() => navigate('/settings/surveys/new')}>
      New survey
    </Button>
  ) : undefined;
  return (
    <SettingsPageLayout page="surveys" width="wide">
      <QueryBoundary query={query} errorMessage="Surveys could not be loaded.">
        {(page) => (
          <DirectoryTable
            mode="server"
            id="surveys"
            urlPrefix=""
            label="Surveys"
            columns={columns}
            rows={page.items}
            total={page.total}
            sort={table.sort}
            onSortChange={table.setSort}
            filterCategories={filterCategories}
            onRowClick={(survey) => navigate(`/settings/surveys/${survey.id}`)}
            toolbarAction={create}
            empty={{
              title: 'No surveys yet',
              description: 'Create a survey to collect feedback from visitors and members.',
              action: canManage ? (
                <Button kind="tertiary" onClick={() => navigate('/settings/surveys/new')}>
                  New survey
                </Button>
              ) : undefined,
            }}
          />
        )}
      </QueryBoundary>
    </SettingsPageLayout>
  );
}
