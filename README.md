# Telegram AI English Practice Bot

Bot Telegram giúp developer luyện trả lời client/PM bằng tiếng Anh: bot gửi tình huống, người dùng trả lời, AI chấm điểm và đưa ra bản viết tốt hơn.

## MVP đã có

- `/start`, `/help`, `/practice [topic]`, `/skip`, `/cancel`, `/retry`, `/history [id]`.
- Level/topic preference: `/level`, `/topic`, `/topics`.
- Optional project-context personalization: `/context <short non-sensitive context>`.
- `/stats` và `/dashboard` (private signed link valid 15 minutes).
- Opt-in scheduled practice: `/schedule on [1-3]`, `/schedule off`, `/quiet HH:mm-HH:mm`.
- Client scenario theo topic phát triển phần mềm và level user mặc định `junior`.
- Gemini structured JSON output được validate trước khi lưu.
- PostgreSQL lưu user, practice session, evaluation và Telegram update idempotency.
- Webhook secret verification và partial unique index: một active session cho mỗi user.

BullMQ/Redis scheduler chỉ chạy khi `SCHEDULER_ENABLED=true` và `REDIS_URL` hợp lệ.

## Chạy local

Yêu cầu: Node.js 22+, Docker và một Telegram bot token từ BotFather.

```powershell
Copy-Item .env.example .env
docker compose up -d
npm install
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

Điền `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` và `GEMINI_API_KEY` vào `.env`. Không commit file `.env`.

## Thiết lập Telegram webhook

Production cần một URL HTTPS public. Đăng ký webhook (thay giá trị placeholder) bằng Telegram Bot API:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<YOUR_DOMAIN>/webhooks/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Telegram sẽ gọi `POST /webhooks/telegram` và backend từ chối request có secret header không khớp. Với local development, dùng HTTPS tunnel; không chạy polling và webhook cùng lúc trên một bot token.

## Các topic hợp lệ

`api_progress_update`, `bug_report`, `pr_review_comment`, `deadline_concern`, `requirement_clarification`, `payment_subscription_issue`, `stripe_invoice_issue`, `database_performance`, `redis_cache_issue`, `deployment_problem`, `daily_standup`, `estimate_task`, `explain_technical_issue`, `client_update`.

Ví dụ: `/practice stripe_invoice_issue`

## Lệnh bot

```text
/level junior
/topic stripe_invoice_issue
/topic all
/context Node.js payment API using Stripe invoices
/context clear
/stats
/dashboard
/schedule on 2
/schedule off
/quiet 21:00-08:00
/delete-my-data
```

`/schedule` luôn là opt-in. Scheduler chỉ gửi khi user chưa có bài đang chờ trả lời, tôn trọng quiet hours và tạo tối đa 1–3 bài/ngày theo timezone của user.

## Kiểm tra chất lượng

```powershell
npm run prisma:generate
npm run build
npm test
npm run lint
npm run format:check
```

## Hành vi khi lỗi

- Reply của user được lưu trước khi gọi AI.
- Nếu Gemini không phản hồi hoặc trả JSON không hợp lệ, session thành `evaluation_failed`; user chạy `/retry` để chấm lại.
- Nếu đã lưu evaluation nhưng Telegram gửi feedback thất bại, session vẫn `completed`; tránh chấm/lưu trùng.
- Telegram `update_id` là idempotency key, nên webhook gửi lại không tạo thêm score hoặc bot message.

## Deploy lên Render

1. Push source code (không gồm `.env`) lên GitHub.
2. Trong Render, tạo một PostgreSQL database và chọn cùng region với Web Service. Mở database, copy **Internal Database URL**.
3. Tạo **Web Service** từ GitHub repository, chọn runtime **Docker**. Render tự dùng `Dockerfile` ở root; không cần khai báo Build/Start Command riêng.
4. Đặt Health Check Path là `/health/live`.
5. Thêm các Environment Variables sau vào Web Service:

   ```text
   NODE_ENV=production
   DATABASE_URL=<Internal Database URL của Render>
   TELEGRAM_BOT_TOKEN=<BotFather token>
   TELEGRAM_WEBHOOK_SECRET=<random secret dài>
   GEMINI_API_KEY=<Gemini API key>
   GEMINI_MODEL=gemini-2.5-flash
   DEFAULT_TIMEZONE=Asia/Ho_Chi_Minh
   PUBLIC_BASE_URL=https://<your-render-service>.onrender.com
   DASHBOARD_SIGNING_SECRET=<second-long-random-secret>
   SCHEDULER_ENABLED=true
   REDIS_URL=<Redis connection URL>
   ```

   Không đặt `PORT`; Render cấp biến này và app tự đọc nó.
6. Deploy. Docker startup sẽ chạy `prisma migrate deploy` trước khi mở NestJS server. Chỉ tiếp tục khi log có dòng API listening và health check xanh.
7. Lấy public URL Render, sau đó đăng ký Telegram webhook tới `<Render URL>/webhooks/telegram` với `TELEGRAM_WEBHOOK_SECRET` đã đặt ở bước 5.
8. Mở `https://<Render URL>/health/live` để xác nhận service reachable, sau đó chat bot: `/start` → `/practice` → reply trực tiếp vào client message.

Để bật scheduler, provision một Redis instance rồi đặt `REDIS_URL` và `SCHEDULER_ENABLED=true`. Sau deploy, dùng `/schedule on 1` trong Telegram để opt in; không bật schedule tự động cho user.
# learn-chat-ai-bot
