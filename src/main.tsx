import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Chromium < 84 不支持 flex 容器上的 gap，退化时交给 CSS 用 margin 兜底。
(function markFlexGapSupport() {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;top:-9999px;left:-9999px;display:flex;flex-direction:column;row-gap:4px";
  const first = document.createElement("div");
  const second = document.createElement("div");
  first.style.height = "2px";
  second.style.height = "2px";
  probe.appendChild(first);
  probe.appendChild(second);
  document.body.appendChild(probe);
  const supported = probe.scrollHeight === 8;
  probe.remove();
  if (!supported) {
    document.documentElement.classList.add("no-flex-gap");
  }
})();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().show())
    .catch(() => {
      // 显示失败时由后端兜底显示窗口。
    });
}
