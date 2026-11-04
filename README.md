# JD노트 (@jdnote5)

외국계(한국 지사) 반도체·하드웨어 엔지니어 공고의 JD를 한국어로 풀어 주는 인스타그램 캐러셀 계정.
Semifeed 파이프라인과 같은 구조(Claude가 판단, 스크립트가 결정적인 일, Slack 승인 후 Worker가 게시)를 쓰되 저장소·Worker·KV를 따로 둔다.

```
scripts/fetch_jobs.py  Lam·AMAT·ASML 채용 사이트에서 한국 공고 수집
→ Claude가 공고 선별 + post.json 작성 (JD를 한국어로 요약·풀이)
→ scripts/render.py      post.json → 1.jpg … 5.jpg (1080×1350)
→ 커밋·푸시 (raw.githubusercontent.com URL이 공개돼야 Instagram이 받아 간다)
→ scripts/slack_post.py  슬라이드 + [승인][반려]
→ worker/                승인 시 Instagram 캐러셀 게시 (자식 컨테이너 → CAROUSEL → publish)
```

## 폴더

| 경로 | 내용 |
|---|---|
| `templates/carousel.html` | 캐러셀 디자인 (표지·하는 일·지원 자격·우대 사항·지원 방법) |
| `posts/<날짜>/<id>/` | `post.json` + 렌더된 `N.jpg`. 형식은 `scripts/render.py` 맨 위 설명, 예시는 `posts/example/sample-fse/` |
| `config/jdnote.json` | 브랜드 문구, 저장소, Slack 채널 |
| `fonts/` | Jua(제목), Pretendard(본문). 둘 다 OFL |
| `worker/` | Cloudflare Worker. 배포는 `worker/README.md` |
| `scripts/fetch_jobs.py` | Lam·AMAT·ASML 한국 공고 수집 → `candidates.json` |
| `RUN.md` | 한 번 실행할 때 따르는 절차 |

## 로컬 확인

```
pip install -r requirements.txt
python3 scripts/render.py posts/example/sample-fse/post.json --today 2026-11-04
python3 scripts/slack_post.py --dry-run posts/example/sample-fse/post.json
python3 -m unittest discover -s tests
cd worker && npm install && npm test && npm run typecheck
```

`render.py`는 문구가 칸을 넘치면 이미지를 만들지 않고 종료 코드 2로 끝난다. 문구를 줄여 다시 실행한다.
토큰·시크릿은 저장소에 커밋하지 않는다 (Worker Secret / 세션 환경 변수에만 둔다).
