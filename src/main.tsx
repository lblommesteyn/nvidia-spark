import { render } from "preact";
import { App } from "./App";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

// Real routing: the dashboard only mounts on the /app route. On the landing
// route ("/") this entry does nothing and main.ts runs the marketing page.
const isAppRoute = window.location.pathname.replace(/\/+$/, "") === "/app";

if (isAppRoute) {
  document.body.classList.add("route-app");
  // Drop the landing boot overlay and reveal the dashboard container.
  document.getElementById("boot")?.remove();
  const terminalApp = document.getElementById("terminal-app");
  terminalApp?.setAttribute("aria-hidden", "false");
  render(<App />, document.getElementById("react-root")!);
}
