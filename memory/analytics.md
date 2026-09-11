# Analytics và error monitoring

Hai tầng, mỗi tầng trả lời một loại câu hỏi:

- **SQL** (`pnpm metrics:weekly`) cho mọi thứ **đã nằm trong DB** — hộ, thành
  viên, gói, đơn hàng, mã. Chính xác tuyệt đối, chạy được ngay cả khi chưa có
  key PostHog nào.
- **PostHog** cho mọi thứ **không để lại dấu vết trong DB** — chạm trần, mở app,
  paywall hiện ra, what-if chạy.

Không đếm cùng một thứ ở cả hai nơi rồi so. SQL trả lời được thì dùng SQL.

## Luật dữ liệu — không có ngoại lệ

Thông tin tài chính là dữ liệu cá nhân nhạy cảm, và PostHog Cloud đặt máy chủ
ngoài Việt Nam. Nên analytics **chỉ nhận hành vi, không nhận tài chính**.

Quy tắc này không mới: `forecast-and-flexible-money.md` đã ghi *"Analytics carry
only a bucket… Never the amount, never the balances: a couple's figures stay
theirs"*. `event-catalog.ts` chỉ là chỗ biến nó thành lỗi biên dịch.

**Cấm gửi:** số tiền của hộ, tên do người dùng đặt (tên hộ/ví/tài sản/mục tiêu),
email, số điện thoại, nội dung tự do, URL có query.

**Được gửi:** UUID, enum, boolean, số đếm, số ngày, mã gói, mã chiến dịch, và
`price_vnd` — giá niêm yết **của chính sản phẩm**, không phải tiền của hộ.

### Cưỡng chế bằng kiểu, không bằng ý thức

`SafeProps<T>` trong `event-catalog.ts` **xoá** mọi property có tên chứa
`amount`, `balance`, `value`, `total`, `vnd`, `sum`, `email`, `name`, `phone`,
`address`, `note`, `label`, `title`, `description`. Property bị xoá khỏi kiểu ⇒
**lỗi compile ngay tại chỗ gọi**, không phải một comment review.

Hai ngoại lệ, mỗi cái có lý do:

- `price_vnd` — giá của mình, là doanh thu chứ không phải tiền của hộ.
- `amount_bucket` — **nhãn** (`'10-50M'`), không bao giờ là con số.

`price` **cố ý không** nằm trong danh sách cấm. Mọi property tiền thật trong
repo đều là VND nguyên, nên `vnd`/`amount`/`value`/`total` đã phủ hết; `price`
chỉ bắt nhầm `auto_price` — một cờ boolean có tên khớp `autoPriceEnabled` và
`auto_price_quota`. Một luật chỉ báo động giả là luật sẽ bị tắt.

`event-catalog.spec.ts` chặn thêm tầng **giá trị** mà kiểu không thấy được: không
số nào ≥ 1000 ngoài `price_vnd` (tiền VND của hộ luôn ≥ 1000; số đếm thì không).

## `distinctId` là HỘ, không phải người

Sản phẩm tính tiền và gate **theo hộ**, và mọi câu hỏi đáng hỏi đều là "bao nhiêu
% hộ". `actorId` chỉ đi kèm như property ở những sự kiện thực sự hỏi về một
người. Kèm theo: distinct id luôn là UUID vô danh, không bao giờ là email.

## Fail-open, không `await`

`AnalyticsService.capture()` trả về **`void`**, không phải `Promise`.
`AuditService.record` được `await` vì một dòng nhật ký phải rollback cùng thao
tác nó mô tả; analytics thì ngược lại. `void` khiến "quên await" là chuyện không
thể xảy ra, giữ `assertQuota` đồng bộ, và đảm bảo PostHog chết không bao giờ làm
request chậm đi hay biến 402 thành 500.

Không có key ⇒ không dựng client ⇒ mọi lời gọi là no-op. Dev, CI và test không
cần tài khoản PostHog. `NODE_ENV=test` tắt hẳn dù có key.

**Bắn sau khi commit.** Sự kiện cho một bản ghi đã rollback là dữ liệu bịa.

## Bắn ở chỗ duy nhất, không bắn ở từng call site

| Sự kiện | Chỗ gắn | Vì sao ở đó |
|---|---|---|
| `paywall_hit` | `EntitlementService.assertQuota` | Nơi **duy nhất** quyết định một trần đếm. Thêm quota thứ ba là đo được ngay |
| `paywall_hit` | `EntitlementGuard` | Tính năng boolean |
| `paywall_hit` | `forecast.service.ts` (horizon) | Kiểm tra **giá trị**, guard không làm được |
| `auto_price_declined` | `assets.service.ts` | **Paywall im lặng** — xem dưới |
| `what_if_run` | `forecast.service.ts` | Thay dòng log cũ, không bắn song song |
| `subscription_granted` | `grantOrExtend` | Người ghi **duy nhất** của `household_subscriptions` ⇒ phủ mọi nguồn |
| `payment_settled` | PayOS `settle` + RevenueCat | Hai đường tiền, không phải một |
| `subscription_expired` | `billing-expiry.cron.ts` | Trước đây churn không để lại dấu vết nào |

**Tại sao không bắn mọi paywall từ exception filter** (nghe có vẻ gọn hơn):
filter không có `householdId`, và quan trọng hơn — **paywall đáng quan tâm nhất
không phải một exception**. `canAutoPrice()` lặng lẽ đặt `autoPriceEnabled =
false` rồi trả 201. Nếu chỉ đo ở filter thì trần duy nhất có **chi phí biến đổi
thật** phía sau (CoinMarketCap, Twelve Data) sẽ vĩnh viễn vô hình.

## `trial_granted` không tồn tại — và đó là chủ ý

`households.service.ts` **không cấp trial** khi tạo hộ: thiếu dòng subscription
nghĩa là Free, và trial là lựa chọn hộ tự bấm trong paywall. Nên một property
`trial_granted` sẽ luôn `false` và sẽ bị đọc thành "không ai dùng thử".

`trial_started` là sự kiện riêng, bắn ở `SubscriptionService.startTrial` — chỗ
lựa chọn thực sự diễn ra. Đó cũng là thứ khiến câu hỏi trial → trả tiền trả lời
được.

> `09 §3` nói trial được cấp tự động lúc tạo hộ. **Tài liệu đó đã lỗi thời**,
> code mới là nguồn sự thật.

## Những chỗ cố ý để `null`

Thà thiếu còn hơn bịa:

- `payment_settled.price_vnd` = `null` trên đường RevenueCat. Store báo
  `price_in_purchased_currency` — tiền của store, đơn vị của store. Gọi nó là
  `_vnd` là dán nhãn sai và làm hỏng mọi phép cộng doanh thu giữa hai đường.
  Doanh thu store đối soát trong console của store.
- `payment_settled.from_reason` = `null` trên đường RevenueCat. IAP tới bằng
  webhook, không có đơn hàng nào của mình ⇒ không truy được bức tường nào dẫn
  tới. Đây là **khoảng mù chấp nhận được**, không phải lỗi cần "sửa" bằng một
  cột bịa.
- `member_joined.member_index` / `hours_since_household_created` = `null`.
  Đường accept không nạp danh sách thành viên, và `metrics:weekly` trả lời đúng
  câu hỏi đó bằng SQL chính xác hơn.

## Error tracking

Trong `HttpExceptionFilter`, và **chỉ 5xx**. 402 là paywall đang hoạt động đúng,
403 là không phải thành viên — đẩy chúng vào error tracking sẽ chôn lỗi thật
dưới đống "app chạy đúng".

- `route` là **pattern** (`/households/:householdId/assets`), không phải URL
  thật: URL thật mang `householdId`, vừa làm nổ cardinality vừa nhét định danh
  vào tiêu đề lỗi. Không khớp được route thì `scrubUrl()` thay UUID bằng `:id`.
- **Không** kèm body, query hay header — chúng mang số tiền.
- Không bao giờ làm hỏng response: `captureException` trả `void` và tự nuốt lỗi.

## Catalog dùng chung ra sao

Một file **được viết tay** ở `backend/src/common/analytics/event-catalog.ts`,
một bản **sinh tự động** ở `frontend/packages/core/src/shared/analytics/`.

Hai workspace pnpm là hai root riêng và core là TypeScript ESM chưa build với
`#/*` self-import, nên backend **thật sự không import được** từ core. Nhưng đây
là bài toán **hai chỗ, không phải ba**: `packages/core` được cả web build lẫn
mobile typecheck biên dịch, nên một bản sinh phục vụ cả hai client.

`pnpm analytics:sync --check` fail CI khi hai bản lệch, và in ra **diff** —
thứ người đọc hành động được — chứ không phải một assertion sai.

## `pnpm metrics:weekly`

Tên bảng/cột thật (nhiều tài liệu cũ ghi sai):

| Thật | Ghi chú |
|---|---|
| `households.created_by` | không phải `owner_user_id` |
| `household_members.deleted_at` | **soft-delete** — người đã rời vẫn còn dòng, mọi query phải lọc |
| `audit_logs.actor_id` | không phải `activity_logs.actor_user_id`. NULL = hệ thống |
| `payment_orders.created_by` | đã có sẵn, chỉ `from_reason` là cột mới |

**Bẫy ở M4:** không đo độ tươi bằng `assets.updated_at` — cron giá chạy hằng
ngày chạm cột đó, khiến mọi hộ có vàng trông như vừa cập nhật. Dùng `audit_logs`
với `actor_id IS NOT NULL`. Kèm cảnh báo: `audit.types.ts` **cố ý không** ghi
nhật ký các money event thu/chi thường ngày, nên hộ chỉ ghi chi tiêu sẽ trông
im ắng hơn thực tế.

Script in cả những câu **không** trả lời được bằng SQL dưới dạng
`n/a (PostHog)`. Bỏ im một câu hỏi là cách một số 0 bị hiểu nhầm thành phép đo.

### Số liệu tuần đi lên PostHog, không nằm trên server

Bản đầu tiên của script chỉ in ra terminal. **Đó là thiết kế sai**: không ai SSH
vào production mỗi sáng thứ Hai, và một bảng in ra rồi mất thì không so sánh
được tuần này với tuần trước — mà so sánh theo thời gian đúng là lý do duy nhất
của một chỉ số hằng tuần. (Lý lẽ "CLI thay vì admin UI" của `redeem:create` ở
đây không áp dụng: mint mã là thao tác một lần, có chủ đích; đọc chỉ số thì định
kỳ.)

`.github/workflows/metrics-weekly.yml` chạy 08:00 thứ Hai giờ VN, trên runner
chứ không trong container — image production cài `--prod`, mà `ts-node` là
devDependency nên script **không chạy được ở đó**.

- **`--push` là opt-in.** Chạy tay để xem thì chỉ in; không lỡ tay bơm trùng
  một tuần vào PostHog.
- **Mỗi mục một event `metrics_weekly`**, mang `metric` (`m2`) làm handle ổn
  định và `metric_title` cho người đọc — đổi chữ trong tiêu đề không làm gãy
  biểu đồ.
- **`captureSystem()` chứ không phải `capture()`.** `capture()` đặt `distinctId`
  là hộ và đóng `household_id` vào payload; một con số toàn hệ thống không thuộc
  hộ nào, và bịa ra một id sẽ nhét một hộ ma vào mọi insight nhóm theo hộ.
  `distinctId` là một sentinel cố định để cả chuỗi là **một** timeline.
- **Phải `flush()` trước khi thoát.** `posthog-node` gom theo lô trong bộ nhớ;
  một CLI thoát ngay sẽ mất cả tuần số liệu mà không báo gì.

### `analytics:sync --check` chạy ở đâu

`.github/workflows/ci.yml` — **workflow này trước đó không tồn tại**. Repo chỉ có
`deploy.yml` (build rồi rollout), nên không gì chặn một PR làm hỏng cả nghìn
test. CI mới chạy typecheck + test + `--check` cho backend, và build + lint +
mobile typecheck cho frontend.

Hai job riêng vì hai workspace ghim **hai bản pnpm khác nhau** (11.18.0 và
10.33.4) — một `corepack prepare` không phục vụ được cả hai.

## Liên quan

[[billing-and-entitlement]] · [[forecast-and-flexible-money]] · [[activity-log]]
