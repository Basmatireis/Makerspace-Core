import { useEffect } from 'react';
import {
  Button,
  Form,
  InlineNotification,
  NumberInput,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { Save } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import type { BrandingConfiguration, PublicConfiguration } from '../../api/generated/models';
import { getBrandingConfiguration, updateBrandingConfiguration } from '../../api/generated/branding/branding';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { SettingsPageLayout } from '../settings/SettingsPageLayout';
import { defaultPublicConfiguration, publicConfigurationFromAdmin, publicConfigurationKey } from './branding';
import {
  FormValues,
  MAX_GREETINGS,
  MAX_GREETING_LENGTH,
  adminQueryKey,
  assets,
  contrastRatio,
  greetingsError,
  mutationMessage,
  toFormValues,
  toUpdateInput,
} from './brandingSettings';
import { ColorField } from './ColorField';
import { LegalEditor } from './LegalEditor';
import { AssetCard } from './AssetCard';

export function BrandingLegalSettingsPage() {
  const queryClient = useQueryClient();
  const configuration = useQuery({
    queryKey: adminQueryKey,
    queryFn: ({ signal }) => getBrandingConfiguration({ signal }),
  });
  const form = useForm<FormValues>({ mode: 'onChange' });
  const values = useWatch({ control: form.control });

  useEffect(() => {
    if (configuration.data) form.reset(toFormValues(configuration.data));
  }, [configuration.data, form]);

  const apply = (result: BrandingConfiguration) => {
    queryClient.setQueryData(adminQueryKey, result);
    queryClient.setQueryData<PublicConfiguration>(publicConfigurationKey, (current) =>
      publicConfigurationFromAdmin(result, current?.timeZone ?? defaultPublicConfiguration.timeZone),
    );
  };
  const save = useMutation({
    mutationFn: (input: FormValues) =>
      updateBrandingConfiguration({ ...toUpdateInput(input), expectedVersion: configuration.data!.version }),
    onSuccess: (result) => {
      apply(result);
      form.reset(toFormValues(result));
    },
  });

  if (configuration.isPending) return <FullPageLoading label="Loading branding configuration" />;
  if (configuration.isError || !configuration.data)
    return (
      <ErrorState
        title="Branding configuration unavailable"
        message="The configuration could not be loaded."
        onRetry={() => void configuration.refetch()}
      />
    );

  const identity = { ...configuration.data.identity, ...values.identity };
  const colors = { ...configuration.data.colors, ...values.colors };
  const imprint = { ...configuration.data.imprint, ...values.imprint };
  const privacy = { ...configuration.data.privacy, ...values.privacy };
  const primaryContrast = contrastRatio(colors.primary ?? '', colors.background ?? '');
  const accentContrast = contrastRatio(colors.accent ?? '', colors.background ?? '');
  return (
    <Tabs>
      <SettingsPageLayout
        page="branding-legal"
        description="Configure the installation-wide organization identity, visual assets, colors, and public legal documents."
        tabs={
          <TabList aria-label="Branding configuration sections">
            <Tab>Organization &amp; colors</Tab>
            <Tab>Assets</Tab>
            <Tab>Legal</Tab>
          </TabList>
        }
        className="branding-settings-page"
      >
        <TabPanels>
          <TabPanel>
            <Form onSubmit={form.handleSubmit((input) => save.mutate(input))}>
              <div className="branding-settings-grid">
                <Tile>
                  <Stack gap={5}>
                    <h2>Organization identity</h2>
                    <TextInput
                      id="legal-organization-name"
                      labelText="Legal organization name"
                      invalid={Boolean(form.formState.errors.identity?.legalOrganizationName)}
                      invalidText={form.formState.errors.identity?.legalOrganizationName?.message}
                      {...form.register('identity.legalOrganizationName', {
                        required: 'Enter the legal organization name.',
                        maxLength: { value: 200, message: 'Use at most 200 characters.' },
                      })}
                    />
                    <TextInput
                      id="display-name"
                      labelText="Display name"
                      invalid={Boolean(form.formState.errors.identity?.displayName)}
                      invalidText={form.formState.errors.identity?.displayName?.message}
                      {...form.register('identity.displayName', {
                        required: 'Enter the display name.',
                        maxLength: { value: 100, message: 'Use at most 100 characters.' },
                      })}
                    />
                    <TextInput
                      id="application-name"
                      labelText="Application name"
                      invalid={Boolean(form.formState.errors.identity?.applicationName)}
                      invalidText={form.formState.errors.identity?.applicationName?.message}
                      {...form.register('identity.applicationName', {
                        required: 'Enter the application name.',
                        maxLength: { value: 150, message: 'Use at most 150 characters.' },
                      })}
                    />
                    <TextInput
                      id="tagline"
                      labelText="Tagline (optional)"
                      {...form.register('identity.tagline', {
                        maxLength: { value: 240, message: 'Use at most 240 characters.' },
                        setValueAs: (value) => value || null,
                      })}
                    />
                    <TextArea
                      id="fun-greetings"
                      labelText="Playful greetings"
                      rows={5}
                      helperText={`One greeting per line, at most ${MAX_GREETINGS} lines of ${MAX_GREETING_LENGTH} characters. {name} is replaced by the person's first name; without it the greeting is shown on its own. Leave empty to always show the time-of-day greeting.`}
                      invalid={Boolean(form.formState.errors.greetingsText)}
                      invalidText={form.formState.errors.greetingsText?.message}
                      {...form.register('greetingsText', { validate: greetingsError })}
                    />
                    <Controller
                      control={form.control}
                      name="identity.funGreetingShare"
                      rules={{
                        validate: (value) =>
                          (Number.isInteger(value) && value >= 0 && value <= 100) ||
                          'Enter a whole number from 0 to 100.',
                      }}
                      render={({ field }) => (
                        <NumberInput
                          id="fun-greeting-share"
                          label="How often"
                          min={0}
                          max={100}
                          step={1}
                          allowEmpty
                          value={field.value}
                          helperText="Out of 100 dashboard visits. 0 turns the playful greetings off."
                          invalid={Boolean(form.formState.errors.identity?.funGreetingShare)}
                          invalidText={form.formState.errors.identity?.funGreetingShare?.message}
                          onChange={(_event, { value }) => field.onChange(value === '' ? Number.NaN : Number(value))}
                        />
                      )}
                    />
                  </Stack>
                </Tile>
                <Tile>
                  <Stack gap={5}>
                    <h2>Application colors</h2>
                    <ColorField
                      name="colors.primary"
                      label="Primary"
                      value={colors.primary ?? ''}
                      error={form.formState.errors.colors?.primary?.message}
                      register={form.register}
                      setValue={form.setValue}
                    />
                    <ColorField
                      name="colors.secondary"
                      label="Secondary"
                      value={colors.secondary ?? ''}
                      error={form.formState.errors.colors?.secondary?.message}
                      register={form.register}
                      setValue={form.setValue}
                    />
                    <ColorField
                      name="colors.accent"
                      label="Accent"
                      value={colors.accent ?? ''}
                      error={form.formState.errors.colors?.accent?.message}
                      register={form.register}
                      setValue={form.setValue}
                    />
                    <ColorField
                      name="colors.background"
                      label="Background"
                      value={colors.background ?? ''}
                      error={form.formState.errors.colors?.background?.message}
                      register={form.register}
                      setValue={form.setValue}
                    />
                    {((primaryContrast !== null && primaryContrast < 4.5) ||
                      (accentContrast !== null && accentContrast < 4.5)) && (
                      <InlineNotification
                        kind="warning"
                        lowContrast
                        hideCloseButton
                        title="Low contrast"
                        subtitle="One or more brand colors have less than 4.5:1 contrast against the background. This does not block saving."
                      />
                    )}
                  </Stack>
                </Tile>
                <aside
                  className="branding-live-preview"
                  style={
                    {
                      '--preview-primary': colors.primary,
                      '--preview-secondary': colors.secondary,
                      '--preview-accent': colors.accent,
                      '--preview-background': colors.background,
                    } as React.CSSProperties
                  }
                >
                  <span>{identity.legalOrganizationName}</span>
                  <strong>{identity.displayName}</strong>
                  <p>{identity.tagline || 'Live preview of unsaved values'}</p>
                  <button type="button">Example action</button>
                </aside>
              </div>
              {save.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Configuration not saved"
                  subtitle={mutationMessage(save.error)}
                />
              )}
              <div className="branding-save-bar">
                <span>
                  {form.formState.isDirty ? 'You have unsaved changes.' : 'All identity and legal fields are saved.'}
                </span>
                <Button
                  type="submit"
                  renderIcon={Save}
                  disabled={!form.formState.isDirty || !form.formState.isValid || save.isPending}
                >
                  {save.isPending ? 'Saving…' : 'Save configuration'}
                </Button>
              </div>
            </Form>
          </TabPanel>
          <TabPanel>
            <div className="branding-assets-grid">
              {assets.map((descriptor) => (
                <AssetCard
                  key={descriptor.slot}
                  descriptor={descriptor}
                  asset={configuration.data.assets[descriptor.key]}
                  version={configuration.data.version}
                  onApplied={apply}
                />
              ))}
            </div>
          </TabPanel>
          <TabPanel>
            <Form onSubmit={form.handleSubmit((input) => save.mutate(input))}>
              <div className="branding-settings-grid">
                <LegalEditor
                  kind="imprint"
                  mode={imprint.mode}
                  markdown={imprint.markdown}
                  register={form.register}
                  setMode={(mode) => form.setValue('imprint.mode', mode, { shouldDirty: true, shouldValidate: true })}
                />
                <LegalEditor
                  kind="privacy"
                  mode={privacy.mode}
                  markdown={privacy.markdown}
                  register={form.register}
                  setMode={(mode) => form.setValue('privacy.mode', mode, { shouldDirty: true, shouldValidate: true })}
                />
              </div>
              {save.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Configuration not saved"
                  subtitle={mutationMessage(save.error)}
                />
              )}
              <div className="branding-save-bar">
                <span>
                  {form.formState.isDirty ? 'You have unsaved changes.' : 'All identity and legal fields are saved.'}
                </span>
                <Button
                  type="submit"
                  renderIcon={Save}
                  disabled={!form.formState.isDirty || !form.formState.isValid || save.isPending}
                >
                  {save.isPending ? 'Saving…' : 'Save configuration'}
                </Button>
              </div>
            </Form>
          </TabPanel>
        </TabPanels>
      </SettingsPageLayout>
    </Tabs>
  );
}
