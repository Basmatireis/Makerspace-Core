type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <img
      aria-hidden="true"
      className={['brand-mark', className].filter(Boolean).join(' ')}
      src="/brand/htumkr-symbol.png"
      alt=""
      width={460}
      height={512}
    />
  );
}
