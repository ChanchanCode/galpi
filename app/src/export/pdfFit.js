// For a small overflow only, find the largest font that keeps one original page
// and its translation together. The callback measures the entire page in Chromium.
// Line-height ratio, paragraph spacing and all margins stay at their selected values.
export function choosePdfPageFont(settings, fits) {
  const requested = settings.fontSize;
  if (!settings.fitSmallOverflow || fits(requested)) return requested;
  const minimum = Math.max(8, Math.ceil(requested * 0.9 * 10 - 1e-7) / 10);
  if (minimum >= requested || !fits(minimum)) return requested;
  let low = Math.round(minimum * 10);
  let high = Math.floor(requested * 10);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid / 10)) low = mid;
    else high = mid - 1;
  }
  return low / 10;
}
