from google import genai
from google.genai import types

try:
    from ..config import settings
    from ..models.schemas import PlanRequest, PlanResponse, ProcessState
    from ..prompts.planner import SYSTEM_PROMPT, build_user_message
    from .dom_filter import filter_elements
except ImportError:
    from config import settings
    from models.schemas import PlanRequest, PlanResponse, ProcessState
    from prompts.planner import SYSTEM_PROMPT, build_user_message
    from services.dom_filter import filter_elements


client = genai.Client(api_key=settings.gemini_api_key)


async def get_plan(request: PlanRequest, process_state: ProcessState) -> PlanResponse:
    filtered = filter_elements(
        request.page_state.interactive_elements,
        request.user_request,
    )

    user_message = build_user_message(request, filtered)

    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=user_message,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=PlanResponse,
        ),
    )

    plan: PlanResponse = response.parsed

    valid_ids = {el.id for el in request.page_state.interactive_elements}

    valid_actions = []
    for action in plan.actions:
        if action.element_id is None or action.element_id in valid_ids:
            valid_actions.append(action)
        else:
            print(f"[Vorder] 유효하지 않은 element_id 제거: {action.element_id}")

    valid_overlay_targets = []
    for target in plan.overlay_targets:
        if target.element_id in valid_ids:
            valid_overlay_targets.append(target)
        else:
            print(f"[Vorder] 유효하지 않은 overlay element_id 제거: {target.element_id}")

    plan.actions = valid_actions
    plan.overlay_targets = valid_overlay_targets

    if (
        not valid_actions
        and not valid_overlay_targets
        and plan.plan_type not in ("completed", "error")
    ):
        plan.plan_type = "error"
        plan.description = "유효한 액션이 없습니다. DOM을 다시 수집하거나 요청을 확인해주세요."

    return plan
