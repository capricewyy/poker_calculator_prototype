// ──────────────────────────────────────────
//  REFRESH SHIM
//  Breaks the circular import between main.js and the UI modules.
//  main.js registers `renderAll` here on init; UI modules call
//  renderAll() through this module.
// ──────────────────────────────────────────
let renderAllFn = () => {};

export function registerRenderAll(fn) {
  renderAllFn = fn;
}

export function renderAll() {
  renderAllFn();
}
