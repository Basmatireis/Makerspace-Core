import type {
  BrandingAssetSlot,
  BrandingConfiguration,
  UpdateBrandingConfigurationRequest,
} from '../../api/generated/models';
import { ApiError } from '../../api/http-client';

/** The request body plus the greetings as the one-per-line text the editor works with. */
export type FormValues = Omit<UpdateBrandingConfigurationRequest, 'expectedVersion'> & { greetingsText: string };

export const MAX_GREETINGS = 50;
export const MAX_GREETING_LENGTH = 120;

/** One greeting per line; blank lines are dropped. */
export function parseGreetings(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function greetingsError(text: string): string | true {
  const lines = parseGreetings(text);
  if (lines.length > MAX_GREETINGS) return `Use at most ${MAX_GREETINGS} greetings.`;
  const index = lines.findIndex((line) => line.length > MAX_GREETING_LENGTH);
  return index < 0 || `Greeting ${index + 1} is longer than ${MAX_GREETING_LENGTH} characters.`;
}

/** The body of the update request: the form values without the editor-only text. */
export function toUpdateInput(values: FormValues): Omit<UpdateBrandingConfigurationRequest, 'expectedVersion'> {
  const { greetingsText, ...input } = values;
  return { ...input, identity: { ...input.identity, funGreetings: parseGreetings(greetingsText) } };
}

export const hexPattern = /^#[0-9a-fA-F]{6}$/;

export const adminQueryKey = ['branding', 'configuration'] as const;

export const assets: ReadonlyArray<{
  key: keyof BrandingConfiguration['assets'];
  slot: BrandingAssetSlot;
  title: string;
  guidance: string;
  accept: string[];
  maxBytes: number;
}> = [
  {
    key: 'logo',
    slot: 'logo',
    title: 'Logo',
    guidance: 'Full organization logo. PNG, WebP, or safe SVG; up to 2 MiB.',
    accept: ['image/png', 'image/webp', 'image/svg+xml'],
    maxBytes: 2 << 20,
  },
  {
    key: 'compactLogo',
    slot: 'compact_logo',
    title: 'Compact logo',
    guidance: 'Symbol used in constrained navigation. PNG, WebP, or safe SVG; up to 2 MiB.',
    accept: ['image/png', 'image/webp', 'image/svg+xml'],
    maxBytes: 2 << 20,
  },
  {
    key: 'favicon',
    slot: 'favicon',
    title: 'Favicon',
    guidance: 'Square browser icon. PNG, WebP, or safe SVG; up to 2 MiB.',
    accept: ['image/png', 'image/webp', 'image/svg+xml'],
    maxBytes: 2 << 20,
  },
  {
    key: 'applicationBackground',
    slot: 'application_background',
    title: 'Application background',
    guidance: 'Authenticated application backdrop. PNG, WebP, JPEG, or safe SVG; up to 8 MiB.',
    accept: ['image/png', 'image/webp', 'image/jpeg', 'image/svg+xml'],
    maxBytes: 8 << 20,
  },
  {
    key: 'authenticationBackground',
    slot: 'authentication_background',
    title: 'Authentication background',
    guidance: 'Sign-in and public page backdrop. PNG, WebP, JPEG, or safe SVG; up to 8 MiB.',
    accept: ['image/png', 'image/webp', 'image/jpeg', 'image/svg+xml'],
    maxBytes: 8 << 20,
  },
];

export function toFormValues(configuration: BrandingConfiguration): FormValues {
  return {
    identity: configuration.identity,
    colors: configuration.colors,
    imprint: configuration.imprint,
    privacy: configuration.privacy,
    greetingsText: configuration.identity.funGreetings.join('\n'),
  };
}

function hexLuminance(value: string): number | null {
  if (!hexPattern.test(value)) return null;
  const channels = [1, 3, 5]
    .map((start) => Number.parseInt(value.slice(start, start + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrastRatio(a: string, b: string): number | null {
  const one = hexLuminance(a);
  const two = hexLuminance(b);
  if (one === null || two === null) return null;
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

export function mutationMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409)
    return 'The configuration changed in another session. Reload it before saving again.';
  return 'The change was not saved. Review the values and try again.';
}
