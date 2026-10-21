import { Button, InlineNotification, Stack } from '@carbon/react';
import type { Material } from '../../../api/generated/models';
import { ArticleFields } from './ArticleFields';

/** Inline fields of a new filament article, rendered inside a form whose values include `article`. */
export function NewFilamentArticle({
  idPrefix,
  created,
  onUseExisting,
}: {
  idPrefix: string;
  created: Material | null;
  onUseExisting: () => void;
}) {
  return (
    <Stack gap={6}>
      {created ? (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title="Filament article created"
          subtitle={`${created.name} exists now. Save again to finish filling the spool with it.`}
        />
      ) : (
        <>
          <p className="mj-secondary">
            The new article is created when you save, and the filament is booked as a purchase.
          </p>
          <ArticleFields kind="filament" idPrefix={idPrefix} />
          <Button kind="ghost" size="sm" onClick={onUseExisting}>
            Use an existing filament
          </Button>
        </>
      )}
    </Stack>
  );
}
