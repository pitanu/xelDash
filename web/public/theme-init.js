// Applies the theme chosen under Settings before the page paints, so a light or dark choice
// that differs from the system does not flash. Loaded as a file: the CSP allows no inline script.
try {
  var theme = localStorage.getItem("xeldash.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (e) {
  // Storage unavailable: follow the system.
}
