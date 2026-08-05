import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* The spacing spine (`--space-*`, 4px steps, plus the `--space-chrome-*` tier for the 2px control
   sizes between them) is declared once in index.css. This guard is deliberately narrower than
   `typeScale.test.ts`: it does not demand that every spacing value be a token, because a real
   share of the app still sits on sizes the scale has no name for (9px, 7px, 11px …), and snapping
   those would move the UI rather than tidy it.

   What it does enforce is the half that is unambiguous: when a value *does* have a token, the
   token has to be the thing written. That is the rule a new stylesheet breaks by reflex — typing
   `padding: 8px` instead of `var(--space-2)` — and it is how 275 declarations drifted off the
   spine while the spine sat right there in index.css. Off-scale values are left to a design
   decision; re-typing an on-scale value as a literal is just drift, and it stops here. */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const TOKEN_SOURCE = "index.css";

/** Spacing shorthands and their longhands — the properties that consume the spine. */
const SPACING_PROPERTY = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/;

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  });
}

/** px value -> token name, read from index.css so the guard can never drift from the scale. */
function spacingByPx(): Map<number, string> {
  const css = fs.readFileSync(path.join(srcDir, TOKEN_SOURCE), "utf8");
  const found = new Map<number, string>();
  for (const m of css.matchAll(/^\s*(--space-[a-z0-9-]+)\s*:\s*([0-9.]+)px\s*;/gm)) {
    const [, name, px] = m;
    if (name && px) found.set(Number(px), name);
  }
  return found;
}

describe("spacing scale", () => {
  const byPx = spacingByPx();

  it("declares the spine in index.css", () => {
    // Guards the guard: a rename that emptied this map would make the check below vacuous.
    expect(byPx.size).toBeGreaterThanOrEqual(12);
    expect(byPx.get(8)).toBe("--space-2");
  });

  it("writes on-scale spacing values as tokens, not literals", () => {
    const offenders = cssFiles(srcDir)
      .filter((file) => path.basename(file) !== TOKEN_SOURCE)
      .flatMap((file) =>
        fs
          .readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, i) => {
            const declaration = /^\s*([a-z-]+):\s*([^;]+);/.exec(line);
            if (!declaration) return [];
            const [, property, value] = declaration;
            if (!property || !value || !SPACING_PROPERTY.test(property)) return [];

            // Only literals are at issue; a value already inside var() is by definition tokenised.
            const literals = [...value.replace(/var\([^)]*\)/g, "").matchAll(/([0-9.]+)px/g)];
            return literals
              .filter((m) => m[1] !== undefined && byPx.has(Number(m[1])))
              .map(
                (m) =>
                  `${path.relative(srcDir, file)}:${i + 1} — ${property}: ${value.trim()} ` +
                  `(${m[1]}px is var(${byPx.get(Number(m[1]))}))`,
              );
          }),
      );

    expect(offenders).toEqual([]);
  });
});
