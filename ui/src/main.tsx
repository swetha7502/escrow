import { createRoot } from "react-dom/client";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/800.css";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { startBackend } from "./lib/backend";

startBackend();
createRoot(document.getElementById("root")!).render(<App />);
