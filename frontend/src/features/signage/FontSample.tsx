import { useEffect } from 'react';
import type { SignageAsset } from '../../api/generated/models';
import { assetContentUrl } from './preview';
import { cssString, registerFontFaces } from './render/style';

/**
 * A sample of an uploaded font. The font is registered under its asset name, exactly as scenes do, so what the sample
 * shows is what `font-family: "<name>"` gives in a widget's CSS.
 */
export function FontSample({
  asset,
  text,
  className,
}: {
  asset: Pick<SignageAsset, 'id' | 'name' | 'sha256'>;
  text: string;
  className?: string;
}) {
  const url = assetContentUrl(asset.id, asset.sha256);
  useEffect(() => {
    registerFontFaces([{ family: asset.name, url }]);
  }, [asset.name, url]);
  return (
    <span className={className} style={{ fontFamily: `${cssString(asset.name)}, sans-serif` }}>
      {text}
    </span>
  );
}
