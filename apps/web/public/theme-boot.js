// Before anything paints: the theme chosen on an earlier visit (src/theme.ts keeps it; the CSP allows only files, so
// this is one, loaded by index.html's head). Nothing chosen: the system's preference, as styles.css reads it.
(function () {
  try {
    var theme = window.localStorage.getItem('pengepassportph-theme');
    if (theme !== 'light' && theme !== 'dark') return;
    document.documentElement.setAttribute('data-theme', theme);
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', theme === 'dark' ? '#101412' : '#ffffff');
  } catch (e) {
    // Storage refused: the system's preference.
  }
})();
