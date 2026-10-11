// First of all: without the bridge, the first `invoke` dies with the global missing.
import "./ponte";

import { idioma } from "../i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PrefsFlutuantes } from "./components/Prefs";

// The HTML `lang` is fixed; the right one is the system's (see src/i18n).
document.documentElement.lang = idioma();

// `?prefs`: only the preferences, over a transparent page — TermIAu shows it floating
// over whatever tab is on screen (see `abrirPreferencias` in src/main.ts).
const soPrefs = new URLSearchParams(location.search).has("prefs");
if (soPrefs) document.documentElement.classList.add("so-prefs");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{soPrefs ? <PrefsFlutuantes /> : <App />}</React.StrictMode>,
);
