import { decodeEntities } from "../html.js";
import { FetchError, defineHandler, getText } from "./handler.js";

export const arxivHandler = defineHandler({
  name: "arxiv",
  description: "arXiv papers: title, authors, abstract via the export API",
  match: (url) => /(^|\.)arxiv\.org$/.test(url.hostname) && /^\/(abs|pdf|html)\//.test(url.pathname),
  async fetch(url, ctx) {
    const id = url.pathname.replace(/^\/(abs|pdf|html)\//, "").replace(/(\.pdf|v\d+)?$/, "");
    const { text: xml } = await getText(`https://export.arxiv.org/api/query?id_list=${id}`, ctx.signal);
    const entry = xml.split("<entry>")[1];
    if (!entry) throw new FetchError(`arXiv paper ${id} not found`);
    const pick = (tag: string) =>
      decodeEntities((entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "").trim());
    const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]);
    const title = pick("title").replace(/\s+/g, " ");
    const parts = [
      `# ${title}`,
      `arXiv:${id} | ${authors.join(", ")} | published ${pick("published").slice(0, 10)}`,
      `pdf: https://arxiv.org/pdf/${id}`,
      "",
      "## Abstract",
      pick("summary").replace(/\s*\n\s*/g, " "),
    ];
    return { kind: "paper", title, content: parts.join("\n") };
  },
});
