// Pagination uses physical print size. Small overflows may reduce only this page's font.
// Only the preview is zoomed. Text that does not fit continues beside the same original.
(async () => {
  try {
    const data = JSON.parse(document.getElementById("pdf-data").textContent);
    const output = document.getElementById("pdf-pages");
    const measure = document.getElementById("pdf-measure");
    const mmPx = 96 / 25.4;
    const settings = data.settings;
    const contentHeight = data.bodyHeight * 4 / 3 - (settings.paddingTop + settings.paddingBottom) * mmPx;
    const contentWidth = data.translationWidth * 4 / 3 - settings.paddingHorizontal * 2 * mmPx;
    measure.style.width = `${contentWidth}px`;
    measure.innerHTML = data.pages.flatMap((page) => page.blocks.map((block) => block.html)).join("");
    measure.getBoundingClientRect();
    await document.fonts.ready;
    measure.replaceChildren();
    const pageMap = [];
    const pageParts = [];
    const pageFontSizes = [];
    let fontSize = settings.fontSize;
    let linePx = fontSize * 4 / 3 * settings.lineHeight;
    const fits = () => column.getBoundingClientRect().height <= contentHeight - 0.5
      && column.scrollWidth <= column.clientWidth + 1;
    const pageNotes = (page) => {
      if (page.continuedFrom) return `<p class="pdf-note">첫 문단의 번역은 원문 ${page.continuedFrom}쪽에 있습니다.</p>`;
      if (!page.blocks.length) return '<p class="pdf-note">이 페이지에는 저장된 번역이 없습니다.</p>';
      return '';
    };
    let column;
    let part;
    const newSheet = (page) => {
      part++;
      const sheet = document.createElement("section");
      sheet.className = "pdf-sheet";
      sheet.dataset.sourcePage = page.index;
      sheet.dataset.part = part;
      sheet.dataset.fontSize = fontSize;
      const header = document.createElement("header");
      const title = document.createElement("span");
      title.textContent = data.title;
      const label = document.createElement("span");
      label.textContent = `원문 ${page.index}쪽${part > 1 ? ` · 번역 이어짐 ${part - 1}` : ""}`;
      header.append(title, label);
      const source = document.createElement("div");
      source.className = "pdf-source";
      for (const [key, value] of Object.entries(page.sourceFit)) {
        if (key !== "scale") source.style[key === "x" ? "left" : key === "y" ? "top" : key] = `${value}pt`;
      }
      const img = document.createElement("img");
      img.src = page.url;
      img.alt = `원문 ${page.index}쪽`;
      source.append(img);
      const divider = document.createElement("div");
      divider.className = "pdf-divider";
      const translation = document.createElement("div");
      translation.className = "pdf-translation";
      column = document.createElement("div");
      column.className = "pdf-flow";
      column.lang = "ko";
      column.style.fontSize = `${fontSize}pt`;
      translation.append(column);
      const footer = document.createElement("footer");
      sheet.append(header, source, divider, translation, footer);
      output.append(sheet);
      pageMap.push(page.index);
      pageParts.push(part);
      pageFontSizes.push(fontSize);
    };
    for (const page of data.pages) {
      part = 0;
      const notes = pageNotes(page);
      measure.innerHTML = notes + page.blocks.map((b) => b.html).join("");
      fontSize = choosePdfPageFont(settings, (candidate) => {
        measure.style.fontSize = `${candidate}pt`;
        return measure.getBoundingClientRect().height <= contentHeight - 0.5
          && measure.scrollWidth <= measure.clientWidth + 1;
      });
      measure.style.fontSize = `${fontSize}pt`;
      linePx = fontSize * 4 / 3 * settings.lineHeight;
      newSheet(page);
      column.innerHTML = notes;
      for (let b = 0; b < page.blocks.length; b++) {
        measure.innerHTML = page.blocks[b].html;
        const paragraph = measure.firstElementChild;
        column.append(paragraph);
        // Keep a heading with at least the first two lines of the next paragraph.
        let reserve = 0;
        if (paragraph.classList.contains("pdf-heading") && page.blocks[b + 1]) {
          measure.innerHTML = page.blocks[b + 1].html;
          reserve = Math.min(measure.getBoundingClientRect().height, linePx * 2);
        }
        if (fits() && column.getBoundingClientRect().height + reserve <= contentHeight - 0.5) continue;
        paragraph.remove();
        const remaining = contentHeight - column.getBoundingClientRect().height;
        if (column.childNodes.length && (reserve || remaining < linePx * 2 + fontSize * 4 / 3 * settings.paragraphSpacing)) {
          newSheet(page);
        }
        column.append(paragraph);
        if (fits()) continue;
        paragraph.remove();
        // Split at token boundaries, keeping formulas intact and using the available space.
        const nodes = Array.from(paragraph.childNodes);
        let offset = 0;
        while (offset < nodes.length) {
          const fragment = paragraph.cloneNode(false);
          if (offset) fragment.classList.add("pdf-paragraph-continued");
          column.append(fragment);
          let lo = 0;
          let hi = nodes.length - offset;
          const fill = (n) => fragment.replaceChildren(...nodes.slice(offset, offset + n));
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            fill(mid);
            if (fits()) lo = mid;
            else hi = mid - 1;
          }
          if (!lo) {
            fragment.remove();
            if (column.childNodes.length) { newSheet(page); continue; }
            // A long URL or word can wrap to more than one whole sheet in a
            // narrow column. Split that text into graphemes rather than losing it.
            const token = nodes[offset];
            if (!(token instanceof Element && token.classList.contains("pdf-math"))) {
              const letters = Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" })
                .segment(token.textContent ?? ""), (s) => s.segment);
              if (letters.length > 1) {
                nodes.splice(offset, 1, ...letters.map((letter) => {
                  const span = document.createElement("span");
                  span.textContent = letter;
                  return span;
                }));
                continue;
              }
            }
            throw new Error("수식이나 단어가 번역 칸보다 큽니다. 번역 칸을 넓히거나 글자 크기·여백을 조절해 주세요.");
          }
          fill(lo);
          offset += lo;
          if (offset < nodes.length) newSheet(page);
        }
      }
    }
    measure.remove();
    document.querySelectorAll(".pdf-sheet footer").forEach((footer, i) => {
      footer.textContent = `${i + 1} / ${pageMap.length} · 원문 ${pageMap[i]}쪽${pageParts[i] > 1 ? ` · 번역 이어짐 ${pageParts[i] - 1}` : ""}`;
    });
    await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => {
      throw new Error(`원문 ${img.alt.replace(/[^0-9]/g, "")}쪽 미리보기를 불러오지 못했습니다.`);
    })));
    document.documentElement.dataset.pdfReady = "true";
    parent.postMessage({ type: "galpi:pdf-ready", token: data.token, pageMap, pageParts, pageFontSizes }, "*");
  } catch (error) {
    parent.postMessage({ type: "galpi:pdf-error", token: document.documentElement.dataset.token,
      error: error instanceof Error ? error.message : String(error) }, "*");
  }
})();
