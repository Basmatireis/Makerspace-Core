import { InlineNotification, Select, SelectItem, Tab, TabList, TabPanel, TabPanels, Tabs } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type CSSProperties } from 'react';
import { createInsertRegistry, InsertContext } from '../insertTarget';
import type { PdfTemplateDetail, PdfTemplateExport } from '../../../api/generated/models';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import type { Zoom } from '../../signage/editor/zoom';
import { schemaHints } from '../blocks';
import { apiDocument, find, type Container, type ToolType } from '../model';
import {
  insertNew,
  layerForDrawing,
  moveBy,
  moveNode,
  nudgeNode,
  patchNode,
  renameNode,
  type EditResult,
} from '../ops';
import { usePaneWidths, PANES } from '../paneWidths';
import { pdfPreviewQuery, serialOf, type PreviewSourceChoice } from '../queries';
import { useDebouncedValue } from '../useDebouncedValue';
import { usePreviewDocument } from '../usePreviewDocument';
import type { DrawResult } from '../usePreviewInteraction';
import { useTemplateEditor } from '../useTemplateEditor';
import { useEditorShortcuts } from '../useEditorShortcuts';
import { EditorBar } from './EditorBar';
import { InsertToolbar } from './InsertToolbar';
import { PreviewCanvas } from './PreviewCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { PublishModal } from './PublishModal';
import { Splitter } from './Splitter';
import { StructureTree } from './StructureTree';
import { StylesPanel } from './StylesPanel';
import { VariablesPanel } from './VariablesPanel';
import { VersionsModal } from './VersionsModal';
import { ZoomBar } from './ZoomBar';

const SAMPLE = 'sample';
const choiceOf = (id: string): PreviewSourceChoice => (id === SAMPLE ? { kind: 'sample' } : { kind: 'record', id });

/** The three panes around one export's working document. Keyed by export in the page, so switching starts fresh. */
export function TemplateEditor({
  detail,
  onKind,
}: {
  detail: PdfTemplateDetail;
  onKind: (kind: PdfTemplateExport) => void;
}) {
  const editor = useTemplateEditor(detail);
  const { doc } = editor;
  const hints = useMemo(() => schemaHints(detail.schema), [detail.schema]);
  const { workRef, sizes, drag: dragPane, commit: commitPane } = usePaneWidths();

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolType | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [leftTab, setLeftTab] = useState(0);
  const [rightTab, setRightTab] = useState(0);
  // Variables inserted from the left tab go into the Properties tab, so that one is brought to the front.
  const [insertRegistry] = useState(() => createInsertRegistry(() => setRightTab(0)));
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [scale, setScale] = useState(1);
  const [source, setSource] = useState(SAMPLE);
  const [dialog, setDialog] = useState<'versions' | 'publish' | null>(null);

  // A selection that no longer exists (after an undo, say) counts as no selection.
  const selectedId = pickedId === 'page' || (pickedId && find(doc, pickedId)) ? pickedId : null;
  const guard = useUnsavedChanges({ isDirty: editor.dirty });

  // Preview: the working document, debounced, with the chosen data. The previous render stays until the next one is there.
  const debounced = useDebouncedValue(doc, 300);
  const preview = useQuery(
    pdfPreviewQuery(detail.export, serialOf(debounced), apiDocument(debounced), choiceOf(source)),
  );
  const shown = usePreviewDocument(preview.data);
  const problems = useMemo(() => preview.data?.problems ?? [], [preview.data]);
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.length - errors.length;
  const errorIds = useMemo(() => new Set(errors.map((p) => p.nodeId)), [errors]);
  const stale = debounced !== doc || preview.isPlaceholderData;

  const select = (id: string | null) => {
    setPickedId(id);
    if (id) setRightTab(0);
  };
  const expand = (ids: string[]) =>
    ids.length && setOpen((now) => ({ ...now, ...Object.fromEntries(ids.map((id) => [id, true])) }));
  const apply = (result: EditResult | null) => {
    if (!result) return false;
    editor.set(result.doc, 'step');
    setPickedId(result.select);
    expand(result.expand);
    return true;
  };
  const insert = (type: ToolType, container: Container, index: number) => {
    setTool(null);
    apply(insertNew(doc, type, container, index, hints));
  };
  const draw = ({ pageIndex, type, at, size }: DrawResult) => {
    const target = layerForDrawing(doc, selectedId, pageIndex);
    const layer = find(target.doc, target.layerId)?.node;
    setTool(null);
    if (layer?.type !== 'layer') return;
    apply(
      insertNew(target.doc, type, { node: layer.id, slot: 'elements' }, layer.elements.length, hints, { at, size }),
    );
  };
  const commit = (next: ReturnType<typeof patchNode>) => {
    if (next) editor.set(next, 'step');
  };

  useEditorShortcuts({
    enabled: true,
    undo: editor.undo,
    redo: editor.redo,
    onTool: setTool,
    onEscape: () => {
      if (tool) setTool(null);
      else if (pickedId) setPickedId(null);
      else return false;
      return true;
    },
    onNudge: (dx, dy) => {
      const next = selectedId && selectedId !== 'page' ? nudgeNode(doc, selectedId, dx, dy) : null;
      commit(next);
      return !!next;
    },
  });

  const panelProps = { doc, selectedId, schema: detail.schema, onChange: editor.set, onSelect: select };
  const sources = [{ id: SAMPLE, label: 'Sample data' }, ...detail.previewSources.filter((s) => s.id !== SAMPLE)];
  const redacted = preview.data?.redacted.length ?? 0;
  const vars = {
    '--pdft-left': `${sizes.left}px`,
    '--pdft-right': `${sizes.right}px`,
  } as CSSProperties;

  return (
    <InsertContext.Provider value={insertRegistry}>
      <div className="pdft">
        <EditorBar
          kind={detail.export}
          name={doc.name}
          onKind={(next) => guard.requestDiscard(() => onKind(next))}
          status={editor.status}
          errors={errors.length}
          warnings={warnings}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          onUndo={editor.undo}
          onRedo={editor.redo}
          onVersions={() => setDialog('versions')}
          onSave={editor.save}
          onPublish={() => setDialog('publish')}
          saveDisabled={!editor.dirty}
          saving={editor.saving}
          publishDisabled={errors.length > 0 || stale || (!editor.dirty && !editor.server.draft)}
        />
        {editor.error && dialog === null && (
          <div className="pdft-notice">
            <InlineNotification
              kind="error"
              lowContrast
              title="Not saved"
              subtitle={editor.error}
              onCloseButtonClick={editor.clearError}
            />
          </div>
        )}
        <div className="pdft-work" ref={workRef} style={vars}>
          <section className="pdft-pane pdft-pane--left" aria-label="Template structure">
            <Tabs selectedIndex={leftTab} onChange={({ selectedIndex }) => setLeftTab(selectedIndex)}>
              <TabList aria-label="Structure and variables" contained fullWidth>
                <Tab>Structure</Tab>
                <Tab>Variables</Tab>
              </TabList>
              <TabPanels>
                <TabPanel className="pdft-tabpanel">
                  <StructureTree
                    doc={doc}
                    selectedId={selectedId}
                    open={open}
                    tool={tool}
                    errorIds={errorIds}
                    onToggle={(key, value) => setOpen((now) => ({ ...now, [key]: value }))}
                    onSelect={select}
                    onHover={setHoverId}
                    onMove={(id, container, index) => apply(moveNode(doc, id, container, index))}
                    onMoveBy={(id, delta) => apply(moveBy(doc, id, delta))}
                    onRename={(id, title) => commit(renameNode(doc, id, title))}
                    onInsert={(container, index) => tool && insert(tool, container, index)}
                  />
                </TabPanel>
                <TabPanel className="pdft-tabpanel">
                  <VariablesPanel {...panelProps} />
                </TabPanel>
              </TabPanels>
            </Tabs>
          </section>
          <Splitter
            side="left"
            label="Width of the structure panel"
            width={sizes.left}
            {...PANES.left}
            defaultWidth={PANES.left.def}
            onDrag={(px) => dragPane('left', px)}
            onCommit={(px) => commitPane('left', px)}
          />
          <section className="pdft-center" aria-label="Preview">
            <div className="pdft-ptools">
              <Select
                id="pdft-data"
                size="sm"
                labelText="Data"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id} text={s.label} />
                ))}
              </Select>
            </div>
            {preview.isError && (
              <div className="pdft-notice">
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="The preview could not be rendered."
                  subtitle={`${preview.error.message}${shown ? ' The last render is still shown.' : ''}`}
                />
              </div>
            )}
            <PreviewCanvas
              shown={shown}
              doc={doc}
              selectedId={selectedId}
              hoverId={hoverId}
              tool={tool}
              zoom={zoom}
              onZoom={setZoom}
              onScale={setScale}
              onSelect={select}
              onHover={setHoverId}
              onGeometry={(id, patch) => commit(patchNode(doc, id, patch))}
              onDraw={draw}
            />
            <InsertToolbar
              tool={tool}
              onTool={setTool}
              onAddLayer={() => apply(insertNew(doc, 'layer', { root: 'layers' }, doc.layers.length, hints))}
            />
            <footer className="pdft-foot">
              <span className="pdft-foot__meta" role="status">
                {shown
                  ? `${shown.preview.pages.length} page${shown.preview.pages.length === 1 ? '' : 's'} · rendered in ${shown.preview.ms} ms${
                      redacted ? ` · ${redacted} field${redacted === 1 ? '' : 's'} hidden for this reader` : ''
                    }`
                  : preview.isPending
                    ? 'Rendering…'
                    : ''}
              </span>
              <ZoomBar zoom={zoom} scale={scale} onZoom={setZoom} />
            </footer>
          </section>
          <Splitter
            side="right"
            label="Width of the properties panel"
            width={sizes.right}
            {...PANES.right}
            defaultWidth={PANES.right.def}
            onDrag={(px) => dragPane('right', px)}
            onCommit={(px) => commitPane('right', px)}
          />
          <section className="pdft-pane pdft-pane--right" aria-label="Properties">
            <Tabs selectedIndex={rightTab} onChange={({ selectedIndex }) => setRightTab(selectedIndex)}>
              <TabList aria-label="Properties and styles" contained fullWidth>
                <Tab>Properties</Tab>
                <Tab>Styles</Tab>
              </TabList>
              <TabPanels>
                <TabPanel className="pdft-tabpanel">
                  <PropertiesPanel {...panelProps} problems={problems} redacted={preview.data?.redacted ?? []} />
                </TabPanel>
                <TabPanel className="pdft-tabpanel">
                  <StylesPanel {...panelProps} />
                </TabPanel>
              </TabPanels>
            </Tabs>
          </section>
        </div>
        {dialog === 'versions' && (
          <VersionsModal
            kind={detail.export}
            templateName={doc.name}
            onClose={() => setDialog(null)}
            busy={editor.working}
            error={editor.error}
            onRestore={(version) => editor.restore(version, () => setDialog(null))}
            onReset={() => {
              editor.resetToBuiltin();
              setDialog(null);
            }}
            onDiscardDraft={editor.server.draft ? () => editor.discard(() => setDialog(null)) : null}
          />
        )}
        {dialog === 'publish' && (
          <PublishModal
            kind={detail.export}
            templateName={doc.name}
            version={editor.nextVersion}
            unsaved={editor.dirty}
            warnings={warnings}
            pending={editor.publishing}
            error={editor.error}
            onClose={() => {
              editor.clearError();
              setDialog(null);
            }}
            onConfirm={() => editor.publish(() => setDialog(null))}
          />
        )}
        <UnsavedChangesDialog guard={guard} message="Your edits to this template have not been saved as a draft." />
      </div>
    </InsertContext.Provider>
  );
}
