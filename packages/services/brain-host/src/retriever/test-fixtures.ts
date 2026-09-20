/** Shared test fixture (excluded from coverage; imported only by *.test.ts). */

import type { EntryDoc } from "./corpus.js";

export function doc(over: Partial<EntryDoc> & { path: string }): EntryDoc {
  return {
    relPath: `wiki/d/${over.path.split("/").pop()}`,
    corpus: "wiki",
    title: "T " + over.path,
    domain: "d",
    tags: ["x"],
    sections: [
      { heading: "Rule", text: "rule text", startLine: 3, endLine: 5 },
      { heading: "Apply when", text: "apply text", startLine: 6, endLine: 8 },
    ],
    entryText: "entry",
    fullText: "rule text apply text",
    hash: "h1",
    ...over,
  };
}
