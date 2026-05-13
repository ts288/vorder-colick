from fastapi import APIRouter, HTTPException, Request

try:
    from ..models.schemas import PlanRequest, PlanResponse, ProcessState
    from ..services.llm_service import get_plan
except ImportError:
    from models.schemas import PlanRequest, PlanResponse, ProcessState
    from services.llm_service import get_plan


router = APIRouter(prefix="/api", tags=["plan"])


@router.post("/plan", response_model=PlanResponse)
async def plan_endpoint(req: PlanRequest, app_request: Request):
    if req.step == 0:
        app_request.app.state.process_state = ProcessState(goal=req.user_request)

    process_state: ProcessState = app_request.app.state.process_state
    process_state.current_phase = "in_progress"

    if req.page_state.url not in process_state.visited_urls:
        process_state.visited_urls.append(req.page_state.url)

    elements = req.page_state.interactive_elements
    iframe_count = sum(1 for el in elements if el.frame_id != "main")
    main_count = len(elements) - iframe_count
    if iframe_count and main_count:
        dom_scope = "mixed"
    elif iframe_count:
        dom_scope = "iframe"
    elif main_count:
        dom_scope = "main"
    else:
        dom_scope = "empty"
    print(f"[Vorder] DOM_SCOPE: {dom_scope} (main={main_count}, iframe={iframe_count})")

    try:
        result = await get_plan(req, process_state)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    result.current_actions = list(result.actions)

    if result.is_complete:
        process_state.current_phase = "done"
        process_state.completed_steps.append(result.description)

    return result
