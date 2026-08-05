import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* Radii were already almost entirely on `--radius-*` when this guard was written — the drift here
   was not literals duplicating tokens but a second idiom for the same thing: four rules said
   `border-radius: 50%` to make a circle while the rest of the app said `var(--radius-full)` for
   exactly that, on square elements of the same kind. Both render identically on a fixed square
   (9999px clamps to half the box), so nothing enforced a choice and both spread.

   This pins the choice and the scale. The one thing it deliberately allows is a radius *smaller*
   than the 4px floor: a 2px-wide rail or a 1.5px-tall tick cannot take the smallest token without
   the radius exceeding the box, and one 8px dot depends on staying square. Those are commented
   where they appear. */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const TOKEN_SOURCE = "index.css";
const RADIUS_PROPERTY = /^border(-(top|bottom)-(left|right))?-radius$/;

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  });
}

/** px value -> token name, read from index.css so the guard cannot drift from the scale. */
function radiusByPx(): Map<number, string> {
  const css = fs.readFileSync(path.join(srcDir, TOKEN_SOURCE), "utf8");
  const found = new Map<number, string>();
  for (const m of css.matchAll(/^\s*(--radius-[a-z0-9-]+)\s*:\s*([0-9.]+)px\s*;/gm)) {
    const [, name, px] = m;
    if (name && px) found.set(Number(px), name);
  }
  return found;
}

/** Every radius declaration in the shipped stylesheets, with its 1-indexed line. */
function radiusDeclarations(): { loc: string; property: string; value: string }[] {
  return cssFiles(srcDir)
    .filter((file) => path.basename(file) !== TOKEN_SOURCE)
    .flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => {
          const m = /^\s*([a-z-]+):\s*([^;]+);/.exec(line);
          const [, property, value] = m ?? [];
          if (!property || !value || !RADIUS_PROPERTY.test(property)) return [];
          return [
            { loc: `${path.relative(srcDir, file)}:${i + 1}`, property, value: value.trim() },
          ];
        }),
    );
}

describe("radius scale", () => {
  const byPx = radiusByPx();

  it("declares the scale in index.css", () => {
    // Guards the guard: a rename that emptied this map would make the checks below vacuous.
    expect(byPx.size).toBeGreaterThanOrEqual(4);
    expect(byPx.get(8)).toBe("--radius-md");
  });

  it("writes on-scale radii as tokens, not literals", () => {
    const offenders = radiusDeclarations().flatMap(({ loc, property, value }) =>
      [...value.replace(/var\([^)]*\)/g, "").matchAll(/([0-9.]+)px/g)]
        .filter((m) => m[1] !== undefined && byPx.has(Number(m[1])))
        .map((m) => `${loc} — ${property}: ${value} (${m[1]}px is var(${byPx.get(Number(m[1]))}))`),
    );

    expect(offenders).toEqual([]);
  });

  it("makes circles with --radius-full rather than a second 50% idiom", () => {
    // 50% and --radius-full are indistinguishable on a fixed square, which is why both took root.
    // One of them has to be the house spelling; --radius-full is the one the app already used.
    const offenders = radiusDeclarations()
      .filter(({ value }) => /(^|\s)50%/.test(value))
      .map(({ loc, property, value }) => `${loc} — ${property}: ${value}`);

    expect(offenders).toEqual([]);
  });
});
