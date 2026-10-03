import { useEffect, useMemo, useRef, useState } from "react";
import type { PaperDocument } from "../types";
import type { PageMerge } from "../render/pagemerge";
import type { TrSource } from "../translate/trBlocks";
import type { TrEntry } from "../translate/useTranslation";
import type { Typography } from "../store/typography";
import { buildPdfPreview, pdfFontCss } from "./pdfDocument";
import { normalizePdfSettings, pdfGeometry, type PdfExportSettings } from "./pdfLayout";
import "./pdfExport.css";

interface PageFit {
  fontSize: number; lineHeight: number; paddingTop: number; paddingBottom: number; paddingHorizontal: number;
  stage: "none" | "typography" | "padding" | "overflow";
}

interface Props {
  doc: PaperDocument; blocks: TrSource[]; entries: Map<string, TrEntry>; merge: PageMerge;
  typography: Typography; translationWidth: number; extracting: boolean;
  onClose: () => void; onSaved: () => void; onHtml: () => void;
}

export function PdfExportDialog({ doc, blocks, entries, merge, typography, translationWidth, extracting,
  onClose, onSaved, onHtml }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<PdfExportSettings>(() => normalizePdfSettings({
    translationPercent: Math.round(translationWidth / (typography.contentMaxWidth + translationWidth) * 100),
    fontSize: typography.trFontSize * 0.75, lineHeight: typography.trLineHeight,
  }));
  const [snapshot, setSnapshot] = useState<Map<string, TrEntry> | null>(null);
  const [previewSettings, setPreviewSettings] = useState(settings);
  const [css, setCss] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pageMap, setPageMap] = useState<number[]>([]);
  const [pageFits, setPageFits] = useState<PageFit[]>([]);
  const [readyToken, setReadyToken] = useState("");
  const [page, setPage] = useState(1);
  const [previewWidth, setPreviewWidth] = useState(800);
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  const initialEntries = useRef(entries);
  const dirty = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { focus?.focus(); };
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      window.paperAPI.loadSettings(),
      window.paperAPI.loadState(doc.doc_id),
      window.paperAPI.cachedTranslations(doc.doc_id, blocks.map((b) => ({ id: b.id, text: b.text }))),
      pdfFontCss(),
    ]).then(([global, state, cached, fonts]) => {
      if (!alive) return;
      const defaults = (global as { pdfExport?: PdfExportSettings } | null)?.pdfExport;
      const prior = defaults ?? (state as { pdf_export?: PdfExportSettings } | null)?.pdf_export;
      if (!dirty.current) {
        const restored = normalizePdfSettings(prior ?? settingsRef.current);
        setSettings(restored);
        // Migrate an existing document's old preference once; global defaults win thereafter.
        if (!defaults) void window.paperAPI.saveSettings({ pdfExport: restored })
          .catch(() => alive && setPersistenceError("내보내기 기본값을 저장하지 못했습니다."));
      }
      const complete = new Map<string, TrEntry>(Object.entries(cached));
      for (const [id, value] of initialEntries.current) complete.set(id, value);
      setCss(fonts);
      setSnapshot(complete);
    }).catch((e) => alive && setError(`미리보기 준비 실패: ${String(e)}`));
    return () => { alive = false; };
  }, [doc.doc_id, blocks]);

  useEffect(() => {
    const timer = setTimeout(() => setPreviewSettings(settings), 180);
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
      fontFamily: typography.trFontLinked ? typography.fontFamily : typography.trFontFamily, css, token });
    return { token, html };
  }, [doc, blocks, snapshot, merge, previewSettings, typography.fontFamily, typography.trFontFamily, typography.trFontLinked, css]);
  const ready = !!preview && readyToken === preview.token && settings === previewSettings;
  const count = pageMap.length;
  const currentFit = ready ? pageFits[page - 1] : null;
  const missing = snapshot ? blocks.filter((b) => !snapshot.get(b.id)?.ko.trim() && !snapshot.get(b.id)?.spans?.length).length : 0;
  const g = pdfGeometry(previewSettings);
  const widthPx = g.width * 4 / 3;
  const heightPx = g.height * 4 / 3;
  const scale = zoom === "actual" ? 1 : Math.min(1, Math.max(0.1, (previewWidth - 40) / widthPx));

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setPreviewWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.data?.token !== preview?.token) return;
      if (event.data.type === "galpi:pdf-ready") {
        setPageMap(event.data.pageMap);
        setPageFits(event.data.pageFits);
        setReadyToken(event.data.token);
        setPage((n) => Math.min(n, event.data.pageMap.length));
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
    if (win && sheet) win.scrollTo(0, sheet.offsetTop - 16);
  }, [page, ready]);

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
      else if (result.path) {
        onSaved();
        onClose();
      }
    } catch (e) { setError(`PDF 저장 실패: ${String(e)}`); }
    finally { setSaving(false); }
  };

  return <div className="pdf-export-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
    <div className="pdf-export-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-export-title"
      ref={dialogRef} tabIndex={-1} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); close(); }
        if (e.key === "Tab") {
          const controls = Array.from(dialogRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, iframe'));
          const first = controls[0]; const last = controls[controls.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="pdf-export-header">
        <div><h2 id="pdf-export-title">원문 + 번역 PDF</h2><p>{doc.title ?? doc.doc_id}</p></div>
        <button aria-label="미리보기 닫기" onClick={close} disabled={saving}>×</button>
      </header>
      <div className="pdf-export-body">
        <aside className="pdf-export-controls">
          <label>용지<select aria-label="PDF 용지" value={settings.paper} disabled={saving}
            onChange={(e) => change({ paper: e.target.value as PdfExportSettings["paper"] })}>
            <option value="a3">A3 가로 · 넓게 읽기</option><option value="a4">A4 가로</option>
          </select></label>
          <label>좌우 폭 <output>원문 {100 - settings.translationPercent}% · 번역 {settings.translationPercent}%</output>
            <input aria-label="번역 칸 폭" type="range" min="25" max="65" step="1" value={settings.translationPercent}
              disabled={saving} onChange={(e) => change({ translationPercent: Number(e.target.value) })} /></label>
          <label>번역 글자 크기 <output>{settings.fontSize} pt</output>
            <input aria-label="번역 글자 크기" type="range" min="8" max="20" step="0.5" value={settings.fontSize}
              disabled={saving} onChange={(e) => change({ fontSize: Number(e.target.value) })} /></label>
          <label>번역 줄간격 <output>{settings.lineHeight.toFixed(2)}</output>
            <input aria-label="번역 줄간격" type="range" min="1.2" max="2.6" step="0.05" value={settings.lineHeight}
              disabled={saving} onChange={(e) => change({ lineHeight: Number(e.target.value) })} /></label>
          <label>번역 위 여백 <output>{settings.paddingTop} mm</output>
            <input aria-label="번역 위 여백" type="range" min="0" max="40" step="1" value={settings.paddingTop}
              disabled={saving} onChange={(e) => change({ paddingTop: Number(e.target.value) })} /></label>
          <label>번역 아래 여백 <output>{settings.paddingBottom} mm</output>
            <input aria-label="번역 아래 여백" type="range" min="0" max="40" step="1" value={settings.paddingBottom}
              disabled={saving} onChange={(e) => change({ paddingBottom: Number(e.target.value) })} /></label>
          <label>번역 좌우 여백 <output>{settings.paddingHorizontal} mm</output>
            <input aria-label="번역 좌우 여백" type="range" min="0" max="20" step="1" value={settings.paddingHorizontal}
              disabled={saving} onChange={(e) => change({ paddingHorizontal: Number(e.target.value) })} /></label>
          <p className="pdf-export-hint">긴 번역은 글자·줄간격(최소 8pt·1.2), 여백 순서로 줄인 뒤 다음 장으로 넘깁니다. 설정은 다른 논문에도 기본값으로 적용됩니다.</p>
          {snapshot && <p className="pdf-export-summary">원문 {doc.pages.length}쪽 · {ready ? `PDF ${count}장` : "조판 중…"}</p>}
          {currentFit && currentFit.stage !== "none" && <p className="pdf-export-fit">현재 장 자동 맞춤: {currentFit.fontSize.toFixed(1)}pt · 줄간격 {currentFit.lineHeight.toFixed(2)}
            {(currentFit.stage === "padding" || currentFit.stage === "overflow") && <> · 여백 축소</>}</p>}
          {missing > 0 && <p className="pdf-export-warning">미번역 {missing}개 문단은 표시만 남겨 저장합니다.</p>}
          {extracting && <p className="pdf-export-warning">원문 추출이 끝나면 PDF를 저장할 수 있습니다.</p>}
          <div className="pdf-export-html"><button onClick={async () => { if (await close()) onHtml(); }} disabled={saving}>HTML로 내보내기</button></div>
        </aside>
        <div className="pdf-export-preview-area">
          <div className="pdf-export-preview-toolbar">
            <button aria-label="이전 미리보기 페이지" disabled={!ready || page <= 1} onClick={() => setPage((n) => n - 1)}>←</button>
            <span>{ready ? `${page} / ${count} · 원문 ${pageMap[page - 1]}쪽` : "미리보기 준비 중…"}</span>
            <button aria-label="다음 미리보기 페이지" disabled={!ready || page >= count} onClick={() => setPage((n) => n + 1)}>→</button>
            <select aria-label="미리보기 확대" value={zoom} onChange={(e) => setZoom(e.target.value as typeof zoom)}>
              <option value="fit">화면에 맞춤</option><option value="actual">100% · 글자 확인</option>
            </select>
          </div>
          <div className="pdf-export-preview" ref={previewRef}>
            {preview && <div style={{ width: widthPx * scale, height: (heightPx + 32) * scale }}>
              <iframe title="PDF 저장 미리보기" ref={frameRef} srcDoc={preview.html} sandbox="allow-scripts allow-same-origin"
                style={{ width: widthPx, height: heightPx + 32, transform: `scale(${scale})`, transformOrigin: "top left" }} />
            </div>}
          </div>
        </div>
      </div>
      <footer className="pdf-export-footer">
        <div role={error || persistenceError ? "alert" : "status"}>{error ?? persistenceError ?? (saving ? "PDF를 저장하고 있습니다…" : "미리보기의 배치로 저장하며, 설정을 앱 공통 기본값으로 기억합니다.")}</div>
        <button onClick={close} disabled={saving}>취소</button>
        <button className="pdf-export-save" onClick={() => void save()} disabled={!ready || saving || extracting}>PDF 저장</button>
      </footer>
    </div>
  </div>;
}
