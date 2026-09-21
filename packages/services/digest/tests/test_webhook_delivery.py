"""Discord webhook delivery — the no-gateway publish path.

`post_discord` maps the same presentation batches the openclaw transport
uses onto webhook JSON (one embed per batch) and POSTs them with urllib;
the opener is injected so nothing here touches the network.
"""

import json
import urllib.error

import pytest

from digest import daily_digest as dd


def _presentation(n_text=2, title="📋 Daily Digest — 2026-09-21", tone="success"):
    blocks = []
    for i in range(n_text):
        blocks.append({"type": "text", "text": f"section {i} body"})
        blocks.append({"type": "divider"})
    return {"title": title, "tone": tone, "blocks": blocks}


class _Resp:
    def __init__(self, status=204):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _capture_opener(status=204, sent=None):
    sent = sent if sent is not None else []

    def opener(req, timeout=None):
        sent.append({
            "url": req.full_url,
            "method": req.get_method(),
            "headers": dict(req.header_items()),
            "body": json.loads(req.data.decode("utf-8")),
            "timeout": timeout,
        })
        return _Resp(status)

    return opener, sent


def test_webhook_payloads_one_embed_per_batch_with_title_tone_and_no_mentions():
    batches = dd._presentation_batches(_presentation())
    payloads = dd._webhook_payloads(batches)
    assert len(payloads) == len(batches) == 1
    embed = payloads[0]["embeds"][0]
    assert embed["title"] == "📋 Daily Digest — 2026-09-21"
    assert embed["color"] == 0x2ECC71
    assert "section 0 body" in embed["description"]
    assert "───" in embed["description"]  # divider rendered as a rule
    assert payloads[0]["allowed_mentions"] == {"parse": []}


def test_webhook_payloads_edge_cases():
    # unknown tone → no colour; non-dict / blank blocks skipped; empty → zero-width space; long title truncated
    payloads = dd._webhook_payloads([
        {"title": "t" * 300, "tone": "weird", "blocks": ["junk", {"type": "text", "text": "   "}]},
        {"blocks": [{"type": "text", "text": "x" * 5000}]},
    ])
    assert payloads[0]["embeds"][0]["description"] == "​"
    assert "color" not in payloads[0]["embeds"][0]
    assert len(payloads[0]["embeds"][0]["title"]) == 256
    assert "title" not in payloads[1]["embeds"][0]
    assert len(payloads[1]["embeds"][0]["description"]) == 4096


def test_post_discord_webhook_posts_every_batch(capsys):
    opener, sent = _capture_opener()
    dd.post_discord(_presentation(), "fallback", dry_run=False, delivery="webhook",
                    webhook_url="https://discord.com/api/webhooks/1/abc", urlopen=opener)
    assert len(sent) == 1
    assert sent[0]["url"] == "https://discord.com/api/webhooks/1/abc"
    assert sent[0]["method"] == "POST"
    assert sent[0]["headers"]["Content-type"] == "application/json"
    assert sent[0]["body"]["embeds"][0]["title"].startswith("📋 Daily Digest")
    assert sent[0]["timeout"] == 30
    out = capsys.readouterr().out
    assert "Posted via Discord webhook" in out
    assert "abc" not in out  # the URL is a secret: never echoed


def test_post_discord_webhook_requires_a_url():
    with pytest.raises(SystemExit) as e:
        dd.post_discord(_presentation(), "fallback", dry_run=False, delivery="webhook", webhook_url=None,
                        urlopen=_capture_opener()[0])
    assert "no Discord webhook URL configured" in str(e.value)
    assert "digest-webhook.url" in str(e.value)


def test_post_discord_webhook_fails_loudly_on_http_error():
    def opener(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 429, "rate limited", {}, None)

    with pytest.raises(SystemExit) as e:
        dd.post_discord(_presentation(), "fallback", dry_run=False, delivery="webhook",
                        webhook_url="https://discord.com/api/webhooks/1/abc", urlopen=opener)
    assert "HTTP 429" in str(e.value)


def test_post_discord_webhook_fails_loudly_on_network_error_and_bad_status():
    def opener(req, timeout=None):
        raise urllib.error.URLError("dns down")

    with pytest.raises(SystemExit) as e:
        dd.post_discord(_presentation(), "fallback", dry_run=False, delivery="webhook",
                        webhook_url="https://discord.com/api/webhooks/1/abc", urlopen=opener)
    assert "dns down" in str(e.value)

    opener2, _ = _capture_opener(status=500)
    with pytest.raises(SystemExit) as e2:
        dd.post_discord(_presentation(), "fallback", dry_run=False, delivery="webhook",
                        webhook_url="https://discord.com/api/webhooks/1/abc", urlopen=opener2)
    assert "HTTP 500" in str(e2.value)


def test_post_discord_dry_run_prints_webhook_payloads(capsys):
    dd.post_discord(_presentation(), "fallback", dry_run=True, delivery="webhook", webhook_url=None)
    out = capsys.readouterr().out
    assert "delivery=webhook" in out
    assert "webhook payloads" in out
    assert "allowed_mentions" in out


def test_post_discord_openclaw_mode_without_cli_points_at_webhook(monkeypatch):
    monkeypatch.setattr(dd, "OPENCLAW_CLI", None)
    with pytest.raises(SystemExit) as e:
        dd.post_discord(_presentation(), "fallback", dry_run=False, delivery="openclaw")
    assert "switch to webhook delivery" in str(e.value)


def test_blank_presentation_gets_a_visible_floor_in_webhook_mode():
    opener, sent = _capture_opener()
    dd.post_discord({"title": "Daily Digest", "tone": "info", "blocks": []}, "fallback", dry_run=False,
                    delivery="webhook", webhook_url="https://discord.com/api/webhooks/1/abc", urlopen=opener)
    assert "nothing to report" in sent[0]["body"]["embeds"][0]["description"]
    assert sent[0]["body"]["embeds"][0]["color"] == 0x3498DB
