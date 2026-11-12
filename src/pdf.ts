import { getDocument, PDFWorker, TextLayer, AnnotationMode } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { App, TFile } from "obsidian";

export function openPdf(app: App, file: TFile, ownerDocument: Document) {
  const url = URL.createObjectURL(new Blob([PAGEBOUND_WORKER], {type:"text/javascript"}));
  let port: Worker;
  try { port = new Worker(url, {type:"module"}); }
  finally { URL.revokeObjectURL(url); }
  const worker = PDFWorker.create({port});
  let closed = false;
  let task: ReturnType<typeof getDocument> | undefined;
  const promise = app.vault.readBinary(file).then(bytes => {
    if (closed) throw new Error("PDF view closed");
    task = getDocument({data:new Uint8Array(bytes),worker,ownerDocument,enableXfa:false,useWasm:false});
    return task.promise;
  });
  return {promise, close() {
    closed = true;
    void (task?.destroy() ?? Promise.resolve()).catch(() => {}).finally(() => {
      worker.destroy();
      port.terminate();
    });
  }};
}

export function pdfPage(doc: Awaited<ReturnType<typeof openPdf>["promise"]>, number: number, parent: HTMLElement, open: () => void) {
  const controls = parent.createDiv("pbn-controls");
  controls.createSpan({text:"PDF page "+number});
  const frame = parent.createDiv("pbn-frame");
  const surface = frame.createDiv("pbn-surface");
  let scale = 1;
  let zoomFrame = 0;
  let generation = 0;
  let aspect = 1 / 1.414;
  let visible = false;
  let active: ReturnType<Awaited<ReturnType<typeof doc.getPage>>["render"]> | undefined;
  let textLayer: TextLayer | undefined;
  let pagePromise: ReturnType<typeof doc.getPage> | undefined;
  let displayed: {element: HTMLElement; width: number} | undefined;
  const resizeSurface = (width: number, height: number) => {
    surface.style.width = width + "px";
    surface.style.height = height + "px";
    if (displayed) displayed.element.style.transform = "scale(" + width / displayed.width + ")";
  };
  const stop = () => {
    generation++;
    active?.cancel();
    textLayer?.cancel();
  };
  const render = async () => {
    stop();
    if (!visible) {
      displayed = undefined;
      surface.replaceChildren();
      return;
    }
    const token = generation;
    try {
      const page = await (pagePromise ??= doc.getPage(number));
      if (token !== generation) return;
      const natural = page.getViewport({scale:1});
      aspect = natural.width / natural.height;
      frame.style.setProperty("--pbn-aspect", natural.width+" / "+natural.height);
      if (!frame.clientWidth) return;
      const viewport = page.getViewport({scale:frame.clientWidth/natural.width*scale});
      const width = viewport.width;
      const height = viewport.height;
      resizeSurface(width, height);
      const next = surface.ownerDocument.createElement("div");
      next.className = "pbn-page-image";
      next.style.width = width + "px";
      next.style.height = height + "px";
      next.style.setProperty("--scale-factor", String(viewport.scale));
      next.style.setProperty("--total-scale-factor", String(viewport.scale*page.userUnit));
      next.style.setProperty("--user-unit", String(page.userUnit));
      next.style.setProperty("--scale-round-x", "1px");
      next.style.setProperty("--scale-round-y", "1px");
      const pixelRatio = Math.min(window.devicePixelRatio, 4096/Math.max(width,height), Math.sqrt(8_000_000/(width*height)));
      const canvas = next.createEl("canvas");
      canvas.width = Math.max(1,Math.floor(width*pixelRatio));
      canvas.height = Math.max(1,Math.floor(height*pixelRatio));
      active = page.render({canvas,viewport,transform:[pixelRatio,0,0,pixelRatio,0,0],annotationMode:AnnotationMode.DISABLE});
      const layer = next.createDiv("textLayer");
      textLayer = new TextLayer({container:layer,viewport,textContentSource:page.streamTextContent()});
      await Promise.all([active.promise,textLayer.render()]);
      if (token !== generation) return;
      displayed = {element: next, width};
      surface.replaceChildren(next);
    } catch {
      if (token === generation && !displayed) surface.createDiv({text:"Could not render this page."});
    }
  };
  const levels = [1,1.25,1.5,2,3];
  function button(label:string, title:string, action:()=>void) {
    const el = controls.createEl("button",{text:label,attr:{type:"button","aria-label":title}});
    el.addEventListener("click",action);
    return el;
  }
  const setZoom = (next: number, x = 0, y = 0) => {
    const zoom = Math.max(1, Math.min(next, 3));
    if (zoom === scale) return;
    const ratio = zoom / scale;
    const left = (frame.scrollLeft + x) * ratio - x;
    const top = (frame.scrollTop + y) * ratio - y;
    scale = zoom;
    reset.textContent = Math.round(scale * 100) + "%";
    // Resize immediately to preserve the anchor across consecutive gesture events.
    const width = frame.clientWidth * scale;
    resizeSurface(width, width / aspect);
    frame.scrollLeft = left;
    frame.scrollTop = top;
    stop();
    cancelAnimationFrame(zoomFrame);
    zoomFrame = requestAnimationFrame(() => void render());
  };
  frame.addEventListener("wheel", event => {
    const lineSize = 16;
    const deltaX = event.deltaX * (event.deltaMode === 1 ? lineSize : event.deltaMode === 2 ? frame.clientWidth : 1);
    const deltaY = event.deltaY * (event.deltaMode === 1 ? lineSize : event.deltaMode === 2 ? frame.clientHeight : 1);
    // Chromium delivers precision-touchpad pinch as a Ctrl+wheel event.
    if (event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      const bounds = frame.getBoundingClientRect();
      setZoom(scale * Math.exp(-deltaY * 0.01), event.clientX - bounds.left, event.clientY - bounds.top);
      return;
    }
    if (scale <= 1) return;
    // Apply both axes ourselves so Chromium's native scroll rail does not choose one.
    event.preventDefault();
    event.stopPropagation();
    frame.scrollLeft += deltaX;
    frame.scrollTop += deltaY;
  }, {passive:false});
  button("−","Zoom out",()=>setZoom([...levels].reverse().find(level=>level<scale) ?? 1));
  const reset = button("100%","Reset zoom",()=>setZoom(1));
  button("+","Zoom in",()=>setZoom(levels.find(level=>level>scale) ?? 3));
  button("↗","Open original PDF page",open);
  let spaceHeld = false;
  let drag: {pointer: number; x: number; y: number; left: number; top: number} | undefined;
  const stopDrag = () => {
    const pointer = drag?.pointer;
    drag = undefined;
    frame.classList.remove("pbn-dragging");
    if (pointer !== undefined && frame.hasPointerCapture(pointer)) frame.releasePointerCapture(pointer);
  };
  frame.addEventListener("keydown", event => {
    if (event.code !== "Space" || scale <= 1) return;
    event.preventDefault();
    spaceHeld = true;
    frame.classList.add("pbn-grab");
  });
  const releaseSpace = () => {
    spaceHeld = false;
    frame.classList.remove("pbn-grab");
    stopDrag();
  };
  frame.addEventListener("keyup", event => { if (event.code === "Space") releaseSpace(); });
  frame.addEventListener("blur", releaseSpace);
  frame.addEventListener("pointerdown", event => {
    if (scale <= 1 || !(event.button === 1 || event.button === 0 && spaceHeld)) return;
    event.preventDefault();
    frame.focus({preventScroll:true});
    frame.setPointerCapture(event.pointerId);
    drag = {pointer:event.pointerId,x:event.clientX,y:event.clientY,left:frame.scrollLeft,top:frame.scrollTop};
    frame.classList.add("pbn-dragging");
  });
  frame.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    frame.scrollLeft = drag.left + drag.x - event.clientX;
    frame.scrollTop = drag.top + drag.y - event.clientY;
  });
  const endPointer = (event: PointerEvent) => { if (event.pointerId === drag?.pointer) stopDrag(); };
  frame.addEventListener("pointerup", endPointer);
  frame.addEventListener("pointercancel", endPointer);
  frame.addEventListener("lostpointercapture", endPointer);
  controls.createSpan({cls:"pbn-pan-hint",text:"Focus page, then Space + drag to pan"});
  frame.tabIndex = 0;
  frame.setAttribute("aria-label","PDF page "+number+" scroll area");
  const intersection = new IntersectionObserver(([entry]) => {
    if (visible === entry.isIntersecting) return;
    visible = entry.isIntersecting;
    void render();
  },{rootMargin:"350px"});
  intersection.observe(frame);
  let lastWidth = frame.clientWidth;
  const resize = new ResizeObserver(() => {
    if (lastWidth === frame.clientWidth) return;
    lastWidth = frame.clientWidth;
    void render();
  });
  resize.observe(frame);
  return () => {cancelAnimationFrame(zoomFrame);intersection.disconnect();resize.disconnect();stop();};
}
