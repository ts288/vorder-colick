from google import genai
from google.genai import types
from openai import OpenAI

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


# --- Gemini client ---
gemini_client = genai.Client(api_key=settings.gemini_api_key) if settings.gemini_api_key else None

# --- OpenAI client ---
openai_client = OpenAI(api_key=settings.openai_api_key) if settings.openai_api_key else None


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
    filtered = filter_elements(
        request.page_state.interactive_elements,
        request.user_request,
    )

    user_message = build_user_message(request, filtered)

    # LLM provider 분기
    provider = settings.llm_provider.lower()
    if provider == "gemini":
        plan = await _get_plan_gemini(user_message)
    elif provider == "openai":
        plan = await _get_plan_openai(user_message)
    else:
        raise ValueError(f"지원하지 않는 LLM provider: {provider}")

    print(f"[Vorder] LLM_PROVIDER: {provider}")

    valid_node_ids = {el.node_id for el in request.page_state.interactive_elements}

    valid_actions = []
    for action in plan.actions:
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

    return plan
