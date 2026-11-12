import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { IntegrationMaintenance } from "./IntegrationMaintenance";
import { preloadForFirstWindow } from "./lazySurfaces";
import { startLocalSessionGuard, useSessionRefresh } from "./state/sessionRefresh";
import { watchLocalSessionWork } from "./state/localSessionWork";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles/global.css";

// Quit, window close and restarts wait while local sessions are refreshed or
// restored, including the launch check that starts right below.
watchLocalSessionWork(useSessionRefresh);

// Before any tile can attach: sessions a replaced terminal server lost come
// back first (see sessionRefresh).
startLocalSessionGuard();

// The first render waits for any split-off code the first window shows (setup
// on first launch, open editors), so it looks exactly as it would unsplit.
// A render error anywhere in the window ends up in a recoverable screen
// instead of a blank window (parts of it have their own boundaries too).
void preloadForFirstWindow().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary label="PzzaCode" variant="screen">
        <App />
      </ErrorBoundary>
      <ErrorBoundary label="Integration upkeep" variant="quiet">
        <IntegrationMaintenance />
      </ErrorBoundary>
    </React.StrictMode>,
  );
});
