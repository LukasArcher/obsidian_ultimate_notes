import { App, Component, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, TFile } from "obsidian";
import { sections } from "./format";
import { openPdf } from "./pdf";

async function renderPages(app: App, component: Component, source: string, path: string, body: HTMLElement) {
  const blocks = sections(source);
  function append<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className = "", text = "") {
    return parent.createEl(tag, {cls: className, text});
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
      if (file?.extension.toLowerCase() === "pdf") pdf = openPdf(app, file, body.ownerDocument);
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
            const canvas = body.doc.adoptNode(createEl("canvas"));
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
}

export async function renderPageNotes(app: App, element: HTMLElement, context: MarkdownPostProcessorContext) {
  if (element.closest(".pbn-document")) return;
  const printing = element.classList.contains("markdown-preview-view") && !!element.closest(".print");
  const info = printing ? null : context.getSectionInfo(element);
  if (!printing && !info) return;
  const file = app.vault.getAbstractFileByPath(context.sourcePath);
  if (!(file instanceof TFile)) return;
  const source = (info?.text ?? await app.vault.cachedRead(file)).replace(/\r\n/g, "\n");
  const blocks = sections(source);
  if (!blocks.length) return;
  let markdown = source;
  if (info) {
    const lineAt = (offset: number) => source.slice(0, offset).split("\n").length - 1;
    const block = blocks.find(item => info.lineStart >= lineAt(item.from) && info.lineEnd <= lineAt(item.to) + 1);
    if (!block) return;
    const linkLine = source.slice(block.from, block.to).split("\n").findIndex(line => line.startsWith("[["));
    const anchor = lineAt(block.from) + linkLine;
    if (linkLine < 0) return;
    if (info.lineStart > anchor || info.lineEnd < anchor) {
      element.classList.add("pbn-reading-fallback");
      return;
    }
    markdown = source.slice(block.from, block.to);
  }
  const output = element.createDiv("pbn-document");
  const lifecycle = new MarkdownRenderChild(output);
  const title = printing && element.firstElementChild?.tagName === "H1" ? element.firstElementChild : null;
  context.addChild(lifecycle);
  try {
    await renderPages(app, lifecycle, markdown, context.sourcePath, output);
    if (output.parentElement === element) element.replaceChildren(...(title ? [title, output] : [output]));
  } catch (error) {
    output.remove();
    console.error("Pagebound Notes could not render the PDF layout", error);
  }
}
