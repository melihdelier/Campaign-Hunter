"""Shared helper: run the REAL crawler pipeline (_refresh_catalog_impl) offline against reviewed fixtures.

Used by test_discovery_v15.py and by tools/gen-giyim-fixture.py (which writes web/fixtures/giyim-regression.v1.json so
the JS locked regression evaluates genuine crawler output).
"""
from __future__ import annotations

import copy
import json
import sys
import tempfile
from datetime import date
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import campaign_crawler as cc  # noqa: E402

FIX = HERE / "fixtures" / "discovery_v15"
TODAY = date(2026, 10, 4)


class FakeHTTPError(Exception):
    pass


def _f(name: str) -> bytes:
    return (FIX / name).read_bytes()


ROUTES = {
    # Wings official JSON API + server-rendered program pages
    "https://www.wingscard.com.tr/api/campaign/list?page=1": "wings_api_p1.json",
    "https://www.wingscard.com.tr/api/campaign/list?page=2": "wings_api_p2.json",
    # TEB: client-rendered listing (no links) + official sitemap
    "https://www.teb.com.tr/sizin-icin/kampanyalar/?cat=Kredi+Kartı": "teb_listing.html",
    "https://www.teb.com.tr/sitemap.xml": "teb_sitemap.xml",
    # Current official detail page (terms read 2026-10, see docs/RELEASE_v1.5.0.md).
    "https://www.teb.com.tr/sizin-icin/giyim-alisveris": "teb_giyim_alisveris.html",
    "https://www.teb.com.tr/sizin-icin/giyim-500": "teb_giyim_500_expired.html",
    "https://www.teb.com.tr/sizin-icin/kredi-kartlari": "teb_product_nav.html",
    "https://www.teb.com.tr/sizin-icin/yurtdisi-indirim": "teb_yurtdisi.html",
    # Maximiles: official sitemap incl. hubs
    "https://www.maximiles.com.tr/sitemap.xml": "maximiles_sitemap.xml",
    "https://www.maximiles.com.tr/kampanyalar/mercedescard-kampanyalari": "maximiles_hub_mercedescard.html",
    "https://www.maximiles.com.tr/kampanyalar/giyim-aksesuar": "maximiles_hub_giyim.html",
    "https://www.maximiles.com.tr/kampanyalar/taksitlendirme-ve-erteleme-firsatlari": "maximiles_hub_taksit.html",
    "https://www.maximiles.com.tr/kampanyalar/mercedescard-a-ozel-giyim-750-tl-maxipuan": "maximiles_mercedescard_giyim.html",
    "https://www.maximiles.com.tr/kampanyalar/kitap-100-tl-maxipuan": "maximiles_unknown_card.html",
    # Miles&Smiles QNB: static listing
    "https://milesandsmilesqnb.com.tr/kampanyalar": None,  # built below
    "https://milesandsmilesqnb.com.tr/kampanyalar/giyim-ve-kozmetik-alisverisinize-2000e-varan-mil-hediye-2014": "qnb_giyim_2000.html",
}
for i in range(10):
    ROUTES[f"https://www.wingscard.com.tr/kampanyalar/wings-kampanya-{i}"] = f"wings_detail_{i}.html"

QNB_LISTING = ('<html><head><title>Kampanyalar</title></head><body><h1>Kampanyalar</h1>'
               '<a href="/kampanyalar/giyim-ve-kozmetik-alisverisinize-2000e-varan-mil-hediye-2014">Giyim</a></body></html>').encode()
WINGS_CORE = ('<html><head><title>Tüm Restoranlarda %15’e Varan İndirim</title></head><body><h1>Tüm Restoranlarda %15’e Varan İndirim</h1>'
              '<p>Wings ile tüm dünyadaki restoran harcamalarında %15’e varan, ayda 2.500 TL’ye kadar indirim. Bankacılık ve kart ayrıcalıklarından yararlanmak için Wings Programları’na katılın.</p></body></html>').encode()


# Retired URL: the old giyim detail now redirects to the campaign LISTING (a hub). The sitemap fixture still lists it,
# so the pipeline must follow the redirect and reject the listing instead of emitting a campaign.
REDIRECTS = {
    "https://www.teb.com.tr/sizin-icin/giyim-alisverislerinize-bonus": ("https://www.teb.com.tr/sizin-icin/kampanyalar/?cat=Kredi+Kartı", "teb_listing.html"),
}


def fake_fetch(url: str, timeout: int = 12):
    u = cc.canonical_url(url) if "api/campaign" not in url and "?cat=" not in url else url
    if u in REDIRECTS:
        final, name = REDIRECTS[u]
        return cc.FetchResult(final, _f(name), "text/html")
    if url == "https://milesandsmilesqnb.com.tr/kampanyalar":
        return cc.FetchResult(url, QNB_LISTING, "text/html")
    if u == "https://www.wingscard.com.tr/ayricaliklar/tum-restoranlarda-15e-varan-indirim":
        return cc.FetchResult(url, WINGS_CORE, "text/html")
    name = ROUTES.get(url) or ROUTES.get(u)
    if not name:
        raise FakeHTTPError(f"404 {url}")
    return cc.FetchResult(url, _f(name), "application/json" if name.endswith(".json") else "text/html")


def fixture_sources(extra: dict | None = None) -> list[dict]:
    """The real reviewed source rows, trimmed to what the fixtures cover (no network)."""
    rows = {s["key"]: copy.deepcopy(s) for s in cc.load_all_sources()}
    wings = rows["wings"]; wings["listing_urls"] = []
    teb = rows["teb_general"]
    maxi = rows["maximiles"]; maxi["listing_urls"] = []; maxi["category_listing_urls"] = []; maxi["fallback_urls"] = []
    qms = rows["qnb_ms"]; qms["fallback_urls"] = []
    out = [wings, teb, maxi, qms]
    for s in out:
        s.update(extra or {})
    return out


def run_pipeline(sources: list[dict], old_catalog: dict | None = None, env: dict | None = None) -> dict:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        catalog = root / "catalog.json"
        if old_catalog is not None:
            catalog.write_text(json.dumps(old_catalog, ensure_ascii=False), encoding="utf-8")
        with patch.object(cc, "CATALOG_FILE", catalog), patch.object(cc, "STAGING_FILE", root / "staging.json"), \
             patch.object(cc, "STATUS_FILE", root / "status.json"), patch.object(cc, "RAW_DIR", root / "raw"), \
             patch.object(cc, "DATA_DIR", root), patch.object(cc, "load_config", return_value=sources), \
             patch.object(cc, "fetch", side_effect=fake_fetch), patch.object(cc, "today_tr", return_value=TODAY), \
             patch.dict("os.environ", env or {}, clear=False):
            return cc._refresh_catalog_impl(max_per_source=90)


VOLATILE = ("verifiedAt",)


def stable_campaigns(payload: dict) -> list[dict]:
    out = []
    for c in payload["campaigns"]:
        c = {k: v for k, v in c.items() if k not in VOLATILE}
        out.append(c)
    return sorted(out, key=lambda c: c.get("id", ""))
