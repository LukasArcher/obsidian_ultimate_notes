import { getDocument, PDFWorker, TextLayer, AnnotationMode } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { App, TFile } from "obsidian";

export function openPdf(app: App, file: TFile) {
  const url = URL.createObjectURL(new Blob([PAGEBOUND_WORKER], {type:"text/javascript"}));
  let port: Worker;
  try { port = new Worker(url, {type:"module"}); }
  finally { URL.revokeObjectURL(url); }
  const worker = PDFWorker.create({port});
  let closed = false;
  let task: ReturnType<typeof getDocument> | undefined;
  const promise = app.vault.readBinary(file).then(bytes => {
    if (closed) throw new Error("PDF view closed");
    task = getDocument({data:new Uint8Array(bytes),worker,enableXfa:false,useWasm:false});
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
  let generation = 0;
  let visible = false;
  let active: ReturnType<Awaited<ReturnType<typeof doc.getPage>>["render"]> | undefined;
  let textLayer: TextLayer | undefined;
  let pagePromise: ReturnType<typeof doc.getPage> | undefined;
  const stop = () => {
    generation++;
    active?.cancel();
    textLayer?.cancel();
    surface.replaceChildren();
  };
  const render = async () => {
    stop();
    if (!visible) return;
    const token = generation;
    try {
      const page = await (pagePromise ??= doc.getPage(number));
      if (token !== generation) return;
      const natural = page.getViewport({scale:1});
      frame.style.setProperty("--pbn-aspect", natural.width+" / "+natural.height);
      if (!frame.clientWidth) return;
      const viewport = page.getViewport({scale:frame.clientWidth/natural.width*scale});
      const width = viewport.width;
      const height = viewport.height;
      surface.style.width = width+"px";
      surface.style.height = height+"px";
      surface.style.setProperty("--scale-factor", String(viewport.scale));
      surface.style.setProperty("--total-scale-factor", String(viewport.scale*page.userUnit));
      surface.style.setProperty("--user-unit", String(page.userUnit));
      surface.style.setProperty("--scale-round-x", "1px");
      surface.style.setProperty("--scale-round-y", "1px");
      const pixelRatio = Math.min(window.devicePixelRatio, 4096/Math.max(width,height), Math.sqrt(8_000_000/(width*height)));
      const canvas = surface.createEl("canvas");
      canvas.width = Math.max(1,Math.floor(width*pixelRatio));
      canvas.height = Math.max(1,Math.floor(height*pixelRatio));
      active = page.render({canvas,viewport,transform:[pixelRatio,0,0,pixelRatio,0,0],annotationMode:AnnotationMode.DISABLE});
      const layer = surface.createDiv("textLayer");
      textLayer = new TextLayer({container:layer,viewport,textContentSource:page.streamTextContent()});
      await Promise.all([active.promise,textLayer.render()]);
    } catch {
      if (token === generation) surface.createDiv({text:"Could not render this page."});
    }
  };
  const levels = [1,1.25,1.5,2,3];
  function button(label:string, title:string, action:()=>void) {
    const el = controls.createEl("button",{text:label,attr:{type:"button","aria-label":title}});
    el.addEventListener("click",action);
    return el;
  }
  const setZoom = (next:number) => {
    scale = levels[Math.max(0,Math.min(next,levels.length-1))];
    reset.textContent = Math.round(scale*100)+"%";
    void render();
  };
  button("−","Zoom out",()=>setZoom(levels.indexOf(scale)-1));
  const reset = button("100%","Reset zoom",()=>setZoom(0));
  button("+","Zoom in",()=>setZoom(levels.indexOf(scale)+1));
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
  return () => {intersection.disconnect();resize.disconnect();stop();};
}
