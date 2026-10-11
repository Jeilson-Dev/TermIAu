// First of all: without the bridge, the first `invoke` dies with the global missing.
import "./ponte";

import { idioma } from "../i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// The HTML `lang` is fixed; the right one is the system's (see src/i18n).
document.documentElement.lang = idioma();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
