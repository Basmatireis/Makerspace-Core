import './styles.scss';
import { useEffect, useState } from 'react';
import {
  Button,
  ContainedList,
  ContainedListItem,
  InlineNotification,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Tag,
  TextInput,
  Tile,
} from '@carbon/react';
import { Redo, Save, TrashCan, Undo } from '@carbon/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { SignageCustomLayout, SignageScene, SignageWidget, SignageZones } from '../../api/generated/models';
import { deleteSignageScene, updateSignageScene } from '../../api/generated/signage/signage';
import { ApiError } from '../../api/http-client';
import { ColorFieldRow, ColorPicker } from '../../app/ColorPicker';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { useCameraBlockedDisplays } from './displayHooks';
import { ChangeLayoutModal } from './ChangeLayoutModal';
import { AssetPicker, DeleteDialog, FitField, LayoutSketch, type LayoutChoice } from './components';
import { AspectRatioSelect } from './AspectRatioFields';
import { errorMessage, isStaleWrite, orientationOf, pluralize } from './helpers';
import { customLayoutsQuery } from './layoutQueries';
import { layoutById, remapZones, resolveLayout } from './layouts';
import { signagePaths } from './paths';
import { PREVIEW_PRESETS, useMachineOptions, useNow, usePreviewData, type PreviewPresetId } from './preview';
import { assetsQuery, sceneQuery, signageKeys, templatesQuery } from './queries';
import { SceneRenderer, ScreenFrame } from './render/SceneRenderer';
import { WidgetFields } from './WidgetFields';
import { canRedo, canUndo, createHistory, deepEqual, pushEdit, redo, undo, type History } from './editorHistory';
import { draftError, toDraft, type Draft } from './sceneDraft';
import { defaultWidget, HEX_COLOR, sceneMachineIds, WIDGET_LABELS, WIDGET_TYPES, type WidgetType } from './widgets';

type SaveState = 'idle' | 'saving' | 'error' | 'conflict';

/** The draft as it is sent: trimmed name and lower-case colour, so a saved scene does not look edited. */
const normalized = (draft: Draft): Draft => ({
  ...draft,
  name: draft.name.trim(),
  backgroundColor: draft.backgroundColor.toLowerCase(),
});

/** Z and Y belong to the browser's own text undo while a text field has focus. */
const isTextTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement &&
      !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(target.type)));

export function SceneEditorPage() {
  const { sceneId = '' } = useParams();
  const query = useQuery(sceneQuery(sceneId));
  const layouts = useQuery(customLayoutsQuery());
  const crumbs = [{ label: 'Signage' }, { label: 'Content', to: signagePaths.content() }];
  if (query.isPending)
    return (
      <PageShell title="Scene" width="fluid" breadcrumbs={crumbs}>
        <FullPageLoading label="Loading scene" />
      </PageShell>
    );
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Scene not found' : 'Scene'} width="fluid" breadcrumbs={crumbs}>
        {missing ? (
          <EmptyState title="This scene does not exist" description="It may have been deleted." />
        ) : (
          <ErrorState
            message={errorMessage(query.error, 'The scene could not be loaded.')}
            onRetry={() => void query.refetch()}
          />
        )}
      </PageShell>
    );
  }
  // A scene on a custom layout cannot show its zones before the layouts are known; others do not wait for them.
  if (query.data.layoutId === 'custom' && layouts.isPending)
    return (
      <PageShell title={query.data.name} width="fluid" breadcrumbs={crumbs}>
        <FullPageLoading label="Loading layout" />
      </PageShell>
    );
  if (query.data.layoutId === 'custom' && layouts.isError)
    return (
      <PageShell title={query.data.name} width="fluid" breadcrumbs={crumbs}>
        <ErrorState
          message={errorMessage(layouts.error, 'The layouts could not be loaded.')}
          onRetry={() => void layouts.refetch()}
        />
      </PageShell>
    );
  return <Editor key={query.data.id} scene={query.data} customLayouts={layouts.data?.items ?? []} crumbs={crumbs} />;
}

function Editor({
  scene,
  customLayouts,
  crumbs,
}: {
  scene: SignageScene;
  customLayouts: readonly SignageCustomLayout[];
  crumbs: { label: string; to?: string }[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canEdit = hasPermission(useCurrentUser(), PermissionId.signagecontentmanage);
  const now = useNow(1000);
  const assets = useQuery(assetsQuery()).data?.items ?? [];
  const templates = useQuery(templatesQuery()).data?.items ?? [];
  const { machines, known: machinesKnown } = useMachineOptions();
  const blockedDisplays = useCameraBlockedDisplays(scene.id);

  const [history, setHistory] = useState<History<Draft>>(() => createHistory(toDraft(scene)));
  const [saved, setSaved] = useState<SignageScene>(scene);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [zoneId, setZoneId] = useState(
    () => resolveLayout(scene.layoutId, scene.customLayoutId, customLayouts).zones[0].id,
  );
  const [preset, setPreset] = useState<PreviewPresetId>('first');
  const [changingLayout, setChangingLayout] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const draft = history.present;
  const dirty = !deepEqual(normalized(draft), toDraft(saved));
  const problem = draftError(draft, customLayouts);
  const saving = saveState === 'saving';
  const canSave = canEdit && dirty && problem === null && !saving;

  /** `key` names the field being typed in: edits of it within half a second form one undo step. */
  const edit = (change: (current: Draft) => Draft, key: string | null = null) => {
    const now = Date.now();
    setHistory((current) => pushEdit(current, change(current.present), key, now));
  };

  const save = async (expectedVersion = saved.version): Promise<void> => {
    if (!canEdit || saving || draftError(draft, customLayouts) !== null) return;
    setSaveState('saving');
    setSaveMessage(null);
    try {
      const next = await updateSignageScene(scene.id, { expectedVersion, ...normalized(draft) });
      setSaved(next);
      setSaveState('idle');
      queryClient.setQueryData(signageKeys.scene(scene.id), next);
      void queryClient.invalidateQueries({ queryKey: signageKeys.scenes() });
    } catch (error) {
      if (isStaleWrite(error)) setSaveState('conflict');
      else {
        setSaveState('error');
        setSaveMessage(errorMessage(error));
      }
    }
  };

  const resetTo = (fresh: SignageScene) => {
    setSaved(fresh);
    setHistory(createHistory(toDraft(fresh)));
    setSaveState('idle');
    setSaveMessage(null);
  };

  const resolveConflict = async (keepMine: boolean) => {
    try {
      const fresh = await queryClient.fetchQuery({ ...sceneQuery(scene.id), staleTime: 0 });
      if (keepMine) {
        setSaved(fresh);
        setSaveState('idle');
        await save(fresh.version);
      } else {
        resetTo(fresh);
        queryClient.setQueryData(signageKeys.scene(scene.id), fresh);
      }
    } catch (error) {
      setSaveMessage(errorMessage(error, 'The latest version could not be loaded.'));
    }
  };

  const discard = () => {
    setHistory(createHistory(toDraft(saved)));
    setSaveState('idle');
    setSaveMessage(null);
    setDiscarding(false);
  };

  // The listener is re-attached on each render so it always sees the current draft.
  useEffect(() => {
    if (!canEdit) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const letter = event.key.toLowerCase();
      if (letter === 's') {
        event.preventDefault();
        if (canSave) void save();
        return;
      }
      if ((letter !== 'z' && letter !== 'y') || isTextTarget(event.target)) return;
      event.preventDefault();
      if (letter === 'y' || event.shiftKey) setHistory((current) => redo(current));
      else setHistory((current) => undo(current));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const unsaved = useUnsavedChanges({ isDirty: dirty });

  const layout = resolveLayout(draft.layoutId, draft.customLayoutId, customLayouts);
  const layoutName =
    draft.layoutId === 'custom'
      ? (customLayouts.find((item) => item.id === draft.customLayoutId)?.name ?? 'Custom layout')
      : layoutById(draft.layoutId).name;
  const selectedId = layout.zones.some((zone) => zone.id === zoneId) ? zoneId : layout.zones[0].id;
  const zone = layout.zones.find((item) => item.id === selectedId)!;
  const widget: SignageWidget = draft.zones[selectedId] ?? { type: 'empty' };
  const setWidget = (next: SignageWidget, key: string | null = null) =>
    edit((current) => ({ ...current, zones: { ...current.zones, [selectedId]: next } }), key);
  const changeLayout = (choice: LayoutChoice) =>
    edit((current) => ({
      ...current,
      layoutId: choice.layoutId,
      customLayoutId: choice.customLayoutId,
      zones: remapZones(
        current.zones,
        resolveLayout(current.layoutId, current.customLayoutId, customLayouts),
        resolveLayout(choice.layoutId, choice.customLayoutId, customLayouts),
      ) as SignageZones,
    }));
  const colourValid = HEX_COLOR.test(draft.backgroundColor);
  const referencedMachineIds = sceneMachineIds(draft.zones);
  const data = usePreviewData(preset, { now, referencedMachineIds });
  const status = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved';

  return (
    <PageShell
      title={draft.name.trim() === '' ? scene.name : draft.name}
      width="fluid"
      breadcrumbs={crumbs}
      actions={
        canEdit ? (
          <div className="sg-editor__actions">
            <Button
              kind="ghost"
              hasIconOnly
              renderIcon={Undo}
              iconDescription="Undo"
              tooltipPosition="bottom"
              disabled={!canUndo(history)}
              onClick={() => setHistory((current) => undo(current))}
            />
            <Button
              kind="ghost"
              hasIconOnly
              renderIcon={Redo}
              iconDescription="Redo"
              tooltipPosition="bottom"
              disabled={!canRedo(history)}
              onClick={() => setHistory((current) => redo(current))}
            />
            <Button kind="ghost" disabled={!dirty || saving} onClick={() => setDiscarding(true)}>
              Discard
            </Button>
            <Button kind="primary" renderIcon={Save} disabled={!canSave} onClick={() => void save()}>
              Save
            </Button>
            <Button kind="danger--tertiary" renderIcon={TrashCan} onClick={() => setDeleting(true)}>
              Delete scene
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="cds--visually-hidden" role="status" aria-live="polite">
        {status}
      </div>
      {saveState === 'conflict' && (
        <>
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="This scene was changed somewhere else"
            subtitle="Your latest edits are not saved yet. Load the latest version, or keep your changes and overwrite it."
          />
          <div className="sg-conflict-actions">
            <Button size="sm" kind="tertiary" onClick={() => void resolveConflict(false)}>
              Load latest
            </Button>
            <Button size="sm" kind="primary" onClick={() => void resolveConflict(true)}>
              Keep my changes
            </Button>
          </div>
        </>
      )}
      {saveState === 'error' && saveMessage && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Saving failed" subtitle={saveMessage} />
      )}
      {saveState === 'conflict' && saveMessage && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Loading failed" subtitle={saveMessage} />
      )}
      {canEdit && dirty && problem && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title="Cannot save yet" subtitle={problem} />
      )}
      <div className="sg-editor">
        <div className="sg-stack sg-editor__structure">
          <Tile>
            <h2 className="sg-section-title">Layout</h2>
            <div className="sg-editor__layout">
              <LayoutSketch
                layoutId={draft.layoutId}
                customLayoutId={draft.customLayoutId}
                customLayouts={customLayouts}
                orientation={orientationOf(draft.aspectRatio)}
              />
              <div className="sg-cell-stack">
                <strong>{layoutName}</strong>
                <span className="sg-secondary">{pluralize(layout.zones.length, 'zone')}</span>
              </div>
            </div>
            {canEdit && (
              <Button kind="tertiary" size="sm" onClick={() => setChangingLayout(true)}>
                Change layout
              </Button>
            )}
          </Tile>
          <ContainedList label="Zones" kind="on-page">
            {layout.zones.map((item) => (
              <ContainedListItem
                key={item.id}
                className={item.id === selectedId ? 'sg-zone-item--active' : undefined}
                onClick={() => setZoneId(item.id)}
              >
                <span className="sg-zone-row" aria-current={item.id === selectedId ? 'true' : undefined}>
                  <span>{item.label}</span>
                  <Tag size="sm" type="cool-gray">
                    {WIDGET_LABELS[draft.zones[item.id]?.type ?? 'empty']}
                  </Tag>
                </span>
              </ContainedListItem>
            ))}
          </ContainedList>
          {canEdit && (
            <Tile>
              <h2 className="sg-section-title">Scene settings</h2>
              <div className="sg-stack">
                <TextInput
                  id="scene-settings-name"
                  labelText="Name"
                  maxLength={100}
                  value={draft.name}
                  invalid={draft.name.trim() === ''}
                  invalidText="A scene needs a name"
                  onChange={(event) => edit((current) => ({ ...current, name: event.target.value }), 'name')}
                />
                <AspectRatioSelect
                  idPrefix="scene-settings"
                  value={draft.aspectRatio}
                  onChange={(aspectRatio) => edit((current) => ({ ...current, aspectRatio }))}
                />
                <ColorFieldRow>
                  <TextInput
                    id="scene-settings-colour"
                    labelText="Background colour"
                    helperText="Hex value, e.g. #161616"
                    autoComplete="off"
                    value={draft.backgroundColor}
                    invalid={!colourValid}
                    invalidText="Enter a hex colour like #161616"
                    onChange={(event) =>
                      edit((current) => ({ ...current, backgroundColor: event.target.value }), 'colour')
                    }
                  />
                  <ColorPicker
                    label="Background colour"
                    value={draft.backgroundColor}
                    onChange={(backgroundColor) => edit((current) => ({ ...current, backgroundColor }), 'colour')}
                  />
                </ColorFieldRow>
                <AssetPicker
                  id="scene-settings-image"
                  label="Background image (optional)"
                  kind="image"
                  assets={assets}
                  value={draft.backgroundAssetId}
                  onChange={(backgroundAssetId) => edit((current) => ({ ...current, backgroundAssetId }))}
                />
                {draft.backgroundAssetId && (
                  <>
                    <FitField
                      id="scene-settings-image-fit"
                      value={draft.backgroundFit}
                      onChange={(backgroundFit) => edit((current) => ({ ...current, backgroundFit }))}
                    />
                    <NumberInput
                      id="scene-settings-image-dim"
                      label={draft.theme === 'dark' ? 'Darken image (%)' : 'Lighten image (%)'}
                      helperText="Keeps text in the zones readable. The colour above shows around a contained image."
                      min={0}
                      max={80}
                      step={10}
                      value={draft.backgroundDim}
                      onChange={(_event, { value }) => {
                        const dim = Number(value);
                        if (value !== '' && Number.isFinite(dim))
                          edit(
                            (current) => ({
                              ...current,
                              backgroundDim: Math.min(80, Math.max(0, Math.round(dim))),
                            }),
                            'dim',
                          );
                      }}
                    />
                  </>
                )}
                <RadioButtonGroup
                  legendText="Text colour"
                  name="scene-theme"
                  valueSelected={draft.theme}
                  onChange={(value) => edit((current) => ({ ...current, theme: value as 'dark' | 'light' }))}
                >
                  <RadioButton id="scene-theme-dark" value="dark" labelText="Light text on dark" />
                  <RadioButton id="scene-theme-light" value="light" labelText="Dark text on light" />
                </RadioButtonGroup>
                <Select
                  id="scene-settings-font"
                  labelText="Scene font"
                  helperText="Zones whose style font is “As the scene” use it."
                  value={draft.fontFamily}
                  onChange={(event) => {
                    const fontFamily = event.target.value as SignageScene['fontFamily'];
                    edit((current) => ({
                      ...current,
                      fontFamily,
                      fontAssetId: fontFamily === 'custom' ? current.fontAssetId : null,
                    }));
                  }}
                >
                  <SelectItem value="sans" text="Sans-serif" />
                  <SelectItem value="serif" text="Serif" />
                  <SelectItem value="mono" text="Monospace" />
                  <SelectItem value="custom" text="Uploaded font" />
                </Select>
                {draft.fontFamily === 'custom' && (
                  <AssetPicker
                    id="scene-settings-font-asset"
                    label="Font"
                    kind="font"
                    assets={assets}
                    value={draft.fontAssetId}
                    onChange={(fontAssetId) => edit((current) => ({ ...current, fontAssetId }))}
                    disabledHint={
                      assets.some((asset) => asset.kind === 'font')
                        ? undefined
                        : 'Upload a WOFF2 font under Media first.'
                    }
                  />
                )}
              </div>
            </Tile>
          )}
        </div>

        <div className="sg-stack sg-editor__canvas">
          <Select
            id="preview-as"
            labelText="Preview as"
            value={preset}
            onChange={(event) => setPreset(event.target.value as PreviewPresetId)}
          >
            {PREVIEW_PRESETS.map((item) => (
              <SelectItem key={item.id} value={item.id} text={item.label} />
            ))}
          </Select>
          <div className={`sg-editor__frame sg-editor__frame--${orientationOf(draft.aspectRatio)}`}>
            <ScreenFrame aspectRatio={draft.aspectRatio} className="sg-canvas">
              <SceneRenderer
                scene={draft}
                data={data}
                customLayouts={customLayouts}
                selectedZone={selectedId}
                onSelectZone={setZoneId}
              />
            </ScreenFrame>
          </div>
          <p className="sg-secondary">
            Select a zone on the canvas or in the list. Zone labels are only shown here. Machine states in the preview
            are simulated; open days and events are the real upcoming ones.
          </p>
        </div>

        <Tile className="sg-editor__properties">
          <h2 className="sg-section-title">Zone: {zone.label}</h2>
          {canEdit ? (
            <div className="sg-stack" key={`${scene.id}-${selectedId}`}>
              <Select
                id="widget-type"
                labelText="Widget type"
                value={widget.type}
                onChange={(event) => setWidget(defaultWidget(event.target.value as WidgetType))}
              >
                {WIDGET_TYPES.map((type) => (
                  <SelectItem key={type} value={type} text={WIDGET_LABELS[type]} />
                ))}
              </Select>
              <WidgetFields
                widget={widget}
                assets={assets}
                templates={templates}
                machines={machines}
                machinesKnown={machinesKnown}
                outsideDisplays={blockedDisplays}
                onChange={(next) => setWidget(next, `zone:${selectedId}:${next.type}`)}
              />
            </div>
          ) : (
            <div className="sg-stack">
              <p>
                Widget: <strong>{WIDGET_LABELS[widget.type]}</strong>
              </p>
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Read only"
                subtitle="Your role can see scenes but not edit them."
              />
            </div>
          )}
        </Tile>
      </div>
      {discarding && (
        <DestructiveActionDialog
          open
          title="Discard changes?"
          fate="none"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onClose={() => setDiscarding(false)}
          onConfirm={discard}
        >
          <p>All edits since the last save are dropped, and undo history is cleared.</p>
        </DestructiveActionDialog>
      )}
      {changingLayout && (
        <ChangeLayoutModal
          sceneName={draft.name}
          current={{ layoutId: draft.layoutId, customLayoutId: draft.customLayoutId }}
          customLayouts={customLayouts}
          orientation={orientationOf(draft.aspectRatio)}
          onSave={changeLayout}
          onClose={() => setChangingLayout(false)}
        />
      )}
      {deleting && (
        <DeleteDialog
          title={`Delete “${scene.name}”?`}
          noun="Scene"
          confirmLabel="Delete scene"
          remove={() => deleteSignageScene(scene.id, { expectedVersion: saved.version })}
          onDeleted={() => unsaved.bypassAfterSubmit(() => navigate(signagePaths.content()))}
          onClose={() => setDeleting(false)}
        >
          <p>
            The scene is removed for good. A scene that a display's default scenes or rules still use cannot be deleted.
          </p>
        </DeleteDialog>
      )}
      <UnsavedChangesDialog
        guard={unsaved}
        title="Leave without saving?"
        message="Your latest edits to this scene have not been saved."
        confirmLabel="Leave"
      />
    </PageShell>
  );
}
