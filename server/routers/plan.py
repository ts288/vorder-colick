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
    sessions: dict[str, ProcessState] = app_request.app.state.sessions

    if req.session_id not in sessions:
        sessions[req.session_id] = ProcessState(goal=req.user_request)

    process_state = sessions[req.session_id]
    process_state.current_phase = "in_progress"

    if req.page_state.url not in process_state.visited_urls:
        process_state.visited_urls.append(req.page_state.url)

    print(f"\n[Vorder] USER_REQUEST: {req.user_request}")
    print(f"[Vorder] PAGE_URL: {req.page_state.url}")
    print(f"[Vorder] ELEMENTS_TOTAL: {len(req.page_state.interactive_elements)}")

    try:
        result = await get_plan(req, process_state)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if result.is_complete:
        process_state.current_phase = "done"
        process_state.completed_steps.append(result.description)

    return result
