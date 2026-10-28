import {
  Button,
  ClickableTile,
  Column,
  Form,
  Grid,
  InlineNotification,
  NumberInput,
  Stack,
  Tag,
  TextArea,
  TextInput,
  Tile,
  Toggle,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, useEffect, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/http-client';
import type { PrivacySettings } from '../../api/generated/models';
import { updatePrivacySettings } from '../../api/generated/privacy/privacy';
import { ErrorState } from '../../app/PageState';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasAnyPermission, hasPermission } from '../auth/permissions';
import { SettingsLoading, SettingsPageLayout } from '../settings/SettingsPageLayout';
import { SettingsTabs, type SettingsTab } from '../settings/SettingsTabs';
import { CategoriesTab, PrivacyContextLine, TabLink } from './CategoriesTab';
import { privacyOverviewQueryOptions, privacyQueryKey, privacySettingsQueryOptions } from './privacy';

const PoliciesTab = lazy(() => import('./PoliciesTab').then(({ PoliciesTab }) => ({ default: PoliciesTab })));
const HoldsTab = lazy(() => import('./HoldsTab').then(({ HoldsTab }) => ({ default: HoldsTab })));
const RequestsTab = lazy(() => import('./RequestsTab').then(({ RequestsTab }) => ({ default: RequestsTab })));
const ActivitiesTab = lazy(() => import('./ActivitiesTab').then(({ ActivitiesTab }) => ({ default: ActivitiesTab })));
const RunsTab = lazy(() => import('./RunsTab').then(({ RunsTab }) => ({ default: RunsTab })));

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
      <PrivacyContextLine overview={data} />
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
        <Column sm={4} md={4} lg={5}>
          <Tile>
            <p className="cds--type-label-01">Policies in force</p>
            <p className="cds--type-productive-heading-05">{data.policiesActive}</p>
          </Tile>
        </Column>
        <Column sm={4} md={4} lg={5}>
          <Tile>
            <p className="cds--type-label-01">Draft only, previous behaviour applies</p>
            <p className="cds--type-productive-heading-05">{data.policiesPending}</p>
          </Tile>
        </Column>
        <Column sm={4} md={4} lg={6}>
          <Tile>
            <p className="cds--type-label-01">No decision yet, kept indefinitely</p>
            <p className="cds--type-productive-heading-05">{data.withoutPolicy}</p>
          </Tile>
        </Column>
      </Grid>
    </Stack>
  );
}

function UsedInTile({ title, detail, to }: { title: string; detail: string; to: string }) {
  const navigate = useNavigate();
  return (
    <ClickableTile
      href={to}
      onClick={(event) => {
        event.preventDefault();
        void navigate(to);
      }}
    >
      <strong>{title}</strong>
      <span className="cds--type-helper-text-01"> {detail}</span>
    </ClickableTile>
  );
}

function ReadinessRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
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
  const overview = useQuery(privacyOverviewQueryOptions()).data;
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
          <div>
            <h3 className="cds--type-productive-heading-03">Controller</h3>
            <p className="cds--type-helper-text-01">
              The organisation that decides why and how personal data is processed. Members and guests see it when they
              ask for their data.
            </p>
          </div>
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
            helperText="Where people send questions and requests. Appears on every export a person receives."
            {...register('dataProtectionContact', { maxLength: 500 })}
          />
          <div>
            <p className="cds--type-label-01">Used in</p>
            <div className="privacy-used-in">
              <UsedInTile
                title="Data request exports"
                detail="manifest.json of every access export"
                to="?tab=requests"
              />
              <UsedInTile title="Overview tile" detail="Controller named check" to="?tab=overview" />
              <UsedInTile
                title="Not yet: privacy notice"
                detail="Branding & legal keeps its own text"
                to="/settings/branding-legal"
              />
            </div>
          </div>
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
          <p className="cds--type-helper-text-01">
            Last run:{' '}
            {overview?.lastRun
              ? `${formatDateTime(overview.lastRun.startedAt)} (${overview.lastRun.mode === 'dry_run' ? 'dry run' : 'executed'})`
              : 'none yet'}{' '}
            · <TabLink tab="runs">Execution history</TabLink>
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
          {overview && (
            <dl className="privacy-kv" aria-label="Ready to switch on?">
              <ReadinessRow label="Ready to switch on?">
                {overview.policiesActive} of {overview.policiesActive + overview.policiesPending} drafted policies are
                active · <TabLink tab="policies">Retention policies</TabLink>
              </ReadinessRow>
              <ReadinessRow label="Last run">
                {overview.lastRun
                  ? `${formatDateTime(overview.lastRun.startedAt)}: ${overview.lastRun.mode === 'dry_run' ? 'would change' : 'changed'} ${overview.lastRun.affectedCount} rows`
                  : 'none yet'}{' '}
                · <TabLink tab="runs">Open</TabLink>
              </ReadinessRow>
              <ReadinessRow label="Open holds">
                {overview.openCategoryHolds} {overview.openCategoryHolds === 1 ? 'category' : 'categories'},{' '}
                {overview.openPersonHolds} {overview.openPersonHolds === 1 ? 'person' : 'people'} ·{' '}
                <TabLink tab="holds">Holds</TabLink>
              </ReadinessRow>
            </dl>
          )}
          <p className="cds--type-helper-text-01">
            Saving needs a fresh sign-in. Changes are audited with the names of the changed fields only.
          </p>
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
          { key: 'activities', label: 'Processing activities', panel: <ActivitiesTab /> },
          { key: 'policies', label: 'Retention policies', panel: <PoliciesTab /> },
          { key: 'holds', label: 'Holds', panel: <HoldsTab /> },
          { key: 'runs', label: 'Execution history', panel: <RunsTab /> },
        ]
      : []),
    ...(hasPermission(currentUser, 'privacy.requests.manage')
      ? [{ key: 'requests', label: 'Data requests', panel: <RequestsTab /> }]
      : []),
    ...(canRead ? [{ key: 'settings', label: 'Settings', panel: <SettingsTab /> }] : []),
  ];
  return (
    <SettingsPageLayout page="privacy" width="wide">
      <SettingsTabs label="Privacy and data retention" tabs={tabs} />
    </SettingsPageLayout>
  );
}
