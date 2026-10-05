// jsdom has no layout: scrolling does nothing, and would otherwise log "Not implemented" on every page change.
window.scrollTo = () => undefined;

// jsdom has no matchMedia: the sheet calls it through detectContext.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}
