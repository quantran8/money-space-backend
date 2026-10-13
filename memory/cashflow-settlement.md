# Cashflow settlement — nối giao dịch thật với khoản đã lên lịch

## Overview

Một **kỳ** của cashflow event được "settle" khi có đúng một money event làm
bằng chứng cho nó. Ba lối vào, chung một service (`CashflowSettlementService`):

| Lối vào | `settled_via` | Money event |
|---|---|---|
| Hoàn tất thủ công | `manual_complete` | tạo mới (như trước) |
| Gắn giao dịch ngân hàng | `manual_link` | dùng ME ngân hàng **đã có** — không tạo ME thứ hai |
| Tự khớp theo nội dung CK | `auto_note` | ME ngân hàng vừa post |

Đây là chỗ chặn double-count: trước đây lương vào bank được post vào ví, event
"Lương" vẫn pending (forecast cộng lần hai), bấm Complete lại tạo ME thứ hai
(ví cộng lần hai). Spec: `11-transaction-capture-reconciliation.md`.

Related: [[cashflow-events]], [[bank-sync]], [[money-events]],
[[forecast-and-flexible-money]].

## Kỳ = `expectedDate` lúc settle

Không có bảng occurrence (recurrence sinh ảo khi đọc — [[cashflow-events]]).
Kỳ đang chờ của một event luôn là `expectedDate`; settle thì ghi kỳ đó vào
`money_events.occurrence_date` rồi đẩy event lên kỳ sau như cũ.

- Kỳ settle **luôn** là `event.expectedDate`, không lấy ngày UI gửi lên: UI gửi
  ngày đã bị clamp về hôm nay cho kỳ quá hạn.
- Unique `(cashflow_event_id, occurrence_date)` trên ME chưa xoá: một kỳ, một
  bằng chứng. Hai người gắn cùng lúc → bên sau nhận 409.
- ME cũ (có `cashflow_event_id`, không có `occurrence_date`) giữ nguyên, không
  backfill bằng cách đoán theo số tiền/ngày.

## Bỏ gắn chỉ ở kỳ mới nhất

Một row không biểu diễn được "kỳ 10 còn chờ, kỳ 11 đã xong". Nên unsettle chỉ
cho phép trên ME có `occurrence_date` lớn nhất của event; kỳ cũ hơn → 409 "bỏ
gắn kỳ sau trước". Revert: `expectedDate = occurrence_date`, `status =
expected`, `lastCompleted*` tính lại từ ME còn lại.

- Bỏ gắn **không** xoá ME: giao dịch ngân hàng là quan sát thật, vẫn ở trong ví.
- ME `manual_complete` không "bỏ gắn" được — nó do chính lệnh hoàn tất tạo ra;
  muốn huỷ thì xoá ME (đảo ví + reopen kỳ).
- Xoá một ME đang là bằng chứng settle đi qua cùng luật này (trước đây xoá ME
  không rollback event).
- Relink (đổi ME cho cùng một kỳ) luôn được phép.

## Tự khớp theo nội dung chuyển khoản

**Chỉ nội dung CK quyết định giao dịch thuộc event nào.** Số tiền/ngày/ví chỉ
là guardrail loại trừ, không bao giờ dùng để đoán.

Rule (`cashflow_match_rules`) gắn vào event, operator `contains` **theo từ
nguyên** (`LUONG` không khớp `LUONGVAN`) trên chuỗi đã chuẩn hoá: NFD bỏ dấu, `đ→d`, viết hoa, ký tự không phải chữ/số thành khoảng
trắng, gộp khoảng trắng. Phrase chuẩn hoá ≥ 4 ký tự. Lưu rule bị từ chối nếu
phrase chứa / bị chứa bởi phrase của event khác đang bật. Không tự học sau khi
user gắn tay.

`exact` bị loại: note thật kiểu `MBVCB.123.LUONG T10 CTY ABC.CT tu…` không bao
giờ khớp nguyên văn.

Matcher chạy ở bước 8 của ingest ([[bank-sync]]), trên note đã trích bởi
`moneyEventNote` (để không khớp vào dòng số TK/số dư):

1. Note rỗng hoặc không rule nào khớp → `none`.
2. Khớp nhiều event → `ambiguous`.
3. Chiều khác, ví khác `settlementAssetId` → `blocked`; event `postponed`/
   `cancelled`/`completed` → `blocked`.
4. Cửa sổ kỳ: ngày giao dịch ∈ `[expectedDate − W, kỳ kế tiếp)`, W = 10 ngày
   (3 ngày cho weekly). Từ kỳ kế tiếp trở đi = nhiều kỳ quá hạn cùng hợp lệ →
   `ambiguous`. Trước cửa sổ → `none`.
5. Kỳ vừa settle bằng `manual_complete` và giao dịch rơi vào cửa sổ kỳ đó →
   `replace_manual` (luôn REVIEW).
6. Còn lại → `matched`. Link `AUTO` + ingest live → post và settle cùng một
   transaction. Ngoài ra chỉ lưu gợi ý lên bank event, chờ inbox.

Số tiền lệch **không** phủ quyết: lương thực nhận có thể khác. Expected nằm ở
`cashflow_events.amount`, actual là `money_events.amount`; kỳ sau vẫn dùng
expected.

## Hoàn tất tay rồi ngân hàng mới báo

`replace_manual`: soft-delete ME `manual_complete` (đảo tác động ví theo đường
xoá sẵn có) và gắn ME ngân hàng vào cùng kỳ, trong một transaction. Ví chỉ đổi
một lần, theo số thật của ngân hàng.

## Lệch số dư

Tự đồng bộ theo số dư ngân hàng khi post, không còn cảnh báo — xem
[[bank-sync]] (mục Số dư).

## Auto post khi đã khớp

Link `AUTO` + `matched` → post và settle trong một transaction. Nếu settle
đụng 409 (kỳ vừa bị người khác gắn), tiền **vẫn được post**, bank event ghi
`match_status = blocked`, `match_reason = SETTLE_CONFLICT`. `ambiguous`/`blocked`
vẫn post như cũ, chỉ không settle. `replace_manual` thì **không** post (post sẽ
cộng tiền lần hai) — giữ `REVIEW` với `MATCH_REPLACE_MANUAL`.

Inbox `resolve`: `post` + `cashflowEventId` = post và gắn; `replace_manual` +
`cashflowEventId` = post rồi thay ME hoàn tất tay (ví chỉ đổi một lần).

Chưa ghi activity log cho settle/unsettle: provenance nằm trên ME
(`settled_via/by/at`, `match_rule_id`). Thêm audit cần mã action mới phía client.

## Where it lives in code

- `src/modules/cashflow-events/domain/settlement.ts`, `note-normalize.ts`
- `src/modules/cashflow-events/services/cashflow-settlement.service.ts`,
  `cashflow-matcher.service.ts`
- `src/modules/cashflow-events/domain/note-match.ts` (matcher thuần)
- `src/modules/bank-sync/domain/wallet-drift.ts` (dùng bởi `BankPostingService`)
- Endpoints dưới `…/cashflow-events/:eventId/`: `link`, `unlink`,
  `replace-manual`, `link-candidates`, `settlements`, `match-rules`;
  `GET …/cashflow-events/match-rules` (cả household, cho màn Cài đặt),
  `POST …/cashflow-events/match-rules/preview`
- Migration `20261013090000_cashflow_settlement`
