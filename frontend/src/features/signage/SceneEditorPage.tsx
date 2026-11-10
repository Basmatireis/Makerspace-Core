import './styles.scss';
import { useEffect, useState } from 'react';
import { Button, ContentSwitcher, IconButton, InlineLoading, InlineNotification, Switch, Toggle } from '@carbon/react';
import { ArrowLeft, Checkmark, Redo, Send, Undo, View, WarningFilled } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { SignageBlock, SignageScene } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useLatestCallback } from '../../app/useLatestCallback';
import { useNotify } from '../../app/toasts';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { canRedo, canUndo, createHistory, pushEdit, redo, undo, type History } from './editorHistory';
import { errorMessage } from './helpers';
import { signagePaths } from './paths';
import { useNow, usePreviewData } from './preview';
import { sceneQuery } from './queries';
import { aspectLabel, sameRatio, sceneGridSize } from './render/aspect';
import { toDraft, type Draft } from './sceneDraft';
import { LIMITS, sceneMachineIds, type WidgetType } from './widgets';
import type { BlockAction } from './editor/BlockToolbar';
import { BlocksList } from './editor/BlocksList';
import {
  addBlock,
  deleteBlocks,
  duplicateBlocks,
  nudge,
  orderBlock,
  splitBlock,
  updateBlocks,
  type ArrangeAction,
} from './editor/blockOps';
import { runArrange } from './editor/arrangeActions';
import { Canvas, type Zoom } from './editor/Canvas';
import { isInlineText } from './editor/canvasModel';
import { Palette } from './editor/Palette';
import { PreviewModal } from './editor/PreviewModal';
import { PropertiesPanel } from './editor/PropertiesPanel';
import { PublishModal } from './editor/PublishModal';
import { usePublishTargets } from './editor/publishTargets';
import { useAutosave, type SaveStatus } from './editor/useAutosave';
import { KEYS, useEditorKeys, type EditorKeyAction } from './editor/useEditorKeys';

export function SceneEditorPage() {
  const { sceneId = '' } = useParams();
  const query = useQuery(sceneQuery(sceneId));
  const crumbs = [{ label: 'Signage' }, { label: 'Screens', to: signagePaths.content() }];
  if (query.isPending)
    return (
      <PageShell title="Screen" width="fluid" breadcrumbs={crumbs}>
        <FullPageLoading label="Loading screen" />
      </PageShell>
    );
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Screen not found' : 'Screen'} width="fluid" breadcrumbs={crumbs}>
        {missing ? (
          <EmptyState title="This screen does not exist" description="It may have been deleted." />
        ) : (
          <ErrorState
            message={errorMessage(query.error, 'The screen could not be loaded.')}
            onRetry={() => void query.refetch()}
          />
        )}
      </PageShell>
    );
  }
  return <Editor key={query.data.id} scene={query.data} />;
}

const ZOOMS: { zoom: Zoom; label: string }[] = [
  { zoom: 'fit', label: 'Fit' },
  { zoom: 0.5, label: '50 %' },
  { zoom: 1, label: '100 %' },
];

function Editor({ scene }: { scene: SignageScene }) {
  const navigate = useNavigate();
  const notify = useNotify();
  const user = useCurrentUser();
  const canEdit = hasPermission(user, PermissionId.signagecontentmanage);
  const canPublish = hasPermission(user, PermissionId.signagepublish);

  const [history, setHistory] = useState<History<Draft>>(() => createHistory(toDraft(scene)));
  const [selection, setSelection] = useState<string[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragType, setDragType] = useState<WidgetType | null>(null);
  const [snapping, setSnapping] = useState(true);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [showMargins, setShowMargins] = useState(false);
  const [overflowKey, setOverflowKey] = useState('');
  const [dialog, setDialog] = useState<'preview' | 'publish' | null>(null);

  const draft = history.present;
  const blocks = draft.blocks;
  const grid = sceneGridSize(draft.aspectRatio);
  const selectedIds = selection.filter((id) => blocks.some((b) => b.id === id));
  const single = selectedIds.length === 1 ? blocks.find((b) => b.id === selectedIds[0])! : null;
  const overflowIds: ReadonlySet<string> = new Set(overflowKey ? overflowKey.split('\n') : []);

  /** Every change of the draft: one undo step, or part of the last one when `coalesceKey` repeats shortly after. */
  const apply = useLatestCallback((next: Draft, coalesceKey?: string) => {
    if (!canEdit) return;
    const now = Date.now();
    setHistory((current) => pushEdit(current, next, coalesceKey ?? null, now));
  });
  const applyBlocks = (next: SignageBlock[], coalesceKey?: string) => {
    if (next !== blocks) apply({ ...draft, blocks: next }, coalesceKey);
  };
  const select = useLatestCallback((ids: string[]) => {
    setSelection(ids);
    if (editingId && !ids.includes(editingId)) setEditingId(null);
  });
  const onOverflow = useLatestCallback((ids: string[]) => setOverflowKey(ids.join('\n')));

  const autosave = useAutosave({
    scene,
    draft,
    enabled: canEdit,
    onReplace: (fresh) => {
      setHistory(createHistory(toDraft(fresh)));
      setEditingId(null);
    },
  });
  const failed = ['error', 'conflict', 'invalid'].includes(autosave.status.kind);
  const unsaved = useUnsavedChanges({ isDirty: autosave.unsaved });
  const { saveNow } = autosave;
  // Leaving while a save is only pending saves first and then leaves; a failed save asks.
  const leaving = unsaved.dialogOpen && !failed;
  const { confirmDiscard } = unsaved;
  useEffect(() => {
    if (!leaving) return;
    let active = true;
    void saveNow().then((ok) => {
      if (ok && active) confirmDiscard();
    });
    return () => {
      active = false;
    };
  }, [leaving, saveNow, confirmDiscard]);

  const { targets, loading: targetsLoading } = usePublishTargets(scene.id);
  const now = useNow(1000);
  const data = usePreviewData('first', { now, referencedMachineIds: sceneMachineIds(blocks) });

  const add = (type: WidgetType, at?: { x: number; y: number } | { intoBlockId: string }) => {
    const into =
      at ?? (single && single.widget.type === 'empty' && !single.locked ? { intoBlockId: single.id } : undefined);
    const result = addBlock(blocks, type, grid, into);
    if (!result.id) {
      notify({ kind: 'warning', title: `A screen holds at most ${LIMITS.blocks} blocks.` });
      return;
    }
    applyBlocks(result.blocks);
    select([result.id]);
  };

  const blockAction = (action: BlockAction) => {
    if (!single) return;
    const id = single.id;
    if (action === 'unlock') applyBlocks(updateBlocks(blocks, [id], (b) => ({ ...b, locked: false })));
    else if (action === 'splitV' || action === 'splitH') {
      const result = splitBlock(blocks, id, action === 'splitV' ? 'vertical' : 'horizontal');
      if (!result.newId) {
        notify({ kind: 'info', title: 'This block is too small to split.' });
        return;
      }
      applyBlocks(result.blocks);
      select([result.newId]);
    } else if (action === 'dup') {
      const result = duplicateBlocks(blocks, [id]);
      applyBlocks(result.blocks);
      if (result.newIds.length) select(result.newIds);
    } else if (action === 'del') {
      applyBlocks(deleteBlocks(blocks, [id]));
      select([]);
    } else applyBlocks(orderBlock(blocks, id, action));
  };

  const arrangeAction = (action: ArrangeAction) =>
    runArrange(draft, selectedIds, action, { rel: 'selection' }, apply, select);

  const commitText = (id: string, html: string) => {
    setEditingId(null);
    applyBlocks(
      updateBlocks(blocks, [id], (b) =>
        b.widget.type === 'text' && b.widget.text !== html ? { ...b, widget: { ...b.widget, text: html } } : b,
      ),
    );
  };

  const doUndo = () => {
    setEditingId(null);
    setHistory((current) => undo(current));
  };
  const doRedo = () => {
    setEditingId(null);
    setHistory((current) => redo(current));
  };

  useEditorKeys(true, (action: EditorKeyAction) => {
    switch (action.kind) {
      case 'undo':
        if (!canEdit) return false;
        doUndo();
        return true;
      case 'redo':
        if (!canEdit) return false;
        doRedo();
        return true;
      case 'selectAll':
        select(blocks.filter((b) => !b.hidden && !b.locked).map((b) => b.id));
        return true;
      case 'escape':
        if (editingId) setEditingId(null);
        else if (selectedIds.length) select([]);
        else return false;
        return true;
      default:
        break;
    }
    if (!canEdit || selectedIds.length === 0) return false;
    switch (action.kind) {
      case 'delete':
        applyBlocks(deleteBlocks(blocks, selectedIds));
        select([]);
        return true;
      case 'duplicate': {
        const result = duplicateBlocks(blocks, selectedIds);
        applyBlocks(result.blocks);
        if (result.newIds.length) select(result.newIds);
        return true;
      }
      case 'order':
        if (single) applyBlocks(orderBlock(blocks, single.id, action.step));
        return true;
      case 'nudge':
        applyBlocks(nudge(blocks, selectedIds, action.dx, action.dy), 'nudge');
        return true;
      case 'editText':
        if (!single || single.locked || !isInlineText(single)) return false;
        setEditingId(single.id);
        return true;
    }
  });

  const shownOn = targets.map((target) => ({
    id: target.id,
    name: target.name,
    detail: target.detail,
    aspectLabel: aspectLabel(target.aspectRatio),
    sameShape: sameRatio(target.aspectRatio, draft.aspectRatio),
  }));

  return (
    <div className="sg-se">
      <header className="sg-se__bar">
        <IconButton
          label="Back to screens"
          kind="ghost"
          size="md"
          align="bottom-start"
          onClick={() => void navigate(signagePaths.content())}
        >
          <ArrowLeft />
        </IconButton>
        <h1 className="sg-se__title" title={draft.name}>
          {draft.name.trim() || 'Untitled screen'}
        </h1>
        <div className="sg-se__spacer" />
        {canEdit ? (
          <SaveState status={autosave.status} onRetry={autosave.retry} />
        ) : (
          <span className="sg-se__state">Read only</span>
        )}
        {canEdit && (
          <>
            <IconButton
              label={`Undo (${KEYS.mod}Z)`}
              kind="ghost"
              size="md"
              align="bottom"
              disabled={!canUndo(history)}
              onClick={doUndo}
            >
              <Undo />
            </IconButton>
            <IconButton
              label={`Redo (${KEYS.shift}${KEYS.mod}Z)`}
              kind="ghost"
              size="md"
              align="bottom"
              disabled={!canRedo(history)}
              onClick={doRedo}
            >
              <Redo />
            </IconButton>
          </>
        )}
        <Button kind="ghost" size="md" renderIcon={View} onClick={() => setDialog('preview')}>
          Preview
        </Button>
        {canPublish && (
          <Button kind="primary" size="md" renderIcon={Send} onClick={() => setDialog('publish')}>
            Publish
          </Button>
        )}
      </header>
      {autosave.status.kind === 'conflict' && (
        <div className="sg-se__notice">
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="This screen was changed somewhere else"
            subtitle={
              autosave.status.message ??
              'Your latest edits are not saved yet. Load the latest version, or keep your changes and overwrite it.'
            }
          />
          <div className="sg-conflict-actions">
            <Button size="sm" kind="tertiary" onClick={() => void autosave.loadLatest()}>
              Load latest
            </Button>
            <Button size="sm" kind="primary" onClick={() => void autosave.keepMine()}>
              Keep my changes
            </Button>
          </div>
        </div>
      )}
      {autosave.status.kind === 'error' && (
        <div className="sg-se__notice">
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Couldn't save"
            subtitle={autosave.status.message}
          />
        </div>
      )}
      {autosave.status.kind === 'invalid' && (
        <div className="sg-se__notice">
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Not saved yet"
            subtitle={autosave.status.message}
          />
        </div>
      )}
      <div className="sg-se__work">
        <div className="sg-se__left">
          {canEdit && <Palette disabled={!canEdit} onAdd={(type) => add(type)} onDragType={setDragType} />}
          <BlocksList
            blocks={blocks}
            selectedIds={selectedIds}
            overflowIds={overflowIds}
            canEdit={canEdit}
            onSelect={select}
            onBlocks={(next) => applyBlocks(next)}
            onHover={setHoverId}
          />
        </div>
        <section className="sg-se__centre" aria-label="Screen">
          <Canvas
            draft={draft}
            data={data}
            selectedIds={selectedIds}
            hoverId={hoverId}
            onHover={setHoverId}
            onSelect={select}
            onBlocks={(next) => applyBlocks(next)}
            canEdit={canEdit}
            snapping={snapping}
            zoom={zoom}
            showMargins={showMargins}
            overflowIds={overflowIds}
            onOverflow={onOverflow}
            editingId={editingId}
            onEditText={setEditingId}
            onCommitText={commitText}
            dragType={dragType}
            onDropWidget={(type, at) => {
              setDragType(null);
              add(type, at);
            }}
            onQuickPick={(id, type) => add(type, { intoBlockId: id })}
            onBlockAction={blockAction}
            onArrange={arrangeAction}
          />
          <footer className="sg-se__foot">
            <div className="sg-se__spacer" />
            <Toggle
              id="sg-show-margins"
              size="sm"
              labelText="Margins"
              hideLabel
              labelA="Margins"
              labelB="Margins"
              toggled={showMargins}
              onToggle={setShowMargins}
            />
            <ContentSwitcher
              size="sm"
              className="sg-se__zoom"
              selectedIndex={ZOOMS.findIndex((item) => item.zoom === zoom)}
              onChange={({ index }) => setZoom(ZOOMS[index ?? 0].zoom)}
            >
              {ZOOMS.map((item) => (
                <Switch key={item.label} name={item.label} text={item.label} />
              ))}
            </ContentSwitcher>
          </footer>
        </section>
        <div className="sg-se__right">
          <PropertiesPanel
            draft={draft}
            selectedIds={selectedIds}
            canEdit={canEdit}
            onChange={apply}
            onSelect={select}
            overflowIds={overflowIds}
            shownOn={shownOn}
            snapping={snapping}
            onSnappingChange={setSnapping}
          />
        </div>
      </div>
      {dialog === 'preview' && (
        <PreviewModal
          draft={draft}
          shapes={targets.map((target) => ({ id: target.id, name: target.name, aspectRatio: target.aspectRatio }))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'publish' && (
        <PublishModal
          sceneName={draft.name}
          targets={targets}
          loading={targetsLoading}
          overflowCount={overflowIds.size}
          saveFirst={saveNow}
          onClose={() => setDialog(null)}
        />
      )}
      <UnsavedChangesDialog
        guard={{ ...unsaved, dialogOpen: unsaved.dialogOpen && failed }}
        title="Leave without saving?"
        message="Your latest edits to this screen could not be saved."
        confirmLabel="Leave"
      />
    </div>
  );
}

function SaveState({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  switch (status.kind) {
    case 'saved':
      return (
        <span className="sg-se__state" role="status">
          <Checkmark aria-hidden="true" /> Draft saved
        </span>
      );
    case 'pending':
    case 'saving':
      return <InlineLoading className="sg-se__state" description="Saving…" />;
    case 'invalid':
      return (
        <span className="sg-se__state sg-se__state--warning" role="status">
          <WarningFilled aria-hidden="true" /> Not saved
        </span>
      );
    case 'error':
      return (
        <span className="sg-se__state sg-se__state--error" role="status">
          <WarningFilled aria-hidden="true" /> Couldn't save
          <Button kind="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </span>
      );
    case 'conflict':
      return (
        <span className="sg-se__state sg-se__state--error" role="status">
          <WarningFilled aria-hidden="true" /> Changed elsewhere
        </span>
      );
  }
}
