/**
 * Wait for a painted frame, so a state we just set is actually seen before we block the main
 * thread on parsing.
 *
 * Parsing is synchronous CPU work. Without a yield between files, every row's "parsing" state is
 * set and replaced inside one long frame and the user sees a freeze followed by a finished list.
 *
 * The timeout is not belt-and-braces: `requestAnimationFrame` does not fire while the tab is
 * hidden, so without it, switching away mid-parse strands the queue on whichever file was in
 * flight and it never settles. Whichever fires first wins.
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(done));
    window.setTimeout(done, 50);
  });
}
