#!/usr/bin/env python3
"""post.json을 templates/carousel.html에 채워 캐러셀 슬라이드 JPEG(1080×1350)를 만든다.

    python3 scripts/render.py posts/2026-11-04/lam-fse-pyeongtaek/post.json [...]
    → 같은 폴더에 1.jpg ~ 5.jpg

post.json 필드 (예시는 posts/example/post.json):
    id            공고 id (폴더 이름과 같다)
    company       회사 이름 (표지)
    title         한국어 직무명, 줄바꿈은 \\n
    title_en      원문 직무명
    role_detail   원문 세부 직함·부서·지역 한 줄
    location, experience, english   표지 칩 세 개 (짧게)
    deadline      마감일 YYYY-MM-DD. 없으면 null → "상시 채용"
    tags          표지 상단 태그 목록 (예: ["신입 OK"])
    hook          표지 아래 두 줄. 줄바꿈은 \n, **강조**는 형광펜
    duties, requirements, preferred, apply_steps
                  [{"text": "...", "sub": "선택"}] 목록. 각 3~5개
    duties_tip, requirements_tip, preferred_tip   선택. 말풍선 한 줄
    source        표지 하단 출처 (예: "Lam Research 채용 사이트")
    short         2~4장 하단 짧은 이름 (예: "Lam Research · FSE")
    link, caption 렌더링에는 쓰지 않음 (Slack 미리보기·Instagram 캡션)
    slides        렌더링 후 이 스크립트가 장 수를 기록한다 (Worker가 사용)

D-day는 렌더링한 날(KST) 기준으로 계산한다. 마감이 지났으면 렌더링을 거부한다.
문구가 영역을 넘치면 JPEG를 만들지 않고 종료 코드 2로 끝낸다. 문구를 줄여 다시 실행하라는 신호다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "templates" / "carousel.html"
CONFIG_PATH = ROOT / "config" / "jdnote.json"
SLIDES = ["cover", "duties", "requirements", "preferred", "apply"]
WIDTH, HEIGHT = 1080, 1350
JPEG_QUALITY = 92
FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium"
KST = timezone(timedelta(hours=9))
WEEKDAYS = "월화수목금토일"
REQUIRED = ["id", "company", "title", "location", "experience", "english",
            "duties", "requirements", "apply_steps", "source", "short"]


def today_kst() -> date:
    return datetime.now(KST).date()


def deadline_text(deadline: str | None, today: date) -> tuple[str, str]:
    """(스티커 큰 글씨, 작은 글씨). 마감이 지났으면 ValueError."""
    if not deadline:
        return "상시", "채용 시 마감"
    end = date.fromisoformat(deadline)
    days = (end - today).days
    if days < 0:
        raise ValueError(f"deadline passed: {deadline}")
    small = f"{end.month}.{end.day}({WEEKDAYS[end.weekday()]}) 마감"
    return ("D-DAY" if days == 0 else f"D-{days}"), small


def validate(post: dict) -> list[str]:
    errors = [f"missing field: {k}" for k in REQUIRED if not post.get(k)]
    for key in ("duties", "requirements", "preferred", "apply_steps"):
        items = post.get(key) or []
        if key == "preferred" and not items:
            continue
        if not isinstance(items, list) or not 1 <= len(items) <= 5 or not all(isinstance(i, dict) and i.get("text") for i in items):
            errors.append(f"{key} must be 1-5 items of {{text, sub?}}")
    return errors


def slides_for(post: dict) -> list[str]:
    # 우대 사항이 없는 공고는 그 장을 건너뛴다.
    return [s for s in SLIDES if s != "preferred" or post.get("preferred")]


def launch(playwright):
    try:
        return playwright.chromium.launch()
    except PlaywrightError:
        return playwright.chromium.launch(executable_path=os.environ.get("JDNOTE_CHROMIUM", FALLBACK_CHROMIUM))


def render(page, post_path: Path, config: dict, today: date | None = None) -> list[str]:
    post = json.loads(post_path.read_text(encoding="utf-8"))
    errors = validate(post)
    try:
        dday, deadline = deadline_text(post.get("deadline"), today or today_kst())
    except ValueError as error:
        errors.append(str(error))
    if errors:
        return errors

    names = slides_for(post)
    payload = {
        **post,
        "brand": config.get("brand", "JD노트"),
        "tagline": config.get("tagline", ""),
        "badge": post.get("badge") or config.get("badge", "외국계 · 엔지니어"),
        "dday": dday,
        "deadline": deadline,
        "pages": len(names),
    }
    page.goto(TEMPLATE.as_uri())
    page.evaluate("document.fonts.ready")
    shots = []
    for index, name in enumerate(names, start=1):
        page.evaluate("([post, name]) => window.fill(post, name)", [{**payload, "page": index}, name])
        page.evaluate("document.fonts.ready")
        problems = page.evaluate("window.overflow()")
        if problems:
            return [f"slide {index} ({name}) overflow: {p}" for p in problems]
        shots.append(page.screenshot(type="jpeg", quality=JPEG_QUALITY))
    # 모든 장이 통과한 뒤에만 쓴다. 일부만 바뀐 캐러셀이 남지 않게 한다.
    for old in post_path.parent.glob("[0-9]*.jpg"):
        old.unlink()
    for index, shot in enumerate(shots, start=1):
        (post_path.parent / f"{index}.jpg").write_bytes(shot)
    # Worker는 이 값으로 1.jpg…N.jpg URL을 만든다.
    if post.get("slides") != len(shots):
        post["slides"] = len(shots)
        post_path.write_text(json.dumps(post, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("posts", nargs="+", type=Path, help="posts/<날짜>/<id>/post.json")
    parser.add_argument("--today", type=date.fromisoformat, help="D-day 기준일 (테스트용, YYYY-MM-DD)")
    args = parser.parse_args()
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}

    failed = 0
    with sync_playwright() as playwright:
        browser = launch(playwright)
        page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1)
        for post_path in args.posts:
            errors = render(page, post_path, config, args.today)
            if errors:
                failed += 1
                print(f"[FAIL] {post_path}: " + "; ".join(errors), file=sys.stderr)
            else:
                print(f"[ok  ] {post_path}", file=sys.stderr)
        browser.close()
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
