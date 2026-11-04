# JD노트 실행 절차 (예약 작업·수동 실행 공통)

한 번 실행할 때 공고 1~2건을 캐러셀로 만들어 Slack 승인 요청까지 보낸다.
Claude는 공고 선별과 한국어 풀이만 맡고, 나머지는 스크립트가 한다.

1. 준비: `pip install -r requirements.txt` (playwright==1.56.0, 세션에 Chromium 있음)
2. 수집: `python3 scripts/fetch_jobs.py` → `candidates.json` (커밋하지 않음)
   - 한 회사가 실패해도 나머지 결과는 나온다. 실패한 회사는 Slack 보고에 적는다.
3. 선별 (Claude): `engineering: true`인 새 공고 중에서
   - 신입·주니어가 지원할 수 있는 공고, 최근 게시일, 회사가 겹치지 않게 1~2건 고른다.
   - 재무·물류·HR·코디네이터 같은 비엔지니어 직무는 고르지 않는다.
4. 작성 (Claude): `posts/<오늘 KST 날짜>/<공고 id>/post.json`. 필드는 `scripts/render.py` 맨 위 설명.
   - 원문에 있는 내용만 쓴다. 마감일이 원문에 없으면 `deadline: null` (표지에 "상시"로 나온다). 추측해서 채우지 않는다.
   - 쉬운 한국어로 풀어 쓴다: 장비·공정 용어는 처음 나올 때 한국어(영어) 형태로.
   - 항목은 장마다 3~5개. 넘치면 render.py가 종료 코드 2로 알려 주니 문구를 줄인다.
   - caption 끝에 "원문 공고를 한국어로 정리한 내용" 안내와 해시태그(10개 이하).
   - 담당자 이름 같은 개인 정보는 넣지 않는다.
5. 렌더: `python3 scripts/render.py posts/<날짜>/<id>/post.json` → 1.jpg… 이미지를 열어 직접 확인한다.
6. 기록: `python3 scripts/mark_seen.py posts/<날짜>/<id>/post.json`
7. 커밋·푸시: `posts/`, `state/` 를 main에 푸시한다 (raw URL이 공개돼야 다음 단계가 된다).
8. Slack: `python3 scripts/slack_post.py posts/<날짜>/<id>/post.json` (SLACK_BOT_TOKEN 필요)
9. 승인되면 Worker가 캐러셀로 게시한다. 이 작업은 여기서 끝난다.
