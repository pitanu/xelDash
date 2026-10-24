import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
// The fonts ship with the dashboard (no font service), so it looks the same on a LAN without internet.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
import { consumeTokenFromUrl } from "./session-token.js";

consumeTokenFromUrl();

createRoot(/** @type {HTMLElement} */ (document.getElementById("root"))).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
