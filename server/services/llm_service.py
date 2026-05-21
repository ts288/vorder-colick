from google import genai
from google.genai import types
from openai import OpenAI

try:
    from ..config import settings
    from ..models.schemas import InteractiveElement, PlanRequest, PlanResponse, ProcessState
    from ..prompts.planner import SYSTEM_PROMPT, build_user_message
    from .dom_filter import filter_elements
except ImportError:
    from config import settings
    from models.schemas import InteractiveElement, PlanRequest, PlanResponse, ProcessState
    from prompts.planner import SYSTEM_PROMPT, build_user_message
    from services.dom_filter import filter_elements


# --- Gemini client ---
gemini_client = genai.Client(api_key=settings.gemini_api_key) if settings.gemini_api_key else None

# --- OpenAI client ---
openai_client = OpenAI(api_key=settings.openai_api_key) if settings.openai_api_key else None


CLICKABLE_TAGS = {"button", "a"}
CLICKABLE_INPUT_TYPES = {"submit", "button", "checkbox", "radio"}
TARGET_REQUIRED_ACTIONS = {"click", "type", "select"}
TARGETLESS_ACTIONS = {"scroll", "wait"}
RECOVERY_STOP_DESCRIPTION = "현재 화면에서 다음 동작을 확실하게 판단하지 못해 자동 수행을 멈췄어요. 화면을 확인한 뒤 다시 시도해 주세요."


def _is_clickable(el: InteractiveElement) -> bool:
    if not el.enabled:
        return False
    if el.tag in CLICKABLE_TAGS:
        return True
    if el.tag == "input" and el.type in CLICKABLE_INPUT_TYPES:
        return True
    return False


async def _get_plan_gemini(user_message: str) -> PlanResponse:
    response = gemini_client.models.generate_content(
        model=settings.gemini_model,
        contents=user_message,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=PlanResponse,
        ),
    )
    return response.parsed


async def _get_plan_openai(user_message: str) -> PlanResponse:
    response = openai_client.beta.chat.completions.parse(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        response_format=PlanResponse,
    )
    return response.choices[0].message.parsed


async def _call_llm(user_message: str) -> PlanResponse:
    # LLM provider 분기
    provider = settings.llm_provider.lower()
    if provider == "gemini":
        return await _get_plan_gemini(user_message)
    elif provider == "openai":
        return await _get_plan_openai(user_message)
    raise ValueError(f"지원하지 않는 LLM provider: {provider}")


def _log_reasoning(plan: PlanResponse) -> None:
    if plan.reasoning:
        print(f"[Vorder] REASONING_CURRENT: {plan.reasoning.current_basis}")
        print(f"[Vorder] REASONING_NEXT: {plan.reasoning.next_prediction}")


def _validate_plan_targets(plan: PlanResponse, elements: list[InteractiveElement]) -> None:
    el_map = {el.node_id: el for el in elements}
    valid_node_ids = set(el_map)
    valid_actions = []
    for action in plan.actions:
        if action.type in TARGET_REQUIRED_ACTIONS:
            if action.node_id is None or not action.name:
                continue
            if action.node_id not in valid_node_ids:
                continue
            if action.type == "click":
                el = el_map[action.node_id]
                if not _is_clickable(el):
                    continue
            valid_actions.append(action)
            continue

        if action.type in TARGETLESS_ACTIONS:
            if action.node_id is None or action.node_id in valid_node_ids:
                valid_actions.append(action)
            continue

        if action.node_id is not None and action.node_id in valid_node_ids:
            valid_actions.append(action)

    valid_overlay_targets = []
    for target in plan.overlay_targets:
        if target.node_id in valid_node_ids:
            valid_overlay_targets.append(target)

    plan.actions = valid_actions
    plan.overlay_targets = valid_overlay_targets


def _should_enter_recovery(plan: PlanResponse, original_plan_type: str) -> tuple[bool, str | None]:
    if (
        not plan.actions
        and not plan.overlay_targets
        and original_plan_type not in ("completed", "error")
    ):
        return True, "LLM이 반환한 액션이 현재 DOM에서 실행 가능한 요소와 매칭되지 않음"

    if original_plan_type == "error":
        return True, plan.description or "정제된 DOM에서 목표와 관련된 실행 가능한 요소를 찾지 못함"

    return False, None


def _finalize_process_state(request: PlanRequest, process_state: ProcessState, plan: PlanResponse) -> None:
    if request.step == 0 and plan.intent:
        process_state.intent = plan.intent

    # 이번 응답의 next_hint를 ProcessState에 저장 (다음 step에서 사용)
    if plan.next_hint:
        process_state.last_next_hint = plan.next_hint
        print(f"[Vorder] NEXT_HINT: keywords={plan.next_hint.keywords}, tags={plan.next_hint.preferred_tags}")
    else:
        process_state.last_next_hint = None


def _log_plan(plan: PlanResponse) -> None:
    print(f"[Vorder] PLAN_TYPE: {plan.plan_type} | {plan.description}")
    if plan.recovery_mode:
        print(f"[RecoveryMode] current_page_state={plan.reasoning.current_basis if plan.reasoning else ''}")
        print(f"[RecoveryMode] prediction_mismatch_reason={plan.recovery_reason or ''}")
        print(f"[RecoveryMode] revised_action={plan.description}")
    for i, action in enumerate(plan.actions):
        print(f"[Vorder] ACTION[{i}]: type={action.type} node_id={action.node_id} name={action.name!r} desc={action.description}")


async def get_plan(request: PlanRequest, process_state: ProcessState) -> PlanResponse:
    # 이전 step의 next_hint를 DOM 필터에 전달
    hint_keywords = None
    hint_tags = None
    if process_state.last_next_hint:
        hint_keywords = process_state.last_next_hint.keywords or None
        hint_tags = process_state.last_next_hint.preferred_tags or None

    filtered = filter_elements(
        request.page_state.interactive_elements,
        request.user_request,
        hint_keywords=hint_keywords,
        hint_tags=hint_tags,
    )

    user_message = build_user_message(request, filtered, intent=process_state.intent)
    plan = await _call_llm(user_message)
    _log_reasoning(plan)

    original_plan_type = plan.plan_type
    _validate_plan_targets(plan, request.page_state.interactive_elements)
    should_recover, recovery_reason = _should_enter_recovery(plan, original_plan_type)

    if should_recover:
        print("[RecoveryMode] Entered recovery mode")
        print(f"[RecoveryMode] predicted_action={process_state.last_next_hint.expected_action if process_state.last_next_hint else ''}")
        print(f"[RecoveryMode] reason={recovery_reason}")

        recovery_message = build_user_message(
            request,
            request.page_state.interactive_elements,
            intent=process_state.intent,
            recovery_mode=True,
            recovery_reason=recovery_reason,
        )
        plan = await _call_llm(recovery_message)
        plan.recovery_mode = True
        plan.recovery_reason = plan.recovery_reason or recovery_reason
        _log_reasoning(plan)

        original_plan_type = plan.plan_type
        _validate_plan_targets(plan, request.page_state.interactive_elements)

        if (
            not plan.actions
            and not plan.overlay_targets
            and original_plan_type not in ("completed", "error")
        ):
            plan.plan_type = "error"
            plan.description = RECOVERY_STOP_DESCRIPTION

    _finalize_process_state(request, process_state, plan)

    _log_plan(plan)

    return plan
