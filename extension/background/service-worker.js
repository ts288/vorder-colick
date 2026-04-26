// 설치/활성화
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vorder] Extension installed");
});

chrome.runtime.onActivated?.addListener(() => {
  console.log("[Vorder] Extension activated");
});

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
      console.error("[Vorder] Loop error:", e);
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
      let pageState;
      try {
        pageState = await collectPageStateViaCdp(tabId);
      } catch (e) {
        notifyPip("APPEND_LOG", "[오류] DOM 수집 실패: " + e.message, tabId);
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
            pageState,
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

      console.log("[Vorder] PLAN:", JSON.stringify(plan, null, 2));
      notifyPip("APPEND_LOG", `[계획] ${plan.description}`, tabId);

      if (plan.isComplete) {
        notifyPip("UPDATE_STATUS", "✓ 완료", tabId);
        break;
      }
      if (plan.planType === "overlay") {
        notifyPip("APPEND_LOG", "[안내] 민감정보 입력 필요 (Phase 6에서 처리)", tabId);
        notifyPip("UPDATE_STATUS", "", tabId);
        break;
      }
      if (plan.planType === "error") {
        notifyPip("APPEND_LOG", "[오류] LLM 오류 응답", tabId);
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
            currentPageState = await collectPageStateViaCdp(tabId);
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

async function collectPageStateViaCdp(tabId, sessionTargetId) {
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
  walkDomTree(documentResult.root, frameMap.mainFrameId, candidates);

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
      __inViewport: meta.inViewport || isBoxInViewport(box, viewport),
    });
  }

  const sortedElements = prioritizeInteractiveElements(interactiveElements);
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

function walkDomTree(node, currentFrameCdpId, out) {
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
      walkDomTree(shadowRoot, currentFrameCdpId, out);
    }
  }

  if (node.contentDocument) {
    const nextFrameCdpId = node.contentDocument.frameId || currentFrameCdpId;
    walkDomTree(node.contentDocument, nextFrameCdpId, out);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      walkDomTree(child, currentFrameCdpId, out);
    }
  }
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
  const debuggee = { tabId };
  const state = await getElementState(debuggee, resolved.element.nodeId);
  if (!state.found) throw new DomStaleError("not_found", action.name || action.nodeId);
  if (!state.enabled) throw new DomStaleError("disabled", action.name || action.nodeId);
  let box = resolved.box;
  const viewport = await getViewportSize(debuggee);
  let point = getBoxCenter(box);

  if (!isPointInViewport(point, viewport)) {
    await cdpCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { nodeId: resolved.element.nodeId });
    box = await requireBoxModel(debuggee, resolved.element.nodeId, action.name);
    point = getBoxCenter(box);
  }

  await showClickIndicator(debuggee, point.x, point.y);
  await sleep(100);

  await cdpCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdpCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdpCommand(debuggee, "Input.dispatchMouseEvent", {
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
  const debuggee = { tabId };
  await cdpCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { nodeId: resolved.element.nodeId });
  const editable = await getElementState(debuggee, resolved.element.nodeId);
  if (!editable.found) throw new DomStaleError("not_found", action.name || action.nodeId);
  if (!editable.enabled) throw new DomStaleError("disabled", action.name || action.nodeId);
  if (!editable.editable) throw new DomStaleError("not_editable", action.name || action.nodeId);

  const typeBox = await getBoxModelSafe(debuggee, resolved.element.nodeId);
  if (typeBox) {
    const typePoint = getBoxCenter(typeBox);
    await showClickIndicator(debuggee, typePoint.x, typePoint.y);
    await sleep(100);
  }

  await cdpCommand(debuggee, "DOM.focus", { nodeId: resolved.element.nodeId });
  await clearFocusedValue(debuggee, resolved.element.nodeId);
  await cdpCommand(debuggee, "Input.insertText", { text: String(action.value) });
  await dispatchInputEvents(debuggee, resolved.element.nodeId);

  return { result: resolved.usedFallback ? "success_fallback" : "success" };
}

async function cdpSelectByNodeId(tabId, action, elements) {
  if (action.value == null) throw new Error("select: value 필요");

  const resolved = await resolveByNodeIdOrName(tabId, action, elements);
  const debuggee = { tabId };
  await cdpCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { nodeId: resolved.element.nodeId });
  const editable = await getElementState(debuggee, resolved.element.nodeId);
  if (!editable.found) throw new DomStaleError("not_found", action.name || action.nodeId);
  if (!editable.enabled) throw new DomStaleError("disabled", action.name || action.nodeId);

  const selectBox = await getBoxModelSafe(debuggee, resolved.element.nodeId);
  if (selectBox) {
    const selectPoint = getBoxCenter(selectBox);
    await showClickIndicator(debuggee, selectPoint.x, selectPoint.y);
    await sleep(100);
  }

  const objectId = await resolveNodeObjectId(debuggee, resolved.element.nodeId);
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
  const debuggee = { tabId };
  const targetElement = action.nodeId == null
    ? null
    : elements.find((element) => element.nodeId === action.nodeId);

  if (targetElement) {
    const box = await getBoxModelSafe(debuggee, targetElement.nodeId);
    if (box && !isZeroSized(box)) {
      return { element: targetElement, box, usedFallback: false };
    }
  }

  const fallback = resolveByName(action, elements);
  if (!fallback) {
    throw new DomStaleError("not_found", action.name || action.nodeId);
  }

  const box = await requireBoxModel(debuggee, fallback.nodeId, action.name);
  const message = `[FALLBACK] nodeId ${action.nodeId} → name "${action.name}" 로 매칭`;
  console.warn(message);
  notifyPip("APPEND_LOG", message, tabId);
  return { element: fallback, box, usedFallback: true };
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
  console.warn("[Vorder] waitForPageLoad timeout");
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

function stripInternalFields(element) {
  const { __inViewport, ...rest } = element;
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

async function clearFocusedValue(debuggee, nodeId) {
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

  await cdpCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    nativeVirtualKeyCode: 91,
    modifiers: 4,
  });
  await cdpCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 4,
  });
  await cdpCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 4,
  });
  await cdpCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    nativeVirtualKeyCode: 91,
  });
  await cdpCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await cdpCommand(debuggee, "Input.dispatchKeyEvent", {
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
  console.log("[CDP]", method, JSON.stringify(params ?? {}));
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
