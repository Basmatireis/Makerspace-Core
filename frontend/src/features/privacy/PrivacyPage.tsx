import {
  Button,
  Column,
  DataTable,
  Form,
  Grid,
  InlineNotification,
  NumberInput,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableExpandedRow,
  TableExpandHeader,
  TableExpandRow,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Tag,
  TextArea,
  TextInput,
  Tile,
  Toggle,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ApiError } from '../../api/http-client';
import type { PrivacyCategory, PrivacySettings } from '../../api/generated/models';
import { updatePrivacySettings } from '../../api/generated/privacy/privacy';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasAnyPermission, hasPermission } from '../auth/permissions';
import { SettingsLoading, SettingsPageLayout } from '../settings/SettingsPageLayout';
import { SettingsTabs, type SettingsTab } from '../settings/SettingsTabs';
import {
  privacyCategoriesQueryOptions,
  privacyOverviewQueryOptions,
  privacyQueryKey,
  privacySettingsQueryOptions,
} from './privacy';

const PoliciesTab = lazy(() => import('./PoliciesTab').then(({ PoliciesTab }) => ({ default: PoliciesTab })));
const HoldsTab = lazy(() => import('./HoldsTab').then(({ HoldsTab }) => ({ default: HoldsTab })));
const RunsTab = lazy(() => import('./RunsTab').then(({ RunsTab }) => ({ default: RunsTab })));

function moduleLabel(id: string): string {
  const text = id.replace(/[_-]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const subjectLabels: Record<PrivacyCategory['subject'], string> = {
  person: 'Person',
  account: 'Account',
  none: 'No subject',
};

function legacyDefaultText(category: PrivacyCategory): string {
  const legacy = category.legacyDefault;
  if (!legacy) return 'None';
  return `${legacy.periodDays} days after ${legacy.trigger} → ${legacy.action}, from ${legacy.source}`;
}

function OverviewTab() {
  const overview = useQuery(privacyOverviewQueryOptions());
  const settings = useQuery(privacySettingsQueryOptions());
  if (overview.isPending) return <SettingsLoading label="Loading privacy overview" />;
  if (overview.isError) {
    return <ErrorState message={overview.error.message} onRetry={() => void overview.refetch()} />;
  }
  const data = overview.data;
  return (
    <Stack gap={5}>
      {settings.data && settings.data.controllerName.trim() === '' && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Controller not named"
          subtitle="Name the controller and a data protection contact in the Settings tab before production use."
        />
      )}
      <Grid condensed fullWidth>
        <Column sm={4} md={4} lg={5}>
          <Tile>
            <p className="cds--type-label-01">Data categories</p>
            <p className="cds--type-productive-heading-05">{data.categories}</p>
          </Tile>
        </Column>
        <Column sm={4} md={4} lg={5}>
          <Tile>
            <p className="cds--type-label-01">Orphaned categories</p>
            <p className="cds--type-productive-heading-05">{data.orphanedCategories}</p>
          </Tile>
        </Column>
        <Column sm={4} md={8} lg={6}>
          <Tile>
            <p className="cds--type-label-01">Automatic retention runs</p>
            <Tag type={data.automaticRunsEnabled ? 'green' : 'gray'} size="md">
              {data.automaticRunsEnabled ? 'Enabled' : 'Disabled'}
            </Tag>
            {!data.automaticRunsEnabled && (
              <p className="cds--type-helper-text-01">
                <code>admin cleanup</code> remains the scheduled path while automatic runs are off.
              </p>
            )}
          </Tile>
        </Column>
      </Grid>
    </Stack>
  );
}

const categoryHeaders = [
  { key: 'name', header: 'Category' },
  { key: 'owner', header: 'Owner module' },
  { key: 'subject', header: 'Subject' },
  { key: 'triggers', header: 'Triggers' },
  { key: 'actions', header: 'Actions' },
  { key: 'legacy', header: 'Legacy default' },
];

function CategoriesTab() {
  const categories = useQuery(privacyCategoriesQueryOptions());
  const [search, setSearch] = useState('');
  const list = categories.data?.categories;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!list) return [];
    if (needle === '') return list;
    return list.filter(
      (category) =>
        category.id.toLowerCase().includes(needle) ||
        category.name.toLowerCase().includes(needle) ||
        category.fields.some((field) => field.toLowerCase().includes(needle)),
    );
  }, [list, search]);

  if (categories.isPending) return <SettingsLoading label="Loading data categories" />;
  if (categories.isError) {
    return <ErrorState message={categories.error.message} onRetry={() => void categories.refetch()} />;
  }
  // DataTable can render one pass with its previous rows, so look up in the full list.
  const byId = new Map(categories.data.categories.map((category) => [category.id as string, category]));
  const rows = filtered.map((category) => ({ id: category.id as string }));

  return (
    <DataTable rows={rows} headers={categoryHeaders}>
      {({ rows: tableRows, headers, getTableProps, getHeaderProps, getRowProps }) => (
        <TableContainer>
          <TableToolbar>
            <TableToolbarContent>
              <TableToolbarSearch
                persistent
                labelText="Search data categories"
                placeholder="Search by id, name or field"
                value={search}
                onChange={(event) => setSearch(typeof event === 'string' ? event : event.target.value)}
              />
            </TableToolbarContent>
          </TableToolbar>
          <Table {...getTableProps()} aria-label="Data categories">
            <TableHead>
              <TableRow>
                <TableExpandHeader aria-label="Expand to see fields" />
                {headers.map((header) => {
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
                const category = byId.get(row.id)!;
                const { key, ...rowProps } = getRowProps({ row });
                return [
                  <TableExpandRow key={key} {...rowProps} expandHeader="Expand to see fields">
                    <TableCell>
                      <strong>{category.name}</strong>
                      <p className="cds--type-helper-text-01">{category.description}</p>
                    </TableCell>
                    <TableCell>
                      <Tag type="cool-gray" size="sm">
                        {moduleLabel(category.ownerModuleId)}
                      </Tag>
                      {category.orphaned && (
                        <Tag type="red" size="sm">
                          Orphaned
                        </Tag>
                      )}
                    </TableCell>
                    <TableCell>
                      <Tag type="blue" size="sm">
                        {subjectLabels[category.subject]}
                      </Tag>
                    </TableCell>
                    <TableCell>
                      {category.triggers.map((trigger) => (
                        <Tag key={trigger} type="gray" size="sm">
                          {trigger}
                        </Tag>
                      ))}
                    </TableCell>
                    <TableCell>
                      {category.actions.map((action) => (
                        <Tag key={action} type="teal" size="sm">
                          {action}
                        </Tag>
                      ))}
                    </TableCell>
                    <TableCell>{legacyDefaultText(category)}</TableCell>
                  </TableExpandRow>,
                  <TableExpandedRow key={`${key}-fields`} colSpan={headers.length + 1}>
                    <Stack gap={3}>
                      <p>{category.retentionNote}</p>
                      <ul aria-label={`${category.name} fields`}>
                        {category.fields.map((field) => (
                          <li key={field}>
                            <code>{field}</code>
                          </li>
                        ))}
                      </ul>
                    </Stack>
                  </TableExpandedRow>,
                ];
              })}
            </TableBody>
          </Table>
          {filtered.length === 0 && <p className="cds--type-helper-text-01">No data categories match.</p>}
        </TableContainer>
      )}
    </DataTable>
  );
}

type SettingsFormValues = Omit<PrivacySettings, 'version' | 'updatedAt'>;

function formValues(settings: PrivacySettings): SettingsFormValues {
  return {
    controllerName: settings.controllerName,
    controllerAddress: settings.controllerAddress,
    dataProtectionContact: settings.dataProtectionContact,
    automaticRunsEnabled: settings.automaticRunsEnabled,
    runIntervalMinutes: settings.runIntervalMinutes,
  };
}

function SettingsForm({ settings, canManage }: { settings: PrivacySettings; canManage: boolean }) {
  const client = useQueryClient();
  const [notice, setNotice] = useState<'saved' | 'stale'>();
  const form = useForm<SettingsFormValues>({ defaultValues: formValues(settings) });
  const {
    control,
    register,
    reset,
    formState: { errors },
  } = form;
  useEffect(() => {
    reset(formValues(settings));
  }, [settings, reset]);

  const mutation = useMutation({
    mutationFn: (values: SettingsFormValues) =>
      updatePrivacySettings({
        ...values,
        runIntervalMinutes: Number(values.runIntervalMinutes),
        expectedVersion: settings.version,
      }),
    onSuccess: async () => {
      setNotice('saved');
      await client.invalidateQueries({ queryKey: privacyQueryKey });
    },
    onError: (error) => {
      const code = error instanceof ApiError ? (error.data as { code?: string } | undefined)?.code : undefined;
      if (code === 'stale_write') {
        setNotice('stale');
        void client.invalidateQueries({ queryKey: privacyQueryKey });
      } else {
        setNotice(undefined);
      }
    },
  });
  const submit = form.handleSubmit(async (values) => {
    setNotice(undefined);
    try {
      await mutation.mutateAsync(values);
    } catch {
      /* rendered below */
    }
  });
  const readOnly = !canManage;

  return (
    <Tile>
      <Form onSubmit={submit}>
        <Stack gap={5}>
          {notice === 'saved' && (
            <InlineNotification
              kind="success"
              lowContrast
              hideCloseButton
              title="Privacy settings saved"
              subtitle="The new values apply right away."
            />
          )}
          {notice === 'stale' && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Not saved"
              subtitle="Settings changed in the meantime; reloaded."
            />
          )}
          {mutation.isError && notice !== 'stale' && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Settings not saved"
              subtitle="Review the values and try again."
            />
          )}
          <TextInput
            id="privacy-controller-name"
            labelText="Controller name"
            maxLength={200}
            readOnly={readOnly}
            {...register('controllerName', { maxLength: 200 })}
          />
          <TextArea
            id="privacy-controller-address"
            labelText="Controller address"
            maxLength={1000}
            rows={3}
            readOnly={readOnly}
            {...register('controllerAddress', { maxLength: 1000 })}
          />
          <TextInput
            id="privacy-dpo-contact"
            labelText="Data protection contact"
            maxLength={500}
            readOnly={readOnly}
            {...register('dataProtectionContact', { maxLength: 500 })}
          />
          <Controller
            control={control}
            name="automaticRunsEnabled"
            render={({ field }) => (
              <Toggle
                id="privacy-automatic-runs"
                labelText="Automatic retention runs"
                labelA="Off"
                labelB="On"
                readOnly={readOnly}
                toggled={field.value}
                onToggle={(checked) => field.onChange(checked)}
              />
            )}
          />
          <p className="cds--type-helper-text-01">
            Approved retention policies run inside the API process. Off: run <code>admin cleanup</code> from your
            scheduler instead.
          </p>
          <Controller
            control={control}
            name="runIntervalMinutes"
            rules={{
              validate: (value) => {
                const n = Number(value);
                return (Number.isInteger(n) && n >= 5 && n <= 1440) || 'Enter a whole number from 5 to 1440.';
              },
            }}
            render={({ field }) => (
              <NumberInput
                id="privacy-run-interval"
                label="Run interval (minutes)"
                min={5}
                max={1440}
                step={5}
                allowEmpty
                readOnly={readOnly}
                value={field.value}
                invalid={Boolean(errors.runIntervalMinutes)}
                invalidText={errors.runIntervalMinutes?.message}
                onChange={(_event, { value }) => field.onChange(value)}
              />
            )}
          />
          {canManage && (
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save privacy settings'}
            </Button>
          )}
        </Stack>
      </Form>
    </Tile>
  );
}

function SettingsTab() {
  const currentUser = useCurrentUser();
  const settings = useQuery(privacySettingsQueryOptions());
  if (settings.isPending) return <SettingsLoading label="Loading privacy settings" />;
  if (settings.isError) {
    return <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} />;
  }
  return <SettingsForm settings={settings.data} canManage={hasPermission(currentUser, 'privacy.settings.manage')} />;
}

export function PrivacyPage() {
  const currentUser = useCurrentUser();
  const canRead = hasAnyPermission(currentUser, ['privacy.read', 'privacy.settings.manage']);
  const tabs: SettingsTab[] = [
    ...(hasPermission(currentUser, 'privacy.read')
      ? [
          { key: 'overview', label: 'Overview', panel: <OverviewTab /> },
          { key: 'categories', label: 'Categories', panel: <CategoriesTab /> },
          { key: 'policies', label: 'Retention policies', panel: <PoliciesTab /> },
          { key: 'holds', label: 'Holds', panel: <HoldsTab /> },
          { key: 'runs', label: 'Execution history', panel: <RunsTab /> },
        ]
      : []),
    ...(canRead ? [{ key: 'settings', label: 'Settings', panel: <SettingsTab /> }] : []),
  ];
  return (
    <SettingsPageLayout page="privacy" width="wide">
      <SettingsTabs label="Privacy and data retention" tabs={tabs} />
    </SettingsPageLayout>
  );
}
