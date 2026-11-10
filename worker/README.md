# JD노트 Worker

Semifeed Worker와 같은 코드 구조이고, 게시만 캐러셀로 바뀌었다. 계정·KV·Slack 앱을 Semifeed와 공유하지 않는다.

## 배포 (Cloudflare 대시보드에서 관리)

Worker는 Cloudflare Workers Builds로 이 저장소에 연결돼 있어서 `main`에 푸시하면 자동으로 배포된다. 클론이나 CLI는 필요 없다.

| 항목 | 값 |
| --- | --- |
| Worker | `jdnote` (https://jdnote.plutofeed.workers.dev) |
| 연결 | 저장소 `plt8172/jdnote5`, 브랜치 `main`, Root directory `/worker`, Deploy command `npx wrangler deploy` |
| 빌드 토큰 | `jdnote build token` |
| KV | 바인딩 `STATE` → 네임스페이스 `jdnote-STATE` |
| Secret | `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`(JD노트 Slack 앱의 xoxb-), `IG_ACCESS_TOKEN`(값만, "Bearer" 없이) |
| Variable | `wrangler.toml`의 `[vars]` (`IG_USER_ID`, `IG_API_VERSION`, `POSTS_BASE_URL`) |
| Cron | `wrangler.toml`의 `[triggers]` |

- 위치: dash.cloudflare.com → Workers & Pages → `jdnote` → Settings. 빌드 기록은 Deployments, 실시간 로그는 Observability 탭.
- Secret은 대시보드의 Variables and secrets에서 바꾼다. 배포해도 유지된다.
- Variable·Cron·KV 바인딩은 `wrangler.toml`이 기준이다. 대시보드에서 바꾸면 다음 배포 때 되돌아가므로 이 파일을 고쳐서 푸시한다.
- Worker 안의 `SLACK_BOT_TOKEN`은 Worker마다 따로 저장되므로 이름에 프로젝트를 붙이지 않는다. Claude 클라우드 환경에서는 `JDNOTE_SLACK_BOT_TOKEN`이다.

## Instagram 토큰

Meta 앱 plutofeed → Instagram API → **API setup with Unified login** → jdnote5 **Generate token** (EAA로 시작하는 시스템 사용자 토큰, 만료 없음).

- 확인: `curl "https://graph.facebook.com/v26.0/<IG_USER_ID>?fields=username&access_token=<토큰>"` 이 jdnote5를 돌려줘야 한다. 계정 id는 shitposts98의 `scripts/check_token.py`로도 볼 수 있다.
- 토큰은 만료되지 않아 갱신 Cron이 없다. 바꿀 때는 Secret `IG_ACCESS_TOKEN`만 다시 넣으면 된다.

## Slack 앱

앱 하나의 Interactivity Request URL은 하나뿐이라 Semifeed 앱을 같이 쓸 수 없다. JD노트용 Slack 앱(권한 `chat:write`)의 Interactivity URL이 위 Worker 주소이고, 봇은 승인 채널에 초대돼 있어야 한다. 채널 id는 `config/jdnote.json`의 `slack_channel_id`.
