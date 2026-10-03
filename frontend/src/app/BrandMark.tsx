import { useBranding } from '../features/branding/branding';

type BrandMarkProps = {
  className?: string;
  kind?: 'logo' | 'compact';
};

export function BrandMark({ className, kind = 'compact' }: BrandMarkProps) {
  const branding = useBranding();
  const source = kind === 'logo' ? branding.assets.logoUrl : branding.assets.compactLogoUrl;
  if (!source) return null;

  return (
    <img
      aria-hidden="true"
      className={['brand-mark', className].filter(Boolean).join(' ')}
      src={source}
      alt=""
      width={460}
      height={512}
    />
  );
}
