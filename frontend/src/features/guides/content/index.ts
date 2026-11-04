import type { GuideDefinition } from '../types';
import { welcome } from './welcome';

/** Every guide of the app. Loaded lazily (see `registry.ts`); the areas' own files add their guides here. */
export const guides: GuideDefinition[] = [welcome];
