(() => {
  const toggle = document.querySelector("#terminal-toggle");
  const overlay = document.querySelector("#terminal-overlay");
  const closeButton = document.querySelector("#terminal-close");
  const frame = document.querySelector("#terminal-frame");
  if (!toggle || !overlay || !closeButton || !frame) return;

  // Scale the cross-origin terminal without reloading its live shell session.
  const storageKey = "html-course-player-terminal-scale";
  const defaultScale = 150;
  let scale = defaultScale;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= 100 && saved <= 250) scale = Math.round(saved / 25) * 25;
  } catch { /* File-mode or restricted storage: keep an in-memory preference. */ }

  const viewport = document.createElement("div");
  viewport.className = "terminal-viewport";
  viewport.style.cssText = "position:relative;min-height:0;min-width:0;overflow:hidden;";
  frame.before(viewport);
  viewport.append(frame);
  frame.style.position = "absolute";
  frame.style.inset = "0 auto auto 0";
  frame.style.transformOrigin = "top left";
  overlay.style.gridTemplateRows = "auto minmax(0, 1fr)";

  const header = overlay.querySelector("header");
  header.style.cssText += ";min-height:58px;gap:10px;flex-wrap:wrap;padding:8px 16px;box-sizing:border-box;";
  const controls = document.createElement("div");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "终端字号调节");
  controls.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
  const output = document.createElement("output");
  output.setAttribute("aria-live", "polite");
  output.style.cssText = "min-width:92px;text-align:center;font-size:16px;color:#d8f3ff;";
  function button(label, title, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.title = title;
    element.setAttribute("aria-label", title);
    element.addEventListener("click", action);
    return element;
  }
  const smaller = button("A−", "减小终端字号", () => setScale(scale - 25));
  const larger = button("A+", "增大终端字号", () => setScale(scale + 25));
  const reset = button("重置", "恢复终端默认字号150%", () => setScale(defaultScale));
  closeButton.before(controls);
  controls.append(smaller, output, larger, reset, closeButton);

  let fullscreen = false;
  const sizeToggle = button("全屏", "切换终端全屏或窗口模式", () => {
    fullscreen = !fullscreen;
    setWindowMode();
  });
  closeButton.before(sizeToggle);
  function setWindowMode() {
    Object.assign(overlay.style, {
      inset: "auto",
      left: fullscreen ? "0" : "7vw",
      top: fullscreen ? "0" : "12vh",
      width: fullscreen ? "100vw" : "86vw",
      height: fullscreen ? "100vh" : "76vh",
      minWidth: fullscreen ? "0" : "min(540px, 96vw)",
      minHeight: fullscreen ? "0" : "min(260px, 90vh)",
      maxWidth: fullscreen ? "100vw" : "92vw",
      maxHeight: fullscreen ? "100vh" : "87vh",
      resize: fullscreen ? "none" : "both",
      overflow: "hidden",
      borderRadius: fullscreen ? "0" : "12px",
      border: fullscreen ? "0" : "1px solid #4285a6",
      boxShadow: fullscreen ? "none" : "0 18px 70px #0009",
      boxSizing: "border-box",
    });
    sizeToggle.textContent = fullscreen ? "窗口" : "全屏";
    sizeToggle.setAttribute("aria-pressed", String(fullscreen));
  }
  setWindowMode();

  function setScale(value) {
    scale = Math.min(250, Math.max(100, value));
    const factor = scale / 100;
    frame.style.width = `${100 / factor}%`;
    frame.style.height = `${100 / factor}%`;
    frame.style.transform = `scale(${factor})`;
    output.textContent = `字号 ${scale}%`;
    smaller.disabled = scale === 100;
    larger.disabled = scale === 250;
    smaller.style.opacity = smaller.disabled ? "0.4" : "1";
    larger.style.opacity = larger.disabled ? "0.4" : "1";
    try { localStorage.setItem(storageKey, String(scale)); } catch { /* Optional persistence. */ }
  }
  setScale(scale);

  function openTerminal() {
    if (!frame.src) frame.src = frame.dataset.src;
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    toggle.setAttribute("aria-expanded", "true");
    Reveal.configure({ keyboard: false });
    setTimeout(() => frame.focus(), 80);
  }

  function closeTerminal() {
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    toggle.setAttribute("aria-expanded", "false");
    Reveal.configure({ keyboard: true });
    toggle.focus();
  }

  toggle.addEventListener("click", openTerminal);
  closeButton.addEventListener("click", closeTerminal);
  window.addEventListener("keydown", (event) => {
    if (event.altKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      overlay.hidden ? openTerminal() : closeTerminal();
    }
  }, true);
  if (new URLSearchParams(window.location.search).get("terminal") === "open") openTerminal();
})();
