# 9d-cicd — Unit Test Dashboard cho 9d-mobile

Node server (zero dependency, Node ≥ 18) quản lý và theo dõi unit test của `9d-mobile`.

## Chạy

```bash
cd 9d-cicd
node server.js          # → http://localhost:4909
# tuỳ chọn:
PORT=8080 MOBILE_REPO=/path/to/9d-mobile node server.js
```

## Tính năng

- Nút **▶ Chạy lại Unit Test** — gọi `9d-mobile/scripts/run-all-unittest.sh` (configure CMake → build → chạy toàn bộ doctest case).
- Bảng trạng thái từng test case, cập nhật **live** qua Server-Sent Events:
  - 🟢 xanh = passed, 🔴 đỏ = failed, 🟡 vàng = đang chạy, xám = chờ chạy.
- Thẻ tổng hợp: tổng số test / passed / failed / đang chạy.
- Panel log build + test output (nút "hiện / ẩn").
- Lịch sử các lần chạy (lưu trong `data/last-run.json`, giữ tối đa 30 lần).

## API

| Endpoint | Mô tả |
|---|---|
| `GET /` | Dashboard |
| `POST /api/run` | Kích hoạt chạy toàn bộ unit test (409 nếu đang chạy) |
| `GET /api/state` | Trạng thái đầy đủ (tests, summary, log, history) |
| `GET /api/events` | SSE stream: `run-start`, `phase`, `tests`, `test`, `log`, `summary`, `run-end` |

## Cách hoạt động

`scripts/run-all-unittest.sh` (trong repo `9d-mobile`) in các marker máy-đọc-được trên stdout
(`##TC_LIST`, `##TC_START`, `##TC_PASS`, `##TC_FAIL`, `##SUMMARY`, tab-separated);
server parse từng dòng và broadcast tới browser. Mỗi test case được chạy riêng bằng
filter `--test-case=` của doctest nên trạng thái "đang chạy" là theo từng case thật.

Test harness nằm ở `9d-mobile/tests/` (doctest, theo skill `.claude/skills/unit-test`).
Thêm test mới: tạo `tests/test_<module>.cpp` và đăng ký trong `tests/CMakeLists.txt` —
dashboard tự nhận diện case mới ở lần chạy kế tiếp, không cần sửa server.
