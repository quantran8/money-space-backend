# Bank sync — ghi nhận giao dịch từ notification ngân hàng

## Overview

iPhone nhận notification biến động số dư (Techcombank, VCB Digibank). Một
iOS Shortcut gửi `app/title/body` về `POST /api/v1/bank-notifications/ingest`.
Backend parse, tìm ví (wallet asset) mà household đã liên kết với tài khoản
ngân hàng đó, rồi ghi một money event **đúng một lần**. Mọi thứ không chắc chắn
nằm trong inbox chờ người dùng xử lý. Số dư ví ngân hàng thì **luôn theo số dư
trong thông báo** — xem mục Số dư.

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
   thật vẫn lọt bước này, lần post kế tiếp sẽ tự đồng bộ số dư (mục Số dư) nhưng
   giao dịch đó vẫn thiếu trong lịch sử.
   App ngoài allowlist vẫn đi tiếp như cũ (`APP_NOT_SUPPORTED`).
3. Insert event `RECEIVED` (raw mã hoá). Trùng `(credential, clientEventId)` →
   trả event cũ, `200 DUPLICATE`. `clientEventId` không bắt buộc: Phím tắt có
   thể không có thao tác tạo UUID, nên khi thiếu, server tự suy ra một UUID cố
   định từ `sha256(credential | fingerprint nội dung | notificationAt)` — gửi lại
   cùng thông báo vẫn ra cùng id.
4. Parse theo `app` allowlist → `PARSE_FAILED` / `REVIEW` khi không chắc.
5. HMAC số TK → source. Không có → `UNMAPPED`. Source DISABLED → `REVIEW`.
6. Link mở tại thời điểm giao dịch; nếu link vừa đổi trong ±10 phút → `REVIEW`.
7. (Đã bỏ) Nghi trùng theo source + chiều + số tiền trong 10 phút. Xem mục
   Chống trùng.
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

## Chuyển tiền giữa hai tài khoản của chính household

Chuyển TCB → VCB sinh hai notification (TCB `-x`, VCB `+x`) đến lệch nhau,
thứ tự bất kỳ. Ghi thành **một** money event `transfer` (category hệ thống
`transfer`, neutral — không tính thu/chi), không phải expense + income.

**Nhận ra đối ứng.** Body của cả hai chiều chứa số TK bên kia ở dạng đầy đủ:
VCB nhận có `…FT….20261013.114711.19035020891016.VND…` (số TCB gửi); TCB nhận
có `CT tu 10 17013153 …` (số VCB, có khi bị chèn khoảng trắng). Lúc route, lấy
mọi cụm số 6–19 chữ số trong `description` (số TK của chính event đã bị che nên
không lọt vào) **cộng** các cặp cụm số cạnh nhau ghép lại (`10 17013153` →
`1017013153`), HMAC với từng provider, tìm source trong household. Đúng một
source khác source của event, ACTIVE, có đúng một link tại thời điểm giao dịch
tới ví hợp lệ khác ví mình → lưu `counterpart_source_id`. Nhiều source khớp →
coi như không có. Số rác (mã ref, ngày giờ) chỉ ra HMAC không khớp gì.

**Ghép cặp.** Event `E` (đã có source + ví) tìm `P`: chiều ngược lại, cùng số
tiền, chưa ghép, khác source, không `DUPLICATE/IGNORED/PARSE_FAILED`, đã có
`matched_asset_id`, thời điểm hiệu lực (`transaction_at` → `notification_at` →
`received_at`) cách nhau ≤ **1 phút**, và **ít nhất một bên** chỉ đích danh bên kia
(`E.counterpart = P.source` hoặc `P.counterpart = E.source`). Hai dòng trỏ nhau
qua `transfer_peer_event_id` (UNIQUE), ghép bằng `updateMany … WHERE peer IS
NULL` trong một transaction — không ghép ba bên. 1 phút vì thực tế hai
notification đến cách nhau 5–10 giây (quyết định của chủ sản phẩm, 2026-10-13);
cửa sổ hẹp để hai lần chuyển cùng số tiền liên tiếp không bị ghép chéo. Đánh
đổi: bên đến sau quá 1 phút (máy tắt, Phím tắt chạy trễ, TCB không có giờ trong
nội dung nên dùng giờ notification) sẽ không ghép được và cũng tự post transfer
→ trước đây **ghi hai lần**, hoặc bên OUT kẹt REVIEW (`OUT_UNVERIFIED`) cạnh
transfer đã post. Nay có lượt ghép muộn bên dưới.

**Ghép muộn** (`findLateTransferPeer`, 2026-10-13): lượt 1 phút trượt thì thử lại
với cửa sổ **24h**, nhưng chỉ nhận peer đã gắn chặt với ví của event (vẫn cần
một bên chỉ đích danh bên kia):
- peer `PROCESSED` có money event `transfer` (chưa settle cashflow) mà phía của
  event này (`to_asset_id` nếu IN, `from_asset_id` nếu OUT) đúng ví của event; hoặc
- peer chưa post, REVIEW vì `OUT_UNVERIFIED`.

Ghép chéo hai lần chuyển cùng số tiền giữa cùng hai ví vẫn ra cùng kết quả, nên
cửa sổ rộng không có hại ở đây. Inbox "Ghi nhận" (không kèm cashflow) cũng chạy
`pairTransferLeg` trước khi post, để một chân đang kẹt bấm vào thành
`TRANSFER_PAIRED` thay vì tạo transfer thứ hai. Ngoài 24h vẫn có thể ghi hai lần;
số dư khi đó được đồng bộ bù (mục Số dư).

**Post** (`BankPostingService.post`, khoá cả hai dòng theo thứ tự id):
- Peer đã có money event `transfer` → event này chỉ thành `PROCESSED`
  (`TRANSFER_PAIRED`), không tạo tiền. Ví đích của transfer phải đúng ví của
  event, không thì 409.
- Peer đã có income/expense (vd VCB tự post trước khi TCB được liên kết) → sửa
  money event đó thành `transfer` qua `updateMoneyEvent` (replay ví như edit).
  Money event đã settle cashflow thì không bị chọn làm peer.
- Chưa bên nào post → tạo transfer (từ ví bên OUT sang ví bên IN), gắn vào event
  đang post; peer thành `PROCESSED` (`TRANSFER_PAIRED`).
- Chưa có peer nhưng có `counterpart_source_id` → vẫn post transfer, bên thiếu
  lấy ví của link counterpart. Event kia đến sau sẽ ghép vào. Link counterpart
  đã mất → rơi về income/expense như cũ.
- Transfer không settle cashflow: route bỏ matcher, inbox `post` kèm
  `cashflowEventId` trên event transfer → 400.

**Tự động hay vào inbox.**
- Peer đã có transfer → luôn đánh dấu `TRANSFER_PAIRED`, kể cả xử lý lại sau
  liên kết, vì không có tiền nào di chuyển.
- Peer có income/expense cần đổi → cần `allowAuto` + link của event `AUTO`.
- Tạo transfer mới → cần `allowAuto` + **cả hai** link `AUTO` (transfer chạm cả
  hai ví), và nếu peer đang chờ thì chỉ khi lý do của nó là `OUT_UNVERIFIED`.
- Có peer thì `OUT_UNVERIFIED` được bỏ qua: số tiền đã được ngân hàng kia xác
  nhận. Chưa có peer thì vẫn giữ.
- Không đủ điều kiện → giữ lý do REVIEW cũ; người dùng bấm Ghi nhận trong inbox
  sẽ ra transfer.

**Race** — thực tế là trường hợp **phổ biến nhất**: Phím tắt gửi hai thông báo
gần như cùng lúc (đo 2026-10-13, TCB → VCB: nhận cách nhau 4ms). Hai luồng route
song song, mỗi bên tìm cặp lúc bên kia chưa ghi `matched_asset_id` /
`counterpart_source_id` → VCB IN tự post transfer qua counterpart, TCB OUT (body
không có số TK VCB) kẹt REVIEW `OUT_UNVERIFIED`. Sửa bằng `closeTransferRace`
(chỉ ingest live): sau khi trạng thái đã chốt, đọc lại event và chạy
`findLateTransferPeer` một lần nữa. Mỗi luồng *ghi xong rồi mới kiểm tra*, nên
luồng kiểm tra sau cùng chắc chắn thấy trạng thái cuối của luồng kia. Ghép được
thì post chân đang chờ → `TRANSFER_PAIRED`. Một chân đã post chỉ đóng chân đang
REVIEW, không bao giờ ghép hai transfer đã post với nhau.
Đồng bộ số dư: event `TRANSFER_PAIRED` dùng money event của peer làm mốc.

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

## Số dư

Số dư trong thông báo là **source of truth** cho ví ngân hàng (quyết định
2026-10-13; trước đó chỉ cảnh báo lệch và chờ user bấm điều chỉnh — bỏ vì user
không cần biết, chỉ cần số đúng). Không còn endpoint `wallet-drift` hay UI cảnh
báo.

Mỗi lần post (auto hoặc từ inbox), trong cùng transaction,
`BankPostingService.syncReportedBalances` lấy observation mới nhất của các ví
vừa chạm (ví đích, và ví bên kia nếu là transfer). Nếu `current_value` khác số
ngân hàng thì `AssetsService.syncWalletBalance` ghi một `asset_update` (note
"Đồng bộ số dư ngân hàng") đặt ví **đúng bằng** số dư báo về
(`domain/wallet-drift.ts → balanceSyncTarget`).

- **Đặt tuyệt đối, không tính drift qua điểm valuation.** Bản đầu tính
  `reported − ledger sau ME − Σ asset_update` với "ledger sau ME" lấy từ
  `asset_valuations` gắn ME. Sai: `replayWalletBalance` đóng dấu lại điểm của
  *mọi* ME theo `event_date`, mà các ME cùng ngày không có thứ tự ổn định → điểm
  "sau ME" là số của ME khác, ra các điều chỉnh rác (đo 2026-10-13: VCB −986k rồi
  −982k). `current_value` thì đúng vì tổng không phụ thuộc thứ tự. Đặt tuyệt đối
  còn tự chữa mọi điều chỉnh sai trước đó ở lần đồng bộ kế tiếp.
- **Chỉ khi chưa bị thay thế** (`superseded`): bỏ qua nếu sau ME của observation
  (so `(created_at, id)`, id là uuid v7) ví đã có một money event dòng tiền khác
  (`asset_update`/`asset_quantity_adjustment` không tính). Khi đó số dư báo về đã
  cũ; thông báo kế tiếp sẽ đồng bộ. Ví dụ: VCB post transfer chạm cả ví TCB, mà
  observation mới nhất của TCB là của transfer trước → không kéo TCB lùi.
- Chỉ đồng bộ khi **post**, không đồng bộ khi event vào REVIEW/UNMAPPED: đồng bộ
  trước rồi post sau sẽ cộng khoản đó hai lần cho tới thông báo kế tiếp.
- Techcombank không có giờ giao dịch: thứ tự trong ngày có thể sai, chấp nhận —
  thông báo kế tiếp sẽ sửa lại.

## Chống trùng

Chỉ hai lớp: `(credential, clientEventId)` và `SAME_PAYLOAD` (HMAC của `app +
title + body` đã chuẩn hoá, trong 24h, cả household). Đủ vì body của mọi ngân
hàng đang hỗ trợ đều chứa mã tham chiếu duy nhất (TCB `Ma tham chieu …`, VCB
`Ref … FT…`) — hai giao dịch thật không bao giờ cùng body.

Lớp `POSSIBLE_DUPLICATE` (cùng source + chiều + số tiền trong 10 phút → REVIEW)
đã bỏ 2026-10-13 theo quyết định của chủ sản phẩm: nó chặn nhầm giao dịch thật
cùng số tiền liên tiếp (chuyển thử 2.000đ hai lần) mà không bắt được gì hai lớp
trên bỏ sót. Event cũ trong DB vẫn có thể mang lý do này nên client giữ chuỗi
dịch. Thêm ngân hàng mới mà body không có mã tham chiếu thì phải xem lại.

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
