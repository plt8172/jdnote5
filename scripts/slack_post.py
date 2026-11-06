#!/usr/bin/env python3
"""공고마다 Slack 메시지 하나를 보낸다: 슬라이드 이미지 + 캡션 미리보기 + [승인][반려] 버튼.

    JDNOTE_SLACK_BOT_TOKEN=xoxb-... python3 scripts/slack_post.py posts/2026-11-04/<id>/post.json [...]
    python3 scripts/slack_post.py --dry-run posts/...post.json   # 보낼 내용만 출력

이미지는 GitHub raw URL을 Block Kit 이미지 블록으로 보여 준다. Instagram도 같은 URL에서
받아 가므로 Slack에서 보이는 슬라이드가 그대로 게시된다. 그래서 커밋·푸시한 뒤에 실행한다.

버튼 value는 공고 경로 키("2026-11-04/<id>")다. Worker는 이 키로
raw URL의 post.json(캡션·슬라이드 수)과 1.jpg… 를 찾는다.

필요한 Slack 권한: chat:write (봇이 채널에 초대돼 있어야 한다).
종료 코드: 0 = 전부 전송, 1 = 하나 이상 실패.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "jdnote.json"
SLACK_API = os.environ.get("SLACK_API_BASE", "https://slack.com/api")
CAPTION_LIMIT = 2200  # Instagram 캡션 최대 길이
HASHTAG_LIMIT = 30
PREVIEW_LIMIT = 2800  # Slack section 텍스트 최대 3000자
MAX_SLIDES = 10  # Instagram 캐러셀 최대 장수


def post_key(post_path: Path) -> str:
    """posts/<날짜>/<id>/post.json → "<날짜>/<id>". Worker와 약속한 버튼 value 형식."""
    return f"{post_path.parent.parent.name}/{post_path.parent.name}"


def slide_paths(post_path: Path) -> list[Path]:
    paths = sorted(post_path.parent.glob("[0-9]*.jpg"), key=lambda p: int(p.stem))
    # 1.jpg부터 빠짐없이 이어져야 Worker가 장 수만으로 URL을 만들 수 있다.
    return paths if [int(p.stem) for p in paths] == list(range(1, len(paths) + 1)) else []


def raw_url(config: dict, key: str, name: str) -> str:
    repo = config.get("github_repo", "plt8172/jdnote5")
    branch = config.get("github_branch", "main")
    return f"https://raw.githubusercontent.com/{repo}/{branch}/posts/{key}/{name}"


def validate(post: dict, slides: list[Path]) -> list[str]:
    errors = [f"missing field: {k}" for k in ("id", "title", "caption", "link") if not post.get(k)]
    caption = post.get("caption", "")
    if len(caption) > CAPTION_LIMIT:
        errors.append(f"caption {len(caption)} chars > {CAPTION_LIMIT}")
    if caption.count("#") > HASHTAG_LIMIT:
        errors.append(f"more than {HASHTAG_LIMIT} hashtags")
    if not 2 <= len(slides) <= MAX_SLIDES:
        errors.append(f"need 2-{MAX_SLIDES} rendered slides 1.jpg.., found {len(slides)}")
    elif post.get("slides") != len(slides):
        errors.append(f"post.json slides={post.get('slides')} but {len(slides)} images (render again)")
    return errors


def wait_until_public(url: str, attempts: int = 6, delay: float = 5.0) -> bool:
    """푸시 직후 raw CDN에 반영되기까지 잠깐 걸릴 수 있어 몇 번 다시 확인한다."""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=15) as response:
                if response.status == 200:
                    return True
        except urllib.error.URLError:
            pass
        if attempt < attempts - 1:
            time.sleep(delay)
    return False


def build_message(channel: str, post: dict, key: str, image_urls: list[str]) -> dict:
    caption = post["caption"]
    if len(caption) > PREVIEW_LIMIT:
        caption = caption[: PREVIEW_LIMIT - 1] + "…"
    title = post["title"].replace("\n", " ")
    images = [
        {"type": "image", "block_id": f"slide_{i}", "image_url": url, "alt_text": f"{title} {i}/{len(image_urls)}"}
        for i, url in enumerate(image_urls, start=1)
    ]
    return {
        "channel": channel,
        "text": f"게시 승인 요청: {post.get('company', '')} {title}",
        "unfurl_links": False,
        "unfurl_media": False,
        "blocks": [
            *images,
            {"type": "section", "block_id": "caption", "text": {"type": "mrkdwn", "text": f"*캡션 미리보기*\n{caption}"}},
            {"type": "context", "block_id": "source", "elements": [{"type": "mrkdwn", "text": f"원문: <{post['link']}|{post.get('company') or '공고 링크'}> · 공고 `{key}` · {len(image_urls)}장"}]},
            {
                "type": "actions",
                "block_id": "jdnote_review",
                "elements": [
                    {"type": "button", "action_id": "approve", "style": "primary", "value": key,
                     "text": {"type": "plain_text", "text": "승인"}},
                    {"type": "button", "action_id": "reject", "style": "danger", "value": key,
                     "text": {"type": "plain_text", "text": "반려"}},
                ],
            },
        ],
    }


def post_message(token: str, message: dict) -> dict:
    request = urllib.request.Request(
        f"{SLACK_API}/chat.postMessage",
        data=json.dumps(message).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("posts", nargs="+", type=Path, help="posts/<날짜>/<id>/post.json")
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--dry-run", action="store_true", help="보내지 않고 메시지 JSON만 출력")
    parser.add_argument("--skip-url-check", action="store_true", help="raw URL 공개 여부 확인 생략 (테스트용)")
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8")) if args.config.exists() else {}
    # 클라우드 환경의 SLACK_BOT_TOKEN·SLACK_CHANNEL_ID는 Semifeed 봇 것이라 읽지 않는다.
    # JD노트 카드가 Semifeed 봇으로 가면 버튼이 Semifeed Worker로 가서 게시되지 않는다.
    channel = os.environ.get("JDNOTE_SLACK_CHANNEL_ID") or config.get("slack_channel_id")
    token = os.environ.get("JDNOTE_SLACK_BOT_TOKEN", "")
    if not args.dry_run and not (token and channel):
        print("JDNOTE_SLACK_BOT_TOKEN 환경 변수와 slack_channel_id 설정이 필요합니다.", file=sys.stderr)
        return 1

    failed = 0
    for post_path in args.posts:
        post = json.loads(post_path.read_text(encoding="utf-8"))
        key = post_key(post_path)
        slides = slide_paths(post_path)
        errors = validate(post, slides)
        urls = [raw_url(config, key, p.name) for p in slides]
        if not errors and not args.dry_run and not args.skip_url_check:
            for url in [*urls, raw_url(config, key, "post.json")]:
                if not wait_until_public(url):
                    errors.append(f"not public yet (push first?): {url}")
        if errors:
            failed += 1
            print(f"[FAIL] {post_path}: " + "; ".join(errors), file=sys.stderr)
            continue

        message = build_message(channel or "", post, key, urls)
        if args.dry_run:
            print(json.dumps(message, ensure_ascii=False, indent=2))
            continue
        try:
            result = post_message(token, message)
        except urllib.error.URLError as error:
            result = {"ok": False, "error": str(error)}
        if result.get("ok"):
            print(f"[ok  ] {post_path} -> ts {result.get('ts')}", file=sys.stderr)
        else:
            failed += 1
            print(f"[FAIL] {post_path}: slack error {result.get('error')}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
