import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
await mkdir("dist", {recursive:true});
const worker = await readFile("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs","utf8");
await build({entryPoints:["src/main.ts"], bundle:true, format:"cjs", target:"es2022", outfile:"dist/main.js", external:["obsidian","@codemirror/state","@codemirror/view","@codemirror/commands"], define:{PAGEBOUND_WORKER:JSON.stringify(worker)}, legalComments:"inline"});
for (const file of ["manifest.json","styles.css"]) await copyFile(file, "dist/"+file);
