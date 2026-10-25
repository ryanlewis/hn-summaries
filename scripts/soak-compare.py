# Soak check: compare the VM's and the Worker's points feeds (on-list stories at or above
# the 300-point gate, then GUIDs and summary length). Usage: python3 scripts/soak-compare.py [-v]
import re, sys, urllib.request, html, datetime, json
def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"user-agent": "soak-compare"}), timeout=30).read().decode()
def items(xml):
    out = {}
    for m in re.finditer(r"<item>(.*?)</item>", xml, re.S):
        it = m.group(1)
        g = re.search(r"<guid[^>]*>([^<]+)</guid>", it).group(1)
        t = re.search(r"<title><!\[CDATA\[(.*?)\]\]></title>", it, re.S).group(1)
        pts = int(re.search(r"· (\d+) points ·", it).group(1))
        body = re.search(r"<description><!\[CDATA\[(.*?)\]\]></description>", it, re.S).group(1)
        paras = [html.unescape(re.sub("<[^>]+>", "", p)) for p in re.findall(r"<p>(.*?)</p>", body, re.S)]
        summ = " ".join(p for p in paras if not p.startswith(("📊", "👉", "(Article unavailable")) and " points · " not in p)
        out[g] = dict(title=t, points=pts, summary=summ)
    return out
vm = items(get("https://hn.rlew.io/feed?sort=points&count=200"))
wk = items(get("https://hn-summaries.ryan-9f5.workers.dev/feed?sort=points&count=200"))
gate = 300
vmg = {g for g, v in vm.items() if v["points"] >= gate}
wkg = {g for g, v in wk.items() if v["points"] >= gate}
both = vmg & wkg
r = dict(at=datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%d %H:%M UTC"), vm_onlist=len(vm), worker_onlist=len(wk),
         vm_above_gate=len(vmg), worker_above_gate=len(wkg), common=len(both),
         only_vm=sorted((vm[g]["title"][:50], vm[g]["points"]) for g in vmg - wkg),
         only_worker=sorted((wk[g]["title"][:50], wk[g]["points"]) for g in wkg - vmg))
wc = lambda s: len(s.split())
r["median_words"] = dict(vm=sorted(wc(vm[g]["summary"]) for g in both)[len(both)//2] if both else None,
                         worker=sorted(wc(wk[g]["summary"]) for g in both)[len(both)//2] if both else None)
print(json.dumps(r, ensure_ascii=False))
if "-v" in sys.argv:
    for g in sorted(both)[:4]:
        print("\n##", vm[g]["title"]); print("VM:", vm[g]["summary"][:500]); print("WK:", wk[g]["summary"][:500])
