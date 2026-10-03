import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  FileUploaderDropContainer,
  Form,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { Renew, Save, TrashCan, Upload } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import ReactMarkdown from 'react-markdown';
import type {
  BrandingAsset,
  BrandingAssetSlot,
  BrandingConfiguration,
  BrandingColors,
  LegalConfiguration,
  UpdateBrandingConfigurationRequest,
} from '../../api/generated/models';
import {
  getBrandingConfiguration,
  getPutBrandingAssetUrl,
  removeBrandingAsset,
  restoreDefaultBrandingAsset,
  updateBrandingConfiguration,
} from '../../api/generated/branding/branding';
import { apiFetch, ApiError } from '../../api/http-client';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { publicConfigurationFromAdmin, publicConfigurationKey } from './branding';

type FormValues = Omit<UpdateBrandingConfigurationRequest, 'expectedVersion'>;

const hexPattern = /^#[0-9a-fA-F]{6}$/;
const adminQueryKey = ['branding', 'configuration'] as const;
const assets: ReadonlyArray<{
  key: keyof BrandingConfiguration['assets'];
  slot: BrandingAssetSlot;
  title: string;
  guidance: string;
  accept: string[];
  maxBytes: number;
}> = [
  { key: 'logo', slot: 'logo', title: 'Logo', guidance: 'Full organization logo. PNG, WebP, or safe SVG; up to 2 MiB.', accept: ['image/png', 'image/webp', 'image/svg+xml'], maxBytes: 2 << 20 },
  { key: 'compactLogo', slot: 'compact_logo', title: 'Compact logo', guidance: 'Symbol used in constrained navigation. PNG, WebP, or safe SVG; up to 2 MiB.', accept: ['image/png', 'image/webp', 'image/svg+xml'], maxBytes: 2 << 20 },
  { key: 'favicon', slot: 'favicon', title: 'Favicon', guidance: 'Square browser icon. PNG, WebP, or safe SVG; up to 2 MiB.', accept: ['image/png', 'image/webp', 'image/svg+xml'], maxBytes: 2 << 20 },
  { key: 'applicationBackground', slot: 'application_background', title: 'Application background', guidance: 'Authenticated application backdrop. PNG, WebP, JPEG, or safe SVG; up to 8 MiB.', accept: ['image/png', 'image/webp', 'image/jpeg', 'image/svg+xml'], maxBytes: 8 << 20 },
  { key: 'authenticationBackground', slot: 'authentication_background', title: 'Authentication background', guidance: 'Sign-in and public page backdrop. PNG, WebP, JPEG, or safe SVG; up to 8 MiB.', accept: ['image/png', 'image/webp', 'image/jpeg', 'image/svg+xml'], maxBytes: 8 << 20 },
];

function toFormValues(configuration: BrandingConfiguration): FormValues {
  return {
    identity: configuration.identity,
    colors: configuration.colors,
    imprint: configuration.imprint,
    privacy: configuration.privacy,
  };
}

function hexLuminance(value: string): number | null {
  if (!hexPattern.test(value)) return null;
  const channels = [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(a: string, b: string): number | null {
  const one = hexLuminance(a);
  const two = hexLuminance(b);
  if (one === null || two === null) return null;
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

function mutationMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return 'The configuration changed in another session. Reload it before saving again.';
  return 'The change was not saved. Review the values and try again.';
}

function ColorField({ name, label, register, setValue, value, error }: {
  name: `colors.${keyof BrandingColors}`;
  label: string;
  register: ReturnType<typeof useForm<FormValues>>['register'];
  setValue: ReturnType<typeof useForm<FormValues>>['setValue'];
  value: string;
  error?: string;
}) {
  const registration = register(name, {
    required: 'Enter a color.',
    pattern: {
      value: hexPattern,
      message: 'Use a six-digit HEX color such as #57569f.',
    },
  });
  return (
    <div className="branding-color-field">
      <label className="branding-color-field__picker">
        <span>{label} picker</span>
        <input
          type="color"
          aria-label={`${label} color picker`}
          value={hexPattern.test(value) ? value : '#000000'}
          onChange={(event) => setValue(name, event.currentTarget.value, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          })}
        />
      </label>
      <TextInput
        id={name.replace('.', '-')}
        labelText={label}
        invalid={Boolean(error)}
        invalidText={error}
        {...registration}
        value={value}
      />
    </div>
  );
}

function LegalEditor({ kind, register, mode, markdown, setMode }: {
  kind: 'imprint' | 'privacy';
  register: ReturnType<typeof useForm<FormValues>>['register'];
  mode: LegalConfiguration['mode'];
  markdown: string;
  setMode?: (mode: LegalConfiguration['mode']) => void;
}) {
  const label = kind === 'imprint' ? 'Imprint' : 'Privacy policy';
  return (
    <Tile className="branding-legal-editor">
      <Stack gap={5}>
        <h2>{label}</h2>
        <RadioButtonGroup legendText={`${label} delivery`} name={`${kind}-mode`} valueSelected={mode} orientation="vertical" onChange={(value) => setMode?.(value as LegalConfiguration['mode'])}>
          <RadioButton labelText="Internal Markdown page" value="internal" id={`${kind}-internal`} />
          <RadioButton labelText="External website" value="external" id={`${kind}-external`} />
        </RadioButtonGroup>
        {mode === 'internal' ? (
          <>
            <TextArea id={`${kind}-markdown`} labelText="Markdown" helperText="Plain Markdown only; raw HTML is not rendered. Maximum 100 KiB." rows={12} {...register(`${kind}.markdown`, { validate: (value) => new TextEncoder().encode(value).byteLength <= 102400 || 'Use at most 100 KiB.' })} />
            <div className="branding-markdown-preview">
              <h3>Preview</h3>
              {markdown ? <ReactMarkdown components={{ a: ({ node, ...props }) => { void node; return <a {...props} target="_blank" rel="noopener noreferrer" />; } }}>{markdown}</ReactMarkdown> : <p>No content configured.</p>}
            </div>
          </>
        ) : (
          <TextInput id={`${kind}-url`} type="url" labelText="External URL" helperText="Absolute HTTP(S) URL. The server never fetches this address." {...register(`${kind}.externalUrl`, { validate: (value) => {
            if (!value) return 'Enter an external URL.';
            try { const parsed = new URL(value); return (['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.host) && !parsed.username && !parsed.password) || 'Use an absolute HTTP(S) URL without credentials.'; } catch { return 'Use an absolute HTTP(S) URL.'; }
          } })} />
        )}
      </Stack>
    </Tile>
  );
}

function AssetCard({ descriptor, asset, version, onApplied }: {
  descriptor: typeof assets[number];
  asset: BrandingAsset;
  version: number;
  onApplied: (configuration: BrandingConfiguration) => void;
}) {
  const [file, setFile] = useState<File>();
  const [confirm, setConfirm] = useState<'remove' | 'default'>();
  const preview = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const upload = useMutation({
    mutationFn: () => apiFetch<BrandingConfiguration>(getPutBrandingAssetUrl(descriptor.slot, { expectedVersion: version }), {
      method: 'PUT',
      headers: { 'Content-Type': file!.type || 'application/octet-stream', 'X-File-Name': file!.name },
      body: file,
    }),
    onSuccess: (result) => { setFile(undefined); onApplied(result); },
  });
  const action = useMutation({
    mutationFn: (mode: 'remove' | 'default') => mode === 'remove'
      ? removeBrandingAsset(descriptor.slot, { expectedVersion: version })
      : restoreDefaultBrandingAsset(descriptor.slot, { expectedVersion: version }),
    onSuccess: (result) => { setConfirm(undefined); onApplied(result); },
  });
  const status = asset.mode === 'custom' ? 'Custom' : asset.mode === 'none' ? 'Removed' : 'Built-in default';
  return (
    <Tile className="branding-asset-card">
      <Stack gap={5}>
        <div className="section-heading"><h2>{descriptor.title}</h2><Tag type={asset.mode === 'custom' ? 'purple' : asset.mode === 'none' ? 'gray' : 'blue'}>{status}</Tag></div>
        <p className="section-description">{descriptor.guidance}</p>
        {(preview || asset.url) ? <img className="branding-asset-preview" src={preview ?? asset.url!} alt={`${descriptor.title} preview`} /> : <div className="branding-asset-preview branding-asset-preview--empty">No asset</div>}
        {asset.mode === 'custom' && asset.originalFilename && <p className="section-description">Saved file: {asset.originalFilename}</p>}
        <FileUploaderDropContainer id={`asset-${descriptor.slot}`} accept={descriptor.accept} maxFileSize={descriptor.maxBytes} multiple={false} labelText="Choose or drop an image" onAddFiles={(_, data) => setFile(data.addedFiles[0])} />
        {file && <p className="section-description">Selected locally: {file.name}</p>}
        {(upload.isError || action.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Asset change failed" subtitle={mutationMessage(upload.error ?? action.error)} />}
        <div className="button-cluster">
          <Button size="sm" renderIcon={Upload} disabled={!file || upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? 'Uploading…' : 'Upload selected'}</Button>
          <Button size="sm" kind="danger--tertiary" renderIcon={TrashCan} disabled={asset.mode === 'none' || action.isPending} onClick={() => setConfirm('remove')}>Remove</Button>
          <Button size="sm" kind="tertiary" renderIcon={Renew} disabled={asset.mode === 'default' || action.isPending} onClick={() => setConfirm('default')}>Restore default</Button>
        </div>
      </Stack>
      <Modal open={Boolean(confirm)} danger={confirm === 'remove'} modalHeading={confirm === 'remove' ? `Remove ${descriptor.title.toLowerCase()}?` : `Restore the default ${descriptor.title.toLowerCase()}?`} primaryButtonText={confirm === 'remove' ? 'Remove asset' : 'Restore default'} secondaryButtonText="Cancel" onRequestClose={() => setConfirm(undefined)} onRequestSubmit={() => { if (confirm) action.mutate(confirm); }}>
        <p>{confirm === 'remove' ? 'The asset will be intentionally absent. This is different from using the bundled default.' : 'The current override will be replaced by the bundled installation asset.'}</p>
      </Modal>
    </Tile>
  );
}

export function BrandingLegalSettingsPage() {
  const queryClient = useQueryClient();
  const configuration = useQuery({ queryKey: adminQueryKey, queryFn: ({ signal }) => getBrandingConfiguration({ signal }) });
  const form = useForm<FormValues>({ mode: 'onChange' });
  const values = useWatch({ control: form.control });

  useEffect(() => { if (configuration.data) form.reset(toFormValues(configuration.data)); }, [configuration.data, form]);

  const apply = (result: BrandingConfiguration) => {
    queryClient.setQueryData(adminQueryKey, result);
    queryClient.setQueryData(publicConfigurationKey, publicConfigurationFromAdmin(result));
  };
  const save = useMutation({
    mutationFn: (input: FormValues) => updateBrandingConfiguration({ ...input, expectedVersion: configuration.data!.version }),
    onSuccess: (result) => { apply(result); form.reset(toFormValues(result)); },
  });

  if (configuration.isPending) return <FullPageLoading label="Loading branding configuration" />;
  if (configuration.isError || !configuration.data) return <ErrorState title="Branding configuration unavailable" message="The configuration could not be loaded." onRetry={() => void configuration.refetch()} />;

  const identity = { ...configuration.data.identity, ...values.identity };
  const colors = { ...configuration.data.colors, ...values.colors };
  const imprint = { ...configuration.data.imprint, ...values.imprint };
  const privacy = { ...configuration.data.privacy, ...values.privacy };
  const primaryContrast = contrastRatio(colors.primary ?? '', colors.background ?? '');
  const accentContrast = contrastRatio(colors.accent ?? '', colors.background ?? '');
  return (
    <Tabs>
      <PageShell
        title="Branding & legal"
        description="Configure the installation-wide organization identity, visual assets, colors, and public legal documents."
        tabs={<TabList aria-label="Branding configuration sections">
          <Tab>Organization &amp; colors</Tab><Tab>Assets</Tab><Tab>Legal</Tab>
        </TabList>}
        className="branding-settings-page"
      >
        <TabPanels>
          <TabPanel>
            <Form onSubmit={form.handleSubmit((input) => save.mutate(input))}>
              <div className="branding-settings-grid">
                <Tile><Stack gap={5}>
                  <h2>Organization identity</h2>
                  <TextInput id="legal-organization-name" labelText="Legal organization name" invalid={Boolean(form.formState.errors.identity?.legalOrganizationName)} invalidText={form.formState.errors.identity?.legalOrganizationName?.message} {...form.register('identity.legalOrganizationName', { required: 'Enter the legal organization name.', maxLength: { value: 200, message: 'Use at most 200 characters.' } })} />
                  <TextInput id="display-name" labelText="Display name" invalid={Boolean(form.formState.errors.identity?.displayName)} invalidText={form.formState.errors.identity?.displayName?.message} {...form.register('identity.displayName', { required: 'Enter the display name.', maxLength: { value: 100, message: 'Use at most 100 characters.' } })} />
                  <TextInput id="application-name" labelText="Application name" invalid={Boolean(form.formState.errors.identity?.applicationName)} invalidText={form.formState.errors.identity?.applicationName?.message} {...form.register('identity.applicationName', { required: 'Enter the application name.', maxLength: { value: 150, message: 'Use at most 150 characters.' } })} />
                  <TextInput id="tagline" labelText="Tagline (optional)" {...form.register('identity.tagline', { maxLength: { value: 240, message: 'Use at most 240 characters.' }, setValueAs: (value) => value || null })} />
                </Stack></Tile>
                <Tile><Stack gap={5}>
                  <h2>Application colors</h2>
                  <ColorField name="colors.primary" label="Primary" value={colors.primary ?? ''} error={form.formState.errors.colors?.primary?.message} register={form.register} setValue={form.setValue} />
                  <ColorField name="colors.secondary" label="Secondary" value={colors.secondary ?? ''} error={form.formState.errors.colors?.secondary?.message} register={form.register} setValue={form.setValue} />
                  <ColorField name="colors.accent" label="Accent" value={colors.accent ?? ''} error={form.formState.errors.colors?.accent?.message} register={form.register} setValue={form.setValue} />
                  <ColorField name="colors.background" label="Background" value={colors.background ?? ''} error={form.formState.errors.colors?.background?.message} register={form.register} setValue={form.setValue} />
                  {((primaryContrast !== null && primaryContrast < 4.5) || (accentContrast !== null && accentContrast < 4.5)) && <InlineNotification kind="warning" lowContrast hideCloseButton title="Low contrast" subtitle="One or more brand colors have less than 4.5:1 contrast against the background. This does not block saving." />}
                </Stack></Tile>
                <aside className="branding-live-preview" style={{ '--preview-primary': colors.primary, '--preview-secondary': colors.secondary, '--preview-accent': colors.accent, '--preview-background': colors.background } as React.CSSProperties}>
                  <span>{identity.legalOrganizationName}</span><strong>{identity.displayName}</strong><p>{identity.tagline || 'Live preview of unsaved values'}</p><button type="button">Example action</button>
                </aside>
              </div>
              {save.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Configuration not saved" subtitle={mutationMessage(save.error)} />}
              <div className="branding-save-bar"><span>{form.formState.isDirty ? 'You have unsaved changes.' : 'All identity and legal fields are saved.'}</span><Button type="submit" renderIcon={Save} disabled={!form.formState.isDirty || !form.formState.isValid || save.isPending}>{save.isPending ? 'Saving…' : 'Save configuration'}</Button></div>
            </Form>
          </TabPanel>
          <TabPanel>
            <div className="branding-assets-grid">{assets.map((descriptor) => <AssetCard key={descriptor.slot} descriptor={descriptor} asset={configuration.data.assets[descriptor.key]} version={configuration.data.version} onApplied={apply} />)}</div>
          </TabPanel>
          <TabPanel>
            <Form onSubmit={form.handleSubmit((input) => save.mutate(input))}>
              <div className="branding-settings-grid">
                <LegalEditor kind="imprint" mode={imprint.mode} markdown={imprint.markdown} register={form.register} setMode={(mode) => form.setValue('imprint.mode', mode, { shouldDirty: true, shouldValidate: true })} />
                <LegalEditor kind="privacy" mode={privacy.mode} markdown={privacy.markdown} register={form.register} setMode={(mode) => form.setValue('privacy.mode', mode, { shouldDirty: true, shouldValidate: true })} />
              </div>
              {save.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Configuration not saved" subtitle={mutationMessage(save.error)} />}
              <div className="branding-save-bar"><span>{form.formState.isDirty ? 'You have unsaved changes.' : 'All identity and legal fields are saved.'}</span><Button type="submit" renderIcon={Save} disabled={!form.formState.isDirty || !form.formState.isValid || save.isPending}>{save.isPending ? 'Saving…' : 'Save configuration'}</Button></div>
            </Form>
          </TabPanel>
        </TabPanels>
      </PageShell>
    </Tabs>
  );
}
