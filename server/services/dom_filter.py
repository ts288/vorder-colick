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

MAX_ELEMENTS = 20
SCORE_THRESHOLD = 2.0   # 이 점수 미만은 관련 없다고 판단
FALLBACK_COUNT = 10     # 임계치 통과 요소가 0개일 때 점수 상위 N개로 폴백


def filter_elements(
    elements: list[InteractiveElement],
    user_request: str,
) -> list[InteractiveElement]:
    keywords = _extract_keywords(user_request)
    boosted_tags = _detect_intent_tags(user_request)

    # 점수 계산
    scored = [(el, _score(el, keywords, boosted_tags)) for el in elements]

    # 무조건 포함
    forced = [el for el in elements if _must_include(el)]
    forced_ids = {el.node_id for el in forced}

    # 임계치 기반 필터링 (forced 제외)
    passed = [
        el for el, score in scored
        if el.node_id not in forced_ids and score >= SCORE_THRESHOLD
    ]

    # 폴백: 임계치 통과 요소가 없으면 점수 상위 FALLBACK_COUNT개
    if not passed:
        candidates = [(el, s) for el, s in scored if el.node_id not in forced_ids]
        passed = [el for el, _ in sorted(candidates, key=lambda x: x[1], reverse=True)[:FALLBACK_COUNT]]

    # 전체 cap
    remaining_slots = MAX_ELEMENTS - len(forced)
    capped = passed[:remaining_slots]

    # 원래 순서 유지
    all_ids_ordered = {el.node_id: i for i, el in enumerate(elements)}
    result = sorted(forced + capped, key=lambda el: all_ids_ordered.get(el.node_id, 9999))

    print(
        f"[Vorder] DOM_FILTER: {len(elements)}개 → {len(result)}개 "
        f"(forced={len(forced)}, passed={len(passed)}, threshold={SCORE_THRESHOLD})"
    )
    return result


def _extract_keywords(text: str) -> list[str]:
    return [t for t in re.split(r"[\s\u3000,./]+", text) if len(t) >= 2]


def _detect_intent_tags(text: str) -> set[str]:
    tags: set[str] = set()
    for pattern, tag_set in INTENT_PATTERNS:
        if pattern.search(text):
            tags |= tag_set
    return tags


def _score(el: InteractiveElement, keywords: list[str], boosted_tags: set[str]) -> float:
    score = 0.0
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

    return score


def _must_include(el: InteractiveElement) -> bool:
    if el.required:
        return True
    if el.tag == "select" and el.options:
        return True
    if el.type == "submit" and el.enabled:
        return True
    return False
