// jsdom has no layout: scrolling does nothing, and would otherwise log "Not implemented" on every page change.
window.scrollTo = () => undefined;
