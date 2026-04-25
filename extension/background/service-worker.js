// 설치/활성화
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vorder] Extension installed");
});

chrome.runtime.onActivated?.addListener(() => {
  console.log("[Vorder] Extension activated");
});

const ACTIVATED_TABS_KEY = "activatedTabIds";
const SERVER_URL = "http://localhost:8000";

async function getActivatedTabIds() {
  const result = await chrome.storage.session.get(ACTIVATED_TABS_KEY);
  return Array.isArray(result[ACTIVATED_TABS_KEY]) ? result[ACTIVATED_TABS_KEY] : [];
}

async function markTabActivated(tabId) {
  const activatedTabIds = await getActivatedTabIds();
  if (activatedTabIds.includes(tabId)) return;
  await chrome.storage.session.set({
    [ACTIVATED_TABS_KEY]: [...activatedTabIds, tabId],
  });
}

async function unmarkTabActivated(tabId) {
  const activatedTabIds = await getActivatedTabIds();
  if (!activatedTabIds.includes(tabId)) return;
  await chrome.storage.session.set({
    [ACTIVATED_TABS_KEY]: activatedTabIds.filter((id) => id !== tabId),
  });
}

async function injectPipPanel(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab?.url || "";
  if (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:")
  ) {
    console.warn(`[Vorder] PiP injection skipped for unsupported page: ${url || "unknown"}`);
    return false;
  }

  try {
    const [{ result: hasPanel }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(document.getElementById("vorder-pip-host")),
    });
    if (hasPanel) return true;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/pip-panel.js"],
    });
    return true;
  } catch (error) {
    console.warn(`[Vorder] PiP injection failed on tab ${tabId}: ${error.message}`);
    return false;
  }
}

// 요청 상태 (SW 메모리에 유지)
let currentStep = 0;
let previousActions = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "USER_REQUEST") {
    // 새 요청 시작 → 상태 초기화
    currentStep = 0;
    previousActions = [];

    handleUserRequest(msg.payload);
    sendResponse({ status: "ok" });
    return true;
  }

  if (msg.type === "START_KEEPALIVE") {
    chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
  }

  if (msg.type === "STOP_KEEPALIVE") {
    chrome.alarms.clear("keepAlive");
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  if (tabId == null) return;

  const injected = await injectPipPanel(tabId);
  if (injected) {
    await markTabActivated(tabId);
    return;
  }

  await unmarkTabActivated(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;

  const activatedTabIds = await getActivatedTabIds();
  if (!activatedTabIds.includes(tabId)) return;

  await injectPipPanel(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  unmarkTabActivated(tabId).catch((error) => {
    console.warn(`[Vorder] Failed to clear tab activation for ${tabId}: ${error.message}`);
  });
});

async function handleUserRequest(userRequest) {
  // 1. DOM 수집
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) {
    notifyPip("APPEND_LOG", "[오류] 활성 탭을 찾을 수 없습니다.");
    notifyPip("UPDATE_STATUS", "");
    return;
  }
  const tabId = tabs[0].id;

  notifyPip("UPDATE_STATUS", "⟳ DOM 수집 중...", tabId);

  let pageState;
  try {
    const domResponse = await chrome.tabs.sendMessage(tabId, { type: "COLLECT_DOM" });
    pageState = domResponse.pageState;
  } catch (e) {
    notifyPip("APPEND_LOG", "[오류] DOM 수집 실패: " + e.message, tabId);
    notifyPip("UPDATE_STATUS", "", tabId);
    return;
  }

  // 2. 서버에 계획 요청
  notifyPip("UPDATE_STATUS", "⟳ LLM 계획 수립 중...", tabId);

  let plan;
  try {
    const res = await fetch(`${SERVER_URL}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userRequest,
        pageState,
        previousActions,
        step: currentStep,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`서버 오류 ${res.status}: ${err}`);
    }

    plan = await res.json();
  } catch (e) {
    notifyPip("APPEND_LOG", "[오류] 서버 연결 실패: " + e.message, tabId);
    notifyPip("UPDATE_STATUS", "", tabId);
    return;
  }

  // 3. 응답 처리
  console.log("[Vorder] PLAN:", JSON.stringify(plan, null, 2));

  // current_actions → 다음 요청의 previous_actions로 저장
  previousActions = plan.currentActions || [];
  currentStep++;

  notifyPip("APPEND_LOG", `[계획] ${plan.description}`, tabId);
  notifyPip("UPDATE_STATUS", plan.isComplete ? "✓ 완료" : "⟳ 실행 대기 중...", tabId);
  // Phase 5에서 plan.actions 기반 CDP 실행 추가 예정
}

function notifyPip(type, payload, targetTabId = null) {
  const sendMessage = (tabId) => {
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { type, payload }).catch(() => {});
  };

  if (targetTabId != null) {
    sendMessage(targetTabId);
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    sendMessage(tabs[0].id);
  });
}

// keep-alive
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // no-op
  }
});
