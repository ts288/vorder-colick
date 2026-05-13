(function () {
  if (document.getElementById("vorder-overlay-host")) return;

  const OVERLAY_CSS = `#overlay-container {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
  pointer-events: none;
}

.highlight-box {
  border: 3px solid #f59e0b;
  border-radius: 4px;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.3);
  animation: vorder-pulse 1.2s ease-in-out infinite;
}

@keyframes vorder-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.3); }
  50% { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0.1); }
}

.highlight-label {
  position: absolute;
  top: -24px;
  left: 0;
  background: #f59e0b;
  color: #000;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
}

.overlay-panel {
  position: fixed;
  bottom: 100px;
  right: 20px;
  background: #1e1e2e;
  color: #cdd6f4;
  border: 1px solid #f59e0b;
  border-radius: 8px;
  padding: 16px;
  width: 240px;
  pointer-events: all;
  z-index: 2147483647;
  font-family: system-ui, sans-serif;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}

.overlay-message {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-line;
}

.overlay-done-btn {
  width: 100%;
  padding: 8px;
  background: #f59e0b;
  color: #000;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.overlay-done-btn:hover {
  background: #d97706;
}`;

  const host = document.createElement("div");
  host.id = "vorder-overlay-host";
  host.style.cssText = "position: absolute; top: 0; left: 0; width: 0; height: 0; overflow: visible; pointer-events: none; z-index: 2147483645;";

  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = OVERLAY_CSS;
  shadow.appendChild(styleEl);

  const container = document.createElement("div");
  container.id = "overlay-container";
  shadow.appendChild(container);
  document.documentElement.appendChild(host);

  const FIELD_SELECTOR = "input, textarea, select";
  const ACTIONABLE_SELECTOR = "input, textarea, select, button, a";
  const MUTATION_DEBOUNCE_MS = 300;

  let observer = null;
  let iframeObservers = [];
  let abortController = null;
  let debounceTimer = null;
  let targetStates = new Map();
  let panelMessageEl = null;
  let currentIsLogin = false;
  let lastIframeClickAt = 0;

  function isFieldFilled(domEl) {
    if (!domEl) return false;

    const tagName = domEl.tagName?.toLowerCase();
    if (tagName === "select") return domEl.value !== "";
    if (tagName === "textarea") return domEl.value.trim() !== "";
    if (tagName !== "input") return false;

    const inputType = (domEl.type || "").toLowerCase();
    if (inputType === "password") return domEl.value.length > 0;
    return domEl.value.trim() !== "";
  }

  function findDomElement(rect) {
    if (!rect) return null;

    const el = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!el) return null;
    if (el.matches?.(ACTIONABLE_SELECTOR)) return el;
    return el.closest?.(ACTIONABLE_SELECTOR) || null;
  }

  function getRemainingTargets() {
    return [...targetStates.values()].filter((state) => !state.filled);
  }

  function updatePanelMessage(isLogin) {
    if (!panelMessageEl || isLogin) return;

    const remainingTargets = getRemainingTargets();
    if (remainingTargets.length === 0) {
      panelMessageEl.textContent = "모든 필드 입력이 완료되었습니다.";
      return;
    }

    panelMessageEl.textContent = `아래 항목을 직접 진행해주세요:\n${remainingTargets
      .map((state) => state.target.label || state.target.name)
      .join(", ")}`;
  }

  function cleanupOverlayState() {
    observer?.disconnect();
    observer = null;

    iframeObservers.forEach((iframeObserver) => iframeObserver.disconnect());
    iframeObservers = [];

    abortController?.abort();
    abortController = null;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    targetStates = new Map();
    panelMessageEl = null;
  }

  function onFieldFilled(index, isLogin) {
    const state = targetStates.get(index);
    if (!state || state.filled) return;

    state.filled = true;
    state.boxEl?.remove();
    state.boxEl = null;
    updatePanelMessage(isLogin);

    if ([...targetStates.values()].every((targetState) => targetState.filled)) {
      chrome.runtime.sendMessage({ type: "OVERLAY_COMPLETE" });
      remove();
    }
  }

  function isModalNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.tagName?.toLowerCase() === "dialog") return true;

    const role = node.getAttribute?.("role");
    if (role === "dialog" || role === "alertdialog") return true;
    if (node.getAttribute?.("aria-modal") === "true") return true;

    const cls = typeof node.className === "string" ? node.className : "";
    if (/\bmodal-backdrop\b/.test(cls)) return true;

    return false;
  }

  function hasModalInAddedNodes(mutations) {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      if (mutation.target === host) continue;

      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (isModalNode(node)) return true;

        try {
          if (node.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog')) {
            return true;
          }
        } catch (_) {}
      }
    }

    return false;
  }

  function attachIframeObserver(iframeEl) {
    let doc;
    try {
      doc = iframeEl.contentDocument;
    } catch (_) {
      return;
    }

    if (!doc || doc.location.href === "about:blank" || !doc.body) {
      iframeEl.addEventListener(
        "load",
        () => attachIframeObserver(iframeEl),
        { once: true, signal: abortController.signal }
      );
      return;
    }

    doc.addEventListener(
      "click",
      () => {
        lastIframeClickAt = Date.now();
      },
      { capture: true, signal: abortController.signal }
    );

    const iframeObserver = new MutationObserver((mutations) => {
      const hasChildListChange = mutations.some(
        (mutation) => mutation.type === "childList" &&
          (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)
      );
      const afterClick = Date.now() - lastIframeClickAt < 700;
      if (!hasChildListChange) return;

      if (currentIsLogin || afterClick) {
        chrome.runtime.sendMessage({ type: "OVERLAY_DISMISSED_BY_DOM" });
        remove();
        return;
      }

      const anyGone = [...targetStates.values()].some(
        (state) => state.domEl && !state.domEl.isConnected
      );
      if (!anyGone) return;

      chrome.runtime.sendMessage({ type: "OVERLAY_DISMISSED_BY_DOM" });
      remove();
    });

    iframeObserver.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "disabled", "aria-hidden"],
    });
    iframeObservers.push(iframeObserver);
  }

  function setupMutationObserver() {
    const observedRoot = document.body;
    if (!observedRoot) return;

    observer = new MutationObserver((mutations) => {
      if (hasModalInAddedNodes(mutations)) {
        chrome.runtime.sendMessage({ type: "OVERLAY_DISMISSED_BY_DOM" });
        remove();
        return;
      }

      const relevant = mutations.some((mutation) => {
        if (mutation.type !== "childList") return false;
        if (mutation.target === host) return false;
        return true;
      });
      if (!relevant) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const anyGone = [...targetStates.values()].some(
          (state) => state.domEl && !state.domEl.isConnected
        );
        if (!anyGone) return;

        chrome.runtime.sendMessage({ type: "OVERLAY_DISMISSED_BY_DOM" });
        remove();
      }, MUTATION_DEBOUNCE_MS);
    });

    observer.observe(observedRoot, { childList: true, subtree: true, attributes: false });

    document.querySelectorAll("iframe").forEach((iframeEl) => {
      attachIframeObserver(iframeEl);
    });
  }

  function render({ targets, isLogin }) {
    cleanupOverlayState();
    currentIsLogin = isLogin;
    container.innerHTML = "";
    abortController = new AbortController();
    targetStates = new Map();

    targets.forEach((target, index) => {
      if (!target.rect) return;

      const domEl = findDomElement(target.rect);
      const filled = isFieldFilled(domEl);
      let boxEl = null;

      if (!filled) {
        boxEl = document.createElement("div");
        boxEl.className = "highlight-box";
        boxEl.style.cssText = `
          position: absolute;
          left: ${target.rect.x}px; top: ${target.rect.y}px;
          width: ${target.rect.width}px; height: ${target.rect.height}px;
          pointer-events: none; z-index: 2147483646;
        `;

        const label = document.createElement("div");
        label.className = "highlight-label";
        label.textContent = target.label || target.name;
        boxEl.appendChild(label);
        container.appendChild(boxEl);
      }

      targetStates.set(index, { boxEl, domEl, filled, target });

      if (!domEl || filled || !domEl.matches?.(FIELD_SELECTOR)) return;

      const eventType = domEl.tagName?.toLowerCase() === "select" ? "change" : "input";
      domEl.addEventListener(
        eventType,
        () => {
          if (isFieldFilled(domEl)) onFieldFilled(index, isLogin);
        },
        { signal: abortController.signal }
      );
    });

    const panel = document.createElement("div");
    panel.className = "overlay-panel";

    const msg = document.createElement("p");
    msg.className = "overlay-message";
    panelMessageEl = msg;
    msg.textContent = isLogin ? "로그인 방식을 선택해주세요." : "";
    panel.appendChild(msg);

    if (!isLogin) {
      const btn = document.createElement("button");
      btn.className = "overlay-done-btn";
      btn.textContent = "입력 완료";
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "OVERLAY_COMPLETE" });
        remove();
      });
      panel.appendChild(btn);
    }

    container.appendChild(panel);
    updatePanelMessage(isLogin);
    setupMutationObserver();
    window.addEventListener(
      'vorder-popup-opened',
      () => {
        chrome.runtime.sendMessage({ type: "OVERLAY_DISMISSED_BY_DOM" });
        remove();
      },
      { once: true, signal: abortController.signal }
    );

    if (!isLogin && targetStates.size > 0 && [...targetStates.values()].every((state) => state.filled)) {
      chrome.runtime.sendMessage({ type: "OVERLAY_COMPLETE" });
      remove();
      return;
    }

    if (!isLogin) {
      const firstActiveState = [...targetStates.values()].find((state) => !state.filled && state.domEl);
      firstActiveState?.domEl?.focus();
    }
  }

  function remove() {
    cleanupOverlayState();
    chrome.runtime.onMessage.removeListener(handleMessage);
    host.remove();
  }

  function handleMessage(msg) {
    if (msg.type === "SHOW_OVERLAY") render(msg.payload);
    if (msg.type === "HIDE_OVERLAY") remove();
  }

  chrome.runtime.onMessage.addListener(handleMessage);
})();
