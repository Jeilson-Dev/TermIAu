// Antes de tudo: sem a ponte, o primeiro `invoke` morre com o global ausente.
import "./ponte";

import { idioma } from "../i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// O `lang` do HTML vem fixo; o certo é o do sistema (ver src/i18n).
document.documentElement.lang = idioma();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
