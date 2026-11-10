import assert from "node:assert/strict";
import { test } from "node:test";
import { transform } from "esbuild";
import { readFile } from "node:fs/promises";
const source=await readFile(new URL("../src/format.ts",import.meta.url),"utf8");
const {code}=await transform(source,{loader:"ts",format:"esm"});
const {sections,cellChange}=await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const blank="<!-- pbn:v1 test 2 -->\n\n[[sample.pdf]]\n\n<!-- pbn:end -->";
function write(source,page,lane,text) {
  const {from,to,insert}=cellChange(sections(source)[0],page,lane,text);
  return source.slice(0,from)+insert+source.slice(to);
}
test("independent lanes survive subsequent edits",()=>{
  const first=write(blank,2,1,"Hello [[Link]]");
  const second=write(first,3,1,"Another page");
  const third=write(second,2,2,"**Second lane**");
  const fourth=write(third,2,1,"Updated");
  const [result]=sections(fourth);
  assert.deepEqual([...result.cells].map(([key,value])=>[key,value.text]),[["2:1","Updated"],["2:2","**Second lane**"],["3:1","Another page"]]);
  assert.equal(fourth.match(/#### PDF page 2/g).length,1);
});
test("incomplete Markdown fences remain editable",()=>{
  const source=write(blank,1,1,"```js\nconst x = 1;");
  assert.equal(sections(source)[0].cells.get("1:1").text,"```js\nconst x = 1;");
});
test("invalid, duplicate and fenced sections stay as source",()=>{
  assert.deepEqual(sections(blank+"\n\n"+blank),[]);
  assert.deepEqual(sections("```md\n"+blank+"\n```"),[]);
  assert.deepEqual(sections(blank.replace("<!-- pbn:end -->","")),[]);
  assert.equal(cellChange(sections(blank)[0],1,1,"<!-- pbn:end -->"),undefined);
});
