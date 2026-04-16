const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  'input:not([type="hidden"])',
  "textarea",
  "select",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  "[onclick]",
  '[tabindex]:not([tabindex="-1"])',
  "iframe",
].join(", ");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "COLLECT_DOM") {
    const pageState = collectPageState();
    sendResponse({ pageState });
    return true;
  }
});

function collectPageState() {
  const frames = collectFrames();
  const interactiveElements = collectElements();

  return {
    url: location.href,
    title: document.title,
    screenMeta: getScreenMeta(),
    frames,
    interactiveElements,
  };
}

// ── frames ──────────────────────────────────────────────────────────────────

function collectFrames() {
  const frames = [
    { frameId: "main", parentFrameId: null, url: location.href },
  ];

  const iframes = document.querySelectorAll("iframe");
  let n = 0;
  for (const iframe of iframes) {
    if (isHidden(iframe)) continue;
    frames.push({
      frameId: `frame-${n++}`,
      parentFrameId: "main",
      url: iframe.src || null,
    });
  }

  return frames;
}

// ── elements ─────────────────────────────────────────────────────────────────

function collectElements() {
  const allEls = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const visibleEls = allEls.filter((el) => !isHidden(el));

  // 500개 초과 시 inViewport 우선
  let limited = visibleEls;
  if (visibleEls.length > 500) {
    const inView = visibleEls.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
    });
    const outOfView = visibleEls.filter((el) => !inView.includes(el));
    limited = [...inView, ...outOfView].slice(0, 500);
  }

  // iframe frameId 매핑: iframe 요소 → frame-N 식별자
  const iframeFrameIds = buildIframeFrameIdMap();

  const elements = [];
  let n = 0;

  for (const el of limited) {
    const tag = el.tagName.toLowerCase();

    if (tag === "iframe") {
      elements.push({
        id: `el-${n++}`,
        frameId: "main",
        tag: "iframe",
        type: null,
        role: null,
        text: "[iframe: 자동화 미지원]",
        ariaLabel: null,
        nearbyText: null,
        placeholder: null,
        value: null,
        checked: null,
        name: null,
        required: false,
        options: null,
        selector: getSelector(el),
        enabled: false,
      });
      continue;
    }

    const element = {
      id: `el-${n++}`,
      frameId: "main",
      tag,
      type: el.type || null,
      role: el.getAttribute("role") || inferRole(el),
      text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 200),
      ariaLabel: el.getAttribute("aria-label") || null,
      nearbyText: getNearbyText(el),
      placeholder: el.placeholder || null,
      value: el.type === "password" ? "[MASKED]" : el.value || null,
      checked: el.type === "radio" || el.type === "checkbox" ? el.checked : null,
      name: el.name || null,
      required: el.required || false,
      options: null,
      selector: getSelector(el),
      enabled: !el.disabled,
    };

    if (tag === "select") {
      element.options = Array.from(el.options).map((opt) => ({
        value: opt.value,
        text: opt.text.trim(),
      }));
    }

    if (el.type === "password") {
      element.placeholder = "[비밀번호]";
    }

    elements.push(element);
  }

  return elements;
}

// iframe 요소 → frame-N 매핑 (현재는 내부 탐색 없이 구조 파악용)
function buildIframeFrameIdMap() {
  const map = new WeakMap();
  const iframes = document.querySelectorAll("iframe");
  let n = 0;
  for (const iframe of iframes) {
    if (!isHidden(iframe)) {
      map.set(iframe, `frame-${n++}`);
    }
  }
  return map;
}

// ── screenMeta ───────────────────────────────────────────────────────────────

function getScreenMeta() {
  const stepEl = document.querySelector(
    '.step-indicator, .steps, [class*="step"], [class*="wizard"]'
  );
  let currentStep = null;
  if (stepEl) {
    const stepText = stepEl.innerText.trim();
    const match = stepText.match(/(\d+\s*\/\s*\d+\s*단계|\d+\s*단계|step\s*\d+)/i);
    currentStep = match ? match[0].trim() : stepText.slice(0, 30);
  }

  const alertEls = document.querySelectorAll(
    '.error, .alert, .notice, [role="alert"], [class*="error"], [class*="alert"]'
  );
  const alerts = [];
  for (const el of alertEls) {
    const text = el.innerText.trim();
    if (!text) continue;
    const className =
      typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
    const type =
      className.includes("error") || el.getAttribute("role") === "alert"
        ? "error"
        : className.includes("warning")
          ? "warning"
          : "info";
    alerts.push({ type, text: text.slice(0, 200) });
    if (alerts.length >= 5) break;
  }

  return { currentStep, alerts };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isHidden(el) {
  const style = window.getComputedStyle(el);
  if (style.display === "none") return true;
  if (style.visibility === "hidden") return true;
  if (parseFloat(style.opacity) === 0) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  return false;
}

function getNearbyText(el) {
  const id = el.id;
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) return label.innerText.trim().slice(0, 80);
  }

  const parentLabel = el.closest("label");
  if (parentLabel) return parentLabel.innerText.trim().slice(0, 80);

  let node = el.parentElement;
  while (node && node !== document.body) {
    const heading = node.querySelector("h1, h2, h3, h4, legend");
    if (heading) return heading.innerText.trim().slice(0, 80);
    node = node.parentElement;
  }

  const prev = el.previousElementSibling;
  if (prev && prev.innerText) return prev.innerText.trim().slice(0, 50);

  return null;
}

function getSelector(el) {
  try {
    if (el.id) return `#${CSS.escape(el.id)}`;
  } catch {
    if (el.id) return `#${el.id}`;
  }

  if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
  if (el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
  if (el.dataset.id) return `[data-id="${el.dataset.id}"]`;
  if (el.getAttribute("aria-label")) {
    return `${el.tagName.toLowerCase()}[aria-label="${el.getAttribute("aria-label")}"]`;
  }

  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    const idx = siblings.indexOf(el) + 1;
    const className =
      typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
    const cls = className ? `.${className.trim().split(/\s+/)[0]}` : "";
    return `${el.tagName.toLowerCase()}${cls}:nth-child(${idx})`;
  }

  return el.tagName.toLowerCase();
}

function inferRole(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") return "textbox";
  if (tag === "select") return "listbox";
  if (tag === "textarea") return "textbox";
  return null;
}
