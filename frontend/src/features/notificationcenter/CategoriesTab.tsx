import { Button, Tag } from '@carbon/react';
import { Add, Locked } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { NotificationCategory } from '../../api/generated/models';
import { formatDate } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { CategoryModal } from './CategoryModal';
import { categoriesQuery } from './queries';

const columns: Column<NotificationCategory>[] = [
  {
    key: 'name',
    header: 'Category',
    sortValue: (category) => category.name,
    render: (category) => (
      <div className="mj-cell-stack">
        <strong>{category.name}</strong>
        <span className="mj-secondary">{category.description}</span>
      </div>
    ),
  },
  {
    key: 'basis',
    header: 'Legal basis',
    sortValue: (category) => category.basis,
    render: (category) =>
      category.basis === 'required' ? (
        <div className="mj-cell-stack">
          <Tag size="sm" type="gray" renderIcon={Locked}>
            Always on
          </Tag>
          <span className="mj-secondary">Contract and safety, no consent needed</span>
        </div>
      ) : (
        <div className="mj-cell-stack">
          <Tag size="sm" type="blue">
            Asks for consent
          </Tag>
          <span className="mj-secondary">Opt-in, can be withdrawn any time</span>
        </div>
      ),
  },
  {
    key: 'rules',
    header: 'Rules',
    narrow: true,
    sortValue: (category) => category.ruleCount,
    render: (category) => category.ruleCount,
  },
  {
    key: 'text',
    header: 'Text',
    narrow: true,
    render: (category) =>
      category.basis === 'required' ? (
        '—'
      ) : (
        <div className="mj-cell-stack">
          <span>Version {category.textVersion}</span>
          <span className="mj-secondary">since {formatDate(category.textChangedAt)}</span>
        </div>
      ),
  },
];

export function CategoriesTab() {
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, PermissionId.notification_rulesmanage);
  const query = useQuery(categoriesQuery());
  // `undefined`: closed; `null`: creating; otherwise the category being edited.
  const [editing, setEditing] = useState<NotificationCategory | null | undefined>(undefined);
  return (
    <QueryBoundary query={query} errorMessage="The categories could not be loaded.">
      {(list) => (
        <>
          <p className="nc-intro">
            Every rule belongs to one category. People decide once per category, so a new rule never asks anyone again.
          </p>
          <DirectoryTable
            id="notification-categories"
            label="Message categories"
            columns={columns}
            rows={list.items}
            totalCount={list.items.length}
            searchText={(category) => `${category.name} ${category.description}`}
            defaultSort={{ key: 'name', direction: 'ASC' }}
            onRowClick={setEditing}
            toolbarAction={
              canManage ? (
                <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setEditing(null)}>
                  New category
                </Button>
              ) : undefined
            }
            empty={{ title: 'No categories', description: 'Create a category before adding rules.' }}
          />
          {editing !== undefined && (
            <CategoryModal
              key={editing?.id ?? 'new'}
              category={editing}
              canManage={canManage}
              onClose={() => setEditing(undefined)}
            />
          )}
        </>
      )}
    </QueryBoundary>
  );
}
