/**
 * Geometry shared between the rendered {@link TableNode} and the elk layout pass.
 * Keeping these in one place means auto-arrange reserves the same box size the DOM
 * actually paints, so nodes don't overlap after "Auto-arrange".
 */
export const NODE_WIDTH = 220;
export const HEADER_HEIGHT = 40;
export const FIELD_ROW_HEIGHT = 30;
export const ADD_FIELD_HEIGHT = 34;

export function tableNodeHeight(fieldCount: number): number {
  return HEADER_HEIGHT + fieldCount * FIELD_ROW_HEIGHT + ADD_FIELD_HEIGHT;
}
