# Loan receivable (Cho vay)

Tiền nhà mình cho người khác vay. Là một tài sản `loan_receivable`
(`formula_calculated`, gốc + lãi tuỳ chọn — xem [[assets]]). Vòng đời có hai
đầu, mỗi đầu là một lần tiền thật di chuyển giữa ví và khoản cho vay.

## 1. Cho vay — "Đã có sẵn" vs "Vừa cho vay"

Dùng lại luồng `fundingAssetId` của form tạo tài sản (xem "Already owned vs.
just bought" trong [[assets]]):

- **Khoản cho vay cũ** (không chọn ví) — khai báo khoản đã cho vay từ trước.
  Không money event, không đụng ví; tài sản ròng tăng vì app vừa biết thêm.
- **Vừa cho vay** (chọn ví `cash` / `bank_account`) — ghi `asset_purchase`
  outflow từ ví sang khoản cho vay, trừ ví đúng **số gốc**. Tài sản ròng đứng yên.
  Ví phải đủ tiền (`assertFundingWalletCovers`).
- Số tiền trừ là **gốc** (`calculationTerm.principalAmount`), không phải giá trị
  hiện tại: một khoản cho vay có ngày bắt đầu trong quá khứ đã cộng lãi dồn,
  trừ ví theo giá trị đó sẽ lấy của ví cả phần lãi chưa từng chi ra. Quy tắc này
  áp dụng cho mọi tài sản formula (cả `saving_deposit`) và khớp với
  `purchaseCostOf` phía client.
- Danh mục của event: `debt` (Nợ) — cho vay là người khác nợ mình; `investment`
  sai nghĩa.

## 2. Đánh dấu đã trả — event `loan_collection`

Người vay trả hết → một money event `loan_collection`:

- `from_asset_id` = khoản cho vay, `to_asset_id` = ví nhận (`cash` /
  `bank_account`; UI mặc định ví tiền mặt đầu tiên), `amount` = số tiền thực
  nhận (UI gợi ý giá trị hiện tại = gốc + lãi dồn), `direction = neutral`
  (chuyển đổi tài sản, không phải thu nhập — như `asset_sale`), danh mục `debt`.
- Áp dụng: cộng ví `amount` (đường `applyWalletEffects` chung; debit phía khoản
  vay là no-op vì không phải ví), rồi **đóng khoản vay**: `assets.status =
  closed`, `calculation_terms.status = matured`. Khoản `closed` rời khỏi tài sản
  ròng, thanh khoản và forecast (mọi chỗ đều lọc `status = active`).
- Tài sản ròng chỉ đổi đúng phần chênh `amount − giá trị khoản vay` (lãi nhận
  thêm hoặc người vay trả thiếu).
- **Sửa / xoá event** hoàn tác qua cặp apply/reverse như `asset_sale`: xoá →
  trừ lại ví và **mở lại** khoản vay (`active` / term `active`).
- Khoản đã thu hồi **ẩn khỏi danh sách nguồn tiền** (`filteredAssets` lọc `closed`);
  vẫn mở được qua link chi tiết / sự kiện để xem lịch sử.
- Lối vào: nút trên trang chi tiết và mục "Đánh dấu đã trả" trong menu ⋯ của dòng
  tài sản (chỉ hiện với `loan_receivable` chưa đóng).
- Chỉ trả **toàn bộ**. Trả từng phần chưa hỗ trợ — sẽ cần giảm `principalAmount`
  giống bán một phần trái phiếu.
- Không dùng `asset_sale`: khoản cho vay không "bán" được, và
  `SELLABLE_ASSET_TYPES` dùng chung với what-if — thêm vào đó sẽ để what-if gợi ý
  "bán khoản cho vay".
- Không dùng `transfer`: transfer bắt buộc hai đầu là ví (`WALLET_ONLY_EVENT_TYPES`)
  và không có hook để đóng / mở lại khoản vay.
