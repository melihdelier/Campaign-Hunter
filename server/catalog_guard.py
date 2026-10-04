#!/usr/bin/env python3
"""Catalog last-known-good (LKG) + quality gate for the GitHub Actions crawl.

GitHub Actions starts every run from a clean checkout, so the crawler had no previous
catalog to fall back on. This script fixes that and decides whether a fresh crawl is
publishable.

  python server/catalog_guard.py fetch-lkg
      Before the crawl: fetch the current production catalog (Supabase snapshot via the
      public publishable key, and the deployed GitHub Pages catalog), pick the newest valid
      one, save it as server/data/catalog_lkg.json and seed server/data/catalog.json so the
      crawler's per-URL / per-source last-known-good fallback works.

  python server/catalog_guard.py evaluate --crawl-outcome success|failure
      After the crawl: compare the new catalog with the LKG and write the final catalog to
      server/data/catalog.json plus a verdict in server/data/catalog_guard.json:
        ok        -> publish the new crawl as is
        repaired  -> some previously healthy sources collapsed; their LKG records are kept,
                     healthy sources use fresh data; publish the repaired catalog
        rejected  -> crawl clearly degraded/failed; keep the LKG catalog, do not publish to
                     Supabase (the deployed static catalog stays the LKG)
      Eligibility schema (v1.4.2): every campaign that carries `eligibilityRule`/`rewardVariants` must have
      `eligibilitySchemaVersion` 1 and a valid rule (server/eligibility_schema.py). An invalid fresh record is
      dropped, never published and never re-read through its legacy fields; its LKG record (same id or
      sourceUrl, itself valid and unexpired) is kept instead. Invalid records found in the LKG are dropped too.
      This happens before source health is measured, so a source whose rules all broke is repaired from LKG.
      If NO last-known-good could be obtained, the gate fails closed: nothing is published and
      the deploy is blocked (deploy=false), so the existing Pages site and Supabase snapshot stay
      untouched. Only an explicit first-bootstrap override (CATALOG_GUARD_ALLOW_BOOTSTRAP=1, set by
      the manual workflow_dispatch input "allow_bootstrap") allows publishing without an LKG.

Only the Python standard library is used. No secret is needed (read uses the publishable key).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

try:  # works both as `python server/catalog_guard.py` and as an imported module in tests
    import eligibility_schema as es
    import source_registry
    import card_eligibility
except ImportError:  # pragma: no cover
    from server import eligibility_schema as es
    from server import source_registry
    from server import card_eligibility

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
CATALOG_FILE = DATA_DIR / "catalog.json"
LKG_FILE = DATA_DIR / "catalog_lkg.json"
VERDICT_FILE = DATA_DIR / "catalog_guard.json"
CONFIG_FILE = ROOT / "source_catalog.json"

try:
    from zoneinfo import ZoneInfo
    TR_TZ = ZoneInfo("Europe/Istanbul")
except Exception:  # tzdata yoksa: Türkiye 2016'dan beri sabit UTC+3
    TR_TZ = timezone(timedelta(hours=3))

# Thresholds (conservative; tuned for ~50-150 campaign catalogs)
MIN_HEALTHY_BASELINE = 1        # any source with >= 1 valid LKG record counts as previously observed/healthy
SOURCE_SEVERE_DROP_MIN_BASE = 5 # severe per-source drop is only judged with a baseline of >= 5
SOURCE_SEVERE_DROP_RATIO = 0.40 # fresh < 40% of baseline -> severe drop
TOTAL_MIN_BASE = 10             # total drop judged only with a baseline of >= 10
TOTAL_SEVERE_DROP_RATIO = 0.50  # total fresh < 50% of baseline -> reject
DEGRADED_SOURCE_SHARE = 0.50    # >= 50% of healthy sources degraded (and >= 2) -> reject

BOOTSTRAP_ENV = "CATALOG_GUARD_ALLOW_BOOTSTRAP"

INVALID_RULE_WARNING = ("Taramada bu kampanyanın uygunluk kuralı geçersiz/desteklenmeyen şema sürümündeydi; "
                        "geçersiz kayıt yayınlanmadı, son başarılı (yayındaki) kayıt korunuyor.")
STALE_WARNING = "Bu kaynak bu taramada sağlıklı sonuç vermedi; son başarılı (yayındaki) katalog kaydı korunuyor."


# ----------------------------------------------------------------------------- helpers
def today_tr() -> str:
    return datetime.now(TR_TZ).date().isoformat()


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def is_valid_catalog(c) -> bool:
    return (isinstance(c, dict) and isinstance(c.get("campaigns"), list) and len(c["campaigns"]) > 0
            and not (c.get("meta") or {}).get("partial") and not (c.get("meta") or {}).get("bootstrap"))


def gen_at(c) -> str:
    return str((c or {}).get("generatedAt") or "")


def source_keys() -> list[str]:
    """Only crawlable (enabled + adapter) sources are judged for health; disabled registry rows never are."""
    try:
        return [s["key"] for s in source_registry.active_sources(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))]
    except Exception:
        return []


def bank_code_by_source() -> dict:
    try:
        return {s["key"]: s.get("bank_code") for s in json.loads(CONFIG_FILE.read_text(encoding="utf-8"))}
    except Exception:
        return {}


def not_expired(c: dict, today: str) -> bool:
    end = c.get("endDate")
    return not end or str(end) >= today


def by_source(campaigns: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for c in campaigns:
        k = c.get("sourceKey")
        if k and c.get("sourceKind") != "user_private":
            out.setdefault(k, []).append(c)
    return out


def http_json(url: str, headers: dict | None = None, timeout: int = 25):
    req = Request(url, headers={"User-Agent": "CampaignHunter-CatalogGuard/1.0", "Accept": "application/json", **(headers or {})})
    with urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def pages_catalog_url() -> str:
    explicit = os.environ.get("PAGES_CATALOG_URL", "").strip()
    if explicit:
        return explicit
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if "/" in repo:
        owner, name = repo.split("/", 1)
        return f"https://{owner.lower()}.github.io/{name}/data/catalog.json"
    return ""


# v1.5.0: GitHub Actions raporlaması (adım özeti + ::error/::warning açıklamaları) yalnız GERÇEK kapı çalışmasında.
# Birim testleri, bilinçli olarak reddedilen/bootstrap senaryolarını çalıştırırken CATALOG_GUARD_ACTIONS_REPORTING=0
# ayarlar; böylece başarılı test işinin özeti "rejected" gibi üretim mesajlarıyla kirlenmez. Üretimde değişken yoktur.
ACTIONS_REPORTING_ENV = "CATALOG_GUARD_ACTIONS_REPORTING"


def actions_reporting() -> bool:
    return os.environ.get(ACTIONS_REPORTING_ENV, "1").strip() != "0"


def annotate(level: str, message: str) -> None:
    """Workflow command in production; plain log line when Actions reporting is disabled (tests)."""
    print(f"::{level}::{message}" if actions_reporting() else f"{level.upper()}: {message}")


def gh_output(**kv) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


def gh_summary(text: str) -> None:
    if not actions_reporting():
        return
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")


# ----------------------------------------------------------------------------- fetch-lkg
def fetch_candidates() -> list[tuple[str, dict]]:
    found: list[tuple[str, dict]] = []
    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY") or os.environ.get("SUPABASE_ANON_KEY") or ""
    if url and key:
        try:
            rows = http_json(f"{url}/rest/v1/catalog_snapshots?id=eq.1&select=payload,updated_at&limit=1", {"apikey": key})
            payload = rows[0]["payload"] if rows else None
            if is_valid_catalog(payload):
                found.append(("supabase", payload))
            else:
                print("LKG: Supabase snapshot boş/geçersiz.")
        except Exception as e:
            print(f"LKG: Supabase snapshot alınamadı: {type(e).__name__}: {e}")
    pages = pages_catalog_url()
    if pages:
        try:
            payload = http_json(pages)
            if is_valid_catalog(payload):
                found.append(("pages", payload))
            else:
                print("LKG: Pages kataloğu boş/geçersiz.")
        except Exception as e:
            print(f"LKG: Pages kataloğu alınamadı: {type(e).__name__}: {e}")
    return found


def cmd_fetch_lkg() -> int:
    candidates = fetch_candidates()
    if not candidates:
        print("LKG bulunamadı; tarama önceki katalog olmadan çalışacak (kalite kapısı yalnız mutlak kontrolleri uygular).")
        LKG_FILE.unlink(missing_ok=True)
        return 0
    source, best = max(candidates, key=lambda x: gen_at(x[1]))
    best = dict(best)
    best.setdefault("meta", {})
    best["meta"] = {**best["meta"], "lkgSource": source}
    write_json(LKG_FILE, best)
    write_json(CATALOG_FILE, best)  # crawler 'old' fallback'ini besler
    print(f"LKG: {source} · {len(best['campaigns'])} kampanya · generatedAt={gen_at(best)}")
    return 0


# ----------------------------------------------------------------------------- evaluate
def mark_stale(c: dict) -> dict:
    s = dict(c)
    s["staleFromLastKnownGood"] = True
    s["decisionWarnings"] = list(dict.fromkeys((s.get("decisionWarnings") or []) + [STALE_WARNING]))
    return s


def split_by_eligibility(campaigns: list[dict], master: dict) -> tuple[list[dict], list[dict], list[dict]]:
    """-> (valid_or_legacy, invalid_entries, warning_entries)."""
    keep, bad, warn = [], [], []
    for c in campaigns:
        v = es.validate_campaign(c, master)
        if v["warnings"]:
            warn.append({"id": c.get("id"), "sourceKey": c.get("sourceKey"), "warnings": v["warnings"]})
        if v["status"] == "invalid":
            bad.append({"campaign": c, "id": c.get("id"), "sourceKey": c.get("sourceKey"), "sourceUrl": c.get("sourceUrl"),
                        "errors": v["errors"]})
        else:
            keep.append(c)
    return keep, bad, warn


def bootstrap_allowed() -> bool:
    return os.environ.get(BOOTSTRAP_ENV, "").strip().lower() in {"1", "true", "yes"}


def evaluate(new: dict | None, lkg: dict | None, crawl_ok: bool, today: str | None = None, keys: list[str] | None = None,
             allow_bootstrap: bool = False, master: dict | None = None) -> tuple[dict | None, dict]:
    """Return (final_catalog_or_None, report). final None means nothing may be deployed (report['deploy'] is False)."""
    today = today or today_tr()
    keys = keys if keys is not None else source_keys()
    master = master if master is not None else es.load_master()
    report: dict = {"verdict": "ok", "publish": True, "deploy": True, "reasons": [], "sources": {}, "repairedSources": [],
                    "baselineGeneratedAt": gen_at(lkg) or None, "baseline": "lkg" if is_valid_catalog(lkg) else "none",
                    "invalidEligibility": [], "eligibilityWarnings": [], "lkgInvalidEligibility": []}
    # Fail closed on eligibility schema: invalid LKG records are never re-published or restored either.
    if is_valid_catalog(lkg):
        lkg_keep, lkg_bad, _ = split_by_eligibility(lkg["campaigns"], master)
        if lkg_bad:
            report["lkgInvalidEligibility"] = [{k: b[k] for k in ("id", "sourceKey", "errors")} for b in lkg_bad]
            lkg = {**lkg, "campaigns": lkg_keep}
    # v1.5.0 (after the schema check, so invalid records are dropped, never "sanitised"): LKG records written before the per-campaign eligibility model carry SOURCE-assumed cards; they are
    # re-derived from their own text before they can be restored (never re-published with the old assumption).
    if is_valid_catalog(lkg):
        bank_by_src = bank_code_by_source()
        normalized = [card_eligibility.normalize_legacy_record(c, bank_by_src) for c in lkg["campaigns"]]
        if any(a is not b for a, b in zip(normalized, lkg["campaigns"])):
            lkg = {**lkg, "campaigns": normalized}
    have_lkg = is_valid_catalog(lkg)

    def reject(reason: str):
        report.update(verdict="rejected", publish=False, deploy=have_lkg)
        report["reasons"].append(reason)
        if not have_lkg:
            report["reasons"].append("Son başarılı katalog yok; yayın ve dağıtım engellendi (mevcut Pages/Supabase korunur).")
        return (lkg if have_lkg else None), report

    if not crawl_ok:
        return reject("Tarama adımı başarısız oldu.")
    if not isinstance(new, dict) or not isinstance(new.get("campaigns"), list):
        return reject("Yeni katalog bulunamadı/okunamadı.")
    if (new.get("meta") or {}).get("partial"):
        return reject("Yeni katalog yarım (partial) işaretli.")
    if have_lkg and gen_at(new) <= gen_at(lkg):
        return reject("Tarayıcı yeni bir katalog üretmedi (generatedAt değişmedi).")

    keep, invalid, warn = split_by_eligibility(new["campaigns"], master)
    report["eligibilityWarnings"] = warn
    report["invalidEligibility"] = [{k: b[k] for k in ("id", "sourceKey", "sourceUrl", "errors")} for b in invalid]
    new = {**new, "campaigns": keep}

    new_campaigns = [c for c in new["campaigns"] if c.get("sourceKind") != "user_private"]
    fresh = [c for c in new_campaigns if not c.get("staleFromLastKnownGood")]
    if not fresh:
        return reject("Taramada hiç taze kampanya yok.")

    if not have_lkg:
        if not allow_bootstrap:
            return reject("Son başarılı üretim kataloğu (Supabase/Pages) alınamadı; kurulu üretimde LKG olmadan yayın yapılmaz. "
                          f"İlk kurulum için workflow'u 'allow_bootstrap' girdisiyle elle çalıştır ({BOOTSTRAP_ENV}=1).")
        report["verdict"] = "bootstrap"
        report["reasons"].append("İlk kurulum (bootstrap) onayı ile son başarılı katalog olmadan yayın yapıldı; yalnız mutlak kontroller uygulandı.")
        final = dict(new)
        final["campaigns"] = [c for c in new["campaigns"] if not (c.get("staleFromLastKnownGood") and not not_expired(c, today))]
        if invalid:
            report["reasons"].append(f"Uygunluk kuralı geçersiz {len(invalid)} kampanya yayından çıkarıldı (LKG yok).")
        final["meta"] = {**(new.get("meta") or {}), "guard": {k: report[k] for k in ("verdict", "baseline", "reasons")}}
        return final, report

    base_by = {k: [c for c in v if not_expired(c, today)] for k, v in by_source(lkg["campaigns"]).items()}
    fresh_by = by_source(fresh)
    new_by = by_source(new_campaigns)
    all_keys = list(dict.fromkeys([*keys, *base_by.keys(), *fresh_by.keys()]))

    healthy, degraded = [], []
    for k in all_keys:
        b = len(base_by.get(k, []))
        f = len(fresh_by.get(k, []))
        info = {"baseline": b, "fresh": f, "status": "ok"}
        if b >= MIN_HEALTHY_BASELINE:
            healthy.append(k)
            if f == 0:
                info["status"] = "zero"
            elif b >= SOURCE_SEVERE_DROP_MIN_BASE and f < b * SOURCE_SEVERE_DROP_RATIO:
                info["status"] = "severe_drop"
            if info["status"] != "ok":
                degraded.append(k)
        elif b == 0 and f == 0:
            info["status"] = "never_healthy"
        report["sources"][k] = info

    # v1.5.0 completeness: the crawler's per-source evidence. LKG equality is NOT completeness — a source whose fresh count
    # equals its baseline is still reported incomplete when its own discovery/parse evidence shows a gap.
    reports_by = {r.get("key"): r for r in ((new.get("meta") or {}).get("source_reports") or []) if isinstance(r, dict)}
    report["incompleteSources"] = []
    for k, info in report["sources"].items():
        comp = (reports_by.get(k) or {}).get("completeness")
        if comp:
            info["completeness"] = comp
            if comp.get("status") == "incomplete":
                report["incompleteSources"].append(k)

    total_base = sum(len(v) for v in base_by.values())
    total_fresh = len(fresh)
    report["totals"] = {"baseline": total_base, "fresh": total_fresh}
    if total_base >= TOTAL_MIN_BASE and total_fresh < total_base * TOTAL_SEVERE_DROP_RATIO:
        return reject(f"Toplam taze kampanya sayısı ciddi düştü ({total_fresh} < %{int(TOTAL_SEVERE_DROP_RATIO*100)} × {total_base}).")
    if len(degraded) >= max(2, math.ceil(len(healthy) * DEGRADED_SOURCE_SHARE)):
        return reject(f"Önceden sağlıklı kaynakların çoğu bozuldu: {', '.join(degraded)}.")

    # Repair: affected sources keep their LKG records (unexpired), plus any fresh records they did produce.
    final_campaigns: list[dict] = []
    for c in new["campaigns"]:
        k = c.get("sourceKey")
        if k in degraded and c.get("staleFromLastKnownGood"):
            continue  # will be re-added from LKG below (single source of truth)
        if c.get("staleFromLastKnownGood") and not not_expired(c, today):
            continue  # do not resurrect expired stale records
        final_campaigns.append(c)
    present_urls = {c.get("sourceUrl") for c in final_campaigns if c.get("sourceUrl")}
    present_ids = {c.get("id") for c in final_campaigns}
    for k in degraded:
        restored = 0
        for c in base_by.get(k, []):
            if (c.get("sourceUrl") and c.get("sourceUrl") in present_urls) or c.get("id") in present_ids:
                continue
            final_campaigns.append(mark_stale(c)); restored += 1
        report["repairedSources"].append({"key": k, "status": report["sources"][k]["status"], "restored": restored,
                                          "baseline": report["sources"][k]["baseline"], "fresh": report["sources"][k]["fresh"]})
    # Invalid fresh records: keep their LKG record (by id or sourceUrl) if not already present.
    present_urls = {c.get("sourceUrl") for c in final_campaigns if c.get("sourceUrl")}
    present_ids = {c.get("id") for c in final_campaigns}
    lkg_by_id = {c.get("id"): c for c in lkg["campaigns"] if not_expired(c, today)}
    lkg_by_url = {c.get("sourceUrl"): c for c in lkg["campaigns"] if c.get("sourceUrl") and not_expired(c, today)}
    for entry, b in zip(report["invalidEligibility"], invalid):
        prev = lkg_by_id.get(b["id"]) or (lkg_by_url.get(b["sourceUrl"]) if b["sourceUrl"] else None)
        if prev is None or prev.get("id") in present_ids or (prev.get("sourceUrl") and prev.get("sourceUrl") in present_urls):
            entry["restoredFromLkg"] = bool(prev is not None and (prev.get("id") in present_ids or prev.get("sourceUrl") in present_urls))
            continue
        restored = mark_stale(prev)
        restored["decisionWarnings"] = list(dict.fromkeys(restored["decisionWarnings"] + [INVALID_RULE_WARNING]))
        final_campaigns.append(restored)
        present_ids.add(prev.get("id"))
        if prev.get("sourceUrl"):
            present_urls.add(prev["sourceUrl"])
        entry["restoredFromLkg"] = True
    if invalid:
        report["verdict"] = "repaired"
        restored_n = sum(1 for e in report["invalidEligibility"] if e.get("restoredFromLkg"))
        report["reasons"].append(f"Uygunluk kuralı geçersiz {len(invalid)} kampanya yayınlanmadı; {restored_n} tanesi için son başarılı kayıt korundu.")
    if degraded:
        report["verdict"] = "repaired"
        report["reasons"].append("Önceden sağlıklı kaynak(lar) sıfır/ciddi düşüş verdi; bu kaynaklar için son başarılı kayıtlar korundu: " + ", ".join(degraded))

    if report["incompleteSources"]:
        report["reasons"].append("Tamlık kanıtı eksik kaynak(lar) (aday/çözümlenen farkı; LKG eşitliği tamlık sayılmaz): "
                                 + ", ".join(report["incompleteSources"]))
    final = dict(new)
    final["campaigns"] = sorted(final_campaigns, key=lambda c: (c.get("bank", ""), c.get("endDate") or "9999-99-99", c.get("title", "")))
    meta = dict(new.get("meta") or {})
    meta["campaign_count"] = len(final["campaigns"])
    if meta.get("sourceRegistry"):
        meta["sourceRegistry"] = source_registry.apply_guard_status(meta["sourceRegistry"], report, (lkg.get("meta") or {}).get("sourceRegistry"))
    meta["guard"] = {"verdict": report["verdict"], "baselineGeneratedAt": report["baselineGeneratedAt"],
                     "repairedSources": [r["key"] for r in report["repairedSources"]], "reasons": report["reasons"],
                     "invalidEligibility": [e["id"] for e in report["invalidEligibility"]],
                     "incompleteSources": list(report.get("incompleteSources") or [])}
    final["meta"] = meta
    return final, report


def cmd_evaluate(crawl_outcome: str) -> int:
    new = load_json(CATALOG_FILE)
    lkg = load_json(LKG_FILE)
    final, report = evaluate(new, lkg, crawl_ok=(crawl_outcome == "success"), allow_bootstrap=bootstrap_allowed())
    if final is not None:
        if report["verdict"] == "rejected":
            final = dict(final)
            final["meta"] = {**(final.get("meta") or {}), "guard": {"verdict": "rejected", "reasons": report["reasons"], "rejectedAt": datetime.now(timezone.utc).isoformat()}}
        write_json(CATALOG_FILE, final)
    else:
        # No LKG and nothing publishable: do not leave a broken/partial file for the copy step.
        CATALOG_FILE.unlink(missing_ok=True)
    write_json(VERDICT_FILE, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    gh_output(verdict=report["verdict"], publish=str(report["publish"]).lower(), deploy=str(report["deploy"]).lower())
    lines = [f"### Katalog kalite kapısı: `{report['verdict']}`", ""]
    lines += [f"- {r}" for r in report["reasons"]] or ["- Sorun yok."]
    if report.get("sources"):
        lines += ["", "| Kaynak | Önceki | Taze | Durum | Tamlık |", "|---|---|---|---|---|"]
        lines += [f"| {k} | {v['baseline']} | {v['fresh']} | {v['status']} | {(v.get('completeness') or {}).get('status', '-')}/{(v.get('completeness') or {}).get('confidence', '-')} |" for k, v in report["sources"].items()]
    src_reports = ((new or {}).get("meta") or {}).get("source_reports") or []
    if src_reports:
        lines += ["", "**Kaynak tamlığı (bu tarama; LKG eşitliği tamlık kanıtı değildir):**", "",
                  "| Kaynak | Yöntem | Aday | Detay URL | Aktif | Çözülen | Kısmi | Çözülemeyen/inceleme | Süresi dolmuş/ret | Ayrıştırma hatası | Resmi sayı | Güven |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in src_reports:
            comp = r.get("completeness") or {}
            rejected = sum((r.get("rejected_page_kinds") or {}).values())
            lines.append(f"| {r.get('key')} | {r.get('mechanism', '-')} | {r.get('listing_candidates', 0) + r.get('sitemap_candidates', 0)} | "
                         f"{r.get('discovered_detail_urls', '-')} | {r.get('active', '-')} | {r.get('resolved', 0)} | {r.get('partial', 0)} | "
                         f"{r.get('unresolved', 0) + r.get('needs_review', 0)} | {r.get('expired', 0)}/{rejected} | {r.get('parse_errors', 0)} | "
                         f"{r.get('official_count') if r.get('official_count') is not None else '-'} | {comp.get('status', '-')}/{comp.get('confidence', '-')} |")
    if report.get("invalidEligibility"):
        lines += ["", "**Geçersiz uygunluk kuralı (yayınlanmadı):**"]
        lines += [f"- `{e['id']}` ({e['sourceKey']}): {'; '.join(e['errors'][:3])}" for e in report["invalidEligibility"]]
    if report.get("eligibilityWarnings"):
        lines += ["", "**Uygunluk kuralı uyarıları (ana veride olmayan kod; etkisiz):**"]
        lines += [f"- `{w['id']}`: {'; '.join(w['warnings'][:3])}" for w in report["eligibilityWarnings"]]
    gh_summary("\n".join(lines))
    if report["verdict"] == "rejected":
        annotate("error", f"Katalog kalite kapısı yeni taramayı reddetti: {' '.join(report['reasons'])}")
    elif report["verdict"] in {"repaired", "bootstrap"}:
        annotate("warning", f"Katalog onarıldı: {' '.join(report['reasons'])}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch-lkg")
    ev = sub.add_parser("evaluate")
    ev.add_argument("--crawl-outcome", default="success")
    a = ap.parse_args(argv)
    if a.cmd == "fetch-lkg":
        return cmd_fetch_lkg()
    return cmd_evaluate(a.crawl_outcome)


if __name__ == "__main__":
    raise SystemExit(main())
