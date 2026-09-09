import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { IntegrationMaintenance } from "./IntegrationMaintenance";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <IntegrationMaintenance />
  </React.StrictMode>,
);
