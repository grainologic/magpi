import { defineHandler } from "../handler.js";
import type { Registry } from "./common.js";
import { crates } from "./crates.js";
import { go } from "./go.js";
import { hex } from "./hex.js";
import { maven } from "./maven.js";
import { npm } from "./npm.js";
import { packagist } from "./packagist.js";
import { pypi } from "./pypi.js";
import { rubygems } from "./rubygems.js";

export type { Registry } from "./common.js";

export const REGISTRIES: Registry[] = [npm, pypi, crates, go, rubygems, packagist, hex, maven];

function resolve(url: URL): { registry: Registry; pkg: string } | undefined {
  for (const registry of REGISTRIES) {
    const pkg = registry.match(url);
    if (pkg) return { registry, pkg };
  }
  return undefined;
}

export const registryHandler = defineHandler({
  name: "packages",
  description: `Package registries (${REGISTRIES.map((r) => r.name).join(", ")}): metadata+readme (light) or download+extract (full)`,
  match: (url) => resolve(url) !== undefined,
  async fetch(url, ctx) {
    const { registry, pkg } = resolve(url)!;
    if (ctx.mode === "full" && registry.full) return registry.full(pkg, ctx);
    return registry.light(pkg, ctx);
  },
});
