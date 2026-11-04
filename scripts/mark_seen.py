#!/usr/bin/env python3
"""게시물을 만든 공고 id를 state/seen.json에 기록해 다음 수집에서 빠지게 한다.

    python3 scripts/mark_seen.py posts/2026-11-04/<id>/post.json [...]

승인·반려와 상관없이 post.json을 만든 시점에 기록한다 (같은 공고를 다시 올리지 않기 위해).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEEN_PATH = ROOT / "state" / "seen.json"


def main(paths: list[str]) -> int:
    data = json.loads(SEEN_PATH.read_text(encoding="utf-8")) if SEEN_PATH.exists() else {"ids": {}}
    now = datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds")
    for path in paths:
        post = json.loads(Path(path).read_text(encoding="utf-8"))
        data["ids"].setdefault(post["id"], now)
    SEEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEEN_PATH.write_text(json.dumps({"ids": dict(sorted(data["ids"].items()))}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"seen {len(data['ids'])} ids", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
