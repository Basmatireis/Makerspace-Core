import './styles.scss';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ContainedList, ContainedListItem, InlineLoading, InlineNotification, NumberInput, RadioButton, RadioButtonGroup, Select, SelectItem, Tag, TextInput, Tile } from '@carbon/react';
import { TrashCan } from '@carbon/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { SignageLayoutId, SignageScene, SignageWidget, SignageZones } from '../../api/generated/models';
import { deleteSignageScene, updateSignageScene } from '../../api/generated/signage/signage';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { useCameraBlockedDisplays } from './displayHooks';
import { ChangeLayoutModal } from './ChangeLayoutModal';
import { AssetPicker, DeleteDialog, FitField, LayoutSketch } from './components';
import { errorMessage, isStaleWrite, orientationLabel, pluralize } from './helpers';
import { layoutById, remapZones } from './layouts';
import { signagePaths } from './paths';
import { PREVIEW_PRESETS, useMachineOptions, useNow, usePreviewData, type PreviewPresetId } from './preview';
import { assetsQuery, sceneQuery, signageKeys, templatesQuery } from './queries';
import { SceneRenderer, ScreenFrame } from './render/SceneRenderer';
import { WidgetFields } from './WidgetFields';
import { draftError, toDraft, type Draft } from './sceneDraft';
import { defaultWidget, HEX_COLOR, sceneMachineIds, WIDGET_LABELS, WIDGET_TYPES, type WidgetType } from './widgets';

const SAVE_DELAY_MS = 700;

type SaveState = 'saved' | 'pending' | 'saving' | 'invalid' | 'error' | 'conflict';
const SAVE_TEXT: Record<SaveState, string> = { saved: 'Saved · draft', pending: 'Unsaved changes…', saving: 'Saving…', invalid: 'Not saved · fix the error', error: 'Not saved', conflict: 'Not saved · changed elsewhere' };

export function SceneEditorPage() {
  const { sceneId = '' } = useParams();
  const query = useQuery(sceneQuery(sceneId));
  const crumbs = [{ label: 'Signage' }, { label: 'Content', to: signagePaths.content() }];
  if (query.isPending) return <PageShell title="Scene" width="fluid" breadcrumbs={crumbs}><FullPageLoading label="Loading scene" /></PageShell>;
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Scene not found' : 'Scene'} width="fluid" breadcrumbs={crumbs}>
        {missing ? <EmptyState title="This scene does not exist" description="It may have been deleted." /> : <ErrorState message={errorMessage(query.error, 'The scene could not be loaded.')} onRetry={() => void query.refetch()} />}
      </PageShell>
    );
  }
  return <Editor key={query.data.id} scene={query.data} crumbs={crumbs} />;
}

function Editor({ scene, crumbs }: { scene: SignageScene; crumbs: { label: string; to?: string }[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canEdit = hasPermission(useCurrentUser(), PermissionId.signagecontentmanage);
  const now = useNow(1000);
  const assets = useQuery(assetsQuery()).data?.items ?? [];
  const templates = useQuery(templatesQuery()).data?.items ?? [];
  const { machines, known: machinesKnown } = useMachineOptions();
  const blockedDisplays = useCameraBlockedDisplays(scene.id);

  const [draft, setDraft] = useState<Draft>(() => toDraft(scene));
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState(() => layoutById(scene.layoutId).zones[0].id);
  const [preset, setPreset] = useState<PreviewPresetId>('first');
  const [changingLayout, setChangingLayout] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Autosave bookkeeping lives in refs: the debounce timer and the in-flight request must not re-trigger renders.
  const latest = useRef(draft);
  const version = useRef(scene.version);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const inFlight = useRef(false);
  const timer = useRef<number | null>(null);
  const gone = useRef(false);
  const hold = useRef(false);

  const save = useCallback(async (): Promise<void> => {
    if (gone.current || hold.current || inFlight.current || revision.current === savedRevision.current) return;
    const current = latest.current;
    const problem = draftError(current);
    if (problem) { setSaveState('invalid'); setSaveMessage(problem); return; }
    const sent = revision.current;
    inFlight.current = true;
    setSaveState('saving');
    try {
      const saved = await updateSignageScene(scene.id, { expectedVersion: version.current, ...current, name: current.name.trim(), orientation: scene.orientation, backgroundColor: current.backgroundColor.toLowerCase() });
      version.current = saved.version;
      savedRevision.current = sent;
      queryClient.setQueryData(signageKeys.scene(scene.id), saved);
      void queryClient.invalidateQueries({ queryKey: signageKeys.scenes() });
      inFlight.current = false;
      if (revision.current !== sent) void save(); else { setSaveState('saved'); setSaveMessage(null); }
    } catch (error) {
      inFlight.current = false;
      if (isStaleWrite(error)) { hold.current = true; setSaveState('conflict'); setSaveMessage(null); } else { setSaveState('error'); setSaveMessage(errorMessage(error)); }
    }
  }, [queryClient, scene.id, scene.orientation]);

  const edit = (change: (current: Draft) => Draft) => {
    const next = change(latest.current);
    latest.current = next;
    revision.current += 1;
    setDraft(next);
    if (!hold.current) setSaveState('pending');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void save(); }, SAVE_DELAY_MS);
  };

  // Leaving the page sends pending changes instead of dropping them.
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (!gone.current && !hold.current && revision.current !== savedRevision.current && !inFlight.current && draftError(latest.current) === null) {
      const current = latest.current;
      void updateSignageScene(scene.id, { expectedVersion: version.current, ...current, name: current.name.trim(), orientation: scene.orientation, backgroundColor: current.backgroundColor.toLowerCase() })
        .then(() => queryClient.invalidateQueries({ queryKey: signageKeys.all }), () => undefined);
    }
  }, [queryClient, scene.id, scene.orientation]);

  const resolveConflict = async (keepMine: boolean) => {
    try {
      const fresh = await queryClient.fetchQuery({ ...sceneQuery(scene.id), staleTime: 0 });
      version.current = fresh.version;
      hold.current = false;
      if (keepMine) {
        revision.current += 1;
        setSaveState('pending');
        void save();
      } else {
        latest.current = toDraft(fresh);
        setDraft(latest.current);
        savedRevision.current = revision.current;
        setSaveState('saved');
        setSaveMessage(null);
      }
    } catch (error) {
      setSaveMessage(errorMessage(error, 'The latest version could not be loaded.'));
    }
  };

  const unsaved = useUnsavedChanges({ isDirty: saveState === 'invalid' || saveState === 'error' || saveState === 'conflict' });

  const layout = layoutById(draft.layoutId);
  const selectedId = layout.zones.some((zone) => zone.id === zoneId) ? zoneId : layout.zones[0].id;
  const zone = layout.zones.find((item) => item.id === selectedId)!;
  const widget: SignageWidget = draft.zones[selectedId] ?? { type: 'empty' };
  const setWidget = (next: SignageWidget) => edit((current) => ({ ...current, zones: { ...current.zones, [selectedId]: next } }));
  const changeLayout = (layoutId: SignageLayoutId) => edit((current) => ({ ...current, layoutId, zones: remapZones(current.zones, current.layoutId, layoutId) as SignageZones }));
  const colourValid = HEX_COLOR.test(draft.backgroundColor);
  const referencedMachineIds = useMemo(() => sceneMachineIds(draft.zones), [draft.zones]);
  const data = usePreviewData(preset, { now, referencedMachineIds });
  const status = SAVE_TEXT[saveState];

  return (
    <PageShell
      title={draft.name.trim() === '' ? scene.name : draft.name} width="fluid" breadcrumbs={crumbs} description={`${status} · ${orientationLabel(scene.orientation)}`}
      actions={canEdit ? <Button kind="danger--tertiary" renderIcon={TrashCan} onClick={() => setDeleting(true)}>Delete scene</Button> : undefined}
    >
      <div className="cds--visually-hidden" role="status" aria-live="polite">{status}</div>
      {saveState === 'conflict' && (
        <>
          <InlineNotification kind="error" lowContrast hideCloseButton title="This scene was changed somewhere else" subtitle="Your latest edits are not saved yet. Load the latest version, or keep your changes and overwrite it." />
          <div className="sg-conflict-actions">
            <Button size="sm" kind="tertiary" onClick={() => void resolveConflict(false)}>Load latest</Button>
            <Button size="sm" kind="primary" onClick={() => void resolveConflict(true)}>Keep my changes</Button>
          </div>
        </>
      )}
      {(saveState === 'invalid' || saveState === 'error') && saveMessage && (
        <>
          <InlineNotification kind={saveState === 'invalid' ? 'warning' : 'error'} lowContrast hideCloseButton title={saveState === 'invalid' ? 'Not saved yet' : 'Saving failed'} subtitle={saveMessage} />
          {saveState === 'error' && <div className="sg-conflict-actions"><Button size="sm" kind="tertiary" onClick={() => { void save(); }}>Try again</Button></div>}
        </>
      )}
      <div className="sg-editor">
        <div className="sg-stack sg-editor__structure">
          <Tile>
            <h2 className="sg-section-title">Layout</h2>
            <div className="sg-editor__layout">
              <LayoutSketch layoutId={draft.layoutId} orientation={scene.orientation} />
              <div className="sg-cell-stack"><strong>{layout.name}</strong><span className="sg-secondary">{pluralize(layout.zones.length, 'zone')}</span></div>
            </div>
            {canEdit && <Button kind="tertiary" size="sm" onClick={() => setChangingLayout(true)}>Change layout</Button>}
          </Tile>
          <ContainedList label="Zones" kind="on-page">
            {layout.zones.map((item) => (
              <ContainedListItem key={item.id} className={item.id === selectedId ? 'sg-zone-item--active' : undefined} onClick={() => setZoneId(item.id)}>
                <span className="sg-zone-row" aria-current={item.id === selectedId ? 'true' : undefined}><span>{item.label}</span><Tag size="sm" type="cool-gray">{WIDGET_LABELS[draft.zones[item.id]?.type ?? 'empty']}</Tag></span>
              </ContainedListItem>
            ))}
          </ContainedList>
          {canEdit && (
            <Tile>
              <h2 className="sg-section-title">Scene settings</h2>
              <div className="sg-stack">
                <TextInput id="scene-settings-name" labelText="Name" maxLength={100} value={draft.name} invalid={draft.name.trim() === ''} invalidText="A scene needs a name" onChange={(event) => edit((current) => ({ ...current, name: event.target.value }))} />
                <div className="sg-colour-field">
                  <TextInput id="scene-settings-colour" labelText="Background colour" helperText="Hex value, e.g. #161616" autoComplete="off" value={draft.backgroundColor} invalid={!colourValid} invalidText="Enter a hex colour like #161616"
                    onChange={(event) => edit((current) => ({ ...current, backgroundColor: event.target.value }))} />
                  <span className="sg-colour-field__swatch" style={{ background: colourValid ? draft.backgroundColor : 'transparent' }} aria-hidden="true" />
                </div>
                <AssetPicker id="scene-settings-image" label="Background image (optional)" kind="image" assets={assets} value={draft.backgroundAssetId} onChange={(backgroundAssetId) => edit((current) => ({ ...current, backgroundAssetId }))} />
                {draft.backgroundAssetId && (
                  <>
                    <FitField id="scene-settings-image-fit" value={draft.backgroundFit} onChange={(backgroundFit) => edit((current) => ({ ...current, backgroundFit }))} />
                    <NumberInput
                      id="scene-settings-image-dim" label={draft.theme === 'dark' ? 'Darken image (%)' : 'Lighten image (%)'} helperText="Keeps text in the zones readable. The colour above shows around a contained image."
                      min={0} max={80} step={10} value={draft.backgroundDim}
                      onChange={(_event, { value }) => { const dim = Number(value); if (value !== '' && Number.isFinite(dim)) edit((current) => ({ ...current, backgroundDim: Math.min(80, Math.max(0, Math.round(dim))) })); }}
                    />
                  </>
                )}
                <RadioButtonGroup legendText="Text colour" name="scene-theme" valueSelected={draft.theme} onChange={(value) => edit((current) => ({ ...current, theme: value as 'dark' | 'light' }))}>
                  <RadioButton id="scene-theme-dark" value="dark" labelText="Light text on dark" />
                  <RadioButton id="scene-theme-light" value="light" labelText="Dark text on light" />
                </RadioButtonGroup>
              </div>
            </Tile>
          )}
        </div>

        <div className="sg-stack sg-editor__canvas">
          <Select id="preview-as" labelText="Preview as" value={preset} onChange={(event) => setPreset(event.target.value as PreviewPresetId)}>
            {PREVIEW_PRESETS.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
          </Select>
          <div className={`sg-editor__frame sg-editor__frame--${scene.orientation}`}>
            <ScreenFrame orientation={scene.orientation} className="sg-canvas">
              <SceneRenderer scene={{ ...draft, orientation: scene.orientation }} data={data} selectedZone={selectedId} onSelectZone={setZoneId} />
            </ScreenFrame>
          </div>
          <p className="sg-secondary">Select a zone on the canvas or in the list. Zone labels are only shown here. Machine states in the preview are simulated; open days and events are the real upcoming ones.</p>
        </div>

        <Tile className="sg-editor__properties">
          <h2 className="sg-section-title">Zone: {zone.label}</h2>
          {canEdit ? (
            <div className="sg-stack" key={`${scene.id}-${selectedId}`}>
              <Select id="widget-type" labelText="Widget type" value={widget.type} onChange={(event) => setWidget(defaultWidget(event.target.value as WidgetType))}>
                {WIDGET_TYPES.map((type) => <SelectItem key={type} value={type} text={WIDGET_LABELS[type]} />)}
              </Select>
              <WidgetFields widget={widget} assets={assets} templates={templates} machines={machines} machinesKnown={machinesKnown} outsideDisplays={blockedDisplays} onChange={setWidget} />
            </div>
          ) : (
            <div className="sg-stack">
              <p>Widget: <strong>{WIDGET_LABELS[widget.type]}</strong></p>
              <InlineNotification kind="info" lowContrast hideCloseButton title="Read only" subtitle="Your role can see scenes but not edit them." />
            </div>
          )}
        </Tile>
      </div>
      {saveState === 'saving' && <InlineLoading className="cds--visually-hidden" description="Saving" status="active" />}
      {changingLayout && <ChangeLayoutModal sceneName={draft.name} layoutId={draft.layoutId} orientation={scene.orientation} onSave={changeLayout} onClose={() => setChangingLayout(false)} />}
      {deleting && (
        <DeleteDialog
          title={`Delete “${scene.name}”?`} noun="Scene" confirmLabel="Delete scene" remove={() => deleteSignageScene(scene.id, { expectedVersion: version.current })}
          onDeleted={() => { gone.current = true; navigate(signagePaths.content()); }} onClose={() => setDeleting(false)}
        >
          <p>The scene is removed for good. A scene that playlists or display rules still use cannot be deleted.</p>
        </DeleteDialog>
      )}
      <UnsavedChangesDialog guard={unsaved} title="Leave without saving?" message="Your latest edits to this scene have not been saved." confirmLabel="Leave" />
    </PageShell>
  );
}
