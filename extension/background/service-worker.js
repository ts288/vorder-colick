// 설치/활성화
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vorder] Extension installed");
});

chrome.runtime.onActivated?.addListener(() => {
  console.log("[Vorder] Extension activated");
});

// PiP 패널에서 오는 메시지 수신
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "USER_REQUEST") {
    console.log("[Vorder] USER_REQUEST received:", msg.payload);
    // Phase 4에서 실제 오케스트레이션 연결
    sendResponse({ status: "ok" });
  }

  if (msg.type === "START_KEEPALIVE") {
    chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
  }

  if (msg.type === "STOP_KEEPALIVE") {
    chrome.alarms.clear("keepAlive");
  }
});

// keep-alive: idle로 인한 service worker 종료 방지
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // no-op: 알람 수신 자체가 SW를 깨운다
  }
});
