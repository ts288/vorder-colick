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
    const userRequest = msg.payload;
    console.log("[Vorder] USER_REQUEST:", userRequest);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: "COLLECT_DOM" }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Vorder] DOM 수집 실패:", chrome.runtime.lastError.message);
          return;
        }
        console.log("[Vorder] USER_REQUEST:", userRequest);
        console.log("[Vorder] PAGE_STATE:", JSON.stringify(response.pageState, null, 2));
      });
    });

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

// keep-alive: idle로 인한 service worker 종료 방지
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // no-op: 알람 수신 자체가 SW를 깨운다
  }
});
