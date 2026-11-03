# SSL Expiry Check

[English](README.md) | **简体中文**

零依赖、并行检查 TLS 证书到期时间，返回 JSON，并直接给出可用于告警的输出。

- **快**：纯 Node 内置模块，无 Docker / 无 `npm install`，所有域名并发检查，单个域名有硬超时
- **简单**：一个 `index.js`，一个必填参数
- **方便告警**：`alert` / `status` / `message` 三个输出直接接 `if:` 和 webhook；另有 `fail-on` 让 job 失败从而触发 GitHub 邮件

## 用法

```yaml
- uses: AkaraChen/ssl-expiry-action@v1
  id: ssl
  with:
    urls: |
      example.com
      https://api.example.com:8443
```

## 输入

| 名称 | 默认 | 说明 |
|---|---|---|
| `urls` | **必填** | 一个或多个 URL / 域名，换行、逗号、空格分隔。不写协议默认 https，不写端口默认 443 |
| `warning-days` | `30` | 剩余天数 ≤ 该值 → `warning` |
| `critical-days` | `7` | 剩余天数 ≤ 该值 → `critical`（已过期也是 `critical`）。不能大于 `warning-days` |
| `timeout` | `10` | 单个域名超时秒数 |
| `retries` | `2` | 读不到证书时（连接被重置、超时、DNS 等）额外重试的次数，避免网络抖动造成误报。证书本身的问题不会重试 |
| `fail-on` | `none` | 最差状态达到该级别时让 step 失败：`none` / `warning` / `critical` / `error` |
| `ca` | 空 | 额外信任的 CA 证书（内网服务用）。PEM 文本（可含多张证书）或 PEM 文件路径，见下文 |

## 输出

| 名称 | 示例 | 说明 |
|---|---|---|
| `json` | `[{...}]` | 全部结果，**按严重程度排序（最差在前）** |
| `status` | `critical` | 所有域名中最差的状态 |
| `alert` | `true` | 任一域名不是 `ok` 即为 `"true"` |
| `message` | `🔴 example.com: expires in 3 days (2026-11-06)` | 每个非 ok 域名一行，可直接发到 IM；全部正常时为空 |

状态级别：`ok` < `warning` < `critical` < `error`

- `error`：连不上、DNS 失败、超时、证书链不受信、域名不匹配等。能读到证书时仍会填 `days_left`

`json` 中每一项：

```json
{
  "url": "https://expired.badssl.com",
  "host": "expired.badssl.com",
  "port": 443,
  "status": "critical",
  "days_left": -4223,
  "expires_at": "2015-04-12T23:59:59.000Z",
  "issuer": "COMODO CA Limited",
  "error": null
}
```

此外 action 还会在运行页面生成 annotation，并在 Job Summary 写一张表。

## 告警方式

### 1. 邮件（零配置）

job 失败时 GitHub 会自动发邮件给最后修改该 workflow cron 的人。

```yaml
with:
  urls: example.com
  fail-on: warning
```

### 2. Webhook（飞书 / 钉钉 / 企业微信 / Slack）

```yaml
- name: Notify
  if: steps.ssl.outputs.alert == 'true'   # 若同时用了 fail-on，改成 always() && steps.ssl.outputs.alert == 'true'
  env:
    MSG: ${{ steps.ssl.outputs.message }}
    WEBHOOK: ${{ secrets.WEBHOOK_URL }}
  run: |
    # 飞书:            {msg_type:"text", content:{text:$t}}
    # 钉钉 / 企业微信:  {msgtype:"text", text:{content:$t}}
    # Slack:           {text:$t}
    jq -n --arg t "SSL 证书告警"$'\n'"$MSG" '{msg_type:"text", content:{text:$t}}' \
      | curl -sf -H 'Content-Type: application/json' -d @- "$WEBHOOK"
```

> 通过 `env` 传入 `message` 而不是直接写进 `run`，可以避免脚本注入。钉钉如果开了"自定义关键词"，把 `SSL` 设为关键词即可。

### 3. 自定义规则

```yaml
- if: steps.ssl.outputs.status == 'critical' || steps.ssl.outputs.status == 'error'
  run: echo "只在严重时处理"

- if: fromJSON(steps.ssl.outputs.json)[0].days_left < 3
  run: echo "最紧急的证书不到 3 天"
```

## 内网服务 / 自建 CA

默认只信任 Node 自带的公共根证书（Mozilla 列表），用内部 CA 签发的证书会被判为 `error`。通过 `ca` 传入你的 CA 即可，它会**追加**到公共根证书之上，所以公网和内网域名可以放在同一次检查里。

```yaml
# 方式一：PEM 内容放在 secret 或 variable 里（多张证书直接拼在一起）
- uses: AkaraChen/ssl-expiry-action@v1
  with:
    urls: |
      example.com
      git.corp.internal
    ca: ${{ secrets.INTERNAL_CA_PEM }}

# 方式二：仓库里的 PEM 文件（路径相对于仓库根目录，需要先 checkout）
- uses: actions/checkout@v5
- uses: AkaraChen/ssl-expiry-action@v1
  with:
    urls: git.corp.internal
    ca: certs/internal-ca.pem
```

> 内网域名需要 runner 能访问到，一般意味着用 self-hosted runner。

## 完整示例

```yaml
name: SSL expiry check
on:
  schedule:
    - cron: '0 1 * * *'   # 每天 UTC 01:00
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: AkaraChen/ssl-expiry-action@v1
        id: ssl
        with:
          urls: |
            example.com
            api.example.com
          warning-days: 21
          critical-days: 7

      - name: Notify
        if: steps.ssl.outputs.alert == 'true'
        env:
          MSG: ${{ steps.ssl.outputs.message }}
          WEBHOOK: ${{ secrets.WEBHOOK_URL }}
        run: |
          jq -n --arg t "SSL 证书告警"$'\n'"$MSG" '{msg_type:"text", content:{text:$t}}' \
            | curl -sf -H 'Content-Type: application/json' -d @- "$WEBHOOK"
```

## 注意

- 公共仓库 60 天没有提交时，GitHub 会自动停用定时 workflow，监控会悄悄停止。
- 引用时建议固定到完整 commit SHA 而不是 `@v1`。
- 运行时为 `node24`，需要 Actions Runner v2.327.1 及以上。GitHub 托管的 runner 没问题，self-hosted runner 版本太旧的需要先升级。

## License

[MIT](LICENSE)
