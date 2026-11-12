import { renderPageNotes } from "./print";
import { App, Component, FuzzySuggestModal, MarkdownRenderer, Plugin, TFile, editorInfoField, editorLivePreviewField } from "obsidian";
import { EditorState, StateField } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { cellChange, PageNotes, sections } from "./format";
import { openPdf, pdfPage } from "./pdf";

class PdfPicker extends FuzzySuggestModal<TFile> {
  constructor(app:App, private choose:(file:TFile)=>void) { super(app); }
  getItems() { return this.app.vault.getFiles().filter(file=>file.extension.toLowerCase()==="pdf"); }
  getItemText(file:TFile) { return file.path; }
  onChooseItem(file:TFile) { this.choose(file); }
}

class PdfWidget extends WidgetType {
  private static mounted = new WeakMap<HTMLElement, PdfLayout>();
  constructor(private app:App, private section:PageNotes, private path:string) { super(); }
  eq(other:PdfWidget) {
    return this.path===other.path && this.section===other.section;
  }
  toDOM(view:EditorView) {
    const root = view.dom.ownerDocument.createElement("div");
    root.className = "pbn";
    PdfWidget.mounted.set(root,new PdfLayout(this.app,view,root,this.section,this.path));
    return root;
  }
  updateDOM(root:HTMLElement) {
    return PdfWidget.mounted.get(root)?.update(this.section,this.path) ?? false;
  }
  destroy(root:HTMLElement) {
    PdfWidget.mounted.get(root)?.unload();
    PdfWidget.mounted.delete(root);
  }
  ignoreEvent() { return true; }
}

class PdfLayout extends Component {
  private body:HTMLElement;
  private toggle:HTMLButtonElement;
  private cells = new Map<string,{refresh:()=>void}>();
  private disposePdf: (()=>void)[] = [];
  private revision = 0;
  constructor(private app:App, private view:EditorView, private root:HTMLElement, private section:PageNotes, private path:string) {
    super();
    this.load();
    this.toggle = root.createEl("button",{attr:{type:"button"}});
    this.toggle.addEventListener("click",()=>{
      const current = this.current();
      if (!current) return;
      const end = this.view.state.doc.lineAt(current.from).to;
      this.view.dispatch({changes:{from:end-5,to:end-4,insert:current.columns===2?"3":"2"}});
    });
    this.body = root.createDiv("pbn-body");
    this.registerEvent(app.vault.on("modify",file=>{if (file.path===this.file()?.path) void this.draw();}));
    this.registerEvent(app.vault.on("delete",()=>{if (!this.file()) void this.draw();}));
    this.registerEvent(app.vault.on("create",file=>{if (file instanceof TFile && file.path===this.file()?.path) void this.draw();}));
    this.registerEvent(app.vault.on("rename",()=>void this.draw()));
    void this.draw();
  }
  private file() {
    const file = this.app.metadataCache.getFirstLinkpathDest(this.section.link,this.path);
    return file?.extension.toLowerCase()==="pdf" ? file : null;
  }
  private current() {
    return sections(this.view.state.doc.toString()).find(section=>section.id===this.section.id);
  }
  update(section:PageNotes,path:string) {
    if (section.id!==this.section.id || path!==this.path) return false;
    const rebuild = section.link!==this.section.link || section.columns!==this.section.columns;
    this.section=section;
    if (rebuild) void this.draw();
    else for (const cell of this.cells.values()) cell.refresh();
    return true;
  }
  private clear() {
    this.revision++;
    this.cells.clear();
    this.disposePdf.reverse().forEach(dispose=>dispose());
    this.disposePdf=[];
    this.body.replaceChildren();
  }
  onunload() { this.clear(); }
  private async draw() {
    this.clear();
    const revision = this.revision;
    this.toggle.textContent = this.section.columns===2 ? "Use three columns" : "Use two columns";
    this.body.dataset.columns=String(this.section.columns);
    const file=this.file();
    let count=0;
    try {
      if (!file) throw new Error("PDF not found");
      const pdf=openPdf(this.app,file,this.root.ownerDocument);
      this.disposePdf.push(pdf.close);
      const doc=await pdf.promise;
      if (this.revision!==revision) return;
      count=doc.numPages;
      for (let page=1;page<=count;page++) {
        const row=this.row(page);
        const pdfCell=row.createDiv("pbn-pdf");
        this.disposePdf.push(pdfPage(doc,page,pdfCell,()=>void this.app.workspace.openLinkText(file.path+"#page="+page,this.path,true)));
        this.lanes(row,page);
      }
    } catch {
      if (this.revision!==revision) return;
      this.body.createDiv({text:file?"The PDF could not be opened. It may be locked or damaged.":"PDF not found."});
    }
    const orphanPages=new Set([...this.section.cells.keys()].map(key=>Number(key.split(":")[0])).filter(page=>page>count));
    for (const page of orphanPages) {
      const row=this.row(page);
      row.createDiv({text:"Unavailable PDF page "+page});
      this.lanes(row,page);
    }
  }
  private row(page:number) {
    return this.body.createDiv({cls:"pbn-row",attr:{"data-page":String(page)}});
  }
  private lanes(row:HTMLElement,page:number) {
    const first=row.createDiv("pbn-lane");
    this.note(first,page,1);
    this.note(this.section.columns===3?row.createDiv("pbn-lane"):first,page,2);
  }
  private note(parent:HTMLElement,page:number,lane:number) {
    const key=page+":"+lane;
    const cell=parent.createDiv("pbn-note");
    const input=cell.createEl("textarea",{attr:{"aria-label":"Page "+page+", notes "+lane,rows:"3"}});
    const preview=cell.createDiv("pbn-note-preview");
    const edit=cell.createEl("button",{text:"Edit notes "+page,attr:{type:"button","aria-label":"Edit notes "+page+", column "+lane}});
    let editing=false;
    let composing=false;
    let displayed: string | undefined;
    let renderer:Component | undefined;
    const refresh=()=>{
      const text=this.section.cells.get(key)?.text ?? "";
      cell.hidden = lane===2 && this.section.columns===2 && !this.section.cells.has(key);
      if (editing) {
        if (!composing && input.value!==text) {
          const position=input.selectionStart;
          input.value=text;
          input.setSelectionRange(position,position);
        }
        return;
      }
      if (text===displayed) return;
      displayed=text;
      if (renderer) this.removeChild(renderer);
      renderer=this.addChild(new Component());
      preview.replaceChildren();
      if (text) {
        const content=preview.createDiv();
        void MarkdownRenderer.render(this.app,text,content,this.path,renderer).catch(()=>{content.textContent=text;});
      }
    };
    this.disposePdf.push(()=>{if(renderer) this.removeChild(renderer);});
    input.hidden=true;
    const begin=()=>{
      if (editing) return;
      editing=true;
      input.hidden=false;
      edit.hidden=true;
      preview.hidden=true;
      refresh();
      input.focus();
    };
    edit.addEventListener("click",begin);
    cell.addEventListener("click",event=>{
      const target = event.target;
      if (!(target instanceof Element) || target.closest("a, button, input, textarea, select, summary")) return;
      if (!input.ownerDocument.getSelection()?.toString()) begin();
    });
    const commit=()=>{
      const current=this.current();
      if (!current) return;
      const value=input.value;
      if ((current.cells.get(key)?.text ?? "")===value) return;
      const change=cellChange(current,page,lane,value);
      if (!change) {
        input.setCustomValidity("Reserved Pagebound marker");
        input.reportValidity();
        return;
      }
      input.setCustomValidity("");
      this.view.dispatch({changes:change,userEvent:"input.type"});
    };
    input.addEventListener("compositionstart",()=>{composing=true;});
    input.addEventListener("compositionend",()=>{composing=false;commit();});
    input.addEventListener("input",()=>{if(!composing)commit();});
    input.addEventListener("keydown",event=>{
      if ((event.ctrlKey||event.metaKey) && ["z","y"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey||event.key.toLowerCase()==="y"?redo:undo)(this.view);
      }
      if (event.key==="Escape") edit.hidden=false,edit.focus();
    });
    input.addEventListener("blur",()=>{
      editing=false;
      input.hidden=true;
      preview.hidden=false;
      edit.hidden=false;
      refresh();
    });
    this.cells.set(key,{refresh});
    refresh();
  }
}

export default class PageboundNotes extends Plugin {
  onload() {
    this.addCommand({id:"insert-pdf-notes",name:"Insert PDF notes",editorCallback:(editor,view)=>{
      const original=view.file;
      new PdfPicker(this.app,file=>{
        if (!original || view.file!==original) return;
        const link=this.app.fileManager.generateMarkdownLink(file,original.path);
        const wiki=link.startsWith("[[")?link:"[["+file.path+"]]";
        editor.replaceSelection("\n\n<!-- pbn:v1 "+crypto.randomUUID()+" 2 -->\n\n"+wiki+"\n\n<!-- pbn:end -->\n\n");
      }).open();
    }});
    this.registerMarkdownPostProcessor((element, context) => renderPageNotes(this.app, element, context));
    const decorations = (state:EditorState) => {
        if (!state.field(editorLivePreviewField,false)) return Decoration.none;
        const path=state.field(editorInfoField,false)?.file?.path;
        if (!path) return Decoration.none;
        return Decoration.set(sections(state.doc.toString()).map(section=>
          Decoration.replace({widget:new PdfWidget(this.app,section,path),block:true}).range(section.from,section.to)),true);
    };
    const field=StateField.define({
      create:decorations,
      update(value,transaction) {
        if (!transaction.docChanged &&
            transaction.startState.field(editorLivePreviewField,false)===transaction.state.field(editorLivePreviewField,false) &&
            transaction.startState.field(editorInfoField,false)?.file===transaction.state.field(editorInfoField,false)?.file) return value;
        return decorations(transaction.state);
      },
      provide:field=>EditorView.decorations.from(field)
    });
    this.registerEditorExtension(field);
  }
}
