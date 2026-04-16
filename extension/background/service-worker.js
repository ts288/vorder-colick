// 설치/활성화
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vorder] Extension installed");
});

chrome.runtime.onActivated?.addListener(() => {
  console.log("[Vorder] Extension activated");
});

const SERVER_URL = "http://localhost:8000";

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

async function handleUserRequest(userRequest) {
  notifyPip("UPDATE_STATUS", "⟳ DOM 수집 중...");

  // 1. DOM 수집
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) {
    notifyPip("APPEND_LOG", "[오류] 활성 탭을 찾을 수 없습니다.");
    notifyPip("UPDATE_STATUS", "");
    return;
  }

  let pageState;
  try {
    const domResponse = await chrome.tabs.sendMessage(tabs[0].id, { type: "COLLECT_DOM" });
    pageState = domResponse.pageState;
  } catch (e) {
    notifyPip("APPEND_LOG", "[오류] DOM 수집 실패: " + e.message);
    notifyPip("UPDATE_STATUS", "");
    return;
  }

  // 2. 서버에 계획 요청
  notifyPip("UPDATE_STATUS", "⟳ LLM 계획 수립 중...");

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
    notifyPip("APPEND_LOG", "[오류] 서버 연결 실패: " + e.message);
    notifyPip("UPDATE_STATUS", "");
    return;
  }

  // 3. 응답 처리
  console.log("[Vorder] PLAN:", JSON.stringify(plan, null, 2));

  // current_actions → 다음 요청의 previous_actions로 저장
  previousActions = plan.currentActions || [];
  currentStep++;

  notifyPip("APPEND_LOG", `[계획] ${plan.description}`);
  notifyPip("UPDATE_STATUS", plan.isComplete ? "✓ 완료" : "⟳ 실행 대기 중...");
  // Phase 5에서 plan.actions 기반 CDP 실행 추가 예정
}

function notifyPip(type, payload) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type, payload });
  });
}

// keep-alive
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // no-op
  }
});
