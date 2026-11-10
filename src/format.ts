export interface PageNotes {
  id: string;
  from: number;
  to: number;
  link: string;
  columns: 2 | 3;
  cells: Map<string, {from: number; to: number; text: string}>;
}
export function sections(source: string): PageNotes[] {
  const results: PageNotes[] = [];
  let current: PageNotes | undefined;
  let cell: {key:string; from:number} | undefined;
  let fence: string | undefined;
  let offset = 0;
  for (const line of source.split("\n")) {
    const from = offset;
    offset += line.length + 1;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (line === "<!-- pbn:/cell -->" && cell) fence = undefined;
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      continue;
    }
    if (delimiter) { fence = delimiter[1]; continue; }
    const start = /^<!-- pbn:v1 ([a-z0-9-]+) ([23]) -->$/.exec(line);
    if (start) {
      current = {id:start[1], columns:start[2]==="2"?2:3, from, to:0, link:"", cells:new Map()};
      cell = undefined;
      continue;
    }
    if (!current) continue;
    if (!current.link) {
      const link = /^\[\[([^\]#|]+)(?:\|[^\]]+)?\]\]$/.exec(line);
      if (link) current.link = link[1];
      else if (line.trim()) current = undefined;
      continue;
    }
    const marker = /^<!-- pbn:cell ([1-9]\d*) ([12]) -->$/.exec(line);
    if (marker && !cell) {
      const key = marker[1]+":"+marker[2];
      if (current.cells.has(key) || !Number.isSafeInteger(Number(marker[1]))) current = undefined;
      else cell = {key,from:offset};
    } else if (line === "<!-- pbn:/cell -->" && cell) {
      const to = Math.max(cell.from,from-1);
      current.cells.set(cell.key,{from:cell.from,to,text:source.slice(cell.from,to)});
      cell = undefined;
    } else if (line === "<!-- pbn:end -->" && !cell) {
      current.to = offset - 1;
      results.push(current);
      current = undefined;
    } else if (line.startsWith("<!-- pbn:")) {
      current = undefined;
      cell = undefined;
    }
  }
  return results.filter(section => results.filter(candidate => candidate.id === section.id).length === 1);
}
export function cellChange(section: PageNotes, page: number, lane: number, value: string) {
  if (/^<!-- pbn:/m.test(value)) return;
  const existing = section.cells.get(page+":"+lane);
  if (existing) return {from:existing.from,to:existing.to,insert:value};
  const from = section.to - "<!-- pbn:end -->".length;
  const heading = section.cells.has(page+":1") || section.cells.has(page+":2") ? "" : "#### PDF page "+page+"\n\n";
  const other = section.cells.get(page+":"+(lane===1?2:1));
  const position = other ? other.to+"\n<!-- pbn:/cell -->".length : from;
  return {from:position,to:position,insert:(other?"\n\n":"")+heading+"<!-- pbn:cell "+page+" "+lane+" -->\n"+value+"\n<!-- pbn:/cell -->\n\n"};
}
