"""v1.5.0 central campaign source registry.

Configuration (reviewed, versioned): server/source_catalog.json — one row per official source:
    key (source_code), bank, bank_code, source_type, adapter, enabled, cadence, priority, listing_urls, ...
Runtime state is published with every catalog in `meta.sourceRegistry` (one row per configured source):
    sourceCode, bankCode, bank, url, sourceType, adapter, enabled, cadence, priority,
    lastCrawlAt, lastSuccessAt, lastVerifiedAt, freshCount, health, sourceVerifiedAt

health: 'ok' (fresh records this run) | 'incomplete' (fresh records, but the completeness evidence shows a discovery or
        parse gap) | 'zero' | 'severe_drop' | 'repaired_from_lkg' (guard kept LKG records) | 'disabled' | 'never_run'
v1.5.0 completeness (per run, from the crawler's source report): mechanism, listing/sitemap candidates, discovered detail
URLs, fetched, active, resolved/partial/unresolved/needs_review, expired, rejected page kinds, parse errors, official
count (only when the bank publishes an enumerable one) and completeness {status: complete|partial|incomplete|unknown,
confidence: high|medium|low}. Equality with the last-known-good catalog is never evidence of completeness.
Crawling stays GLOBAL and CENTRAL: the registry is read only by the scheduled crawler; a user selecting a bank never
starts or configures a crawl. Disabled sources are never fetched.
"""
from __future__ import annotations

import json
from pathlib import Path

CONFIG_FILE = Path(__file__).resolve().parent / "source_catalog.json"


def load_all(path: Path = CONFIG_FILE) -> list[dict]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def is_active(source: dict) -> bool:
    return source.get("enabled", True) is not False and bool(source.get("adapter", "generic_html_v1"))


def active_sources(all_sources: list[dict]) -> list[dict]:
    return [s for s in all_sources if is_active(s)]


def _previous(prev_registry) -> dict:
    return {r.get("sourceCode"): r for r in (prev_registry or []) if isinstance(r, dict)}


METRIC_KEYS = ("mechanism", "listing_candidates", "sitemap_candidates", "discovered_detail_urls", "truncated", "fetched",
               "fetch_errors", "active", "applicable", "resolved", "partial", "unresolved", "needs_review", "expired",
               "rejected_page_kinds", "parse_errors", "official_count", "official_active_count", "completeness")


def build_registry(all_sources: list[dict], campaigns: list[dict], crawled_at: str | None, prev_registry=None,
                   source_reports: list[dict] | None = None) -> list[dict]:
    """Registry rows after a crawl. `campaigns` is the crawl output (fresh + stale-from-LKG records)."""
    prev = _previous(prev_registry)
    reports = {r.get("key"): r for r in (source_reports or []) if isinstance(r, dict)}
    fresh_by: dict[str, int] = {}
    for c in campaigns:
        if c.get("sourceKey") and not c.get("staleFromLastKnownGood") and c.get("sourceKind") != "user_private":
            fresh_by[c["sourceKey"]] = fresh_by.get(c["sourceKey"], 0) + 1
    rows = []
    for s in all_sources:
        code = s["key"]
        p = prev.get(code, {})
        active = is_active(s)
        fresh = fresh_by.get(code, 0) if active else 0
        ran = active and crawled_at is not None
        success_at = crawled_at if (ran and fresh > 0) else p.get("lastSuccessAt")
        rows.append({
            "sourceCode": code,
            "bankCode": s.get("bank_code"),
            "bank": s.get("bank"),
            "url": (s.get("listing_urls") or [None])[0],
            "sourceType": s.get("source_type", "official_campaign_listing"),
            "adapter": s.get("adapter", "generic_html_v1") if active else s.get("adapter"),
            "enabled": active,
            "cadence": s.get("cadence", "scheduled_twice_daily"),
            "priority": s.get("priority", 100),
            "lastCrawlAt": crawled_at if ran else p.get("lastCrawlAt"),
            "lastSuccessAt": success_at,
            "lastVerifiedAt": success_at,
            "freshCount": fresh if ran else p.get("freshCount", 0),
            "health": _health(fresh, reports.get(code)) if ran else ("disabled" if not active else p.get("health", "never_run")),
            "sourceVerifiedAt": s.get("source_verified_at"),
            "metrics": ({k: reports[code].get(k) for k in METRIC_KEYS} if (ran and code in reports) else p.get("metrics")),
        })
    return rows


def _health(fresh: int, report: dict | None) -> str:
    if fresh <= 0:
        return "zero"
    if ((report or {}).get("completeness") or {}).get("status") == "incomplete":
        return "incomplete"
    return "ok"


def apply_guard_status(registry: list[dict], report: dict, prev_registry=None) -> list[dict]:
    """After the quality guard: degraded sources that were repaired from LKG keep their previous lastSuccessAt."""
    prev = _previous(prev_registry)
    repaired = {r["key"] for r in report.get("repairedSources", [])}
    out = []
    for row in registry or []:
        r = dict(row)
        status = (report.get("sources") or {}).get(r["sourceCode"], {}).get("status")
        if r["sourceCode"] in repaired:
            r["health"] = "repaired_from_lkg"
            r["lastSuccessAt"] = prev.get(r["sourceCode"], {}).get("lastSuccessAt")
            r["lastVerifiedAt"] = r["lastSuccessAt"]
            if isinstance(r.get("metrics"), dict):
                comp = dict(r["metrics"].get("completeness") or {})
                comp.update(status="partial" if comp.get("status") == "complete" else comp.get("status", "unknown"), confidence="low")
                comp["reasons"] = list(comp.get("reasons") or []) + ["Kaynak bu taramada son başarılı kayıtlardan onarıldı."]
                r["metrics"] = {**r["metrics"], "completeness": comp}
        elif status in {"severe_drop", "zero"} and r.get("enabled"):
            r["health"] = status
        out.append(r)
    return out
