const DEFAULT_STATE = {
  minimized: false,
  position: { x: 20, y: 20 },
  inputValue: "",
  logs: [],
};

init();

async function init() {
  if (window !== window.top) {
    return; // iframe 에서는 실행 안 함
  }
  if (document.getElementById("vorder-pip-host")) {
    return;
  }

  const styleText = await loadStyles();
  try {
    chrome.storage.local.get(["pipState"], (result) => {
      if (chrome.runtime.lastError) {
        createPanel(DEFAULT_STATE, styleText);
        return;
      }
      const pipState = (result && result.pipState) || DEFAULT_STATE;
      createPanel(pipState, styleText);
    });
  } catch {
    createPanel(DEFAULT_STATE, styleText);
  }
}

async function loadStyles() {
  const response = await fetch(chrome.runtime.getURL("styles/pip-panel.css"));
  return response.text();
}

function createPanel(savedState, styleText) {
  const pipState = normalizeState(savedState);
  const host = document.createElement("div");
  host.id = "vorder-pip-host";

  const shadowRoot = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = styleText;
  shadowRoot.appendChild(styleEl);

  const container = document.createElement("div");
  container.id = "pip-container";
  container.style.right = `${pipState.position.x}px`;
  container.style.bottom = `${pipState.position.y}px`;

  const header = document.createElement("div");
  header.id = "pip-header";

  const title = document.createElement("span");
  title.id = "pip-title";
  title.textContent = "Vorder";

  const controls = document.createElement("div");
  controls.id = "pip-controls";

  const minimizeBtn = document.createElement("button");
  minimizeBtn.id = "pip-minimize";

  const closeBtn = document.createElement("button");
  closeBtn.id = "pip-close";
  closeBtn.textContent = "✕";

  controls.appendChild(minimizeBtn);
  controls.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(controls);

  const body = document.createElement("div");
  body.id = "pip-body";

  const statusEl = document.createElement("div");
  statusEl.id = "pip-status";

  const logEl = document.createElement("div");
  logEl.id = "pip-log";

  const inputRow = document.createElement("div");
  inputRow.id = "pip-input-row";

  const input = document.createElement("textarea");
  input.id = "pip-input";
  input.placeholder = "무엇을 도와드릴까요?";
  input.value = pipState.inputValue;

  const sendBtn = document.createElement("button");
  sendBtn.id = "pip-send";
  sendBtn.textContent = "전송";

  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);

  body.appendChild(statusEl);
  body.appendChild(logEl);
  body.appendChild(inputRow);

  container.appendChild(header);
  container.appendChild(body);
  shadowRoot.appendChild(container);
  document.body.appendChild(host);

  renderLogs(logEl, pipState.logs);
  applyMinimizedState();

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startRight = 20;
  let startBottom = 20;

  header.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startRight = parseInt(container.style.right, 10) || 20;
    startBottom = parseInt(container.style.bottom, 10) || 20;
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) {
      return;
    }

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    container.style.right = `${startRight - dx}px`;
    container.style.bottom = `${startBottom - dy}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) {
      return;
    }

    dragging = false;
    savePosition();
  });

  minimizeBtn.addEventListener("click", () => {
    pipState.minimized = !pipState.minimized;
    applyMinimizedState();
    saveState();
  });

  closeBtn.addEventListener("click", () => {
    host.remove();
    try { chrome.storage.local.remove("pipState"); } catch { /* storage unavailable */ }
  });

  sendBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) {
      return;
    }

    if (!chrome.runtime?.id) {
      appendLog("[오류] 익스텐션이 재로드됐습니다. 페이지를 새로고침해주세요.");
      return;
    }
    appendLog(`[요청] ${text}`);
    chrome.runtime.sendMessage({ type: "USER_REQUEST", payload: text });
    input.value = "";
    saveInputValue("");
  });

  input.addEventListener("input", () => {
    saveInputValue(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "UPDATE_STATUS") {
      statusEl.textContent = msg.payload;
    }
    if (msg.type === "APPEND_LOG") {
      appendLog(msg.payload);
    }
  });

  function applyMinimizedState() {
    if (pipState.minimized) {
      body.style.display = "none";
      container.style.height = `${header.offsetHeight}px`;
      minimizeBtn.textContent = "□";
      return;
    }

    body.style.display = "flex";
    container.style.height = "auto";
    minimizeBtn.textContent = "─";
  }

  function appendLog(message) {
    const item = document.createElement("div");
    item.className = "log-item";
    item.textContent = message;
    logEl.prepend(item);
    logEl.scrollTop = 0;
    pipState.logs = [message, ...pipState.logs].slice(0, 50);
    saveState();
  }

  function renderLogs(target, logs) {
    logs.forEach((message) => {
      const item = document.createElement("div");
      item.className = "log-item";
      item.textContent = message;
      target.appendChild(item);
    });
  }

  function saveInputValue(value) {
    pipState.inputValue = value;
    saveState();
  }

  function savePosition() {
    pipState.position = {
      x: parseInt(container.style.right, 10) || 20,
      y: parseInt(container.style.bottom, 10) || 20,
    };
    saveState();
  }

  function saveState() {
    try { chrome.storage.local.set({ pipState }); } catch { /* storage unavailable */ }
  }
}

function normalizeState(state) {
  return {
    minimized: state?.minimized ?? DEFAULT_STATE.minimized,
    position: {
      x: state?.position?.x ?? DEFAULT_STATE.position.x,
      y: state?.position?.y ?? DEFAULT_STATE.position.y,
    },
    inputValue: state?.inputValue ?? DEFAULT_STATE.inputValue,
    logs: Array.isArray(state?.logs) ? state.logs.slice(0, 50) : [],
  };
}
