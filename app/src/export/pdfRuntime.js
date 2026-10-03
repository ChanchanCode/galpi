// Preview pagination runs at physical print size, before any preview zoom is applied.
(async () => {
  try {
    const data = JSON.parse(document.getElementById("pdf-data").textContent);
    const output = document.getElementById("pdf-pages");
    const measure = document.getElementById("pdf-measure");
    // Request every font the actual translated content uses before measuring lines.
    measure.innerHTML = data.pages.flatMap((page) => page.blocks.map((block) => block.html)).join("");
    measure.getBoundingClientRect();
    await document.fonts.ready;
    measure.replaceChildren();
    const pageMap = [];
    const pageFits = [];
    const mmPx = 96 / 25.4;
    const contentHeight = (profile) => data.bodyHeight * 4 / 3 - (profile.paddingTop + profile.paddingBottom) * mmPx;
    const contentWidth = (profile) => data.translationWidth * 4 / 3 - profile.paddingHorizontal * 2 * mmPx;
    let profile;
    const styleFlow = (element) => {
      element.style.fontSize = `${profile.fontSize}pt`;
      element.style.lineHeight = String(profile.lineHeight);
    };
    const pageNotes = (page) => {
      if (page.continuedFrom) return `<p class="pdf-note">첫 문단의 번역은 원문 ${page.continuedFrom}쪽에서 이어집니다.</p>`;
      if (!page.blocks.length) return '<p class="pdf-note">이 페이지에는 저장된 번역이 없습니다.</p>';
      return '';
    };
    let column;
    let sheet;
    let part;
    const fits = () => column.getBoundingClientRect().height <= contentHeight(profile) - 0.5
      && column.scrollWidth <= column.clientWidth + 1;
    const newSheet = (page) => {
      part++;
      sheet = document.createElement("section");
      sheet.className = "pdf-sheet";
      sheet.dataset.sourcePage = page.index;
      const header = document.createElement("header");
      const title = document.createElement("span");
      title.textContent = data.title;
      const label = document.createElement("span");
      label.textContent = `원문 ${page.index}쪽${part > 1 ? ` · 번역 이어짐 ${part - 1}` : ""}`;
      header.append(title, label);
      const source = document.createElement("div");
      source.className = "pdf-source";
      const img = document.createElement("img");
      img.src = page.url;
      img.alt = `원문 ${page.index}쪽`;
      img.loading = "lazy";
      source.append(img);
      const translation = document.createElement("div");
      translation.className = "pdf-translation";
      translation.style.padding = `${profile.paddingTop}mm ${profile.paddingHorizontal}mm ${profile.paddingBottom}mm`;
      column = document.createElement("div");
      column.className = "pdf-flow";
      column.lang = "ko";
      styleFlow(column);
      sheet.dataset.fitStage = profile.stage;
      sheet.dataset.fontSize = String(profile.fontSize);
      sheet.dataset.lineHeight = String(profile.lineHeight);
      translation.append(column);
      const footer = document.createElement("footer");
      footer.textContent = `${page.index}쪽 원문 + 번역`;
      sheet.append(header, source, translation, footer);
      output.append(sheet);
      pageMap.push(page.index);
      pageFits.push({ ...profile, sourcePage: page.index, part });
    };
    for (const page of data.pages) {
      part = 0;
      const notes = pageNotes(page);
      const allHtml = notes + page.blocks.map((block) => block.html).join("");
      measure.innerHTML = allHtml;
      profile = choosePdfFit(data.settings, (candidate) => {
        measure.style.width = `${contentWidth(candidate)}px`;
        measure.style.fontSize = `${candidate.fontSize}pt`;
        measure.style.lineHeight = String(candidate.lineHeight);
        return measure.getBoundingClientRect().height <= contentHeight(candidate) - 0.5
          && measure.scrollWidth <= measure.clientWidth + 1;
      });
      measure.style.width = `${contentWidth(profile)}px`;
      styleFlow(measure);
      newSheet(page);
      column.innerHTML = notes;
      for (const block of page.blocks) {
        measure.innerHTML = block.html;
        const paragraph = measure.firstElementChild;
        const fullHeight = paragraph.getBoundingClientRect().height;
        column.append(paragraph);
        if (fits()) continue;
        paragraph.remove();
        // Keep ordinary paragraphs together. Long paragraphs use the remaining space
        // beside a heading before continuing, instead of leaving a mostly empty sheet.
        if (fullHeight <= contentHeight(profile) - 0.5) {
          newSheet(page);
          column.append(paragraph);
          if (fits()) continue;
          paragraph.remove();
        }
        // Oversize paragraphs split only at token boundaries; math stays an indivisible token.
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
            throw new Error("번역의 수식이나 단어가 한 페이지보다 큽니다. 글자 크기를 줄여 주세요.");
          }
          fill(lo);
          offset += lo;
          if (offset < nodes.length) newSheet(page);
        }
      }
    }
    measure.remove();
    document.querySelectorAll(".pdf-sheet footer").forEach((footer, i) => {
      footer.textContent += ` · ${i + 1} / ${pageMap.length}`;
    });
    document.documentElement.dataset.pdfReady = "true";
    parent.postMessage({ type: "galpi:pdf-ready", token: data.token, pageMap, pageFits }, "*");
  } catch (error) {
    parent.postMessage({ type: "galpi:pdf-error", token: document.documentElement.dataset.token,
      error: error instanceof Error ? error.message : String(error) }, "*");
  }
})();
