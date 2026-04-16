from pydantic import BaseModel


class ScreenAlert(BaseModel):
    type: str
    text: str


class ScreenMeta(BaseModel):
    current_step: str | None = None
    alerts: list[ScreenAlert] = []


class FrameInfo(BaseModel):
    frame_id: str
    parent_frame_id: str | None = None
    url: str | None = None


class SelectOption(BaseModel):
    value: str
    text: str


class InteractiveElement(BaseModel):
    id: str
    frame_id: str
    tag: str
    type: str | None = None
    role: str | None = None
    text: str
    aria_label: str | None = None
    nearby_text: str | None = None
    placeholder: str | None = None
    value: str | None = None
    checked: bool | None = None
    name: str | None = None
    required: bool = False
    options: list[SelectOption] | None = None
    selector: str
    enabled: bool


class PageState(BaseModel):
    url: str
    title: str
    screen_meta: ScreenMeta
    frames: list[FrameInfo]
    interactive_elements: list[InteractiveElement]


class ProcessState(BaseModel):
    goal: str
    completed_steps: list[str] = []
    current_phase: str = "started"
    visited_urls: list[str] = []


class PlanRequest(BaseModel):
    session_id: str
    user_request: str
    page_state: PageState
    previous_actions: list[dict] = []
    step: int = 0


class Action(BaseModel):
    type: str
    element_id: str | None = None
    value: str | None = None
    description: str


class OverlayTarget(BaseModel):
    element_id: str
    label: str
    input_type: str


class PlanResponse(BaseModel):
    plan_type: str
    actions: list[Action] = []
    overlay_targets: list[OverlayTarget] = []
    description: str
    is_complete: bool
