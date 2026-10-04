import { useEffect, useMemo, useRef, useState } from "react";
import type { PaperDocument } from "../types";
import type { PageMerge } from "../render/pagemerge";
import type { TrSource } from "../translate/trBlocks";
import type { TrEntry } from "../translate/useTranslation";
import type { Typography } from "../store/typography";
import { fontFamilyName, useStore } from "../store/useStore";
import { buildPdfPreview, pdfFontCss } from "./pdfDocument";
import { DEFAULT_PDF_SETTINGS, normalizePdfSettings, pdfGeometry, type PdfExportSettings } from "./pdfLayout";
import "./pdfExport.css";

function PdfControl({ label, value, min, max, step = 1, unit, disabled, note, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit: string;
  disabled: boolean; note?: string; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (raw: number) => {
    const next = Number(Math.min(max, Math.max(min, Math.round(raw / step) * step)).toFixed(3));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return <div className="pdf-export-control">
    <div className="pdf-export-control-label"><span>{label}</span><div className="pdf-export-number">
      <input aria-label={`${label} 값`} type="number" min={min} max={max} step={step} value={draft} disabled={disabled}
        onChange={(e) => setDraft(e.target.value)} onBlur={() => draft.trim() && Number.isFinite(Number(draft)) ? commit(Number(draft)) : setDraft(String(value))}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /><span>{unit}</span>
    </div></div>
    <div className="pdf-export-range">
      <button aria-label={`${label} 줄이기`} disabled={disabled || value <= min} onClick={() => commit(value - step)}>−</button>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => commit(Number(e.target.value))} />
      <button aria-label={`${label} 늘리기`} disabled={disabled || value >= max} onClick={() => commit(value + step)}>＋</button>
    </div>
    {note && <p className="pdf-export-hint">{note}</p>}
  </div>;
}

interface Props {
  doc: PaperDocument; blocks: TrSource[]; entries: Map<string, TrEntry>; merge: PageMerge;
  typography: Typography; translationWidth: number; extracting: boolean;
  onClose: () => void; onSaved: () => void; onHtml: () => void;
}

export function PdfExportDialog({ doc, blocks, entries, merge, typography, extracting,
  onClose, onSaved, onHtml }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const userFonts = useStore((s) => s.userFonts);
  const [settings, setSettings] = useState<PdfExportSettings>(() => normalizePdfSettings({}));
  const [snapshot, setSnapshot] = useState<Map<string, TrEntry> | null>(null);
  const [previewSettings, setPreviewSettings] = useState(settings);
  const [css, setCss] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pageMap, setPageMap] = useState<number[]>([]);
  const [pageParts, setPageParts] = useState<number[]>([]);
  const [pageFontSizes, setPageFontSizes] = useState<number[]>([]);
  const [readyToken, setReadyToken] = useState("");
  const [page, setPage] = useState(1);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [zoom, setZoom] = useState("fit");
  const initialEntries = useRef(entries);
  const dirty = useRef(false);
  const anchor = useRef({ source: doc.pages[0]?.index ?? 1, part: 1 });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const inheritedFont = typography.trFontLinked ? typography.fontFamily : typography.trFontFamily;
  const fonts = [
    { label: "현재 읽기 글꼴", value: "" },
    { label: "고딕 · 시스템", value: '"Apple SD Gothic Neo", "Malgun Gothic", sans-serif' },
    { label: "명조 · 시스템", value: '"AppleMyungjo", "Batang", serif' },
    ...userFonts.map((f) => ({ label: f.name, value: `"${fontFamilyName(f.name)}"` })),
  ];
  if (!fonts.some((f) => f.value === settings.fontFamily)) fonts.push({ label: "저장한 글꼴", value: settings.fontFamily });

  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { focus?.focus(); };
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      window.paperAPI.loadSettings(), window.paperAPI.loadState(doc.doc_id),
      window.paperAPI.cachedTranslations(doc.doc_id, blocks.map((b) => ({ id: b.id, text: b.text }))), pdfFontCss(),
    ]).then(([global, state, cached, fontsCss]) => {
      if (!alive) return;
      const defaults = (global as { pdfExport?: PdfExportSettings } | null)?.pdfExport;
      const prior = defaults ?? (state as { pdf_export?: PdfExportSettings } | null)?.pdf_export;
      if (!dirty.current) setSettings(normalizePdfSettings(prior ?? settingsRef.current));
      const complete = new Map<string, TrEntry>(Object.entries(cached));
      for (const [id, value] of initialEntries.current) complete.set(id, value);
      setCss(fontsCss);
      setSnapshot(complete);
    }).catch((e) => alive && setError(`미리보기 준비 실패: ${String(e)}`));
    return () => { alive = false; };
  }, [doc.doc_id, blocks]);

  useEffect(() => {
    const timer = setTimeout(() => setPreviewSettings(settings), 120);
    return () => clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => {
      void window.paperAPI.saveSettings({ pdfExport: settings })
        .then(() => setPersistenceError(null))
        .catch(() => setPersistenceError("내보내기 기본값을 저장하지 못했습니다."));
    }, 400);
    return () => clearTimeout(timer);
  }, [settings]);

  const preview = useMemo(() => {
    if (!snapshot) return null;
    const token = crypto.randomUUID();
    const html = buildPdfPreview({ doc, blocks, entries: snapshot, merge, settings: previewSettings,
      fontFamily: inheritedFont, css, token });
    return { token, html };
  }, [doc, blocks, snapshot, merge, previewSettings, inheritedFont, css]);
  const ready = !!preview && readyToken === preview.token && settings === previewSettings;
  const count = pageMap.length;
  const continuations = count - doc.pages.length;
  const currentFontSize = pageFontSizes[page - 1] ?? settings.fontSize;
  const fittedSources = new Set(pageMap.filter((_, i) => pageFontSizes[i] < settings.fontSize - 0.01)).size;
  const missing = snapshot ? blocks.filter((b) => !snapshot.get(b.id)?.ko.trim() && !snapshot.get(b.id)?.spans?.length).length : 0;
  const g = pdfGeometry(previewSettings);
  const widthPx = g.width * 4 / 3;
  const heightPx = g.height * 4 / 3;
  const widthScale = Math.max(0.1, (viewport.width - 48) / widthPx);
  const scale = zoom === "fit" ? Math.min(1, widthScale, Math.max(0.1, (viewport.height - 48) / heightPx))
    : zoom === "width" ? widthScale : Number(zoom) / 100;

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewport({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.data?.token !== preview?.token) return;
      if (event.data.type === "galpi:pdf-ready") {
        const map: number[] = event.data.pageMap;
        const parts: number[] = event.data.pageParts;
        setPageMap(map);
        setPageParts(parts);
        setPageFontSizes(event.data.pageFontSizes);
        setReadyToken(event.data.token);
        const first = map.indexOf(anchor.current.source);
        const last = map.lastIndexOf(anchor.current.source);
        setPage(first < 0 ? 1 : Math.min(last, first + anchor.current.part - 1) + 1);
        setError(null);
      } else if (event.data.type === "galpi:pdf-error") setError(event.data.error);
    };
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  }, [preview?.token]);

  useEffect(() => {
    if (!ready) return;
    const win = frameRef.current?.contentWindow;
    const sheet = frameRef.current?.contentDocument?.querySelectorAll<HTMLElement>(".pdf-sheet")[page - 1];
    if (win && sheet) win.scrollTo(0, sheet.offsetTop);
    anchor.current = { source: pageMap[page - 1], part: pageParts[page - 1] };
  }, [page, ready, pageMap, pageParts]);

  const change = (patch: Partial<PdfExportSettings>) => {
    dirty.current = true;
    setError(null);
    setSettings((prev) => normalizePdfSettings({ ...prev, ...patch }));
  };
  const persist = async () => {
    await window.paperAPI.saveSettings({ pdfExport: settingsRef.current });
    setPersistenceError(null);
  };
  const close = async () => {
    if (saving) return false;
    try {
      if (dirty.current) await persist();
      onClose();
      return true;
    } catch {
      setPersistenceError("내보내기 기본값을 저장하지 못했습니다. 다시 시도해 주세요.");
      return false;
    }
  };
  const save = async () => {
    const frameDoc = frameRef.current?.contentDocument;
    if (!ready || !frameDoc || saving || extracting) return;
    setSaving(true);
    setError(null);
    try {
      try { await persist(); }
      catch { setPersistenceError("내보내기 기본값을 저장하지 못했습니다. 다시 시도해 주세요."); return; }
      const clone = frameDoc.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script, .pdf-source img").forEach((el) => el.remove());
      const result = await window.paperAPI.exportPdf({ docId: doc.doc_id, settings,
        html: `<!doctype html>${clone.outerHTML}`, pageMap });
      if (result.error) setError(result.error);
      else if (result.path) { onSaved(); onClose(); }
    } catch (e) { setError(`PDF 저장 실패: ${String(e)}`); }
    finally { setSaving(false); }
  };
  const control = (key: keyof PdfExportSettings, label: string, min: number, max: number, unit: string, step = 1, note?: string) =>
    <PdfControl key={key} label={label} value={settings[key] as number} min={min} max={max} unit={unit} step={step}
      disabled={saving} note={note} onChange={(n) => change({ [key]: n })} />;

  return <div className="pdf-export-backdrop" onMouseDown={(e) => e.target === e.currentTarget && void close()}>
    <div className="pdf-export-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-export-title"
      ref={dialogRef} tabIndex={-1} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); void close(); }
        if (e.key === "Tab") {
          const controls = Array.from(dialogRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), iframe'));
          const first = controls[0]; const last = controls[controls.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="pdf-export-header">
        <div><h2 id="pdf-export-title">원문 + 번역 PDF 저장</h2><p>{doc.title ?? doc.doc_id}</p></div>
        <button aria-label="미리보기 닫기" onClick={() => void close()} disabled={saving}>×</button>
      </header>
      <div className="pdf-export-body">
        <aside className="pdf-export-controls" aria-label="PDF 배치 설정">
          <fieldset><legend>지면</legend>
            <label>용지<select aria-label="PDF 용지" value={settings.paper} disabled={saving}
              onChange={(e) => change({ paper: e.target.value as PdfExportSettings["paper"] })}>
              <option value="a3">A3 가로 · 420 × 297 mm</option><option value="a4">A4 가로 · 297 × 210 mm</option>
            </select></label>
            {control("translationPercent", "번역 칸 폭", 25, 65, "%", 1, `원문 ${100 - settings.translationPercent}% · 번역 ${settings.translationPercent}%`)}
            {control("outerMargin", "종이 바깥 여백", 4, 20, "mm")}
            {control("columnGap", "원문과 번역 사이", 2, 20, "mm")}
          </fieldset>
          <fieldset><legend>번역 글꼴</legend>
            <label>글꼴<select aria-label="번역 글꼴" value={settings.fontFamily} disabled={saving}
              onChange={(e) => change({ fontFamily: e.target.value })}>
              {fonts.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select></label>
            {control("fontSize", "번역 글자 크기", 8, 20, "pt", 0.5)}
            <label className="pdf-export-check"><input type="checkbox" aria-label="살짝 넘치는 쪽만 글자 크기 줄이기"
              checked={settings.fitSmallOverflow} disabled={saving}
              onChange={(e) => change({ fitSmallOverflow: e.target.checked })} />살짝 넘치는 쪽만 글자 크기 줄이기</label>
            <p className="pdf-export-hint">최대 10%만 줄입니다(최소 8pt). 줄간격 배율과 여백은 유지합니다.</p>
            {control("lineHeight", "번역 줄간격", 1.2, 2.6, "배", 0.05, `줄 높이 ${(settings.fontSize * settings.lineHeight).toFixed(1)} pt`)}
            {control("paragraphSpacing", "문단 간격", 0, 2, "em", 0.1)}
          </fieldset>
          <fieldset><legend>번역 칸 안쪽 여백</legend>
            {control("paddingTop", "번역 위 여백", 0, 40, "mm")}
            {control("paddingBottom", "번역 아래 여백", 0, 40, "mm")}
            {control("paddingHorizontal", "번역 좌우 여백", 0, 20, "mm", 1, "왼쪽과 오른쪽에 각각 적용")}
          </fieldset>
          <p className="pdf-export-hint">{settings.fitSmallOverflow
            ? "조금 넘치는 번역은 해당 쪽의 글자 크기로 맞춥니다. 크게 넘치는 번역은 같은 원문과 함께 다음 장에 이어집니다."
            : "긴 번역은 선택한 글자 크기 그대로 같은 원문과 함께 다음 장에 이어집니다."}</p>
          {missing > 0 && <p className="pdf-export-warning">미번역 {missing}개 문단은 표시만 남겨 저장합니다.</p>}
          {extracting && <p className="pdf-export-warning">원문 추출이 끝나면 PDF를 저장할 수 있습니다.</p>}
          <div className="pdf-export-control-actions">
            <button onClick={() => change(DEFAULT_PDF_SETTINGS)} disabled={saving}>기본 배치로 초기화</button>
            <button onClick={async () => { if (await close()) onHtml(); }} disabled={saving}>HTML로 내보내기</button>
          </div>
        </aside>
        <div className="pdf-export-preview-area">
          <div className="pdf-export-preview-toolbar">
            <div className="pdf-export-navigation">
              <button aria-label="이전 미리보기 페이지" disabled={!ready || page <= 1} onClick={() => setPage((n) => n - 1)}>←</button>
              <select aria-label="미리보기 페이지" value={ready ? page : ""} disabled={!ready} onChange={(e) => setPage(Number(e.target.value))}>
                {!ready && <option value="">설정 반영 중…</option>}
                {pageMap.map((source, i) => <option key={i} value={i + 1}>{i + 1} / {count} · 원문 {source}쪽{pageParts[i] > 1 ? ` · 이어짐 ${pageParts[i] - 1}` : ""}</option>)}
              </select>
              <button aria-label="다음 미리보기 페이지" disabled={!ready || page >= count} onClick={() => setPage((n) => n + 1)}>→</button>
            </div>
            <select aria-label="미리보기 확대" value={zoom} onChange={(e) => setZoom(e.target.value)}>
              <option value="fit">한 장 전체 · {Math.round(scale * 100)}%</option><option value="width">가로에 맞춤</option>
              <option value="50">50%</option><option value="75">75%</option><option value="100">100% · 글자 확인</option><option value="125">125%</option>
            </select>
          </div>
          <div className="pdf-export-preview" ref={previewRef} aria-busy={!ready}>
            {preview && <div className={!ready ? "pdf-export-sheet updating" : "pdf-export-sheet"}
              style={{ width: widthPx * scale, height: heightPx * scale }}>
              <iframe title="PDF 저장 미리보기" ref={frameRef} srcDoc={preview.html} sandbox="allow-scripts allow-same-origin"
                style={{ width: widthPx, height: heightPx, transform: `scale(${scale})`, transformOrigin: "top left" }} />
            </div>}
            {!ready && !error && <div className="pdf-export-loading" role="status">{snapshot ? "설정을 미리보기에 반영하고 있습니다…" : "원문과 번역을 준비하고 있습니다…"}</div>}
          </div>
          <div className="pdf-export-preview-caption">{ready
            ? `원문 ${doc.pages.length}쪽 → PDF ${count}장${continuations > 0 ? ` · 번역 이어짐 ${continuations}장` : ""}${fittedSources ? ` · 글자 맞춤 ${fittedSources}쪽` : ""} · 현재 ${currentFontSize.toFixed(1)}pt${currentFontSize < settings.fontSize - 0.01 ? ` (기준 ${settings.fontSize}pt)` : ""} / 줄간격 ${settings.lineHeight.toFixed(2)}`
            : "미리보기 준비 중…"}</div>
        </div>
      </div>
      <footer className="pdf-export-footer">
        <div role={error || persistenceError ? "alert" : "status"}>{error ?? persistenceError ?? (saving ? "PDF를 저장하고 있습니다…" : "미리보기와 같은 글꼴·크기·여백으로 저장합니다. 설정은 다음에도 기억합니다.")}</div>
        <button onClick={() => void close()} disabled={saving}>닫기</button>
        <button className="pdf-export-save" onClick={() => void save()} disabled={!ready || saving || extracting}>{saving ? "저장 중…" : "PDF 저장"}</button>
      </footer>
    </div>
  </div>;
}
