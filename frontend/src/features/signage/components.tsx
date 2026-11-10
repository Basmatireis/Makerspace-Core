import { useState, type ReactNode } from 'react';
import {
  CodeSnippet,
  ComboBox,
  Link as CarbonLink,
  ListItem,
  Modal,
  Select,
  SelectItem,
  Stack,
  UnorderedList,
} from '@carbon/react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { SignageAsset } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import {
  errorMessage,
  inUseReferences,
  playerAddress,
  referenceHref,
  referenceLabel,
  type SignageReference,
} from './helpers';
import { usePreviewData } from './preview';
import { signageKeys } from './queries';
import { SceneRenderer, ScreenFrame } from './render/SceneRenderer';
import type { RenderScene } from './render/types';

/** The player address as a copyable inline snippet. */
export function PlayerAddress() {
  return (
    <CodeSnippet type="inline" feedback="Copied">
      {playerAddress()}
    </CodeSnippet>
  );
}

/** Loading and error states of one query; renders its children once data exists. */
export function QueryBoundary({
  query,
  label,
  children,
}: {
  query: Pick<UseQueryResult, 'isPending' | 'isError' | 'error' | 'refetch'>;
  label: string;
  children: ReactNode;
}) {
  if (query.isPending) return <InlineLoadingState label={`Loading ${label}`} />;
  if (query.isError)
    return (
      <ErrorState
        message={errorMessage(query.error, `The ${label} could not be loaded.`)}
        onRetry={() => void query.refetch()}
      />
    );
  return <>{children}</>;
}

// Thumbnails share one clock so they do not re-render every second.
const THUMBNAIL_NOW = Date.now();

/** Small static rendering of a scene (as displays show it) for cards and scene list rows. */
export function SceneThumbnail({ scene, className }: { scene: RenderScene; className?: string }) {
  const data = usePreviewData('announcement', { now: THUMBNAIL_NOW, still: true });
  return (
    <ScreenFrame aspectRatio={scene.aspectRatio} className={`sg-thumb${className ? ` ${className}` : ''}`}>
      <SceneRenderer scene={scene} data={data} />
    </ScreenFrame>
  );
}

export function AssetPicker({
  id,
  label,
  kind,
  assets,
  value,
  onChange,
  disabledHint,
}: {
  id: string;
  label: string;
  kind: 'image' | 'video' | 'font';
  assets: readonly SignageAsset[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabledHint?: string;
}) {
  const items = assets.filter((item) => item.kind === kind);
  const selected = items.find((item) => item.id === value) ?? null;
  return (
    <ComboBox<SignageAsset>
      autoAlign
      id={id}
      titleText={label}
      placeholder={`Choose ${kind === 'image' ? 'an image' : kind === 'video' ? 'a video' : 'a font'} from Media`}
      items={items}
      itemToString={(item) => item?.name ?? ''}
      selectedItem={selected}
      helperText={value && !selected ? 'This media no longer exists. Choose another.' : disabledHint}
      invalid={Boolean(value) && !selected}
      invalidText="This media no longer exists. Choose another."
      onChange={({ selectedItem }) => onChange(selectedItem?.id ?? null)}
    />
  );
}

export function FitField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: 'contain' | 'cover';
  onChange: (fit: 'contain' | 'cover') => void;
}) {
  return (
    <Select
      id={id}
      labelText="Fit"
      value={value}
      onChange={(event) => onChange(event.target.value as 'contain' | 'cover')}
    >
      <SelectItem value="cover" text="Cover (crop to fill)" />
      <SelectItem value="contain" text="Contain (show everything)" />
    </Select>
  );
}

/** The things that block a delete (409 `signage_in_use`), linked where a page exists. */
export function ReferenceList({ references, onNavigate }: { references: SignageReference[]; onNavigate?: () => void }) {
  return (
    <UnorderedList>
      {references.map((reference) => {
        const href = referenceHref(reference);
        return (
          <ListItem key={`${reference.kind}-${reference.id}`}>
            {href ? (
              <CarbonLink as={Link} to={href} onClick={onNavigate}>
                {reference.name}
              </CarbonLink>
            ) : (
              reference.name
            )}
            <span className="sg-secondary"> · {referenceLabel(reference)}</span>
          </ListItem>
        );
      })}
    </UnorderedList>
  );
}

/** Explains that something is still referenced and lists the references. */
export function InUseDialog({
  title,
  label,
  references,
  onClose,
}: {
  title: string;
  label: string;
  references: SignageReference[];
  onClose: () => void;
}) {
  return (
    <Modal open passiveModal size="sm" modalHeading={title} modalLabel={label} onRequestClose={onClose}>
      <Stack gap={5}>
        <p>Remove these references first, then delete it.</p>
        {references.length > 0 ? (
          <ReferenceList references={references} onNavigate={onClose} />
        ) : (
          <p className="sg-secondary">The server did not name the references.</p>
        )}
      </Stack>
    </Modal>
  );
}

/**
 * Confirms a delete, runs it, and explains a 409 `signage_in_use` by listing the references instead of showing a bare error.
 * `remove` quotes the entity's `expectedVersion` where the API wants one.
 */
export function DeleteDialog({
  title,
  noun,
  confirmLabel,
  children,
  remove,
  onDeleted,
  onClose,
}: {
  title: string;
  /** Capitalised thing being deleted, e.g. "Scene"; labels the blocked dialog. */
  noun: string;
  confirmLabel: string;
  children: ReactNode;
  remove: () => Promise<unknown>;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [references, setReferences] = useState<SignageReference[] | null>(null);
  const mutation = useMutation({
    mutationFn: remove,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.all });
      onDeleted();
    },
    onError: (error) => {
      const found = inUseReferences(error);
      if (found) setReferences(found);
    },
  });
  if (references)
    return (
      <InUseDialog
        title={`${noun} is still in use`}
        label={`Delete ${noun.toLowerCase()}`}
        references={references}
        onClose={onClose}
      />
    );
  return (
    <DestructiveActionDialog
      open
      title={title}
      fate="permanent"
      confirmLabel={confirmLabel}
      pending={mutation.isPending}
      error={mutation.isError && !inUseReferences(mutation.error) ? errorMessage(mutation.error) : undefined}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    >
      {children}
    </DestructiveActionDialog>
  );
}
