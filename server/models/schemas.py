from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _Base(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )


class ScreenAlert(_Base):
    type: str
    text: str


class ScreenMeta(_Base):
    current_step: str | None = None
    alerts: list[ScreenAlert] = []


class FrameInfo(_Base):
    frame_id: str
    parent_frame_id: str | None = None
    url: str | None = None


class SelectOption(_Base):
    value: str
    text: str


class InteractiveElement(_Base):
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


class PageState(_Base):
    url: str
    title: str
    screen_meta: ScreenMeta
    frames: list[FrameInfo]
    interactive_elements: list[InteractiveElement]


class ProcessState(_Base):
    goal: str
    completed_steps: list[str] = []
    current_phase: str = "started"
    visited_urls: list[str] = []


class PlanRequest(_Base):
    user_request: str
    page_state: PageState
    previous_actions: list[dict] = []
    step: int = 0


class Action(_Base):
    type: str
    element_id: str | None = None
    value: str | None = None
    description: str


class OverlayTarget(_Base):
    element_id: str
    label: str
    input_type: str


class PlanResponse(_Base):
    plan_type: str
    actions: list[Action] = []
    current_actions: list[Action] = []
    overlay_targets: list[OverlayTarget] = []
    description: str
    is_complete: bool
