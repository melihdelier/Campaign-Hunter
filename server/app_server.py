#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import unicodedata
from difflib import SequenceMatcher
import json
import mimetypes
from pathlib import Path
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from datetime import datetime

from campaign_crawler import (
    refresh_catalog, load_catalog, STATUS_FILE, atomic_json, generic_parse,
    RefreshAlreadyRunning,
)

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DATA = Path(__file__).resolve().parent / "data"
CUSTOM_FILE = DATA / "custom_campaigns.json"
HOST = "127.0.0.1"
PORT = 8765
LOCK = threading.Lock()
VERSION_FILE = ROOT / "VERSION.txt"


def app_version() -> str:
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip() or "unknown"
    except Exception:
        return "unknown"


def read_json(path: Path, fallback):
    try: return json.loads(path.read_text(encoding="utf-8"))
    except Exception: return fallback


def custom_campaigns():
    return read_json(CUSTOM_FILE, {"campaigns":[]}).get("campaigns",[])


def full_catalog():
    base=load_catalog()
    items=list(base.get("campaigns",[]))+custom_campaigns()
    return {**base,"campaigns":items,"meta":{**base.get("meta",{}),"campaign_count":len(items),"custom_count":len(custom_campaigns())}}




TR_FOLD = str.maketrans({"ç":"c","ğ":"g","ı":"i","ö":"o","ş":"s","ü":"u","Ç":"c","Ğ":"g","İ":"i","I":"i","Ö":"o","Ş":"s","Ü":"u"})
DUP_STOP = {"kampanya","kampanyasi","kampanyası","indirim","firsat","fırsat","ile","icin","için","varan","ozel","özel","tl","ve","de","da","te","ta","bir","bu","yapacaginiz","yapacağınız","harcama","harcamalarinizda","harcamalarınızda"}


def _fold(s: str) -> str:
    s=(s or "").translate(TR_FOLD).lower()
    s=unicodedata.normalize("NFKD",s)
    s="".join(ch for ch in s if not unicodedata.combining(ch))
    s=re.sub(r"[^a-z0-9]+"," ",s)
    return re.sub(r"\s+"," ",s).strip()


def _tokens(s: str) -> set[str]:
    return {x for x in _fold(s).split() if len(x)>2 and x not in DUP_STOP}


def _jaccard(a: set[str], b: set[str]) -> float:
    return (len(a & b) / len(a | b)) if a and b else 0.0


def _merchant_values(c: dict) -> set[str]:
    scope=c.get("merchantScope") or {}
    return {_fold(x) for x in (scope.get("values") or []) if _fold(x)}


def duplicate_candidates(bank: str, card_ids: list[str], title: str, text: str, campaigns: list[dict], limit: int = 3) -> list[dict]:
    """Find likely duplicates before a user-private campaign is persisted.

    This intentionally errs on the side of *warning*, not automatic rejection.
    The user makes the final same/different decision.
    """
    query_title=_fold(title)
    query_blob=_fold((title or "")+" "+(text or ""))
    q_tokens=_tokens((title or "")+" "+(text or ""))
    q_title_tokens=_tokens(title or text[:180])
    q_cards=set(card_ids or [])
    out=[]
    for c in campaigns:
        if bank and c.get("bank") and _fold(bank)!=_fold(c.get("bank")):
            continue
        c_cards=set(c.get("cardProductIds") or [])
        if q_cards and c_cards and not (q_cards & c_cards):
            continue
        c_title=c.get("title") or ""
        c_summary=c.get("termsSummary") or ""
        c_title_fold=_fold(c_title)
        title_seq=SequenceMatcher(None, query_title or _fold(text[:160]), c_title_fold).ratio() if c_title_fold else 0.0
        title_j=_jaccard(q_title_tokens,_tokens(c_title))
        body_j=_jaccard(q_tokens,_tokens(c_title+" "+c_summary))
        contains=bool(c_title_fold and len(c_title_fold)>=8 and c_title_fold in query_blob)
        score=max(title_seq*0.50 + title_j*0.25 + body_j*0.25, 0.93 if contains else 0.0)
        # Matching dates/categories/merchant make an already similar campaign more convincing.
        if score >= 0.35:
            qlow=_fold(text)
            if c.get("startDate") and _fold(str(c.get("startDate"))) in qlow: score+=0.03
            if c.get("endDate") and _fold(str(c.get("endDate"))) in qlow: score+=0.03
            merchants=_merchant_values(c)
            if merchants and any(m in query_blob for m in merchants): score+=0.08
        if score >= 0.52:
            out.append({
                "score": round(min(score,1.0),3),
                "id": c.get("id"), "bank": c.get("bank"), "title": c_title,
                "startDate": c.get("startDate"), "endDate": c.get("endDate"),
                "termsSummary": c_summary[:550], "sourceUrl": c.get("sourceUrl"),
                "sourceKind": c.get("sourceKind"), "categories": c.get("categories") or [],
            })
    out.sort(key=lambda x:x["score"], reverse=True)
    return out[:limit]


def build_custom_campaign(bank: str, card_ids: list[str], title: str, text: str) -> dict:
    source={"key":"custom","bank":bank,"card_products":card_ids}
    effective_title=title.strip()
    if not effective_title:
        # A pasted bank-app detail often starts with the campaign heading.
        first=next((x.strip() for x in text.splitlines() if 4 <= len(x.strip()) <= 140), "")
        effective_title=first[:140] or "Bana özel kampanya"
    html=(f"<h1>{effective_title}</h1><p>{text}</p>").encode("utf-8")
    from datetime import date
    c=generic_parse(source,"custom://manual/preview",html,date.today())
    if not c:
        c={"id":"custom-preview","bank":bank,"title":effective_title,"cardProductIds":card_ids,"categories":["all"],"merchantScope":{"kind":"all"},"startDate":None,"endDate":None,"status":"active","resetPolicy":"campaign","periodCap":None,"requiresEnrollment":False,"rewardRule":{"kind":"unknown","minSpend":0},"rewardUnit":"discount_try","transactionRules":{},"rulesComplete":False,"decisionWarnings":["Metin otomatik çözümlenemedi; alanları manuel doğrula."],"sourceKind":"user_private","sourceUrl":None,"verifiedAt":datetime.now().isoformat(),"termsSummary":text[:750]}
    c["sourceKind"]="user_private"; c["sourceUrl"]=None; c["title"]=effective_title
    return c

def status():
    return read_json(STATUS_FILE,{"state":"never_run","campaign_count":0,"error_count":0})


def json_response(h, code, obj):
    raw=json.dumps(obj,ensure_ascii=False).encode("utf-8")
    h.send_response(code); h.send_header("Content-Type","application/json; charset=utf-8"); h.send_header("Content-Length",str(len(raw))); h.send_header("Cache-Control","no-store"); h.end_headers(); h.wfile.write(raw)


def parse_body(h):
    n=int(h.headers.get("Content-Length","0") or 0); raw=h.rfile.read(n) if n else b"{}"
    return json.loads(raw.decode("utf-8"))


def _refresh_worker():
    try:
        refresh_catalog()
    except RefreshAlreadyRunning:
        # A scheduled/manual process is already doing the same refresh. Its status
        # file is shared, so the UI can simply keep following that run.
        pass
    except Exception as e:
        old=load_catalog()
        atomic_json(STATUS_FILE,{
            "state":"error", "stage":"failed", "error":f"{type(e).__name__}: {e}",
            "campaign_count":len(old.get("campaigns",[])), "error_count":1,
            "last_finished_at":datetime.now().astimezone().isoformat(),
        })
    finally:
        try: LOCK.release()
        except RuntimeError: pass


def start_refresh_background() -> bool:
    """Start one in-process refresh without blocking the HTTP request."""
    if not LOCK.acquire(blocking=False):
        return False
    threading.Thread(target=_refresh_worker, daemon=True, name="campaign-refresh").start()
    return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): return

    def do_GET(self):
        p=urlparse(self.path).path
        if p=="/api/catalog": return json_response(self,200,full_catalog())
        if p=="/api/status": return json_response(self,200,status())
        if p=="/api/version": return json_response(self,200,{"ok":True,"version":app_version()})
        if p=="/api/health": return json_response(self,200,{"ok":True,"version":app_version(),"time":datetime.now().isoformat()})
        if p=="/": p="/index.html"
        target=(WEB / p.lstrip("/")).resolve()
        if WEB.resolve() not in target.parents and target != WEB.resolve():
            self.send_error(403); return
        if not target.exists() or not target.is_file():
            self.send_error(404); return
        body=target.read_bytes(); ctype=mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200); self.send_header("Content-Type",ctype+(("; charset=utf-8") if ctype.startswith("text/") or "javascript" in ctype else "")); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-cache"); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        p=urlparse(self.path).path
        if p=="/api/refresh":
            if not start_refresh_background():
                return json_response(self,409,{"ok":True,"alreadyRunning":True,"error":"refresh_already_running",**status()})
            # Do not keep the browser waiting for a multi-minute crawl.
            return json_response(self,202,{"ok":True,"started":True,"status":status()})
        if p=="/api/custom-campaign":
            try:
                obj=parse_body(self)
                bank=obj.get("bank") or "Özel"
                card_ids=obj.get("cardProductIds") or []
                text=(obj.get("text") or "").strip()
                title=(obj.get("title") or "").strip()
                force_add=bool(obj.get("forceAdd"))
                if not text or not card_ids: return json_response(self,400,{"error":"text_and_card_required"})
                c=build_custom_campaign(bank,card_ids,title,text)
                matches=duplicate_candidates(bank,card_ids,c.get("title") or title,text,full_catalog().get("campaigns",[]))
                if matches and not force_add:
                    return json_response(self,409,{"ok":False,"error":"possible_duplicate","message":"Yüklemek istediğiniz kampanya sistemde olabilir.","candidateCampaigns":matches,"parsedCampaign":c})
                c["id"]="custom-"+str(int(time.time()*1000))
                c["verifiedAt"]=datetime.now().isoformat()
                cur=read_json(CUSTOM_FILE,{"campaigns":[]}); cur.setdefault("campaigns",[]).append(c); atomic_json(CUSTOM_FILE,cur)
                return json_response(self,200,{"ok":True,"campaign":c,"forcedAfterDuplicateWarning":force_add and bool(matches)})
            except Exception as e: return json_response(self,400,{"error":f"{type(e).__name__}: {e}"})
        self.send_error(404)


def background_initial_refresh():
    catalog=load_catalog()
    generated=catalog.get("generatedAt")
    fresh=False
    if generated:
        try:
            dt=datetime.fromisoformat(generated.replace("Z","+00:00"))
            age=(datetime.now(dt.tzinfo) - dt).total_seconds()
            fresh=age < 6*3600 and not catalog.get("meta",{}).get("bootstrap")
        except Exception:
            fresh=False
    if catalog.get("campaigns") and fresh: return
    start_refresh_background()


def scheduler_loop():
    last_key=None
    while True:
        now=datetime.now()
        if (now.hour,now.minute) in [(8,0),(18,0)]:
            key=now.strftime("%Y-%m-%d-%H:%M")
            if key!=last_key:
                if start_refresh_background(): last_key=key
        time.sleep(20)


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,default=PORT); ap.add_argument("--no-open",action="store_true"); ap.add_argument("--skip-initial-refresh",action="store_true"); args=ap.parse_args()
    if not args.skip_initial_refresh: threading.Thread(target=background_initial_refresh,daemon=True).start()
    threading.Thread(target=scheduler_loop,daemon=True).start()
    url=f"http://{HOST}:{args.port}"
    if not args.no_open: threading.Timer(1.0,lambda:webbrowser.open(url)).start()
    print(f"Banka Kampanya Avcısı {app_version()}: {url}")
    print("Kapatmak için Ctrl+C")
    ThreadingHTTPServer((HOST,args.port),Handler).serve_forever()

if __name__=="__main__": main()
