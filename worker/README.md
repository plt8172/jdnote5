# JD노트 Worker 배포

Semifeed Worker와 같은 코드 구조이고, 게시만 캐러셀로 바뀌었다. 계정·KV·Slack 앱을 Semifeed와 공유하지 않는다.

1. `npm install`
2. KV 만들기: `npx wrangler kv namespace create STATE` → 나온 id를 `wrangler.toml`의 `[[kv_namespaces]] id`에 넣는다.
3. Instagram 토큰: Meta 앱 plutofeed → Instagram API → **API setup with Unified login** → jdnote5 **Generate token** (EAA로 시작하는 시스템 사용자 토큰, 만료 없음).
   - 확인: `curl "https://graph.facebook.com/v26.0/<IG_USER_ID>?fields=username&access_token=<토큰>"` 이 jdnote5를 돌려줘야 한다. 계정 id는 shitposts98의 `scripts/check_token.py`로도 볼 수 있다.
4. Secret 등록 (값만 붙여 넣는다, "Bearer" 없이):
   ```
   npx wrangler secret put IG_ACCESS_TOKEN
   npx wrangler secret put SLACK_BOT_TOKEN
   npx wrangler secret put SLACK_SIGNING_SECRET
   ```
5. `npx wrangler deploy` → 주소 예: `https://jdnote.<계정>.workers.dev`
6. Slack: 앱 하나의 Interactivity Request URL은 하나뿐이라 Semifeed 앱을 같이 쓸 수 없다.
   JD노트용 Slack 앱을 새로 만들고 (권한 `chat:write`), Interactivity URL을 5번 주소로, 봇을 승인 채널에 초대한다.
   채널 id는 `config/jdnote.json`의 `slack_channel_id`에 넣는다.

토큰은 만료되지 않아 갱신 Cron이 없다. 토큰을 바꿀 때는 Secret `IG_ACCESS_TOKEN`만 다시 넣으면 된다.
