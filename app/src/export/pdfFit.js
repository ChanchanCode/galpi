// Choose the least adjustment that fits one source page. The browser supplies
// a measurement callback; stored defaults are never changed by this calculation.
export function choosePdfFit(settings, fits) {
  const base = {
    fontSize: settings.fontSize, lineHeight: settings.lineHeight,
    paddingTop: settings.paddingTop, paddingBottom: settings.paddingBottom,
    paddingHorizontal: settings.paddingHorizontal,
  };
  if (fits(base)) return { ...base, stage: "none" };
  const minScale = Math.min(8 / base.fontSize, 1.2 / base.lineHeight);
  const typographyAt = (scale) => ({ ...base,
    fontSize: Math.max(8, base.fontSize * scale),
    lineHeight: Math.max(1.2, base.lineHeight * scale),
  });
  const minimum = typographyAt(minScale);
  // Binary search finds the largest typography or padding that still fits.
  const largestFit = (low, high, profile) => {
    for (let i = 0; i < 12; i++) {
      const mid = (low + high) / 2;
      if (fits(profile(mid))) low = mid;
      else high = mid;
    }
    return profile(low);
  };
  if (fits(minimum)) return { ...largestFit(minScale, 1, typographyAt), stage: "typography" };
  const paddingAt = (scale) => ({ ...minimum,
    paddingTop: base.paddingTop * scale,
    paddingBottom: base.paddingBottom * scale,
    paddingHorizontal: base.paddingHorizontal * scale,
  });
  const noPadding = paddingAt(0);
  if (fits(noPadding)) return { ...largestFit(0, 1, paddingAt), stage: "padding" };
  return { ...noPadding, stage: "overflow" };
}
