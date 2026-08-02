import { FetchError, getJson } from "../handler.js";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.js";

export const npm: Registry = {
  name: "npm",
  match: (url) => {
    if (url.hostname === "registry.npmjs.org") return seg(url).slice(0, 2).join("/");
    if (/(^|\.)npmjs\.com$/.test(url.hostname)) {
      const s = seg(url);
      if (s[0] === "package") return s.slice(1, s[1]?.startsWith("@") ? 3 : 2).join("/");
    }
    return undefined;
  },
  async light(pkg, ctx) {
    const d = await getJson<any>(`https://registry.npmjs.org/${pkg}`, ctx.signal);
    const latest = d["dist-tags"]?.latest;
    const header = metaBlock(`${pkg} (npm)`, {
      version: latest,
      description: d.description,
      homepage: d.homepage,
      repository: d.repository?.url,
    });
    return {
      kind: "package-info",
      title: pkg,
      content: `${header}\n\n---\n\n${d.readme ?? "(no readme in registry)"}`,
    };
  },
  async full(pkg, ctx) {
    const d = await getJson<any>(`https://registry.npmjs.org/${pkg}`, ctx.signal);
    const latest = d["dist-tags"]?.latest;
    const tarball = d.versions?.[latest]?.dist?.tarball;
    if (!tarball) throw new FetchError(`No tarball found for ${pkg}`);
    return fullFromArchive(tarball, "pkg.tgz", ctx, metaBlock(`${pkg}@${latest} (npm)`, { description: d.description }));
  },
};
