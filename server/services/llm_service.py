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

    # LLM provider 분기
    provider = settings.llm_provider.lower()
    if provider == "gemini":
        plan = await _get_plan_gemini(user_message)
    elif provider == "openai":
        plan = await _get_plan_openai(user_message)
    else:
        raise ValueError(f"지원하지 않는 LLM provider: {provider}")

    print(f"[Vorder] LLM_PROVIDER: {provider}")
    if plan.reasoning:
        print(f"[Vorder] REASONING_CURRENT: {plan.reasoning.current_basis}")
        print(f"[Vorder] REASONING_NEXT: {plan.reasoning.next_prediction}")

    if request.step == 0 and plan.intent:
        process_state.intent = plan.intent

    # 이번 응답의 next_hint를 ProcessState에 저장 (다음 step에서 사용)
    if plan.next_hint:
        process_state.last_next_hint = plan.next_hint
        print(f"[Vorder] NEXT_HINT: keywords={plan.next_hint.keywords}, tags={plan.next_hint.preferred_tags}")
    else:
        process_state.last_next_hint = None

    el_map = {el.node_id: el for el in request.page_state.interactive_elements}
    valid_node_ids = set(el_map)
    requires_target = {"click", "type", "select"}

    valid_actions = []
    for action in plan.actions:
        if action.type in requires_target:
            if action.node_id is None or not action.name:
                print(f"[Vorder] node_id/name 없는 액션 제거: {action}")
                continue
            if action.node_id not in valid_node_ids:
                print(f"[Vorder] 유효하지 않은 node_id 제거: {action.node_id}")
                continue
            if action.type == "click":
                el = el_map[action.node_id]
                if not _is_clickable(el):
                    print(
                        f"[Vorder] 클릭 불가 요소 제거: {action.node_id} "
                        f"tag={el.tag} type={el.type}"
                    )
                    continue
            valid_actions.append(action)
            continue

        if action.node_id is None or action.node_id in valid_node_ids:
            valid_actions.append(action)
        else:
            print(f"[Vorder] 유효하지 않은 node_id 제거: {action.node_id}")

    valid_overlay_targets = []
    for target in plan.overlay_targets:
        if target.node_id in valid_node_ids:
            valid_overlay_targets.append(target)
        else:
            print(f"[Vorder] 유효하지 않은 overlay node_id 제거: {target.node_id}")

    plan.actions = valid_actions
    plan.overlay_targets = valid_overlay_targets

    if (
        not valid_actions
        and not valid_overlay_targets
        and plan.plan_type not in ("completed", "error")
    ):
        plan.plan_type = "error"
        plan.description = "유효한 액션이 없습니다. DOM을 다시 수집하거나 요청을 확인해주세요."

    print(f"[Vorder] PLAN_TYPE: {plan.plan_type} | {plan.description}")
    for i, action in enumerate(plan.actions):
        print(f"[Vorder] ACTION[{i}]: type={action.type} node_id={action.node_id} name={action.name!r} desc={action.description}")

    return plan
