// 설치/활성화
chrome.runtime.onInstalled.addListener(() => {});

chrome.runtime.onActivated?.addListener(() => {});

const ACTIVATED_TABS_KEY = "activatedTabIds";
const SERVER_URL = "http://localhost:8000";
const MAX_STEPS = 20;
const MAX_CONSECUTIVE_DOM_STALE = 3;
const MAX_CONSECUTIVE_REPEAT = 2;
const ACTION_DELAY_MS = 300;
const PAGE_LOAD_TIMEOUT_MS = 10000;
const DOM_CHANGE_ACTION_TYPES = new Set(["click", "type", "select"]);
const INTERACTIVE_TAGS = new Set(["button", "a", "input", "textarea", "select", "iframe"]);
const CLICKABLE_ROLES = new Set(["button", "link", "tab", "menuitem"]);
const logBuffer = [];

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
    return false;
  }
}

class DomStaleError extends Error {
  constructor(reason, target) {
    super(`DOM stale: ${reason} (${target ?? "unknown"})`);
    this.name = "DomStaleError";
    this.reason = reason;
    this.target = target;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "USER_REQUEST") {
    runAutomationLoop(msg.payload).catch((e) => {
      notifyPip("APPEND_LOG", "[오류] 루프 실패: " + e.message, sender.tab?.id ?? null);
      notifyPip("UPDATE_STATUS", "", sender.tab?.id ?? null);
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
  if (msg.type === "GET_LOG_BUFFER") {
    sendResponse({ logs: logBuffer.slice() });
    return true;
  }
  if (msg.type === "CLEAR_LOG_BUFFER") {
    logBuffer.splice(0, logBuffer.length);
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
  });
});

async function runAutomationLoop(userRequest) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) {
    notifyPip("APPEND_LOG", "[오류] 활성 탭을 찾을 수 없습니다.");
    return;
  }
  const tabId = tabs[0].id;

  chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });

  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
    notifyPip("APPEND_LOG", "[연결] debugger attached", tabId);
  } catch (e) {
    if (String(e.message || e).includes("already attached")) {
      attached = true;
      notifyPip("APPEND_LOG", "[연결] debugger 이미 연결됨", tabId);
    } else {
      notifyPip("APPEND_LOG", "[오류] debugger 연결 실패: " + e.message, tabId);
      chrome.alarms.clear("keepAlive");
      return;
    }
  }

  const attachedIframeTargetIds = new Set();
  try {
    const debuggee = { tabId };
    await ensureCdpDomains(debuggee);

    let step = 0;
    let allPreviousActions = [];
    let consecutiveDomStale = 0;
    let lastActionKey = null;
    let lastActionRepeatCount = 0;

    while (step < MAX_STEPS) {
      notifyPip("UPDATE_STATUS", `⟳ DOM 수집 중... (${step + 1}/${MAX_STEPS})`, tabId);
      for (const targetId of attachedIframeTargetIds) {
        try { await chrome.debugger.detach({ targetId }); } catch (_) {}
      }
      attachedIframeTargetIds.clear();
      let pageState;
      try {
        pageState = await collectPageStateViaCdp(tabId, attachedIframeTargetIds);
      } catch (e) {
        notifyPip("APPEND_LOG", "[오류] DOM 수집 실패: " + e.message, tabId);
        notifyPip("APPEND_LOG", "[안내] 현재 페이지에서 요청한 정보를 찾을 수 없습니다. 다른 페이지에서 다시 시도해주세요.", tabId);
        break;
      }

      notifyPip("UPDATE_STATUS", "⟳ LLM 계획 수립 중...", tabId);
      let plan;
      try {
        const res = await fetch(`${SERVER_URL}/api/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userRequest,
            pageState: {
              ...pageState,
              interactiveElements: pageState.interactiveElements.map(cleanForLlm),
            },
            previousActions: allPreviousActions,
            step,
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`서버 오류 ${res.status}: ${err}`);
        }
        plan = await res.json();
      } catch (e) {
        notifyPip("APPEND_LOG", "[오류] 서버 연결 실패: " + e.message, tabId);
        break;
      }

      notifyPip("APPEND_LOG", `[계획] ${plan.description}`, tabId);

      if (plan.isComplete) {
        notifyPip("UPDATE_STATUS", "✓ 완료", tabId);
        break;
      }
      if (plan.planType === "overlay") {
        notifyPip("APPEND_LOG", `[안내] 직접 입력 필요: ${plan.description}`, tabId);
        notifyPip("UPDATE_STATUS", "⏸ 직접 입력 대기 중...", tabId);

        const overlayTargets = plan.overlayTargets || [];
        const enrichedTargets = await enrichOverlayTargets(
          tabId,
          overlayTargets,
          pageState.interactiveElements
        );

        const isLogin = overlayTargets.some((target) => target.inputType === "login");
        await injectOverlay(tabId);
        await sendOverlayShow(tabId, enrichedTargets, isLogin);

        if (isLogin) {
          await waitForNavigationOrDismiss(tabId);
        } else {
          await waitForOverlayComplete(tabId);
        }

        await removeOverlay(tabId);
        if (isLogin) {
          await waitForIframeDomSettle(tabId);
        }
        notifyPip("APPEND_LOG", "[안내] 입력 완료. 재개합니다.", tabId);
        notifyPip("UPDATE_STATUS", "", tabId);

        allPreviousActions.push({
          type: "overlay",
          name: overlayTargets.map((target) => target.name).join(", "),
          description: isLogin ? "사용자가 로그인 방식 선택" : "사용자가 민감정보 직접 입력 완료",
          result: "success",
        });
        allPreviousActions = allPreviousActions.slice(-20);

        step++;
        continue;
      }
      if (plan.planType === "error") {
        notifyPip("APPEND_LOG", `[안내] ${plan.description || "현재 페이지에서 요청한 정보를 찾을 수 없습니다. 다른 페이지에서 다시 시도해주세요."}`, tabId);
        notifyPip("UPDATE_STATUS", "", tabId);
        break;
      }

      const actions = plan.actions || [];
      if (actions.length === 0) {
        notifyPip("APPEND_LOG", "[경고] 액션이 비어있음. 종료.", tabId);
        break;
      }

      const urlBefore = (await chrome.tabs.get(tabId)).url;
      const executedActions = [];
      let stepHadDomStale = false;
      let currentPageState = pageState;

      for (const action of actions) {
        const actionKey = `${action.type}:${action.nodeId ?? "none"}:${action.name ?? ""}:${action.value ?? ""}`;
        if (actionKey === lastActionKey) {
          lastActionRepeatCount++;
        } else {
          lastActionKey = actionKey;
          lastActionRepeatCount = 1;
        }
        if (lastActionRepeatCount > MAX_CONSECUTIVE_REPEAT) {
          notifyPip("APPEND_LOG", "[오류] 동일 액션 반복 감지. 종료합니다.", tabId);
          notifyPip("UPDATE_STATUS", "", tabId);
          return;
        }

        notifyPip("UPDATE_STATUS", `⟳ ${action.description}`, tabId);
        notifyPip("APPEND_LOG", `[실행] ${action.description}`, tabId);

        const snapshotBefore = DOM_CHANGE_ACTION_TYPES.has(action.type)
          ? getDomSnapshot(currentPageState)
          : null;

        let resultStr = "success";
        try {
          const execution = await executeCdpAction(tabId, action, currentPageState.interactiveElements);
          resultStr = execution.result;
        } catch (e) {
          if (e instanceof DomStaleError) {
            resultStr = `dom_stale_${e.reason}`;
            stepHadDomStale = true;
            consecutiveDomStale++;
            notifyPip("APPEND_LOG", `[DOM 변경 감지] ${e.message} → 재수집`, tabId);
            executedActions.push({ ...action, result: resultStr });
            break;
          }
          resultStr = "error";
          notifyPip("APPEND_LOG", "[오류] 액션 실행 실패: " + e.message, tabId);
          executedActions.push({ ...action, result: resultStr });
          break;
        }

        await sleep(ACTION_DELAY_MS);

        if (action.navigates) {
          executedActions.push({ ...action, result: resultStr });
          await waitForPageLoad(tabId);
          break;
        }

        const urlAfter = (await chrome.tabs.get(tabId)).url;
        if (urlAfter !== urlBefore) {
          executedActions.push({ ...action, result: resultStr });
          await waitForPageLoad(tabId);
          break;
        }

        if (snapshotBefore !== null) {
          try {
            for (const targetId of attachedIframeTargetIds) {
              try { await chrome.debugger.detach({ targetId }); } catch (_) {}
            }
            attachedIframeTargetIds.clear();
            currentPageState = await collectPageStateViaCdp(tabId, attachedIframeTargetIds);
            const snapshotAfter = getDomSnapshot(currentPageState);
            if (snapshotAfter === snapshotBefore) {
              resultStr = "no_dom_change";
              notifyPip("APPEND_LOG", `[경고] 액션 후 DOM 변화 없음: ${action.description}`, tabId);
            }
          } catch (e) {
            notifyPip("APPEND_LOG", "[경고] 액션 후 DOM 재수집 실패: " + e.message, tabId);
          }
        }

        executedActions.push({ ...action, result: resultStr });
      }

      if (!stepHadDomStale) consecutiveDomStale = 0;

      if (consecutiveDomStale >= MAX_CONSECUTIVE_DOM_STALE) {
        notifyPip("APPEND_LOG", "[오류] 요소를 지속적으로 찾지 못해 종료합니다.", tabId);
        notifyPip("UPDATE_STATUS", "", tabId);
        break;
      }

      allPreviousActions = [...allPreviousActions, ...executedActions].slice(-20);
      step++;
    }

    if (step >= MAX_STEPS) {
      notifyPip("APPEND_LOG", "[경고] 자동 실행 한도 초과. 종료합니다.", tabId);
      notifyPip("UPDATE_STATUS", "", tabId);
    }
  } finally {
    for (const targetId of attachedIframeTargetIds) {
      try { await chrome.debugger.detach({ targetId }); } catch (_) {}
    }
    if (attached) {
      try {
        await chrome.debugger.detach({ tabId });
        notifyPip("APPEND_LOG", "[연결] debugger detached", tabId);
      } catch (_) {
        // ignore
      }
    }
    chrome.alarms.clear("keepAlive");
  }
}

async function ensureCdpDomains(debuggee) {
  await cdpCommand(debuggee, "Page.enable");
  await cdpCommand(debuggee, "DOM.enable");
  await cdpCommand(debuggee, "Runtime.enable");
}

async function enrichOverlayTargets(tabId, overlayTargets, interactiveElements) {
  const elementMap = new Map((interactiveElements || []).map((element) => [element.nodeId, element]));
  const enrichedTargets = [];

  for (const target of overlayTargets || []) {
    const element = elementMap.get(target.nodeId);
    let rect = element?.precomputedRect || null;
    if (!rect && element) {
      const elemDebuggee = getDebuggeeForElement(tabId, element);
      const cdpNodeId = getCdpNodeId(element);
      const box = await getBoxModelSafe(elemDebuggee, cdpNodeId);
      if (box) {
        rect = {
          x: Math.min(...box.border.filter((_, index) => index % 2 === 0)),
          y: Math.min(...box.border.filter((_, index) => index % 2 === 1)),
          width: box.width,
          height: box.height,
        };
      }
    }
    enrichedTargets.push({ ...target, rect });
  }

  return enrichedTargets;
}

async function injectOverlay(tabId) {
  const [{ result: hasOverlay }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Boolean(document.getElementById("vorder-overlay-host")),
  });
  if (hasOverlay) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/overlay.js"],
  });

  // main world에 window.open 패치 주입 (CSP 우회)
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: patchWindowOpen,
  });
}

function patchWindowOpen() {
  if (window.__vorderOpenPatched) return;
  window.__vorderOpenPatched = true;
  const orig = window.open;
  window.open = function (...args) {
    // 첫 호출 시 자동 복원 (overlay 없는 상태에서 팝업 열어도 영구 패치 안 됨)
    window.open = orig;
    delete window.__vorderOpenPatched;
    window.dispatchEvent(new CustomEvent('vorder-popup-opened'));
    return orig.apply(this, args);
  };
}

async function sendOverlayShow(tabId, enrichedTargets, isLogin) {
  await chrome.tabs.sendMessage(tabId, {
    type: "SHOW_OVERLAY",
    payload: { targets: enrichedTargets, isLogin },
  });
}

async function waitForNavigationOrDismiss(tabId) {
  return new Promise((resolve) => {
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(navListener);
      chrome.runtime.onMessage.removeListener(msgListener);
      resolve();
    };

    const navListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const msgListener = (msg, sender) => {
      if (
        (msg.type === "OVERLAY_DISMISSED_BY_DOM" || msg.type === "OVERLAY_COMPLETE") &&
        sender.tab?.id === tabId
      ) {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(navListener);
    chrome.runtime.onMessage.addListener(msgListener);
  });
}

async function waitForIframeDomSettle(tabId, timeout = 1200) {
  const debuggee = { tabId };
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const frameTreeResult = await cdpCommand(debuggee, "Page.getFrameTree");
      if (collectChildFrames(frameTreeResult.frameTree).length > 0) {
        await sleep(300);
        return;
      }
    } catch (_) {
      return;
    }
    await sleep(150);
  }
}

async function waitForOverlayComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (msg, sender) => {
      if (
        (msg.type === "OVERLAY_COMPLETE" || msg.type === "OVERLAY_DISMISSED_BY_DOM") &&
        sender.tab?.id === tabId
      ) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function removeOverlay(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "HIDE_OVERLAY" });
  } catch (_) {
    // overlay.js already removed
  }
}

async function collectPageStateViaCdp(tabId, attachedIframeTargetIds = new Set()) {
  const debuggee = { tabId };
  await ensureCdpDomains(debuggee);

  const [documentResult, frameTreeResult, screenMeta, viewport] = await Promise.all([
    cdpCommand(debuggee, "DOM.getDocument", { depth: -1, pierce: true }),
    cdpCommand(debuggee, "Page.getFrameTree"),
    collectScreenMeta(debuggee),
    getViewportSize(debuggee),
  ]);

  const frameMap = buildFrameMap(frameTreeResult.frameTree);
  const candidates = [];
  const iframeNodeMap = new Map();
  const contentDocFrameIds = new Set();
  walkDomTree(documentResult.root, frameMap.mainFrameId, candidates, iframeNodeMap, contentDocFrameIds);

  const interactiveElements = [];
  let fallbackIndex = 0;
  for (const candidate of candidates) {
    const attrs = attributesToObject(candidate.attributes);
    if (attrs["aria-hidden"] === "true") continue;
    if (candidate.tag === "input" && (attrs.type || "").toLowerCase() === "hidden") continue;

    const box = await getBoxModelSafe(debuggee, candidate.nodeId);
    if (!box || isZeroSized(box)) continue;

    const meta = await getNodeMetadata(debuggee, candidate.nodeId, candidate.tag, fallbackIndex);
    fallbackIndex += 1;
    if (!meta.enabled && candidate.tag === "iframe") {
      // iframe 자체는 액션 대상이 아니지만 구조 파악용으로 포함
    }

    interactiveElements.push({
      nodeId: candidate.nodeId,
      frameId: frameMap.byCdpId.get(candidate.frameCdpId) || "main",
      name: meta.name,
      tag: candidate.tag,
      type: attrs.type || null,
      role: attrs.role || inferRole(candidate.tag),
      text: meta.text,
      ariaLabel: attrs["aria-label"] || null,
      nearbyText: meta.nearbyText,
      placeholder: meta.placeholder,
      value: meta.value,
      checked: meta.checked,
      inputName: meta.inputName,
      required: meta.required,
      options: meta.options,
      enabled: meta.enabled,
      __insidePopup: Boolean(meta.insidePopup),
      __popupInfo: meta.popupInfo || null,
      __inViewport: meta.inViewport || isBoxInViewport(box, viewport),
    });
  }

  let iframeElements = await collectCrossOriginIframeElements(
    tabId, frameTreeResult, iframeNodeMap, attachedIframeTargetIds, contentDocFrameIds
  );

  const childFrames = collectChildFrames(frameTreeResult.frameTree);
  const contentDocumentFrameElements = interactiveElements.filter((el) => el.frameId !== "main");
  if (childFrames.length > 0 && iframeElements.length === 0 && contentDocumentFrameElements.length === 0) {
    console.warn("[Vorder][iframe-diag] child frame exists but no iframe DOM collected; retrying once");
    await sleep(300);
    iframeElements = await collectCrossOriginIframeElements(
      tabId, frameTreeResult, iframeNodeMap, attachedIframeTargetIds, contentDocFrameIds
    );
  }

  const iframeScopedElements = iframeElements.length > 0
    ? iframeElements
    : contentDocumentFrameElements;
  const popupScopedElements = interactiveElements.filter((element) => element.__insidePopup);
  const mainElements = interactiveElements.filter((element) => element.frameId === "main");
  const selectedScope = selectDomScope(popupScopedElements, iframeScopedElements, mainElements);
  if (selectedScope.scope === "popup") {
    const popupInfo = popupScopedElements.find((element) => element.__popupInfo)?.__popupInfo;
    console.log("[Vorder][popup] active popup detected:", popupInfo || {});
  }
  console.log("[Vorder][iframe-diag] collected DOM scopes:", {
    childFrames: childFrames.length,
    mainElements: mainElements.length,
    popupElements: popupScopedElements.length,
    isolatedIframeElements: iframeElements.length,
    contentDocumentFrameElements: contentDocumentFrameElements.length,
  });
  console.log("[Vorder][dom-scope] selected:", selectedScope.scope, "elements=", selectedScope.elements.length, "reason=", selectedScope.reason);
  const sortedElements = prioritizeInteractiveElements(selectedScope.elements);
  const frames = frameMap.frames;
  const title = await getDocumentTitle(debuggee);
  const url = (await chrome.tabs.get(tabId)).url || "";

  return {
    url,
    title,
    screenMeta,
    frames,
    interactiveElements: sortedElements,
  };
}

function walkDomTree(node, currentFrameCdpId, out, iframeNodeMap, contentDocFrameIds = null) {
  if (!node) return;

  const tag = String(node.nodeName || "").toLowerCase();
  const attrs = attributesToObject(node.attributes);
  if (isInteractiveNode(tag, attrs)) {
    out.push({
      nodeId: node.nodeId,
      tag,
      attributes: node.attributes || [],
      frameCdpId: currentFrameCdpId,
    });
  }

  if (Array.isArray(node.shadowRoots)) {
    for (const shadowRoot of node.shadowRoots) {
      walkDomTree(shadowRoot, currentFrameCdpId, out, iframeNodeMap, contentDocFrameIds);
    }
  }

  if (tag === "iframe") {
    console.log("[Vorder][iframe-diag] iframe node:", {
      hasContentDoc: !!node.contentDocument,
      hasFrameId: !!node.frameId,
      frameId: node.frameId,
      src: attributesToObject(node.attributes || []).src,
    });
  }

  if (node.contentDocument) {
    const nextFrameCdpId = node.contentDocument.frameId || node.frameId || currentFrameCdpId;
    const frameIdForTracking = node.contentDocument.frameId || node.frameId;
    if (frameIdForTracking && contentDocFrameIds) contentDocFrameIds.add(frameIdForTracking);
    walkDomTree(node.contentDocument, nextFrameCdpId, out, iframeNodeMap, contentDocFrameIds);
  } else if (tag === "iframe" && node.frameId) {
    iframeNodeMap?.set(node.frameId, node.nodeId);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      walkDomTree(child, currentFrameCdpId, out, iframeNodeMap, contentDocFrameIds);
    }
  }
}

async function collectCrossOriginIframeElements(tabId, frameTreeResult, iframeNodeMap, attachedIframeTargetIds, contentDocFrameIds) {
  const mainDebuggee = { tabId };
  const allFrames = collectChildFrames(frameTreeResult.frameTree);
  const viewport = await getViewportSize(mainDebuggee);
  const iframeElements = [];
  let syntheticId = 10_000_000;

  console.log("[Vorder][iframe-diag] allFrames:", allFrames.length, allFrames.map((f) => f.frame.id));
  console.log("[Vorder][iframe-diag] iframeNodeMap (before fill):", [...iframeNodeMap.entries()]);

  // Fill missing iframeNodeMap entries via DOM.getFrameOwner for cross-origin frames
  for (const childFrame of allFrames) {
    const frameId = childFrame.frame.id;
    if (iframeNodeMap.has(frameId)) continue;
    try {
      const ownerResult = await cdpCommand(mainDebuggee, "DOM.getFrameOwner", { frameId });
      const pushResult = await cdpCommand(mainDebuggee, "DOM.pushNodesByBackendIdsToFrontend", {
        backendNodeIds: [ownerResult.backendNodeId],
      });
      const nodeId = pushResult.nodeIds[0];
      if (nodeId) {
        iframeNodeMap.set(frameId, nodeId);
        console.log("[Vorder][iframe-diag] DOM.getFrameOwner filled:", frameId, "→ nodeId:", nodeId);
      }
    } catch (e) {
      console.warn("[Vorder][iframe-diag] DOM.getFrameOwner failed:", frameId, e.message);
    }
  }

  // Collect same-origin iframe elements via Page.createIsolatedWorld (no separate attach needed)
  for (const childFrame of allFrames) {
    const frameId = childFrame.frame.id;

    if (!iframeNodeMap.has(frameId)) {
      console.log("[Vorder][iframe-diag] skip (no host nodeId):", frameId);
      continue;
    }

    const hostNodeId = iframeNodeMap.get(frameId);
    const hostBox = await getBoxModelSafe(mainDebuggee, hostNodeId);
    if (!hostBox) continue;
    if (!isBoxInViewport(hostBox, viewport)) {
      console.log("[Vorder][iframe-diag] skip (iframe host outside viewport):", frameId);
      continue;
    }
    const hostOffsetX = Math.min(...hostBox.border.filter((_, i) => i % 2 === 0));
    const hostOffsetY = Math.min(...hostBox.border.filter((_, i) => i % 2 === 1));

    try {
      const worldResult = await cdpCommand(mainDebuggee, "Page.createIsolatedWorld", {
        frameId,
        worldName: "vorder-collect",
        grantUniversalAccess: false,
      });
      const executionContextId = worldResult.executionContextId;

      const evalResult = await cdpCommand(mainDebuggee, "Runtime.evaluate", {
        expression: `(function() {
  const normalize = (value, max) => {
    if (value == null) return null;
    const cleaned = String(value).replace(/\\s+/g, " ").trim();
    if (!cleaned) return null;
    return cleaned.slice(0, max || 80);
  };
  const SELECTORS = [
    'input:not([type="hidden"]):not([aria-hidden="true"])',
    'button:not([aria-hidden="true"])',
    'select:not([aria-hidden="true"])',
    'textarea:not([aria-hidden="true"])',
    'a[href]:not([aria-hidden="true"])',
    '[role="button"]:not([aria-hidden="true"])',
    '[role="link"]:not([aria-hidden="true"])',
    '[role="checkbox"]:not([aria-hidden="true"])',
    '[role="radio"]:not([aria-hidden="true"])',
  ].join(",");
  const elements = [];
  let idx = 0;
  for (const el of document.querySelectorAll(SELECTORS)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const tag = (el.tagName || "").toLowerCase();
    const ariaLabel = normalize(el.getAttribute("aria-label"), 80);
    const placeholder = normalize(el.placeholder || el.getAttribute("placeholder"), 80);
    const inputName = normalize(el.getAttribute("name"), 80);
    const title = normalize(el.getAttribute("title"), 80);
    const visibleText = normalize(el.innerText || el.textContent || "", 80);
    const describedByText = (() => {
      const ids = normalize(el.getAttribute("aria-describedby"), 200);
      if (!ids) return null;
      const texts = ids.split(/\\s+/)
        .map(id => document.getElementById(id))
        .filter(Boolean)
        .map(node => normalize(node.innerText || node.textContent, 80))
        .filter(Boolean);
      return texts.length ? texts.join(" ") : ids;
    })();
    const getLabelText = () => {
      if (el.labels && el.labels.length) {
        return normalize(Array.from(el.labels).map(l => l.innerText).join(" "), 80);
      }
      const parentLabel = typeof el.closest === "function" && el.closest("label");
      return parentLabel ? normalize(parentLabel.innerText, 80) : null;
    };
    const getNearbyText = () => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const heading = node.querySelector("h1,h2,h3,h4,legend");
        if (heading) { const t = normalize(heading.innerText, 80); if (t) return t; }
        node = node.parentElement;
      }
      const prev = el.previousElementSibling;
      return prev && prev.innerText ? normalize(prev.innerText, 80) : null;
    };
    const labelText = getLabelText();
    const nearbyText = getNearbyText();
    const semanticName = ariaLabel || labelText || visibleText || title || describedByText || nearbyText || placeholder || inputName || (tag + "#" + idx);
    let value = null;
    if ("value" in el && typeof el.value === "string" && el.value) {
      value = el.type === "password" ? "[MASKED]" : el.value.slice(0, 200);
    }
    let options = null;
    if (tag === "select" && el.options) {
      options = Array.from(el.options).map(opt => ({ value: String(opt.value ?? ""), text: normalize(opt.text, 200) || "" }));
    }
    const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    elements.push({
      tag, type: el.getAttribute("type") || null, role: el.getAttribute("role") || null,
      name: semanticName, text: normalize(el.innerText || el.value || ariaLabel || labelText || title || describedByText || placeholder || "", 200) || "",
      ariaLabel, nearbyText, placeholder: el.type === "password" ? "[비밀번호]" : placeholder,
      value, checked: "checked" in el ? Boolean(el.checked) : null,
      required: Boolean(el.required), enabled: !el.disabled, inputName, options, inViewport,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
    idx++;
  }
  return JSON.stringify(elements);
})()`,
        contextId: executionContextId,
        returnByValue: true,
      });

      if (evalResult.result?.type !== "string") {
        console.warn("[Vorder][iframe-diag] Runtime.evaluate non-string result:", frameId, evalResult.result?.type);
        continue;
      }

      const elements = JSON.parse(evalResult.result.value);
      console.log("[Vorder][iframe-diag] same-origin iframe elements:", frameId, elements.length);

      for (const el of elements) {
        const absX = hostOffsetX + el.rect.x;
        const absY = hostOffsetY + el.rect.y;
        const inViewport = el.inViewport && isPointInViewport({ x: absX + el.rect.width / 2, y: absY + el.rect.height / 2 }, viewport);
        iframeElements.push({
          nodeId: syntheticId++,
          __cdpNodeId: null,
          __iframeTargetId: null,
          precomputedRect: { x: absX, y: absY, width: el.rect.width, height: el.rect.height },
          frameId: `iframe-${frameId.slice(0, 8)}`,
          name: el.name,
          tag: el.tag,
          type: el.type,
          role: el.role || inferRole(el.tag),
          text: el.text,
          ariaLabel: el.ariaLabel,
          nearbyText: el.nearbyText,
          placeholder: el.placeholder,
          value: el.value,
          checked: el.checked,
          inputName: el.inputName,
          required: el.required,
          options: el.options,
          enabled: el.enabled,
          __inViewport: inViewport,
        });
      }
    } catch (e) {
      console.warn("[Vorder][iframe-diag] isolated world collection failed:", frameId, e.message);
    }
  }

  return iframeElements;
}

async function collectScreenMeta(debuggee) {
  const expression = `(function() {
    const normalize = (value, max) => {
      if (!value) return null;
      const cleaned = String(value).replace(/\\s+/g, " ").trim();
      if (!cleaned) return null;
      return cleaned.slice(0, max);
    };

    const stepEl = document.querySelector('.step-indicator, .steps, [class*="step"], [class*="wizard"]');
    let currentStep = null;
    if (stepEl) {
      const stepText = normalize(stepEl.innerText, 80);
      const match = stepText && stepText.match(/(\\d+\\s*\\/\\s*\\d+\\s*단계|\\d+\\s*단계|step\\s*\\d+)/i);
      currentStep = match ? match[0].trim() : stepText;
    }

    const alertEls = document.querySelectorAll(
      '.error, .alert, .notice, [role="alert"], [class*="error"], [class*="alert"]'
    );
    const alerts = [];
    for (const el of alertEls) {
      const text = normalize(el.innerText, 200);
      if (!text) continue;
      const className =
        typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
      const type =
        className.includes("error") || el.getAttribute("role") === "alert"
          ? "error"
          : className.includes("warning")
            ? "warning"
            : "info";
      alerts.push({ type, text });
      if (alerts.length >= 5) break;
    }

    return { currentStep, alerts };
  })()`;

  const result = await cdpCommand(debuggee, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return result.result?.value || { currentStep: null, alerts: [] };
}

async function getDocumentTitle(debuggee) {
  const result = await cdpCommand(debuggee, "Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });
  return result.result?.value || "";
}

async function getViewportSize(debuggee) {
  const result = await cdpCommand(debuggee, "Runtime.evaluate", {
    expression: "({ width: window.innerWidth, height: window.innerHeight })",
    returnByValue: true,
  });
  return result.result?.value || { width: 0, height: 0 };
}

async function getNodeMetadata(debuggee, nodeId, tag, fallbackIndex) {
  const objectId = await resolveNodeObjectId(debuggee, nodeId);
  try {
    const response = await cdpCommand(debuggee, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(fallbackIndex) {
        const el = this;
        const normalize = (value, max = 80) => {
          if (value == null) return null;
          const cleaned = String(value).replace(/\\s+/g, " ").trim();
          if (!cleaned) return null;
          return cleaned.slice(0, max);
        };
        const clip = (value, max) => normalize(value, max);
        const tagName = (el.tagName || "").toLowerCase();
        const getZIndex = (node) => {
          const parsed = Number.parseInt(getComputedStyle(node).zIndex, 10);
          return Number.isFinite(parsed) ? parsed : 0;
        };
        const isVisibleBox = (node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0 &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          );
        };
        const hasPopupName = (node) => {
          const className =
            typeof node.className === "string" ? node.className : node.getAttribute("class") || "";
          const haystack = ((node.id || "") + " " + className).toLowerCase();
          return /(modal|popup|pop-content|pop-|pop_|layer|dialog)/.test(haystack);
        };
        const isTopLayerCandidate = (node) => {
          const rect = node.getBoundingClientRect();
          const points = [
            [rect.left + rect.width / 2, rect.top + rect.height / 2],
            [rect.left + Math.min(20, rect.width / 2), rect.top + Math.min(20, rect.height / 2)],
          ];
          return points.some(([x, y]) => {
            if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
            const topEl = document.elementFromPoint(x, y);
            return topEl && (node === topEl || node.contains(topEl) || topEl.contains(node));
          });
        };
        const scorePopupCandidate = (node) => {
          if (!node || !node.matches || node.id === "vorder-pip-host" || node.id === "vorder-overlay-host") {
            return null;
          }
          if (!isVisibleBox(node)) return null;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          const role = node.getAttribute("role");
          const semantic =
            node.matches("dialog[open]") ||
            role === "dialog" ||
            role === "alertdialog" ||
            node.getAttribute("aria-modal") === "true";
          const named = hasPopupName(node);
          const floating = ["fixed", "absolute", "sticky"].includes(style.position);
          if (!semantic && !named && !floating) return null;

          let score = 0;
          if (node.matches("dialog[open]")) score += 10;
          if (role === "dialog" || role === "alertdialog") score += 8;
          if (node.getAttribute("aria-modal") === "true") score += 8;
          if (named) score += 4;
          score += 3;
          if (floating) score += 3;
          const zIndex = getZIndex(node);
          if (zIndex >= 100) score += 2;
          if (isTopLayerCandidate(node)) score += 4;
          if (rect.width >= window.innerWidth * 0.2 && rect.height >= window.innerHeight * 0.1) score += 2;
          if (!semantic && !named && score < 8) return null;
          return {
            node,
            score,
            zIndex,
            text: normalize(node.innerText || node.textContent || "", 120),
            className: typeof node.className === "string" ? node.className : node.getAttribute("class") || "",
            id: node.id || "",
          };
        };
        const findActivePopup = () => {
          const selectors = [
            "dialog[open]",
            "[role='dialog']",
            "[role='alertdialog']",
            "[aria-modal='true']",
            "[class*='modal' i]",
            "[class*='popup' i]",
            "[class*='pop-content' i]",
            "[class*='pop-' i]",
            "[class*='pop_' i]",
            "[class*='layer' i]",
            "[class*='dialog' i]",
            "[id*='modal' i]",
            "[id*='popup' i]",
            "[id*='layer' i]",
          ].join(",");
          const scored = Array.from(document.querySelectorAll(selectors))
            .map(scorePopupCandidate)
            .filter(Boolean)
            .filter((candidate) => candidate.score >= 8);
          scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.zIndex - a.zIndex;
          });
          return scored[0] || null;
        };

        const getLabelText = () => {
          if (el.labels && el.labels.length) {
            const joined = Array.from(el.labels)
              .map((label) => normalize(label.innerText, 80))
              .filter(Boolean)
              .join(" ");
            if (joined) return clip(joined, 80);
          }
          if (typeof el.closest === "function") {
            const parentLabel = el.closest("label");
            if (parentLabel) return clip(parentLabel.innerText, 80);
          }
          return null;
        };

        const getNearbyText = () => {
          let node = el.parentElement;
          while (node && node !== document.body) {
            const heading = node.querySelector("h1, h2, h3, h4, legend");
            if (heading) {
              const text = clip(heading.innerText, 80);
              if (text) return text;
            }
            node = node.parentElement;
          }
          const prev = el.previousElementSibling;
          if (prev && prev.innerText) return clip(prev.innerText, 80);
          return null;
        };

        const visibleText = clip(el.innerText || el.textContent || "", 80);
        const nearbyText = getNearbyText();
        const ariaLabel = clip(el.getAttribute("aria-label"), 80);
        const labelText = getLabelText();
        const placeholder = clip(el.placeholder || el.getAttribute("placeholder"), 80);
        const inputName = clip(el.getAttribute("name"), 80);
        const title = clip(el.getAttribute("title"), 80);
        const semanticName =
          ariaLabel ||
          labelText ||
          visibleText ||
          placeholder ||
          inputName ||
          title ||
          nearbyText ||
          tagName + "#" + fallbackIndex;

        const rect = el.getBoundingClientRect();
        const inViewport =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;

        let value = null;
        if ("value" in el && typeof el.value === "string" && el.value) {
          value = el.type === "password" ? "[MASKED]" : el.value.slice(0, 200);
        }

        let options = null;
        if (tagName === "select" && el.options) {
          options = Array.from(el.options).map((opt) => ({
            value: String(opt.value ?? ""),
            text: clip(opt.text, 200) || "",
          }));
        }
        const activePopup = findActivePopup();
        const insidePopup = Boolean(activePopup && activePopup.node.contains(el));

        return {
          name: semanticName,
          text: clip(el.innerText || el.value || ariaLabel || "", 200) || "",
          nearbyText,
          placeholder: el.type === "password" ? "[비밀번호]" : placeholder,
          value,
          checked: "checked" in el ? Boolean(el.checked) : null,
          required: Boolean(el.required),
          enabled: !el.disabled,
          inputName,
          options,
          insidePopup,
          popupInfo: insidePopup ? {
            score: activePopup.score,
            zIndex: activePopup.zIndex,
            id: activePopup.id,
            className: activePopup.className,
            text: activePopup.text,
          } : null,
          inViewport,
        };
      }`,
      arguments: [{ value: fallbackIndex }],
      returnByValue: true,
    });
    return response.result?.value || {
      name: `${tag}#${fallbackIndex}`,
      text: "",
      nearbyText: null,
      placeholder: null,
      value: null,
      checked: null,
      required: false,
      enabled: true,
      inputName: null,
      options: null,
      inViewport: false,
    };
  } finally {
    await releaseObject(debuggee, objectId);
  }
}

async function executeCdpAction(tabId, action, elements) {
  switch (action.type) {
    case "click":
      return cdpClickByNodeId(tabId, action, elements);
    case "type":
      return cdpTypeByNodeId(tabId, action, elements);
    case "select":
      return cdpSelectByNodeId(tabId, action, elements);
    case "scroll":
      await cdpScroll(tabId, action.value);
      return { result: "success" };
    case "wait":
      await cdpWait(tabId, action.value);
      return { result: "success" };
    case "navigate":
      await cdpNavigate(tabId, action.value);
      return { result: "success" };
    default:
      throw new Error(`알 수 없는 액션 타입: ${action.type}`);
  }
}

async function showClickIndicator(debuggee, x, y) {
  const expression = `(function() {
    var el = document.createElement('div');
    el.id = '__vorder_click_indicator__';
    el.style.cssText = 'position:fixed; left:${x}px; top:${y}px; width:20px; height:20px; ' +
      'margin-left:-10px; margin-top:-10px; border-radius:50%; ' +
      'background:rgba(255,0,0,0.5); border:2px solid red; ' +
      'pointer-events:none; z-index:2147483647; ' +
      'animation:__vorder_pulse__ 600ms ease-out forwards;';
    if (!document.getElementById('__vorder_indicator_style__')) {
      var style = document.createElement('style');
      style.id = '__vorder_indicator_style__';
      style.textContent = '@keyframes __vorder_pulse__ { ' +
        '0% { transform:scale(0.5); opacity:1; } ' +
        '50% { transform:scale(1.5); opacity:0.7; } ' +
        '100% { transform:scale(2); opacity:0; } }';
      document.head.appendChild(style);
    }
    var prev = document.getElementById('__vorder_click_indicator__');
    if (prev) prev.remove();
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 600);
  })()`;
  try {
    await cdpCommand(debuggee, "Runtime.evaluate", { expression });
  } catch (_) {
    // 시각화 실패는 무시 — 핵심 기능에 영향 없음
  }
}

async function cdpClickByNodeId(tabId, action, elements) {
  const resolved = await resolveByNodeIdOrName(tabId, action, elements);
  const { debuggee, cdpNodeId, element } = resolved;
  const inputDebuggee = { tabId };
  const hasRealNodeId = element.__cdpNodeId !== null;

  if (hasRealNodeId) {
    const state = await getElementState(debuggee, cdpNodeId);
    if (!state.found) throw new DomStaleError("not_found", action.name || action.nodeId);
    if (!state.enabled) throw new DomStaleError("disabled", action.name || action.nodeId);
  }

  let box = resolved.box;
  const viewport = await getViewportSize(inputDebuggee);
  let point = getBoxCenter(box);

  if (!isPointInViewport(point, viewport)) {
    if (hasRealNodeId) {
      await cdpCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { nodeId: cdpNodeId });
      box = element.precomputedRect
        ? resolved.box
        : await requireBoxModel(debuggee, cdpNodeId, action.name);
      point = getBoxCenter(box);
    }
  }

  await showClickIndicator(inputDebuggee, point.x, point.y);
  await sleep(100);

  await cdpCommand(inputDebuggee, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdpCommand(inputDebuggee, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdpCommand(inputDebuggee, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });

  return { result: resolved.usedFallback ? "success_fallback" : "success" };
}

async function cdpTypeByNodeId(tabId, action, elements) {
  if (action.value == null) throw new Error("type: value 필요");

  const resolved = await resolveByNodeIdOrName(tabId, action, elements);
  const { debuggee, cdpNodeId, element } = resolved;
  const inputDebuggee = { tabId };
  const hasRealNodeId = element.__cdpNodeId !== null;

  if (hasRealNodeId) {
    await cdpCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { nodeId: cdpNodeId });
    const editable = await getElementState(debuggee, cdpNodeId);
    if (!editable.found) throw new DomStaleError("not_found", action.name || action.nodeId);
    if (!editable.enabled) throw new DomStaleError("disabled", action.name || action.nodeId);
    if (!editable.editable) throw new DomStaleError("not_editable", action.name || action.nodeId);
  }

  const typePoint = getBoxCenter(resolved.box);
  await showClickIndicator(inputDebuggee, typePoint.x, typePoint.y);
  await sleep(100);

  if (hasRealNodeId) {
    await cdpCommand(debuggee, "DOM.focus", { nodeId: cdpNodeId });
    await clearFocusedValue(debuggee, cdpNodeId, inputDebuggee);
  } else {
    await cdpCommand(inputDebuggee, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: typePoint.x,
      y: typePoint.y,
      button: "left",
      clickCount: 1,
    });
    await cdpCommand(inputDebuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: typePoint.x,
      y: typePoint.y,
      button: "left",
      clickCount: 1,
    });
  }

  await cdpCommand(inputDebuggee, "Input.insertText", { text: String(action.value) });

  if (hasRealNodeId) {
    await dispatchInputEvents(debuggee, cdpNodeId);
  }

  return { result: resolved.usedFallback ? "success_fallback" : "success" };
}

async function cdpSelectByNodeId(tabId, action, elements) {
  if (action.value == null) throw new Error("select: value 필요");

  const resolved = await resolveByNodeIdOrName(tabId, action, elements);
  const { debuggee, cdpNodeId } = resolved;
  const inputDebuggee = { tabId };

  await cdpCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { nodeId: cdpNodeId });
  const editable = await getElementState(debuggee, cdpNodeId);
  if (!editable.found) throw new DomStaleError("not_found", action.name || action.nodeId);
  if (!editable.enabled) throw new DomStaleError("disabled", action.name || action.nodeId);

  const selectPoint = getBoxCenter(resolved.box);
  await showClickIndicator(inputDebuggee, selectPoint.x, selectPoint.y);
  await sleep(100);

  const objectId = await resolveNodeObjectId(debuggee, cdpNodeId);
  try {
    const response = await cdpCommand(debuggee, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(nextValue) {
        if (this.tagName !== "SELECT") return { ok: false, reason: "not_found" };
        this.value = String(nextValue);
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }`,
      arguments: [{ value: String(action.value) }],
      returnByValue: true,
    });
    const result = response.result?.value;
    if (!result?.ok) {
      throw new DomStaleError(result?.reason || "not_found", action.name || action.nodeId);
    }
  } finally {
    await releaseObject(debuggee, objectId);
  }

  return { result: resolved.usedFallback ? "success_fallback" : "success" };
}

async function resolveByNodeIdOrName(tabId, action, elements) {
  const targetElement = action.nodeId == null
    ? null
    : elements.find((element) => element.nodeId === action.nodeId);

  if (targetElement) {
    const debuggee = getDebuggeeForElement(tabId, targetElement);
    const cdpNodeId = getCdpNodeId(targetElement);
    const box = targetElement.precomputedRect
      ? boxFromPrecomputedRect(targetElement.precomputedRect)
      : await getBoxModelSafe(debuggee, cdpNodeId);
    if (box && !isZeroSized(box)) {
      return { element: targetElement, box, debuggee, cdpNodeId, usedFallback: false };
    }
  }

  const fallback = resolveByName(action, elements);
  if (!fallback) {
    throw new DomStaleError("not_found", action.name || action.nodeId);
  }

  const debuggee = getDebuggeeForElement(tabId, fallback);
  const cdpNodeId = getCdpNodeId(fallback);
  const box = fallback.precomputedRect
    ? boxFromPrecomputedRect(fallback.precomputedRect)
    : await requireBoxModel(debuggee, cdpNodeId, action.name);
  const message = `[FALLBACK] nodeId ${action.nodeId} → name "${action.name}" 로 매칭`;
  notifyPip("APPEND_LOG", message, tabId);
  return { element: fallback, box, debuggee, cdpNodeId, usedFallback: true };
}

function resolveByName(action, elements) {
  if (!action.name) return null;

  return elements.find((element) => {
    if (element.name !== action.name) return false;
    switch (action.type) {
      case "click":
        return (
          element.tag === "button" ||
          element.tag === "a" ||
          element.tag === "input" ||
          CLICKABLE_ROLES.has(element.role || "")
        );
      case "type":
        return element.tag === "input" || element.tag === "textarea";
      case "select":
        return element.tag === "select";
      default:
        return false;
    }
  }) || null;
}

function getDomSnapshot(pageState) {
  return (pageState.interactiveElements || [])
    .map((element) => `${element.nodeId}:${element.tag}:${element.name}`)
    .join("|");
}

async function cdpScroll(tabId, value) {
  const debuggee = { tabId };
  let expression;
  const str = String(value ?? "down");
  const num = Number(str);
  if (!Number.isNaN(num)) {
    expression = `window.scrollBy(0, ${num})`;
  } else if (str === "up") {
    expression = "window.scrollBy(0, -500)";
  } else if (str === "down") {
    expression = "window.scrollBy(0, 500)";
  } else if (str === "top") {
    expression = "window.scrollTo(0, 0)";
  } else if (str === "bottom") {
    expression = "window.scrollTo(0, document.body.scrollHeight)";
  } else {
    expression = `(function() {
      const el = document.querySelector(${JSON.stringify(str)});
      if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
    })()`;
  }
  await cdpCommand(debuggee, "Runtime.evaluate", { expression });
}

async function cdpWait(tabId, value) {
  const debuggee = { tabId };
  const str = String(value ?? "1000");
  const num = Number(str);
  if (!Number.isNaN(num)) {
    await sleep(num);
    return;
  }
  const timeout = 5000;
  const interval = 200;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await cdpCommand(debuggee, "Runtime.evaluate", {
      expression: `!!document.querySelector(${JSON.stringify(str)})`,
      returnByValue: true,
    });
    if (res.result?.value === true) return;
    await sleep(interval);
  }
  throw new DomStaleError("not_found", str);
}

async function cdpNavigate(tabId, url) {
  const debuggee = { tabId };
  if (!url) throw new Error("navigate: url 필요");
  await cdpCommand(debuggee, "Page.navigate", { url });
  await waitForPageLoad(tabId);
}

async function waitForPageLoad(tabId, timeout = PAGE_LOAD_TIMEOUT_MS) {
  const debuggee = { tabId };
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(300);
    try {
      const res = await cdpCommand(debuggee, "Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (res.result?.value === "complete") {
        await sleep(500);
        return;
      }
    } catch (_) {
      // 페이지 전환 중 일시적 오류 → 다시 시도
    }
  }
}

function buildFrameMap(frameTree) {
  const frames = [];
  const byCdpId = new Map();
  let counter = 0;
  let mainFrameId = frameTree.frame.id;

  const visit = (tree, parentDisplayId) => {
    const displayId = parentDisplayId == null ? "main" : `frame-${counter++}`;
    if (parentDisplayId == null) {
      mainFrameId = tree.frame.id;
    }
    byCdpId.set(tree.frame.id, displayId);
    frames.push({
      frameId: displayId,
      parentFrameId: parentDisplayId,
      url: tree.frame.url || null,
    });
    for (const child of tree.childFrames || []) {
      visit(child, displayId);
    }
  };

  visit(frameTree, null);
  return { frames, byCdpId, mainFrameId };
}

function prioritizeInteractiveElements(elements) {
  if (elements.length <= 500) {
    return elements.map(stripInternalFields);
  }
  const inViewport = elements.filter((element) => element.__inViewport);
  const outOfViewport = elements.filter((element) => !element.__inViewport);
  return [...inViewport, ...outOfViewport].slice(0, 500).map(stripInternalFields);
}

function selectDomScope(popupElements, iframeElements, mainElements) {
  if (popupElements.length > 0) {
    return {
      scope: "popup",
      elements: popupElements,
      reason: "active popup detected",
    };
  }
  if (iframeElements.length > 0) {
    return {
      scope: "iframe",
      elements: iframeElements,
      reason: "iframe elements detected",
    };
  }
  return {
    scope: "main",
    elements: mainElements,
    reason: "no popup or iframe",
  };
}

function stripInternalFields(element) {
  const { __inViewport, __insidePopup, __popupInfo, ...rest } = element;
  return rest;
}

function attributesToObject(attributes) {
  const result = {};
  for (let i = 0; i < (attributes || []).length; i += 2) {
    result[attributes[i]] = attributes[i + 1];
  }
  return result;
}

function isInteractiveNode(tag, attrs) {
  if (!tag) return false;
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (CLICKABLE_ROLES.has(attrs.role || "")) return true;
  if ("onclick" in attrs) return true;
  if ("tabindex" in attrs && attrs.tabindex !== "-1") return true;
  return false;
}

function inferRole(tag) {
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input" || tag === "textarea") return "textbox";
  if (tag === "select") return "listbox";
  return null;
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch (_) { return ""; }
}

function getCdpNodeId(element) {
  return element.__cdpNodeId ?? element.nodeId;
}

function getDebuggeeForElement(tabId, element) {
  return element?.__iframeTargetId ? { targetId: element.__iframeTargetId } : { tabId };
}

function collectChildFrames(frameTree) {
  const result = [];
  for (const child of frameTree.childFrames || []) {
    result.push(child);
    result.push(...collectChildFrames(child));
  }
  return result;
}

function cleanForLlm({ __cdpNodeId, __iframeTargetId, precomputedRect, ...rest }) {
  return rest;
}

async function getElementState(debuggee, nodeId) {
  const objectId = await resolveNodeObjectId(debuggee, nodeId);
  try {
    const response = await cdpCommand(debuggee, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        return {
          found: true,
          enabled: !this.disabled,
          editable: !(this.disabled || this.readOnly)
        };
      }`,
      returnByValue: true,
    });
    return response.result?.value || { found: false, enabled: false, editable: false };
  } finally {
    await releaseObject(debuggee, objectId);
  }
}

async function clearFocusedValue(debuggee, nodeId, inputDebuggee = debuggee) {
  try {
    await cdpCommand(debuggee, "DOM.setAttributeValue", {
      nodeId,
      name: "value",
      value: "",
    });
  } catch (_) {
    // value attribute may not exist
  }

  const objectId = await resolveNodeObjectId(debuggee, nodeId);
  try {
    await cdpCommand(debuggee, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if ("value" in this) this.value = "";
      }`,
    });
  } finally {
    await releaseObject(debuggee, objectId);
  }

  await cdpCommand(inputDebuggee, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    nativeVirtualKeyCode: 91,
    modifiers: 4,
  });
  await cdpCommand(inputDebuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 4,
  });
  await cdpCommand(inputDebuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 4,
  });
  await cdpCommand(inputDebuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    nativeVirtualKeyCode: 91,
  });
  await cdpCommand(inputDebuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await cdpCommand(inputDebuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
}

async function dispatchInputEvents(debuggee, nodeId) {
  const objectId = await resolveNodeObjectId(debuggee, nodeId);
  try {
    await cdpCommand(debuggee, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
    });
  } finally {
    await releaseObject(debuggee, objectId);
  }
}

async function resolveNodeObjectId(debuggee, nodeId) {
  const response = await cdpCommand(debuggee, "DOM.resolveNode", { nodeId });
  const objectId = response.object?.objectId;
  if (!objectId) {
    throw new DomStaleError("not_found", nodeId);
  }
  return objectId;
}

async function releaseObject(debuggee, objectId) {
  if (!objectId) return;
  try {
    await cdpCommand(debuggee, "Runtime.releaseObject", { objectId });
  } catch (_) {
    // ignore
  }
}

async function getBoxModelSafe(debuggee, nodeId) {
  try {
    const response = await cdpCommand(debuggee, "DOM.getBoxModel", { nodeId });
    return response.model || null;
  } catch (_) {
    return null;
  }
}

async function requireBoxModel(debuggee, nodeId, target) {
  const box = await getBoxModelSafe(debuggee, nodeId);
  if (!box) throw new DomStaleError("not_found", target || nodeId);
  if (isZeroSized(box)) throw new DomStaleError("not_rendered", target || nodeId);
  return box;
}

function isZeroSized(box) {
  const width = Math.abs(box.width || 0);
  const height = Math.abs(box.height || 0);
  if (width === 0 || height === 0) return true;
  return false;
}

function boxFromPrecomputedRect({ x, y, width, height }) {
  const border = [x, y, x + width, y, x + width, y + height, x, y + height];
  return { border, content: border, width, height };
}

function getBoxCenter(box) {
  const quad = box.content || box.border;
  let x = 0;
  let y = 0;
  for (let i = 0; i < quad.length; i += 2) {
    x += quad[i];
    y += quad[i + 1];
  }
  return { x: x / 4, y: y / 4 };
}

function isPointInViewport(point, viewport) {
  return point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height;
}

function isBoxInViewport(box, viewport) {
  const point = getBoxCenter(box);
  return isPointInViewport(point, viewport);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpCommand(debuggee, method, params) {
  return chrome.debugger.sendCommand(debuggee, method, params);
}

function notifyPip(type, payload, targetTabId = null) {
  if (type === "APPEND_LOG") {
    logBuffer.push(payload);
    if (logBuffer.length > 50) {
      logBuffer.splice(0, logBuffer.length - 50);
    }
  }
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
