import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@mtss/design-tokens/tokens.css";
import "./styles/components.css";
import "./styles/sections.css";

import { render } from "solid-js/web";
import { ThemeProvider } from "./theme/ThemeProvider.js";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("root element #root is missing from index.html");

render(
  () => (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  ),
  root,
);
