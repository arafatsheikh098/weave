import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Template {
  id: string;
  name: string;
  description: string;
  kind: "latex" | "markdown";
  main: string;
  accent: string;
  files: { path: string; text: string }[];
}

/** Load starter templates from `templates/<id>/` (meta.json plus the files). */
export async function loadTemplates(dir = join(import.meta.dirname, "..", "templates")): Promise<Template[]> {
  const out: Template[] = [];
  for (const id of (await readdir(dir)).sort()) {
    const meta = JSON.parse(await readFile(join(dir, id, "meta.json"), "utf8")) as Omit<Template, "id" | "files">;
    const files: Template["files"] = [];
    for (const name of (await readdir(join(dir, id))).sort()) {
      if (name === "meta.json") continue;
      files.push({ path: name, text: await readFile(join(dir, id, name), "utf8") });
    }
    out.push({ id, ...meta, files });
  }
  // Show the most useful ones first.
  const order = ["article", "ieee", "beamer", "cv", "notes"];
  return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export const BLANK: Template = {
  id: "blank",
  name: "Blank LaTeX",
  description: "An empty document.",
  kind: "latex",
  main: "main.tex",
  accent: "gray",
  files: [
    {
      path: "main.tex",
      text: "\\documentclass{article}\n\\begin{document}\n\nStart writing here.\n\n\\end{document}\n",
    },
  ],
};
