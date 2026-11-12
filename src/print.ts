import { App, Component, MarkdownRenderer, Notice } from "obsidian";
import { sections } from "./format";
import { openPdf } from "./pdf";

export async function printPdfNotes(app: App, owner: Component, source: string, path: string, host: Document) {
  const blocks = sections(source);
  if (!blocks.length) return;
  const frame = host.createElement("iframe");
  frame.className = "pbn-print-frame";
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.title = "Pagebound Notes print document";
  host.body.appendChild(frame);
  const component = owner.addChild(new Component());
  component.register(() => frame.remove());
  const progress = new Notice("Preparing PDF pages and notes…", 0);
  try {
    const document = frame.contentDocument;
    const printWindow = frame.contentWindow;
    if (!document || !printWindow) throw new Error("Print window unavailable");
    document.title = path.split("/").at(-1)?.replace(/\.md$/i, "") ?? "PDF notes";
    const style = host.createElement("style");
    document.head.appendChild(style);
    style.textContent = `
      @page { size: A4 landscape; margin: 12mm; }
      body { font: 11pt system-ui, sans-serif; color: #161616; margin: 0; }
      h1 { font-size: 18pt; }
      h2 { font-size: 12pt; margin: 0 0 4mm; }
      .page { break-before: page; }
      .row { display: grid; gap: 5mm; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); }
      .three { grid-template-columns: minmax(0, 1.3fr) repeat(2, minmax(0, 1fr)); }
      img { max-width: 100%; max-height: 160mm; object-fit: contain; }
      .notes { overflow-wrap: anywhere; }
      pre { white-space: pre-wrap; }
      blockquote { margin-left: 0; padding-left: .75em; border-left: 2px solid #aaa; }
      .notes > :first-child { margin-top: 0; }
    `;
    const body = host.createElement("main");
    document.body.appendChild(body);
    function append<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className = "", text = "") {
      const element = host.createElement(tag);
      element.className = className;
      element.textContent = text;
      parent.appendChild(element);
      return element;
    }
    let position = 0;
    const markdown = (text: string, element: HTMLElement) => MarkdownRenderer.render(app, text, element, path, component);
    const urls: string[] = [];
    component.register(() => urls.forEach(url => URL.revokeObjectURL(url)));
    for (const block of blocks) {
      if (source.slice(position, block.from).trim()) await markdown(source.slice(position, block.from), append(body, "div"));
      position = block.to;
      const file = app.metadataCache.getFirstLinkpathDest(block.link, path);
      let count = 0;
      let pdf: ReturnType<typeof openPdf> | undefined;
      try {
        if (file?.extension.toLowerCase() === "pdf") pdf = openPdf(app, file);
        const doc = await pdf?.promise;
        if (doc) {
          for (let page = 1; page <= doc.numPages; page++) {
            const sheet = append(body, "section", "page");
            append(sheet, "h2", "", file?.basename + " · " + page);
            const row = append(sheet, "div", block.columns === 3 ? "row three" : "row");
            const slide = append(row, "div");
            try {
              const original = await doc.getPage(page);
              const natural = original.getViewport({scale: 1});
              const viewport = original.getViewport({scale: 1500 / Math.max(natural.width, natural.height)});
              const canvas = document.createElement("canvas");
              canvas.width = Math.ceil(viewport.width);
              canvas.height = Math.ceil(viewport.height);
              await original.render({canvas, viewport}).promise;
              const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
              canvas.width = canvas.height = 0;
              if (!blob) throw new Error("Could not encode the page");
              const url = URL.createObjectURL(blob);
              urls.push(url);
              const image = append(slide, "img");
              image.alt = "PDF page " + page;
              image.src = url;
              await image.decode();
            } catch {
              slide.textContent = "This PDF page could not be rendered.";
            }
            const notes = append(row, "div", "notes");
            await markdown(block.cells.get(page + ":1")?.text ?? "", notes);
            const second = block.columns === 3 ? append(row, "div", "notes") : append(notes, "div");
            await markdown(block.cells.get(page + ":2")?.text ?? "", second);
            count = page;
          }
        }
      } catch {
        append(body, "p", "", "Could not open PDF: " + block.link);
      } finally {
        pdf?.close();
      }
      if (!pdf) append(body, "p", "", "PDF not found: " + block.link);
      for (const [key, cell] of block.cells) {
        if (Number(key.split(":")[0]) <= count) continue;
        append(body, "h2", "", "Notes for unavailable PDF page " + key.split(":")[0]);
        await markdown(cell.text, append(body, "div", "notes"));
      }
    }
    if (source.slice(position).trim()) await markdown(source.slice(position), append(body, "div"));
    await document.fonts.ready;
    printWindow.addEventListener("afterprint", () => owner.removeChild(component), {once: true});
    printWindow.print();
  } catch {
    owner.removeChild(component);
    new Notice("Could not prepare Pagebound Notes for printing.");
  } finally {
    progress.hide();
  }
}
