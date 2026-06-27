// 갈피 앱 마크 — 인라인 SVG(앱 아이콘과 동일: 종이색 라운드 사각 + 클레이 책갈피).
// 브랜드 색이라 테마와 무관하게 고정.
export function GalpiMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" className="galpi-mark" aria-hidden="true">
      <rect x="84" y="84" width="856" height="856" rx="196" fill="#f1e7cf" />
      <rect x="84" y="84" width="856" height="856" rx="196" fill="none" stroke="#2b2622" strokeOpacity="0.07" strokeWidth="4" />
      <path d="M426 275 H598 A44 44 0 0 1 642 319 V745 L512 659 L382 745 V319 A44 44 0 0 1 426 275 Z" fill="#d2674a" />
      <path d="M512 659 L642 745 V319 A44 44 0 0 0 598 275 H512 Z" fill="#bf4e36" fillOpacity="0.85" />
      <rect x="382" y="392" width="260" height="30" fill="#f1e7cf" />
      <rect x="382" y="470" width="260" height="30" fill="#f1e7cf" />
    </svg>
  );
}
