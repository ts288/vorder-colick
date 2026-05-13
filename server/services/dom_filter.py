import re

try:
    from ..models.schemas import InteractiveElement
except ImportError:
    from models.schemas import InteractiveElement


INTENT_PATTERNS = [
    (re.compile(r"입력|작성|검색|쓰|타이핑"), {"input", "textarea"}),
    (re.compile(r"클릭|누르|선택|이동|가|열"), {"button", "a"}),
    (re.compile(r"선택|고르|드롭|옵션"), {"select"}),
    (re.compile(r"제출|신청|확인|완료|저장"), {"button", "input"}),
]

CTA_PATTERNS = {
    "신청", "제출", "확인", "다음", "로그인", "조회", "등록", "저장", "검색", "동의",
    "발급", "접수", "예약", "신고", "취소", "삭제", "출력", "인쇄", "열람", "납부",
    "변경", "수정", "시작", "진행", "완료", "전송", "입력",
}

MAX_ELEMENTS = 20
SENSITIVE_MAX_ELEMENTS = 25
SENSITIVE_TEXT_FIELD_MAX = 15
SENSITIVE_BUTTON_MAX = 10
SCORE_THRESHOLD = 2.0   # 이 점수 미만은 관련 없다고 판단
FALLBACK_COUNT = 10     # 임계치 통과 요소가 0개일 때 점수 상위 N개로 폴백
MIN_HINT_RESULTS = 3    # hint 기반 결과가 이보다 적으면 유저 키워드 결과와 병합

INTERACTIVE_TAGS = {"button", "input", "textarea", "select", "a"}
NON_INTERACTIVE_PENALTY = -5.0  # 직접 인터랙션 불가 태그 패널티
HINT_KEYWORD_WEIGHT = 10.0      # next_hint 키워드 매칭 — 최고 가중치

# 민감정보 관련 맥락을 나타내는 키워드 (user_request / hint_keywords 에서 탐지)
SENSITIVE_INTENT_KW = {
    "로그인", "회원가입", "가입", "인증", "본인확인", "결제", "송금", "이체",
    "비밀번호", "패스워드", "아이디", "주민", "주민등록", "생년월일",
    "전화", "휴대폰", "휴대전화", "계좌", "카드", "인증번호", "인증서",
}

# 민감 필드로 판정할 요소의 필드값 키워드
SENSITIVE_FIELD_KW = {
    "비밀번호", "패스워드", "주민", "생년월일", "전화", "휴대폰", "휴대전화",
    "계좌", "카드", "인증",
}


def filter_elements(
    elements: list[InteractiveElement],
    user_request: str,
    hint_keywords: list[str] | None = None,
    hint_tags: list[str] | None = None,
) -> list[InteractiveElement]:
    keywords = _extract_keywords(user_request)
    boosted_tags = _detect_intent_tags(user_request)
    hint_kw_set = set(hint_keywords or [])
    hint_tag_set = set(hint_tags or [])

    # 점수 계산
    scored = [
        (el, _score(el, keywords, boosted_tags, hint_kw_set, hint_tag_set))
        for el in elements
    ]

    # 무조건 포함 (기본 규칙)
    # 빈 입력 필드도 overlay 후보가 되어야 하므로 텍스트 입력 계열은 항상 LLM에 전달한다.
    forced_elements = [el for el in elements if _must_include(el) or _is_text_input_field(el)]

    sensitive_mode = _needs_sensitive_context(elements, user_request, hint_kw_set)

    # 민감 필드는 사용자 요청 또는 hint 에 민감 맥락이 있을 때만 강제 포함
    if sensitive_mode:
        already_forced_ids = {el.node_id for el in forced_elements}
        for el in elements:
            if el.node_id in already_forced_ids:
                continue
            if _is_sensitive_field(el):
                forced_elements.append(el)

    forced = forced_elements
    forced_ids = {el.node_id for el in forced}

    relaxed_elements: list[InteractiveElement] = []
    if sensitive_mode:
        relaxed_elements = _collect_sensitive_mode_elements(elements, forced_ids)

    relaxed_ids = {el.node_id for el in relaxed_elements}

    # 임계치 기반 필터링 후 점수 내림차순 정렬 (DOM 순서가 아닌 관련도 순으로 cap)
    passed_scored = sorted(
        [
            (el, s)
            for el, s in scored
            if el.node_id not in forced_ids
            and el.node_id not in relaxed_ids
            and s >= SCORE_THRESHOLD
        ],
        key=lambda x: x[1],
        reverse=True,
    )
    passed = [el for el, _ in passed_scored]

    # 폴백: 임계치 통과 요소가 없으면 점수 상위 FALLBACK_COUNT개
    if not passed and not sensitive_mode:
        candidates = [(el, s) for el, s in scored if el.node_id not in forced_ids]
        passed = [el for el, _ in sorted(candidates, key=lambda x: x[1], reverse=True)[:FALLBACK_COUNT]]

    # 전체 cap
    max_elements = SENSITIVE_MAX_ELEMENTS if sensitive_mode else MAX_ELEMENTS
    remaining_slots = max(0, max_elements - len(forced) - len(relaxed_elements))
    capped = passed[:remaining_slots]

    # 원래 순서 유지
    all_ids_ordered = {el.node_id: i for i, el in enumerate(elements)}
    result = sorted(
        forced + relaxed_elements + capped,
        key=lambda el: all_ids_ordered.get(el.node_id, 9999),
    )

    # 디버깅: 수집된 전체 요소와 필터 결과
    def _frame_prefix(el):
        return f"[{el.frame_id}]" if el.frame_id != "main" else ""

    def _display_text(el):
        value = el.text or el.name or el.placeholder or el.aria_label or el.nearby_text or el.input_name
        if not value:
            return None
        return value[:20]

    all_names = [
        f"{_frame_prefix(el)}{el.tag}:{text}"
        for el in elements
        if (text := _display_text(el))
    ]
    result_names = [
        f"{_frame_prefix(el)}{el.tag}:{text}"
        for el in result
        if (text := _display_text(el))
    ]
    print(f"[Vorder] DOM_ALL({len(elements)}): {all_names}")
    print(f"[Vorder] DOM_RESULT({len(result)}): {result_names}")
    return result


def _extract_keywords(text: str) -> list[str]:
    tokens = [t for t in re.split(r"[\s\u3000,./]+", text) if len(t) >= 2]
    # 한국어 동사 어간 추출 (간단 버전)
    stems = set()
    for t in tokens:
        stems.add(t)
        if len(t) >= 3:
            stems.add(t[:-1])  # "신청하고" → "신청하"
        if len(t) >= 4:
            stems.add(t[:-2])  # "신청하고" → "신청"
    return list(stems)


def _detect_intent_tags(text: str) -> set[str]:
    tags: set[str] = set()
    for pattern, tag_set in INTENT_PATTERNS:
        if pattern.search(text):
            tags |= tag_set
    return tags


def _score(
    el: InteractiveElement,
    keywords: list[str],
    boosted_tags: set[str],
    hint_keywords: set[str],
    hint_tags: set[str],
) -> float:
    score = 0.0

    # 유저 키워드 매칭
    search_fields = [
        (el.text, 3.0),
        (el.nearby_text or "", 2.0),
        (el.placeholder or "", 2.0),
        (el.aria_label or "", 1.5),
    ]
    for field, weight in search_fields:
        for kw in keywords:
            if kw in field:
                score += weight

    if el.tag in boosted_tags:
        score += 2.0

    # 비대화형 태그 패널티 (button/input/textarea/select/a 외)
    if el.tag not in INTERACTIVE_TAGS:
        score += NON_INTERACTIVE_PENALTY

    # hint 키워드 매칭 — 최고 가중치
    hint_fields = [el.text or "", el.name or "", el.aria_label or "", el.placeholder or ""]
    for hk in hint_keywords:
        for field in hint_fields:
            if hk in field:
                score += HINT_KEYWORD_WEIGHT
                break  # 같은 hint 키워드에 대해 한 번만 가산

    # hint 태그 매칭
    if hint_tags and el.tag in hint_tags:
        score += 3.0

    # CTA 패턴 보너스 (must_include 대신 점수 기반으로 처리)
    if el.tag in {"button", "a"} and el.enabled:
        text = el.text or ""
        if any(p in text for p in CTA_PATTERNS):
            score += 4.0

    return score


def _must_include(el: InteractiveElement) -> bool:
    if el.required:
        return True
    if el.tag == "select" and el.options:
        return True
    if el.type == "submit" and el.enabled:
        return True
    return False


def _needs_sensitive_context(
    elements: list[InteractiveElement],
    user_request: str,
    hint_keywords: set[str],
) -> bool:
    """사용자 요청/힌트 또는 페이지 구조로 민감 입력 모드가 필요한지 판단."""
    haystack = user_request or ""
    if hint_keywords:
        haystack = haystack + " " + " ".join(hint_keywords)
    has_sensitive_request = any(kw in haystack for kw in SENSITIVE_INTENT_KW)
    has_sensitive_field = any(
        el.type == "password" or _is_sensitive_field(el)
        for el in elements
    )
    has_text_input = any(_is_text_input_field(el) for el in elements)
    return has_text_input and (has_sensitive_request or has_sensitive_field)


def _collect_sensitive_mode_elements(
    elements: list[InteractiveElement],
    excluded_ids: set[int],
) -> list[InteractiveElement]:
    text_fields: list[InteractiveElement] = []
    button_fields: list[InteractiveElement] = []

    for el in elements:
        if el.node_id in excluded_ids:
            continue
        if _is_text_input_field(el):
            text_fields.append(el)
            continue
        if _is_sensitive_mode_button(el):
            button_fields.append(el)

    return text_fields[:SENSITIVE_TEXT_FIELD_MAX] + button_fields[:SENSITIVE_BUTTON_MAX]


def _is_text_input_field(el: InteractiveElement) -> bool:
    if not el.enabled:
        return False
    if el.tag == "textarea":
        return True
    return el.tag == "input" and (el.type or "text") in {
        "text",
        "email",
        "tel",
        "number",
        "password",
        "search",
        "url",
        "date",
        "month",
        "week",
        "time",
        "datetime-local",
    }


def _is_sensitive_mode_button(el: InteractiveElement) -> bool:
    if not el.enabled:
        return False
    if el.tag in {"button", "a"}:
        return True
    return el.tag == "input" and el.type in {"submit", "button"}


def _is_sensitive_field(el: InteractiveElement) -> bool:
    """민감정보 입력용 필드인지 판정."""
    if el.type == "password":
        return True
    if el.tag not in {"input", "textarea", "select"}:
        return False
    fields = [
        el.text or "",
        el.placeholder or "",
        el.aria_label or "",
        el.input_name or "",
        el.nearby_text or "",
    ]
    combined = " ".join(fields)
    return any(kw in combined for kw in SENSITIVE_FIELD_KW)
