# E2E Checklist — 2 Accounts (Production Verification)

> Điều kiện cuối của chuỗi multi-account. Chạy **một lượt theo thứ tự** sau khi
> claim quota tay cho acc thứ hai. Mọi lệnh giả định proxy chạy ở
> `localhost:18080` với `ZCODE_PROXY_API_KEY` từ `.env` — chỉnh cho khớp setup
> thực tế. Debug phải BẬT (`zcode-proxy serve debug` hoặc config) để có header
> `x-zcode-account` và log unknown-error.

## 0. Chuẩn bị

- [ ] **Backup `credentials.json`** từ docker volume:
  `docker cp zcode-api-zcode-proxy-1:/data/auth/credentials.json ./credentials-backup.json`
- [ ] **Backup `ZCODE_PROXY_CREDENTIAL_SECRET`** vào password manager — **KHÔNG** để cạnh file backup (không secret = không giải mã được)
- [ ] Deploy bản mới với 1 acc → chạy vài request thường, xác nhận hành vi y như cũ (pass-through)
- [ ] Bật debug
- [ ] Claim quota acc thứ hai trên web ZAI (bằng tay)
- [ ] Backup `auth login zai --add` cho acc thứ hai (nếu chưa)

**Quan sát log khi 1-acc pass-through:** không có dòng `pool:` nào bất thường,
không watchdog warning, không global-guard suspicion.

## 1. Thêm acc thứ hai (server đang chạy)

```bash
zcode-proxy auth login zai --add --label acc2
zcode-proxy auth list
```

- [ ] Output: **ADDED new account** (không phải UPDATED)
- [ ] `auth list`: 2 dòng, userId che bớt (`user…xxxx`), primary vẫn là acc cũ
- [ ] Chạy `--add` lần nữa với đúng acc2 → phải ra **UPDATED existing account**, vẫn 2 dòng (dedupe)
- [ ] Không có key/token nào xuất hiện trong stdout

## 2. Hot-reload (không restart)

- Đợi tối đa ~5s (sync timer), gửi vài request
- [ ] Log có `account=user-cli (pool)` hoặc debug line cho acc2 — pool nhận acc mới

## 3. Phân phối

```bash
# Tuần tự — 10 request, đọc header x-zcode-account của từng cái:
for i in $(seq 1 10); do
  curl -s -o /dev/null -D - -X POST http://localhost:18080/v1/messages \
    -H "x-api-key: $ZCODE_PROXY_API_KEY" -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"glm-5.3-flash","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' \
    | grep -i x-zcode-account
done
```

- [ ] **Xen kẽ gần đều** giữa 2 id (round-robin)
- [ ] Không request nào lỗi do pool (429 `all_accounts_cooling` / 503 `no_account_available`)

```bash
# Đồng thời — 6 request:
for i in $(seq 1 6); do
  curl -s -o /dev/null -D - -X POST http://localhost:18080/v1/messages \
    -H "x-api-key: $ZCODE_PROXY_API_KEY" -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"glm-5.3-flash","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' \
    | grep -iE "x-zcode-account|HTTP" &
done; wait
```

- [ ] **Không dồn hết vào một acc** (inflight cap + reserve tránh stampede)

## 4. Stream dài (phiên Claude Code thật)

Chạy một phiên Claude Code qua proxy vài phút:

- [ ] **Không watchdog warning** (`pool: reservation watchdog force-released…`)
- [ ] `inFlight` về 0 sau khi xong — qua debug line hoặc:
  `curl -s localhost:18080/quota | jq '.accounts[] | {id, status}'` (healthy = slot rảnh)
- [ ] **Ctrl+C giữa stream**: slot được giải phóng NGAY (cancel path), không đợi 15 phút.
  Kiểm chứng: request kế tiếp chạy bình thường, không dính `accounts_busy`/queue timeout

## 5. `/quota`

```bash
curl -s localhost:18080/quota | jq
```

- [ ] Có `accounts[]` với **2 phần tử** + `aggregate` + `legacy`
- [ ] `legacy.balances` khớp acc **primary** (acc cũ)
- [ ] `lastPolledAt` cập nhật sau vài phút (poller chạy)
- [ ] `aggregate.accountsReporting == accountsTotal == 2`
- [ ] `aggregate.totalRemainingUnits` = tổng 2 acc
- [ ] **Không có chuỗi nào giống token/key** trong response:
  `curl -s localhost:18080/quota | grep -ciE "ey[jA-Za-z0-9]|Bearer|api.?key.:"` → phải là 0

## 6. Failover (không ép lỗi)

**Đừng ép 429/401.** Hai đường an toàn:

- [ ] Nếu acc nào **tự hết quota** trong quá trình dùng → log phải có
  `pool: account <id> quota exhausted (biz 1005)`, request thành công ở acc kia
  (hoặc client nhận 1005 body nếu cả hai hết), `/quota` thể hiện `exhausted`
- [ ] `auth remove <acc2-id>` lúc server đang chạy → về chế độ 1 acc, request
  đang chạy không vỡ; `auth login zai --add --label acc2` lại để khôi phục
- [ ] `auth remove` acc cuối mà quên `--yes` → phải bị TỪ CHỐI (exit ≠ 0)

## 7. Log cần đọc (tuần đầu)

- [ ] Mọi dòng `pool: unknown upstream error` → copy status + biz code + body
      preview vào issue #7 (dữ liệu cho bảng phân loại lỗi)
- [ ] Dòng `global_401_suspected` / `global_429` → ghi ngữ cảnh vào #7 (chỉnh ngưỡng)
- [ ] Dòng cooling/exhausted/expired → kiểm tra hồi phục đúng thời điểm
      (exhausted: 30 phút nếu không biết reset; expired: probe 10 phút)

## Tiêu chí qua

- [ ] Phân phối đều, không request nào lỗi do pool
- [ ] Không leak slot sau stream và sau ngắt client
- [ ] `/quota` đúng shape, không credential
- [ ] Không credential trong log

## Nếu có gì đó sai

1. `auth remove` acc2 → quay về 1-acc pass-through (hành vi cũ, đã verify)
2. Rollback: dùng lại image cũ + restore `credentials.json` backup + secret
3. Mở issue với log unknown-error đã redact
