import { useState } from 'react';
import { Button, ContainedList, ContainedListItem, InlineNotification, NumberInput, RadioButton, RadioButtonGroup, Select, SelectItem, Tag, TextInput, Tile } from '@carbon/react';
import { Launch } from '@carbon/icons-react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { RequirePermission } from '../../sales/components/RequirePermission';
import { useNow, useStore } from '../../store';
import { SceneRenderer, ScreenFrame } from '../components/SceneRenderer';
import { TemplateSketch } from '../components/TemplatePicker';
import { FitField, MediaPicker, WidgetFields } from '../components/WidgetFields';
import { ChangeTemplateModal } from '../dialogs/ChangeTemplateModal';
import { displaySceneIds } from '../helpers';
import { useSignage } from '../SignageContext';
import { templateById } from '../templates';
import { useSignageQuery } from '../useSignageQuery';
import { defaultWidget, PREVIEW_PRESETS, WIDGET_LABELS, WIDGET_TYPES } from '../widgets';
import type { Widget, WidgetType } from '../types';
import '../signage.scss';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function SceneEditorPage() {
  const { sceneId = '' } = useParams();
  const signage = useSignage();
  const scene = signage.scenes.find((item) => item.id === sceneId) ?? null;
  const query = useSignageQuery(scene, null);
  const crumbs = [{ label: 'Signage' }, { label: 'Content', to: '/signage/content' }];
  return (
    <RequirePermission permission="signage.read" title="Scene" crumbs={crumbs}>
      {query.status === 'success' && !scene ? (
        <PageShell title="Scene not found" breadcrumbs={crumbs} width="fluid"><EmptyState title="This scene does not exist" /></PageShell>
      ) : query.status !== 'success' || !query.data ? (
        <PageShell title="Scene" breadcrumbs={crumbs} width="fluid"><QueryBoundary query={query} errorMessage="The scene could not be loaded."><EmptyState title="No data" /></QueryBoundary></PageShell>
      ) : <Editor sceneId={sceneId} crumbs={crumbs} />}
    </RequirePermission>
  );
}

function Editor({ sceneId, crumbs }: { sceneId: string; crumbs: { label: string; to?: string }[] }) {
  const store = useStore();
  const signage = useSignage();
  const navigate = useNavigate();
  const now = useNow(1000);
  const scene = signage.scenes.find((item) => item.id === sceneId)!;
  const template = templateById(scene.templateId);
  const [zoneId, setZoneId] = useState(template.zones[0].id);
  const [preview, setPreview] = useState('h2d');
  const [changingTemplate, setChangingTemplate] = useState(false);
  const canEdit = store.can('signage.content.manage');
  const selectedId = template.zones.some((zone) => zone.id === zoneId) ? zoneId : template.zones[0].id;
  const zone = template.zones.find((item) => item.id === selectedId)!;
  const widget = scene.zones[selectedId] ?? { type: 'empty' as const };
  const previewSim = (PREVIEW_PRESETS.find((item) => item.id === preview) ?? PREVIEW_PRESETS[0]).sim;
  const outsideDisplays = signage.displays.filter((display) => display.outside && !display.revoked && displaySceneIds(display, signage.playlists).has(scene.id)).map((display) => display.name);

  const setWidget = (next: Widget) => signage.updateScene(scene.id, (current) => ({ ...current, zones: { ...current.zones, [selectedId]: next } }));
  const backgroundValid = HEX.test(scene.background);

  return (
    <PageShell
      title={scene.name} width="fluid" breadcrumbs={crumbs} description={`Saved · draft · ${scene.orientation === 'portrait' ? 'Portrait' : 'Landscape'}`}
      actions={<Button kind="tertiary" renderIcon={Launch} onClick={() => navigate(`/signage/play/${scene.id}?as=${preview}`)}>Preview fullscreen</Button>}
    >
      <div className="sg-editor">
        <div className="mj-stack sg-editor__structure">
          <Tile>
            <h2 className="mj-section-title">Template</h2>
            <div className="sg-editor__template">
              <TemplateSketch templateId={scene.templateId} orientation={scene.orientation} />
              <div className="mj-cell-stack"><strong>{template.name}</strong><span className="mj-secondary">{template.zones.length} {template.zones.length === 1 ? 'zone' : 'zones'}</span></div>
            </div>
            {canEdit && <Button kind="tertiary" size="sm" onClick={() => setChangingTemplate(true)}>Change template</Button>}
          </Tile>
          <ContainedList label="Zones" kind="on-page">
            {template.zones.map((item) => (
              <ContainedListItem key={item.id} className={item.id === selectedId ? 'sg-zone-item--active' : undefined} onClick={() => setZoneId(item.id)}>
                <span className="sg-zone-row" aria-current={item.id === selectedId ? 'true' : undefined}><span>{item.label}</span><Tag size="sm" type="cool-gray">{WIDGET_LABELS[scene.zones[item.id]?.type ?? 'empty']}</Tag></span>
              </ContainedListItem>
            ))}
          </ContainedList>
          {canEdit && (
            <Tile>
              <h2 className="mj-section-title">Scene settings</h2>
              <div className="mj-stack">
                <TextInput id="scene-settings-name" labelText="Name" value={scene.name} invalid={scene.name.trim() === ''} invalidText="A scene needs a name" onChange={(event) => signage.updateScene(scene.id, (current) => ({ ...current, name: event.target.value }))} />
                <div className="sg-colour-field">
                  <TextInput id="scene-settings-colour" labelText="Background colour" helperText="Hex value, e.g. #161616" autoComplete="off" value={scene.background} invalid={!backgroundValid} invalidText="Enter a hex colour like #161616"
                    onChange={(event) => signage.updateScene(scene.id, (current) => ({ ...current, background: event.target.value }))} />
                  <span className="sg-colour-field__swatch" style={{ background: backgroundValid ? scene.background : 'transparent' }} aria-hidden="true" />
                </div>
                <MediaPicker id="scene-settings-image" label="Background image (optional)" kind="image" media={signage.media} value={scene.backgroundImage?.mediaId ?? null}
                  onChange={(mediaId) => signage.updateScene(scene.id, (current) => ({ ...current, backgroundImage: mediaId ? { fit: 'cover', dim: 30, ...current.backgroundImage, mediaId } : null }))} />
                {scene.backgroundImage && (
                  <>
                    <FitField id="scene-settings-image-fit" value={scene.backgroundImage.fit}
                      onChange={(fit) => signage.updateScene(scene.id, (current) => ({ ...current, backgroundImage: current.backgroundImage && { ...current.backgroundImage, fit } }))} />
                    <NumberInput id="scene-settings-image-dim" label={scene.theme === 'dark' ? 'Darken image (%)' : 'Lighten image (%)'} helperText="Keeps text in the zones readable. The colour above shows around a contained image."
                      min={0} max={80} step={10} value={scene.backgroundImage.dim}
                      onChange={(_event, { value }) => { const dim = Number(value); if (Number.isFinite(dim)) signage.updateScene(scene.id, (current) => ({ ...current, backgroundImage: current.backgroundImage && { ...current.backgroundImage, dim: Math.min(80, Math.max(0, dim)) } })); }} />
                  </>
                )}
                <RadioButtonGroup legendText="Text colour" name="scene-theme" valueSelected={scene.theme} onChange={(value) => signage.updateScene(scene.id, (current) => ({ ...current, theme: value as 'dark' | 'light' }))}>
                  <RadioButton id="scene-theme-dark" value="dark" labelText="Light text on dark" />
                  <RadioButton id="scene-theme-light" value="light" labelText="Dark text on light" />
                </RadioButtonGroup>
              </div>
            </Tile>
          )}
        </div>

        <div className="mj-stack sg-editor__canvas">
          <Select id="preview-as" labelText="Preview as" value={preview} onChange={(event) => setPreview(event.target.value)}>
            {PREVIEW_PRESETS.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
          </Select>
          <div className={`sg-editor__frame sg-editor__frame--${scene.orientation}`}>
            <ScreenFrame orientation={scene.orientation} className="sg-canvas">
              <SceneRenderer scene={scene} sim={previewSim} now={now} media={signage.media} selectedZone={selectedId} onSelectZone={setZoneId} />
            </ScreenFrame>
          </div>
          <p className="mj-secondary">Select a zone on the canvas or in the list. Zone labels are only shown here.</p>
        </div>

        <Tile className="sg-editor__properties">
          <h2 className="mj-section-title">Zone: {zone.label}</h2>
          {canEdit ? (
            <div className="mj-stack" key={`${scene.id}-${selectedId}`}>
              <Select id="widget-type" labelText="Widget type" value={widget.type} onChange={(event) => setWidget(defaultWidget(event.target.value as WidgetType, signage.media))}>
                {WIDGET_TYPES.map((type) => <SelectItem key={type} value={type} text={WIDGET_LABELS[type]} />)}
              </Select>
              <WidgetFields widget={widget} media={signage.media} outsideDisplays={outsideDisplays} onChange={setWidget} />
            </div>
          ) : (
            <div className="mj-stack">
              <p>Widget: <strong>{WIDGET_LABELS[widget.type]}</strong></p>
              <InlineNotification kind="info" lowContrast hideCloseButton title="Read only" subtitle="Your role can see scenes but not edit them." />
            </div>
          )}
        </Tile>
      </div>
      {changingTemplate && <ChangeTemplateModal scene={scene} onClose={() => setChangingTemplate(false)} onSave={(templateId) => signage.changeTemplate(scene.id, templateId)} />}
    </PageShell>
  );
}
