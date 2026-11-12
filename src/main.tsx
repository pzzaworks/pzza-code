import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { IntegrationMaintenance } from "./IntegrationMaintenance";
import { preloadForFirstWindow } from "./lazySurfaces";
import { startLocalSessionGuard } from "./state/sessionRefresh";
import "./styles/global.css";

// Before any tile can attach: sessions a replaced terminal server lost come
// back first (see sessionRefresh).
startLocalSessionGuard();

// The first render waits for any split-off code the first window shows (setup
// on first launch, open editors), so it looks exactly as it would unsplit.
void preloadForFirstWindow().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
      <IntegrationMaintenance />
    </React.StrictMode>,
  );
});
