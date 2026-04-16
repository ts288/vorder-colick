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

MAX_ELEMENTS = 80


def filter_elements(
    elements: list[InteractiveElement],
    user_request: str,
) -> list[InteractiveElement]:
    keywords = _extract_keywords(user_request)
    boosted_tags = _detect_intent_tags(user_request)

    scored = []
    for el in elements:
        score = _score(el, keywords, boosted_tags)
        scored.append((score, el))

    forced = [el for el in elements if _must_include(el)]
    forced_ids = {el.id for el in forced}

    ranked = sorted(
        [(s, el) for s, el in scored if el.id not in forced_ids],
        key=lambda x: x[0],
        reverse=True,
    )

    top = [el for _, el in ranked[: max(0, MAX_ELEMENTS - len(forced))]]

    all_ids_ordered = {el.id: i for i, el in enumerate(elements)}
    result = sorted(forced + top, key=lambda el: all_ids_ordered.get(el.id, 9999))

    print(f"[Vorder] DOM_FILTER: {len(elements)}개 → {len(result)}개 (forced={len(forced)})")
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
