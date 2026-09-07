// Render WHITEPAPER.md into a standalone page at build time.
//
// The point is that there is no second copy: the page is generated from the
// repository's actual whitepaper, so it cannot drift from it. Edit the .md;
// the page follows.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const md = readFileSync(resolve(repo, "WHITEPAPER.md"), "utf8");

marked.setOptions({ gfm: true, headerIds: true, mangle: false });
const body = marked.parse(md);

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const title = "ante — whitepaper";

writeFileSync(
  resolve(here, "../whitepaper.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)}</title>
    <meta name="description" content="The complete account of ante: the argument, the specification, the failure modes, and the threat model." />
  </head>
  <body>
    <main class="doc">
      <p class="backlink"><a href="./index.html">&larr; ante</a></p>
      ${body}
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
  "utf8",
);
console.log("rendered whitepaper.html from WHITEPAPER.md");
