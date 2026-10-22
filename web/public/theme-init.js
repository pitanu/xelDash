// Applies the theme and animation choices made under Settings before the page paints, so a light or dark choice
// that differs from the system does not flash, and charts do not start animating when animations are off. Loaded as a file:
// the CSP allows no inline script.
try {
  var theme = localStorage.getItem("xeldash.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  if (localStorage.getItem("xeldash.motion") === "off") document.documentElement.dataset.motion = "off";
} catch (e) {
  // Storage unavailable: follow the system.
}
