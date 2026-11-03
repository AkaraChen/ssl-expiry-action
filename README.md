# SSL Expiry Check

**English** | [简体中文](README.zh-CN.md)

A zero-dependency GitHub Action that checks TLS certificate expiry in parallel, returns JSON, and gives you outputs that plug straight into alerting.

- **Fast**: Node built-ins only, no Docker, no `npm install`. All hosts are checked concurrently with a hard per-host timeout
- **Simple**: one `index.js`, one required input
- **Alert-friendly**: `alert` / `status` / `message` outputs drop right into `if:` and webhooks; `fail-on` fails the job so GitHub emails you

## Usage

```yaml
- uses: AkaraChen/ssl-expiry-action@v1
  id: ssl
  with:
    urls: |
      example.com
      https://api.example.com:8443
```

## Inputs

| Name | Default | Description |
|---|---|---|
| `urls` | **required** | One or more URLs / hosts, separated by newline, comma or space. Scheme defaults to https, port to 443 |
| `warning-days` | `30` | Days left ≤ this → `warning` |
| `critical-days` | `7` | Days left ≤ this → `critical` (expired certs are always `critical`) |
| `timeout` | `10` | Per-host timeout in seconds |
| `fail-on` | `none` | Fail the step when the worst status reaches this level: `none` / `warning` / `critical` / `error` |
| `ca` | empty | Extra CA certificate(s) to trust, for internal services. PEM text (may contain several certs) or a path to a PEM file. See below |

## Outputs

| Name | Example | Description |
|---|---|---|
| `json` | `[{...}]` | All results, **sorted by severity (worst first)** |
| `status` | `critical` | Worst status across all hosts |
| `alert` | `true` | `"true"` if any host is not `ok` |
| `message` | `🔴 example.com: expires in 3 days (2026-11-06)` | One line per non-ok host, ready to post to chat. Empty when everything is ok |

Status levels: `ok` < `warning` < `critical` < `error`

- `error`: connection refused, DNS failure, timeout, untrusted chain, hostname mismatch, etc. `days_left` is still filled in when the certificate could be read

Each item in `json`:

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

The action also adds annotations to the run page and writes a table to the Job Summary.

## Alerting

### 1. Email (zero setup)

When a job fails, GitHub emails the user who last modified the workflow's cron schedule.

```yaml
with:
  urls: example.com
  fail-on: warning
```

### 2. Webhook (Slack / Feishu / DingTalk / WeCom)

```yaml
- name: Notify
  if: steps.ssl.outputs.alert == 'true'   # with fail-on, use: always() && steps.ssl.outputs.alert == 'true'
  env:
    MSG: ${{ steps.ssl.outputs.message }}
    WEBHOOK: ${{ secrets.WEBHOOK_URL }}
  run: |
    # Slack:            {text:$t}
    # Feishu:           {msg_type:"text", content:{text:$t}}
    # DingTalk / WeCom: {msgtype:"text", text:{content:$t}}
    jq -n --arg t "SSL certificate alert"$'\n'"$MSG" '{text:$t}' \
      | curl -sf -H 'Content-Type: application/json' -d @- "$WEBHOOK"
```

> Pass `message` through `env` instead of inlining it in `run` to avoid script injection.

### 3. Custom rules

```yaml
- if: steps.ssl.outputs.status == 'critical' || steps.ssl.outputs.status == 'error'
  run: echo "only on severe problems"

- if: fromJSON(steps.ssl.outputs.json)[0].days_left < 3
  run: echo "the most urgent cert has less than 3 days left"
```

## Internal services / private CA

By default only Node's bundled public roots (the Mozilla list) are trusted, so certificates issued by an internal CA are reported as `error`. Pass your CA via `ca`. It is **added on top of** the public roots, so public and internal hosts can be checked in the same run.

```yaml
# Option 1: PEM content in a secret or variable (concatenate multiple certs)
- uses: AkaraChen/ssl-expiry-action@v1
  with:
    urls: |
      example.com
      git.corp.internal
    ca: ${{ secrets.INTERNAL_CA_PEM }}

# Option 2: a PEM file in the repo (path relative to the repo root, checkout first)
- uses: actions/checkout@v5
- uses: AkaraChen/ssl-expiry-action@v1
  with:
    urls: git.corp.internal
    ca: certs/internal-ca.pem
```

> Internal hosts must be reachable from the runner, which usually means a self-hosted runner.

## Full example

```yaml
name: SSL expiry check
on:
  schedule:
    - cron: '0 1 * * *'   # daily at 01:00 UTC
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
          jq -n --arg t "SSL certificate alert"$'\n'"$MSG" '{text:$t}' \
            | curl -sf -H 'Content-Type: application/json' -d @- "$WEBHOOK"
```

## Notes

- In public repos, GitHub disables scheduled workflows after 60 days without commits, and your monitoring stops silently.
- Consider pinning to a full commit SHA instead of `@v1`.

## License

[MIT](LICENSE)
