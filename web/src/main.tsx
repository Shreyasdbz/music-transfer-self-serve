import { render } from "solid-js/web";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("root element #root is missing from index.html");

render(() => <App />, root);
