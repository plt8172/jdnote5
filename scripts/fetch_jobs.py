#!/usr/bin/env python3
"""외국계 회사 채용 사이트에서 한국 근무 공고를 모아 candidates.json을 만든다.

    python3 scripts/fetch_jobs.py                 # 전체 회사, 새 공고만
    python3 scripts/fetch_jobs.py --company lam   # 한 회사만
    python3 scripts/fetch_jobs.py --include-seen  # 이미 다룬 공고도 포함

회사별 방식 (각 사이트 robots.txt가 허용하는 경로만 쓴다):
    lam    Eightfold 공개 JSON  /api/pcsx/search, /api/pcsx/position_details
    amat   /sitemap.xml의 한국 도시 /job/ URL → 상세 페이지 JSON-LD(JobPosting)
    asml   /en/job_posting-sitemap.xml → 상세 페이지 __NEXT_DATA__ jobData
           (근무지가 상세 페이지에만 있어 처음 한 번은 전체를 읽는다. 결과는
            state/asml_index.json에 남겨 다음부터는 새 URL만 읽는다)

출력 candidates.json (저장소에 커밋하지 않는다):
    {"fetched_at": ..., "jobs": [{id, company, title, location, url, posted,
      department, engineering, description}]}
    description은 HTML을 걷어 낸 원문 JD (최대 8000자). 담당자 이름 같은 개인 정보는 담지 않는다.

state/seen.json에 있는 id는 건너뛴다. 기록은 scripts/mark_seen.py가 한다 (게시물을 만든 공고만).
종료 코드: 0 = 성공, 1 = 한 회사라도 실패 (나머지 회사 결과는 그대로 쓴다).
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "candidates.json"
SEEN_PATH = ROOT / "state" / "seen.json"
ASML_INDEX_PATH = ROOT / "state" / "asml_index.json"
USER_AGENT = "Mozilla/5.0 (compatible; jdnote-job-digest/1.0)"
DESCRIPTION_LIMIT = 8000
AMAT_KR_CITIES = ("hwaseong", "pyeongtaek", "icheon", "seongnam", "cheongju", "cheonan", "seoul", "yongin", "suwon", "giheung")
# 엔지니어 직무 추정용. Claude가 최종 선별하므로 넓게 잡는다.
ENGINEERING = re.compile(r"engineer|technician|scientist|developer|architect|specialist|expert|r&d|process|field service|엔지니어|연구", re.I)


def fetch(url: str, timeout: int = 30, retries: int = 2) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == retries:
                raise RuntimeError(f"{url}: {error}") from error
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def html_to_text(value: str) -> str:
    text = re.sub(r"<(br|/p|/li|/h\d|/div)\s*/?>", "\n", value or "", flags=re.I)
    text = re.sub(r"<li[^>]*>", "• ", text, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    lines = [re.sub(r"[ \t ]+", " ", line).strip() for line in text.splitlines()]
    text = "\n".join(line for line in lines if line)
    return text[:DESCRIPTION_LIMIT]


def job(company: str, native_id: str, title: str, location: str, url: str, posted: str,
        department: str = "", description: str = "") -> dict:
    slug = re.sub(r"[^a-z0-9]+", "-", str(native_id).lower()).strip("-")
    return {
        "id": f"{company}-{slug}"[:64],
        "company": company,
        "title": title.strip(),
        "location": location,
        "url": url,
        "posted": posted[:10] if posted else "",
        "department": department or "",
        "engineering": bool(ENGINEERING.search(f"{title} {department}")),
        "description": description,
    }


# ── Lam Research ─────────────────────────────────────────────

LAM = "https://careers.lamresearch.com"


def fetch_lam() -> list[dict]:
    positions, start = [], 0
    while True:
        query = urllib.parse.urlencode({"domain": "lamresearch.com", "location": "South Korea", "start": start})
        data = json.loads(fetch(f"{LAM}/api/pcsx/search?{query}"))["data"]
        batch = data.get("positions") or []
        positions += batch
        start += len(batch)
        if not batch or start >= int(data.get("count") or 0):
            break
    jobs = []
    for position in positions:
        # standardizedLocations에는 엉뚱한 값이 섞여 있어 locations(KR-도시-번호)만 믿는다.
        locations = [loc for loc in position.get("locations") or [] if loc.startswith("KR-")]
        if not locations:
            continue
        query = urllib.parse.urlencode({"position_id": position["id"], "domain": "lamresearch.com"})
        detail = json.loads(fetch(f"{LAM}/api/pcsx/position_details?{query}"))["data"]
        posted = datetime.fromtimestamp(position.get("postedTs") or 0, timezone.utc).date().isoformat()
        jobs.append(job(
            "lam", str(position.get("displayJobId") or position["id"]), position["name"],
            ", ".join(re.sub(r"^KR-([A-Za-z-]+?)-\d+.*$", r"\1", loc) for loc in locations),
            f"{LAM}{position.get('positionUrl', '')}", posted, position.get("department", ""),
            html_to_text(detail.get("jobDescription", "")),
        ))
    return jobs


# ── Applied Materials ────────────────────────────────────────

AMAT = "https://jobs.appliedmaterials.com"


def amat_detail(url: str) -> dict | None:
    page = fetch(url)
    for raw in re.findall(r'<script[^>]*ld\+json[^>]*>(.*?)</script>', page, re.S):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if data.get("@type") != "JobPosting":
            continue
        place = data.get("jobLocation") or {}
        if isinstance(place, list):
            place = place[0] if place else {}
        address = place.get("address") or {}
        location = ", ".join(v for v in (address.get("addressLocality"), address.get("addressRegion")) if v)
        native = url.rstrip("/").rsplit("/", 1)[-1]
        return job("amat", native, html.unescape(data.get("title", "")), location or "South Korea", url,
                   data.get("datePosted", ""), data.get("occupationalCategory", "") or "",
                   html_to_text(data.get("description", "")))
    return None


def fetch_amat() -> list[dict]:
    sitemap = fetch(f"{AMAT}/sitemap.xml")
    urls = [u for u in re.findall(r"<loc>([^<]+/job/[^<]+)</loc>", sitemap)
            if urllib.parse.urlsplit(u).path.split("/")[2].startswith(AMAT_KR_CITIES)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        return [j for j in pool.map(amat_detail, sorted(set(urls))) if j]


# ── ASML ─────────────────────────────────────────────────────

ASML = "https://www.asml.com"


def asml_job_data(url: str) -> dict | None:
    page = fetch(url)
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
    if not match:
        return None
    return (json.loads(match.group(1)).get("props", {}).get("pageProps", {}) or {}).get("jobData")


def fetch_asml() -> list[dict]:
    index = json.loads(ASML_INDEX_PATH.read_text(encoding="utf-8")) if ASML_INDEX_PATH.exists() else {}
    sitemap = fetch(f"{ASML}/en/job_posting-sitemap.xml")
    urls = sorted(set(re.findall(r"<loc>([^<]+/careers/find-your-job/[^<]+)</loc>", sitemap)))
    # 사이트맵에서 빠진 URL(마감된 공고)은 색인에서도 지운다.
    index = {u: v for u, v in index.items() if u in urls}
    unknown = [u for u in urls if u not in index]
    korea = [u for u in urls if index.get(u, {}).get("kr")]

    def check(url: str):
        try:
            return url, asml_job_data(url)
        except RuntimeError as error:
            print(f"  asml skip {url}: {error}", file=sys.stderr)
            return url, None

    jobs = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        # 한국 공고는 매번 다시 읽어 본문 변경·마감을 반영한다.
        for url, data in pool.map(check, unknown + korea):
            if data is None:
                continue
            is_kr = "korea" in str(data.get("country", "")).lower()
            index[url] = {"kr": is_kr}
            if not is_kr or str(data.get("status", "Open")).lower() != "open":
                continue
            jobs.append(job("asml", data.get("id") or url.rsplit("-", 1)[-1], data.get("displayJobTitle", ""),
                            data.get("location") or data.get("city", ""), url, data.get("datePosted", ""),
                            ", ".join(data.get("team") or []), html_to_text(data.get("descriptionExternal", ""))))
    ASML_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    ASML_INDEX_PATH.write_text(json.dumps(dict(sorted(index.items())), indent=0) + "\n", encoding="utf-8")
    return jobs


COMPANIES = {"lam": fetch_lam, "amat": fetch_amat, "asml": fetch_asml}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--company", choices=sorted(COMPANIES), action="append", help="이 회사만 (여러 번 지정 가능)")
    parser.add_argument("--include-seen", action="store_true")
    parser.add_argument("--out", type=Path, default=OUT_PATH)
    args = parser.parse_args()

    seen = json.loads(SEEN_PATH.read_text(encoding="utf-8")).get("ids", {}) if SEEN_PATH.exists() else {}
    jobs, failed = [], 0
    for name in args.company or sorted(COMPANIES):
        started = time.time()
        try:
            found = COMPANIES[name]()
        except Exception as error:  # 한 회사가 실패해도 나머지는 계속한다.
            failed += 1
            print(f"[FAIL] {name}: {error}", file=sys.stderr)
            continue
        fresh = [j for j in found if args.include_seen or j["id"] not in seen]
        print(f"[ok  ] {name}: 한국 공고 {len(found)}건, 새 공고 {len(fresh)}건 ({time.time() - started:.0f}s)", file=sys.stderr)
        jobs += fresh

    jobs.sort(key=lambda j: j["posted"], reverse=True)
    jobs.sort(key=lambda j: not j["engineering"])
    args.out.write_text(json.dumps({"fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "jobs": jobs},
                                   ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(jobs)}건 → {args.out}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
