# 9d-web — Test Dashboard cho 9d-mobile

Node server (zero dependency, Node ≥ 18) chạy & giám sát test của `9d-mobile`. Hai suite, hai tab:
- **Unit Test** → `9d-mobile/scripts/run-all-unittest.sh` (doctest host, cô lập, không link engine).
- **UI Test (app thật)** → `9d-mobile/scripts/run-all-uitest.sh` (drive app `ndshell_mac` thật: login, PIN…).

## Chạy

```bash
cd 9d-web
node server.js          # → http://localhost:4909
# tuỳ chọn:
PORT=8080 MOBILE_REPO=/path/to/9d-mobile node server.js
```

## Tính năng

- Nút **▶ Chạy** — chạy toàn bộ suite của tab đang mở.
- **Chạy riêng từng case**: mỗi dòng có nút ▶ để chạy đúng case đó (không đụng các case khác trên bảng).
- **Điều khiển PIN / gameplay** (chỉ tab UI Test): ô nhập *mã PIN* + nút **▶ Test PIN sai** và **▶ Vào game + zoom**.
  - **Test PIN sai**: gõ mã đã nhập, kỳ vọng server từ chối (case `pin_<label>_wrong`).
  - **Vào game + zoom**: dùng mã đã nhập làm PIN đăng nhập vào thế giới rồi test scroll-chuột zoom in/out camera (case `scroll_zoom_<label>` — đã bao gồm login thành công + PIN đúng).
  - Để trống ô → dùng PIN mặc định của account trong `accounts.ini`.
- Bảng trạng thái từng test case, cập nhật **live** qua Server-Sent Events:
  🟢 passed · 🔴 failed · 🟡 đang chạy · xám chờ chạy. Case UI (kể cả PIN) hiện sẵn trước cả lần chạy đầu.
- Case UI sắp xếp & chạy theo thứ tự **từ ngoài vào trong** (đúng thứ tự người chơi gặp màn hình):
  `login_*` (màn đăng nhập) → `pin_*_wrong` (numpad mã PIN) → `scroll_zoom_*` (camera trong game)
  → `actionbar_*` (mobile action bar trong game — nút ATK / F-circles / Fight / LOCK / NEXT / AP, sâu nhất).
- Thẻ tổng hợp (tổng/passed/failed/đang chạy), panel log, lịch sử (lưu `data/last-run.json`, tối đa 30 lần;
  lần chạy 1 case ghi kèm tên case trong cột kết quả).

## API

| Endpoint | Mô tả |
|---|---|
| `GET /` | Dashboard |
| `POST /api/run?suite=<unit\|ui>` | Chạy test. Body JSON tuỳ chọn: `{"only":["<case>",…], "pin":"<digits>"}` — `only` = chạy đúng các case đó (partial run); `pin` = mã PIN gõ cho case PIN. Cũng nhận query `?only=a,b&pin=1234`. 409 nếu đang chạy. |
| `GET /api/state?suite=<…>` | Trạng thái đầy đủ (tests, summary, log, history) |
| `GET /api/cases?suite=ui` | Danh sách case UI khám phá nhanh (không build) — dùng để hiện case PIN trước khi chạy |
| `GET /api/events` | SSE stream: `state`, `run-start`, `phase`, `tests`, `test`, `log`, `summary`, `run-end` |

## Cách hoạt động

Cả 2 script in marker tab-separated trên stdout (`##PHASE / ##TC_LIST / ##TC_START / ##TC_PASS /
##TC_FAIL(+detail) / ##SUMMARY`); server parse từng dòng và broadcast qua SSE.

- **Partial run** (`only`): server truyền `ND_UITEST_ONLY=<case,…>` cho `run-all-uitest.sh`; script chỉ
  liệt kê/chạy đúng các case đó. Dashboard **không xoá** các case khác trên bảng, summary tính lại toàn bảng.
- **PIN override** (`pin`): server truyền `ND_UITEST_PIN_OVERRIDE=<digits>` → app gõ đúng mã đó ở màn PIN.
- Case UI được sinh từ `9d-mobile/tests/ui/accounts.ini` và trả về theo thứ tự từ ngoài vào trong:
  dòng `expect!=success` → `login_<label>`; dòng `expect=success` có cột PIN (cột 5) → `pin_<label>_wrong`
  (đúng/sai **do server game quyết** — `MSG_NO_SECONDARY_PW_CHECK`, test chỉ quan sát game-state);
  dòng `expect=success` → `scroll_zoom_<label>` + `actionbar_<label>` (gameplay, vào thế giới thật;
  actionbar test nút ATK / F-circles / Fight / LOCK / NEXT / AP của mobile action bar).
  Xem `9d-mobile/tests/ui/README.md`.

Unit harness ở `9d-mobile/tests/` (doctest). Thêm test mới không cần sửa server — dashboard tự nhận ở lần chạy kế tiếp.
