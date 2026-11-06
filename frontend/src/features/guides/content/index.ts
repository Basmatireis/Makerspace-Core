import type { GuideDefinition } from '../types';
import { openDaysGuides } from './openDays';
import { salesGuides } from './sales';
import { staffingGuides } from './staffing';
import { welcome } from './welcome';
import { workshopGuides } from './workshop';

/** Every guide of the app. Loaded lazily (see `registry.ts`); the areas' own files add their guides here. */
export const guides: GuideDefinition[] = [
  welcome,
  ...workshopGuides,
  ...salesGuides,
  ...openDaysGuides,
  ...staffingGuides,
];
