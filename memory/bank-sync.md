# Bank sync — ghi nhận giao dịch từ notification ngân hàng

## Overview

iPhone nhận notification biến động số dư (Techcombank, VCB Digibank). Một
iOS Shortcut gửi `app/title/body` về `POST /api/v1/bank-notifications/ingest`.
Backend parse, tìm ví (wallet asset) mà household đã liên kết với tài khoản
ngân hàng đó, rồi ghi một money event **đúng một lần**. Mọi thứ không chắc chắn
nằm trong inbox chờ người dùng xử lý, **không bao giờ tự sửa số dư**.

Tính năng Premium (`bank_sync`). Related: [[money-events]], [[assets]],
[[billing-and-entitlement]], [[auth]].

## Ánh xạ khái niệm từ spec

| Spec | Ở đây |
|---|---|
| account REAL | wallet asset (`cash`, `bank_account`) đang `active`, chưa xoá |
| account VIRTUAL / quỹ | goal + `GoalAssetAllocation` — không phải asset nên không thể nhận posting; không cần `balance_scope` |
| transaction | `MoneyEvent` (`origin = bank_notification`, `notification_event_id`) |
| user | `Profile`, nhưng dữ liệu thuộc **household** |

## Ba đối tượng

- **Credential** (`bank_ingest_credentials`): token của một thiết bị, gắn với
  **một user + một household**. Raw token (`msk_live_…`) chỉ trả một lần lúc
  tạo; DB lưu `sha256`. Mỗi request ingest kiểm tra lại membership còn sống —
  rời household là token hết tác dụng. Chỉ chủ token thấy/thu hồi token của
  mình.
- **External source** (`bank_external_sources`): tài khoản ngân hàng thật,
  định danh bằng `HMAC(BANK_SYNC_HMAC_KEY, provider:sốTK)`; chỉ lưu last4 để
  hiển thị. Thuộc household. Không bao giờ map bằng last4 hay tên ngân hàng.
- **Link** (`bank_source_links`): source → wallet theo khoảng thời gian, tối đa
  một link mở (`valid_to IS NULL`) cho mỗi source. Đổi ví = đóng link cũ + mở
  link mới trong một transaction; giao dịch cũ giữ nguyên ví cũ. Mặc định
  `REVIEW`; `AUTO` chỉ bật khi người dùng xác nhận và ví hợp lệ.

## Luồng ingest

1. Guard: token → credential ACTIVE chưa hết hạn → membership còn sống →
   household có Premium (thiếu thì 402 để Shortcut báo rõ).
2. Validate body bằng tay (key lạ — kể cả `userId`/`accountId` — bị từ chối),
   giới hạn 4 KiB (Caddy chặn trước, guard chặn lại), 30 req/phút/token. Bộ đếm
   nằm trong RAM của process: đúng khi chỉ có một instance. Không có giới hạn
   theo IP — Caddy bản chuẩn không có.
2b. **Thông báo không phải biến động số dư thì bỏ, không lưu gì** (không event,
   không raw, không inbox) → trả `200 NOT_TRANSACTION`. Mỗi parser có
   `isBalanceMovement` — chỉ kiểm tra dấu hiệu, không parse: Techcombank cần
   title `± VND <số>` hoặc dòng `Số dư: VND`; VCB cần `Số dư TK VCB` hoặc
   `Số dư <số> VND`. Quảng cáo/ưu đãi/kích hoạt tài khoản rơi ở đây. Ngưỡng cố
   ý lỏng: một biến động đổi format mà còn dòng số dư vẫn đi tiếp và thành
   `PARSE_FAILED` để người dùng thấy, thay vì bị bỏ âm thầm. Nếu một biến động
   thật vẫn lọt bước này, cảnh báo lệch số dư ([[cashflow-settlement]]) sẽ lộ ra.
   App ngoài allowlist vẫn đi tiếp như cũ (`APP_NOT_SUPPORTED`).
3. Insert event `RECEIVED` (raw mã hoá). Trùng `(credential, clientEventId)` →
   trả event cũ, `200 DUPLICATE`. `clientEventId` không bắt buộc: Phím tắt có
   thể không có thao tác tạo UUID, nên khi thiếu, server tự suy ra một UUID cố
   định từ `sha256(credential | fingerprint nội dung | notificationAt)` — gửi lại
   cùng thông báo vẫn ra cùng id.
4. Parse theo `app` allowlist → `PARSE_FAILED` / `REVIEW` khi không chắc.
5. HMAC số TK → source. Không có → `UNMAPPED`. Source DISABLED → `REVIEW`.
6. Link mở tại thời điểm giao dịch; nếu link vừa đổi trong ±10 phút → `REVIEW`.
7. Nghi trùng (cùng source, chiều, số tiền trong 10 phút) → `REVIEW`
   (`POSSIBLE_DUPLICATE`); không tự gộp vì hai giao dịch thật có thể cùng số tiền.
8. Ví không còn hợp lệ → `REVIEW`. Chạy matcher theo nội dung CK, lưu gợi ý
   (`suggested_cashflow_event_id`, `match_status`) lên event. Link `AUTO` → post
   (và settle nếu khớp duy nhất; `replace_manual` thì giữ `REVIEW`); ngược lại
   `REVIEW`. Chi tiết: [[cashflow-settlement]].

`202` chỉ nghĩa là đã nhận. UI luôn đọc status thật từ DB.

Kiểm tra "cùng payload" (bước 3) không khoá: hai bản giống hệt nhau đến cùng
lúc có thể cùng lọt qua. Chấp nhận — hiếm, và chốt cuối vẫn là inbox/đối soát.

## Inbox

Trạng thái mở: `UNMAPPED`, `REVIEW`, `PARSE_FAILED`, `FAILED`. Người dùng:

- **Ghi nhận** (`post`): chọn ví (mặc định ví của link). Được phép cả với
  `UNMAPPED` và `DUPLICATE` — người dùng đã nhìn thấy và tự quyết.
  `PARSE_FAILED` không có số tiền nên không post được; người dùng ghi tay.
- **Ghi nhận & gắn** (`post` + `cashflowEventId`), **Thay khoản đã ghi tay**
  (`replace_manual` + `cashflowEventId`) — xem [[cashflow-settlement]].
- **Bỏ qua** → `IGNORED`.
- **Đọc lại** (reparse) khi raw còn hạn; kết quả tối đa là `REVIEW`.

Event `UNMAPPED` không tự tạo source: người dùng nhập đủ số tài khoản ở màn
liên kết, rồi các event chờ được xử lý lại.

## Vì sao inbox là bảng riêng, không phải money event `pending_confirmation`

`replayWalletBalance` đọc mọi money event chưa xoá **bất kể `status`**. Một
event "chờ duyệt" sẽ làm lệch số dư ngay. Event chỉ thành money event khi đã
được post.

## Posting

`BankPostingService.post` chạy trong `runInTransactionAndInvalidate`: khoá dòng
event (`FOR UPDATE`), gọi `MoneyEventsService.createMoneyEvent` (income vào ví
với IN, expense từ ví với OUT; category hệ thống `income` / `other`), đánh dấu
`PROCESSED`. Event date = ngày giao dịch theo giờ Việt Nam. Note = nội dung
thông báo (body) với số tài khoản đầy đủ thay bằng `••` + 4 số cuối — đây là
chữ thật từ ngân hàng, không phải chữ hệ thống tự bịa ([[money-events]]).
Riêng Techcombank: body là các dòng `Tài khoản` / `Số dư` / nội dung, nên lúc
post (`moneyEventNote`) note của money event chỉ lấy dòng cuối và cắt bỏ từ
`Ma tham chieu …` trở đi (vd `An sang. Ma tham chieu 053248` → `An sang`);
VCB: note là đoạn sau `Ref <mã>.` và trước chuỗi trace `FT…` (vd `Ref
6286IBT….TRAN DINH QUAN chuyen FT2628….…` → `TRAN DINH QUAN chuyen`); không có
`Ref` thì giữ nguyên. `description` của bank event vẫn giữ nguyên body đã che. Body
được che và lưu vào `bank_notification_events.description` lúc parse, vì bản
gốc mã hoá có thể đã tắt hoặc hết hạn khi người dùng xác nhận từ hộp thư. `money_events.notification_event_id UNIQUE` là chốt cuối chống
post hai lần khi hai luồng chạy song song. `created_by` = user của credential
(hoặc người bấm xác nhận trong inbox), không phải người tạo household.

## Xử lý lại sau khi liên kết

Tạo source/link xong, các event `UNMAPPED` cùng HMAC được chạy lại bước 5–8,
nhưng **chỉ lên tới `REVIEW`** — event cũ không bao giờ tự post, kể cả khi link
là `AUTO`, vì người dùng chưa nhìn thấy chúng.

## Parser

- Techcombank: amount + chiều chỉ từ title `± VND x`; số TK sau `Tài khoản:`;
  số dư từ `Số dư: VND …`. Không có thời gian trong nội dung.
- VCB: cụm `Số dư TK VCB <tk> ±x VND lúc dd-MM-yyyy HH:mm:ss` (giờ Việt Nam);
  số dư là cụm `Số dư x VND` **thứ hai**. `Ref` chưa được dùng làm reference.
- Fail closed: thiếu cụm hoặc cụm khớp nhiều lần → không đoán.
- Chiều **OUT chưa có mẫu thật** → parser hạ về `REVIEW` (`OUT_UNVERIFIED`)
  cho tới khi có fixture đã redact. Gỡ cờ trong parser khi đã có.

## Dữ liệu nhạy cảm (ADR)

- Raw title/body được lưu **mã hoá AES-256-GCM** (`BANK_SYNC_PAYLOAD_KEY`) để
  parse lại khi ngân hàng đổi format; cron xoá ciphertext sau **30 ngày**. Sau
  đó event không parse lại được nữa — chấp nhận.
- Số TK đầy đủ chỉ sống trong RAM; không log, không trả về response. Logger
  redact key `accountNumber`/`rawPayload`; analytics cấm tên property chứa
  `account`/`payload`.
- `BANK_SYNC_STORE_RAW_PAYLOAD=false` tắt hẳn việc lưu bản gốc: chỉ còn HMAC
  fingerprint (vẫn đủ để chống trùng), event mới không parse lại được. Dùng khi
  parser đã ổn định. Mặc định bật.
- Thiếu `BANK_SYNC_HMAC_KEY` → ingest trả 503. Thiếu `BANK_SYNC_PAYLOAD_KEY` chỉ
  503 khi đang bật lưu bản gốc.

## Lệch số dư

`reported_balance_minor` được so với số dư ledger ngay sau ME của chính event
đó (`GET …/bank-sync/wallet-drift`). Chỉ hiển thị, không tự sửa — xem
[[cashflow-settlement]].

## Trust model

Token chứng minh **ai gửi request**, không chứng minh giao dịch có thật ở ngân
hàng. Không dùng dữ liệu này để xác nhận thanh toán.

## Credential: chỉ chủ token quản lý

Danh sách và thu hồi chỉ thấy token của chính mình, không phải của cả
household. Mỗi người tối đa 10 token đang hoạt động.

## Where it lives in code

- backend: `src/modules/bank-sync/` (guard, parsers, services, cron;
  `domain/money-event-note.ts` dùng chung với matcher),
  `money-events` nhận thêm `opts.actorId/origin/notificationEventId`.
- frontend-web: `packages/core/src/features/bank-sync/`,
  `web/src/features/bank-sync/`.
