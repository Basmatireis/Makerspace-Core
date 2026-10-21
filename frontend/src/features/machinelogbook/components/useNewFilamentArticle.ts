import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createMaterial, getMaterial } from '../../../api/generated/inventory/inventory';
import type { Material } from '../../../api/generated/models';
import { articleBody, type ArticleValues } from './ArticleFields';

/**
 * Creates the filament article of a "fill with new filament" flow. The article is created once: when the fill that
 * follows fails, a retry reuses the created article instead of creating a duplicate.
 */
export function useNewFilamentArticle() {
  const [created, setCreated] = useState<Material | null>(null);
  const create = useMutation({
    mutationFn: (values: ArticleValues) => createMaterial(articleBody(values, 'filament')),
  });
  const ensure = async (values: ArticleValues) => {
    if (created) {
      // A failed attempt may have raced with other stock changes, so a retry works with the current version.
      const current = await getMaterial(created.id);
      setCreated(current);
      return current;
    }
    const article = await create.mutateAsync(values);
    setCreated(article);
    return article;
  };
  const reset = () => {
    setCreated(null);
    create.reset();
  };
  return { created, ensure, reset };
}
