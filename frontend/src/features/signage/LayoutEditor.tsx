import { useState } from 'react';
import {
  Button,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Stack,
  TextInput,
  UnorderedList,
  ListItem,
  Link as CarbonLink,
} from '@carbon/react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import type { SignageCustomLayout, SignageCustomLayoutMode } from '../../api/generated/models';
import { createSignageCustomLayout, updateSignageCustomLayout } from '../../api/generated/signage/signage';
import { PageShell } from '../../app/PageShell';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import {
  affectedScenes,
  blankLayout,
  gridToRects,
  layoutError,
  layoutRequest,
  rectsToGrid,
  toDraft,
  type AffectedScene,
  type GridConversion,
  type LayoutDraft,
} from './customLayoutModel';
import { FreeLayoutEditor } from './FreeLayoutEditor';
import { GridLayoutEditor } from './GridLayoutEditor';
import { errorMessage, isStaleWrite, pluralize } from './helpers';
import { customLayoutKeys } from './layoutQueries';
import { LayoutDiagram } from './LayoutDiagram';
import { resolveLayout } from './layouts';
import { signagePaths } from './paths';
import { scenesQuery, signageKeys } from './queries';

type Orientation = 'landscape' | 'portrait';

/** Zones that would lose widgets, or null when the scenes could not be checked. */
type RemovalCheck = { scenes: AffectedScene[] | null; values: LayoutDraft };

type Props = {
  /** The layout being edited; absent for a new one. */
  layout?: SignageCustomLayout;
  canEdit: boolean;
  /** Called when the person asks for the latest version after a conflict. */
  onReload?: () => void;
};

/** Creates or edits a custom layout: name, mode, zones, preview and the warning before widgets of removed zones are dropped. */
export function LayoutEditor({ layout, canEdit, onReload }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const initial = layout ? toDraft(layout) : blankLayout();
  const form = useForm<LayoutDraft>({ defaultValues: initial });
  const draft = useWatch({ control: form.control }) as LayoutDraft;
  const [selectedId, setSelectedId] = useState<string | null>(initial.zones[0]?.id ?? null);
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  const [conversion, setConversion] = useState<GridConversion | null>(null);
  const [removal, setRemoval] = useState<RemovalCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const unsaved = useUnsavedChanges({ isDirty: form.formState.isDirty });

  const update = (patch: Partial<LayoutDraft>) => {
    for (const [key, value] of Object.entries(patch))
      form.setValue(key as keyof LayoutDraft, value as never, { shouldDirty: true });
  };
  const problem = layoutError(draft);

  const mutation = useMutation({
    mutationFn: (values: LayoutDraft) =>
      layout
        ? updateSignageCustomLayout(layout.id, { expectedVersion: layout.version, ...layoutRequest(values) })
        : createSignageCustomLayout(layoutRequest(values)),
    onSuccess: async (_saved, values) => {
      setRemoval(null);
      await queryClient.invalidateQueries({ queryKey: signageKeys.all });
      form.reset(values);
      unsaved.bypassAfterSubmit(() => navigate(signagePaths.content('layouts')));
    },
    onError: (error) => {
      setRemoval(null);
      if (isStaleWrite(error) && layout)
        void queryClient.invalidateQueries({ queryKey: customLayoutKeys.one(layout.id) });
    },
  });

  const switchMode = (mode: SignageCustomLayoutMode) => {
    if (mode === draft.mode) return;
    if (mode === 'free') {
      update({ mode, columns: [1], rows: [1], zones: gridToRects(draft.columns, draft.rows, draft.zones) });
      return;
    }
    setConversion(rectsToGrid(draft.zones));
  };
  const applyConversion = (result: GridConversion) => {
    update({ mode: 'grid', columns: result.columns, rows: result.rows, zones: result.zones });
    setSelectedId(result.zones[0]?.id ?? null);
    setConversion(null);
  };

  // Removing zones drops the widgets scenes hold in them, so the affected scenes are shown first.
  const save = async (values: LayoutDraft) => {
    const removed = layout ? layout.zones.filter((zone) => !values.zones.some((item) => item.id === zone.id)) : [];
    if (!layout || removed.length === 0 || layout.sceneCount === 0) {
      mutation.mutate(values);
      return;
    }
    setChecking(true);
    try {
      const scenes = await queryClient.fetchQuery({ ...scenesQuery(), staleTime: 0 });
      const affected = affectedScenes(scenes.items, layout.id, layout.zones, values.zones);
      if (affected.length === 0) mutation.mutate(values);
      else setRemoval({ scenes: affected, values });
    } catch {
      setRemoval({ scenes: null, values });
    } finally {
      setChecking(false);
    }
  };
  const submit = form.handleSubmit((values) => {
    if (layoutError(values) === null) void save(values);
  });

  const title = (draft.name ?? '').trim() === '' ? (layout ? layout.name : 'New layout') : draft.name;
  const resolved = resolveLayout('custom', 'preview', [{ id: 'preview', ...draft }]);

  const common = {
    layout: draft,
    orientation,
    selectedId,
    onSelect: setSelectedId,
    onChange: update,
  };

  return (
    <PageShell
      title={title}
      width="wide"
      breadcrumbs={[
        { label: 'Signage' },
        { label: 'Content', to: signagePaths.content() },
        { label: 'Layouts', to: signagePaths.content('layouts') },
      ]}
      description={
        layout
          ? `Used by ${pluralize(layout.sceneCount, 'scene')}. Layout changes apply to scenes after the next publish.`
          : 'Custom layouts can be used by any scene.'
      }
    >
      {!canEdit ? (
        <div className="sg-stack">
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Read only"
            subtitle="Your role can see layouts but not change them."
          />
          <div className="sg-layout-readonly">
            <LayoutDiagram layout={resolved} orientation="landscape" />
            <StructuredListWrapper isCondensed aria-label="Zones">
              <StructuredListBody>
                <StructuredListRow>
                  <StructuredListCell noWrap>Mode</StructuredListCell>
                  <StructuredListCell>{draft.mode === 'grid' ? 'Grid' : 'Free'}</StructuredListCell>
                </StructuredListRow>
                {draft.zones.map((zone) => (
                  <StructuredListRow key={zone.id}>
                    <StructuredListCell noWrap>Zone</StructuredListCell>
                    <StructuredListCell>{zone.label}</StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          </div>
        </div>
      ) : (
        <form noValidate onSubmit={submit}>
          <div className="sg-layout-editor">
            <Stack gap={5}>
              <Controller
                control={form.control}
                name="name"
                render={({ field }) => (
                  <TextInput
                    id="layout-name"
                    labelText="Name"
                    maxLength={100}
                    invalid={field.value.trim() === ''}
                    invalidText="Give the layout a name"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
              <RadioButtonGroup
                legendText="Mode"
                name="layout-mode"
                valueSelected={draft.mode}
                onChange={(value) => switchMode(value as SignageCustomLayoutMode)}
              >
                <RadioButton id="layout-mode-grid" value="grid" labelText="Grid (rows and columns)" />
                <RadioButton id="layout-mode-free" value="free" labelText="Free (rectangles)" />
              </RadioButtonGroup>
              <RadioButtonGroup
                legendText="Preview shape"
                name="layout-preview"
                valueSelected={orientation}
                onChange={(value) => setOrientation(value as Orientation)}
              >
                <RadioButton id="layout-preview-landscape" value="landscape" labelText="Landscape" />
                <RadioButton id="layout-preview-portrait" value="portrait" labelText="Portrait" />
              </RadioButtonGroup>
              <p className="sg-secondary">
                The preview shape does not change the layout. Scenes on portrait and landscape displays use the same
                zones.
              </p>
            </Stack>
            <div className="sg-layout-editor__work">
              {draft.mode === 'grid' ? <GridLayoutEditor {...common} /> : <FreeLayoutEditor {...common} />}
            </div>
          </div>

          {problem && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Not ready to save"
              subtitle={problem}
            />
          )}
          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Layout not saved"
              subtitle={
                isStaleWrite(mutation.error)
                  ? 'Somebody else changed this layout. Load the latest version to continue; your edits here are lost.'
                  : errorMessage(mutation.error)
              }
            />
          )}
          {mutation.isError && isStaleWrite(mutation.error) && onReload && (
            <div className="sg-conflict-actions">
              <Button size="sm" kind="tertiary" onClick={onReload}>
                Load latest version
              </Button>
            </div>
          )}
          <div className="sg-form-actions">
            <Button kind="secondary" as={Link} to={signagePaths.content('layouts')}>
              Cancel
            </Button>
            <Button type="submit" disabled={problem !== null || mutation.isPending || checking}>
              {mutation.isPending || checking ? 'Saving…' : layout ? 'Save layout' : 'Create layout'}
            </Button>
          </div>
        </form>
      )}

      {conversion && (
        <Modal
          open
          size="sm"
          modalHeading="Convert to a grid?"
          modalLabel="Layout mode"
          primaryButtonText="Convert to grid"
          secondaryButtonText="Keep free layout"
          preventCloseOnClickOutside
          onRequestClose={() => setConversion(null)}
          onRequestSubmit={() => applyConversion(conversion)}
        >
          <Stack gap={4}>
            <p>
              Zones snap to the nearest grid lines, so their positions and sizes change a little. A grid cannot have
              overlapping zones.
            </p>
            {conversion.dropped.length > 0 && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title={`${pluralize(conversion.dropped.length, 'zone')} will be removed`}
                subtitle={`${conversion.dropped.map((zone) => zone.label).join(', ')} would overlap an earlier zone.`}
              />
            )}
            <p className="sg-secondary">
              Result: {conversion.columns.length} columns and {conversion.rows.length} rows, {conversion.zones.length}{' '}
              zones.
            </p>
          </Stack>
        </Modal>
      )}
      {removal && (
        <Modal
          open
          danger
          size="sm"
          modalHeading="Remove zones from scenes?"
          modalLabel="Save layout"
          primaryButtonText={mutation.isPending ? 'Saving…' : 'Save and drop widgets'}
          secondaryButtonText="Keep editing"
          primaryButtonDisabled={mutation.isPending}
          preventCloseOnClickOutside
          onRequestClose={() => setRemoval(null)}
          onRequestSubmit={() => mutation.mutate(removal.values)}
        >
          <Stack gap={4}>
            {removal.scenes === null ? (
              <p>
                Zones are removed and scenes using this layout lose the widgets in them. The scenes could not be listed
                here.
              </p>
            ) : (
              <>
                <p>Saving removes widgets from these scenes. Their other zones stay as they are.</p>
                <UnorderedList>
                  {removal.scenes.map((scene) => (
                    <ListItem key={scene.id}>
                      <CarbonLink as={Link} to={signagePaths.scene(scene.id)} target="_blank">
                        {scene.name}
                      </CarbonLink>
                      <span className="sg-secondary">
                        {' '}
                        · loses the widget in {scene.zones.map((zoneLabel) => zoneLabel).join(', ')}
                      </span>
                    </ListItem>
                  ))}
                </UnorderedList>
              </>
            )}
            <p className="sg-secondary">Scenes are saved as drafts; displays change when published.</p>
          </Stack>
        </Modal>
      )}
      <UnsavedChangesDialog
        guard={unsaved}
        title="Leave without saving?"
        message="Your changes to this layout have not been saved."
        confirmLabel="Leave"
      />
    </PageShell>
  );
}
