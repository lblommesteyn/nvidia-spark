import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import { AuthGate } from "./components/AuthGate";
import { api, AUTH_EXPIRED_EVENT, getSessionToken } from "./services/api";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

// Real routing: the dashboard only mounts on the /app route. On the landing
// route ("/") this entry does nothing and main.ts runs the marketing page.
const isAppRoute = window.location.pathname.replace(/\/+$/, "") === "/app";

/**
 * Gate the terminal behind onboarding. On load we validate any stored session
 * token; a valid token drops straight into the dashboard, otherwise the
 * multi-step AuthGate collects business info and mints one. A 401 mid-session
 * (expired/rotated token) drops back to the gate.
 */
function Root() {
  const [state, setState] = useState<"checking" | "gate" | "app">("checking");

  useEffect(() => {
    let cancelled = false;
    const token = getSessionToken();
    if (!token) {
      setState("gate");
      return;
    }
    api
      .session()
      .then(() => { if (!cancelled) setState("app"); })
      .catch(() => { if (!cancelled) setState("gate"); });

    const onExpired = () => setState("gate");
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => {
      cancelled = true;
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
    };
  }, []);

  if (state === "checking") {
    return <div class="auth-gate"><div class="auth-checking">Verifying access…</div></div>;
  }
  if (state === "gate") {
    return <AuthGate onAuthed={() => setState("app")} />;
  }
  return <App />;
}

if (isAppRoute) {
  document.body.classList.add("route-app");
  // Drop the landing boot overlay and reveal the dashboard container.
  document.getElementById("boot")?.remove();
  const terminalApp = document.getElementById("terminal-app");
  terminalApp?.setAttribute("aria-hidden", "false");
  render(<Root />, document.getElementById("react-root")!);
}
