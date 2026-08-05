import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* The type scale was documented in CLAUDE.md and in index.css long before anything checked it,
   and it drifted: the pass that put every font-size on the scale was stranded on an unmerged
   branch for four days while new stylesheets landed at raw px. A rule nothing enforces is a rule
   that decays silently, so this walks the shipped CSS and fails on any font-size that is not a
   token. index.css is the scale's definition and is where the raw px legitimately live. */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const TOKEN_SOURCE = "index.css";

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  });
}

/** `--type-*` names declared in index.css — the only legal right-hand side for a font-size. */
function declaredTypeTokens(): string[] {
  const css = fs.readFileSync(path.join(srcDir, TOKEN_SOURCE), "utf8");
  return [...css.matchAll(/^\s*(--type-[a-z0-9-]+)\s*:/gm)].flatMap((m) => m[1] ?? []);
}

/** Every `font-size:` declaration in a stylesheet, with its 1-indexed line. */
function fontSizeDeclarations(file: string): { line: number; value: string }[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((text, i) => {
      const value = /font-size:\s*([^;]+);/.exec(text)?.[1]?.trim();
      return value ? [{ line: i + 1, value }] : [];
    });
}

describe("type scale", () => {
  const tokens = declaredTypeTokens();

  it("declares the scale in index.css", () => {
    // Guards the guard: a rename that emptied this list would make every check below vacuous.
    expect(tokens.length).toBeGreaterThanOrEqual(8);
    expect(tokens).toContain("--type-body-sm");
  });

  it("sets every font-size in shipped CSS from a --type-* token", () => {
    const offenders = cssFiles(srcDir)
      .filter((file) => path.basename(file) !== TOKEN_SOURCE)
      .flatMap((file) =>
        fontSizeDeclarations(file)
          .filter(({ value }) => !tokens.some((token) => value.includes(`var(${token})`)))
          .map(({ line, value }) => `${path.relative(srcDir, file)}:${line} — font-size: ${value}`),
      );

    expect(offenders).toEqual([]);
  });

  it("points every font-size at a token that actually exists", () => {
    // A typo'd `var(--type-body-xxs)` is invalid CSS that silently inherits rather than erroring,
    // so matching the `--type-` prefix is not enough — the name has to resolve.
    const unknown = cssFiles(srcDir).flatMap((file) =>
      fontSizeDeclarations(file)
        .flatMap(({ line, value }) =>
          [...value.matchAll(/var\((--type-[a-z0-9-]+)\)/g)].flatMap((m) =>
            m[1] ? [{ line, name: m[1] }] : [],
          ),
        )
        .filter(({ name }) => !tokens.includes(name))
        .map(({ line, name }) => `${path.relative(srcDir, file)}:${line} — unknown ${name}`),
    );

    expect(unknown).toEqual([]);
  });
});
