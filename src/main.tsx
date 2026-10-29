import ReactDOM from "react-dom/client";
import "@fontsource/barlow-semi-condensed/400.css";
import "@fontsource/barlow-semi-condensed/500.css";
import "@fontsource/barlow-semi-condensed/600.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { platform } from "./lib/platform";
import { applyInterface, loadSettings } from "./lib/settings";
import { applyTheme, themeById } from "./lib/themes";
import App from "./App";

document.documentElement.dataset.platform = platform;

// The settings come first, so the first frame already has the right theme.
void loadSettings().then((settings) => {
  applyTheme(themeById(settings.theme));
  applyInterface(settings);
  // No StrictMode: its double-mount in development would start every shell twice.
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App initialSettings={settings} />);
});
