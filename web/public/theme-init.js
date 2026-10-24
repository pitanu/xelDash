// Applies the theme, colour and animation choices made under Settings before the page paints, so a light or dark choice
// that differs from the system, or a colour theme other than the default, does not flash, and charts do not start animating when
// animations are off. Loaded as a file: the CSP allows no inline script.
try {
  var theme = localStorage.getItem("xeldash.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  var palette = localStorage.getItem("xeldash.palette");
  if (palette === "ember" || palette === "glacier" || palette === "amethyst" || palette === "terminal") document.documentElement.dataset.palette = palette;
  if (localStorage.getItem("xeldash.motion") === "off") document.documentElement.dataset.motion = "off";
  // A main colour of the person's own: the variables worked out when it was picked, each a plain #rrggbb colour or nothing is applied.
  var accent = localStorage.getItem("xeldash.accent");
  var vars = JSON.parse(localStorage.getItem("xeldash.accent-vars") || "null");
  if (accent && /^#[0-9a-f]{6}$/i.test(accent) && vars && typeof vars === "object") {
    var names = Object.keys(vars);
    var valid = names.length === 6 && names.every(function (n) { return /^--custom-accent(-soft|-ink)?(-dark)?$/.test(n) && /^#[0-9a-f]{6}$/i.test(vars[n]); });
    if (valid) {
      names.forEach(function (n) { document.documentElement.style.setProperty(n, vars[n]); });
      document.documentElement.dataset.accent = "custom";
      document.documentElement.dataset.accentColor = accent;
    }
  }
} catch (e) {
  // Storage unavailable: follow the system, in the default colours.
}
