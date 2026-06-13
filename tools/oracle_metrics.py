#!/usr/bin/env python3
"""
oracle_metrics.py — aggregate Althemis oracle operating metrics.

The JSON files under data/ are *snapshots* (current pending jobs + current tier
state), not event history. The only complete event record is the oracle's
journald log. So this script parses the log as the source of truth and uses the
JSON snapshots only to mark still-pending Phase B jobs and report current tiers.

Usage:
    journalctl -u althemis-oracle --no-pager | python3 tools/oracle_metrics.py
    python3 tools/oracle_metrics.py --log oracle.log --data ./data
    python3 tools/oracle_metrics.py            # auto-runs journalctl itself

Metrics (the 4 the reviewer asked for):
  1. Phase A attestation distribution: VERIFIED / unverifiable / SLASHED
  2. No-contest rate: no_contest / (win + loss + no_contest) among settled Phase B
  3. Tier transitions: window closes and tier changes
  4. Quorum-failure frequency: retry / below-quorum events
"""
import sys, os, re, json, argparse, subprocess
from collections import Counter

JOB = re.compile(r"\[oracle\] job #(\d+):\s*(.*)")
TX  = re.compile(r"tx=(0x[0-9a-fA-F]+)")

def read_lines(args):
    if args.log:
        with open(args.log, encoding="utf-8", errors="replace") as f:
            return f.readlines()
    if not sys.stdin.isatty():
        return sys.stdin.readlines()
    # fallback: run journalctl ourselves
    out = subprocess.run(
        ["journalctl", "-u", "althemis-oracle", "--no-pager", "-q"],
        capture_output=True, text=True,
    )
    return out.stdout.splitlines()

def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def classify(rest):
    """Return (phaseA, phaseB, is_quorum_event) tags for the text after 'job #N:'."""
    a = b = None
    quorum = False
    low = rest.lower()
    if "attestation verified" in low:
        a = "verified"
    elif rest.startswith("SLASH") or "slash" in low:
        a = "slashed"
    elif "complete (unverifiable" in low:
        a = "unverifiable"
    if "complete (no_contest)" in low:
        b = "no_contest"
    else:
        m = re.search(r"complete \((win|loss)\)", low)
        if m:
            b = m.group(1)
        elif "complete" in low and "unverifiable" not in low and a != "slashed":
            # legacy "COMPLETE \u2713" format: settled but outcome kind not logged
            b = "complete?"
    if ("retry" in low or "below quorum" in low or "quorum fail" in low):
        quorum = True
    return a, b, quorum

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", help="read log from file instead of stdin/journalctl")
    ap.add_argument("--data", default="./data", help="path to data/ dir for snapshots")
    ap.add_argument("--min-job", type=int, default=0,
                    help="only count jobs with id >= N (drops pre-final-ruleset jobs)")
    args = ap.parse_args()

    lines = read_lines(args)

    jobs = {}            # jobId -> {phaseA, phaseB, tx_a, tx_b}
    quorum_events = 0
    tier_closes = 0
    tier_changes = 0

    for ln in lines:
        if "[tier] window closed" in ln:
            tier_closes += 1
            if "(was " in ln:
                tier_changes += 1
            continue
        m = JOB.search(ln)
        if not m:
            continue
        jid, rest = m.group(1), m.group(2)
        rec = jobs.setdefault(jid, {"phaseA": None, "phaseB": None, "tx": None})
        a, b, q = classify(rest)
        if q:
            quorum_events += 1
        if a:
            rec["phaseA"] = a
        if b:
            rec["phaseB"] = b
        txm = TX.search(rest)
        if txm:
            rec["tx"] = txm.group(1)

    # mark still-pending Phase B jobs from the live snapshot
    pending = set()
    ostate = load_json(os.path.join(args.data, "oracle_state.json"))
    for jid, v in (ostate.items() if isinstance(ostate, dict) else []):
        rec = jobs.get(str(jid))
        if rec and rec["phaseA"] == "verified" and rec["phaseB"] is None:
            rec["phaseB"] = "pending"
            pending.add(str(jid))

    # drop pre-final-ruleset jobs if requested
    if args.min_job:
        jobs = {k: v for k, v in jobs.items() if int(k) >= args.min_job}
        pending = {k for k in pending if int(k) >= args.min_job}
        print(f"(counting jobs #{args.min_job}+ only — pre-final-ruleset jobs dropped)")

    # ---- aggregate ----
    pa = Counter(r["phaseA"] for r in jobs.values() if r["phaseA"])
    pa_total = sum(pa.values())
    settled_b = Counter(r["phaseB"] for r in jobs.values()
                        if r["phaseB"] in ("win", "loss", "no_contest"))
    b_total = sum(settled_b.values())
    nc_rate = (settled_b["no_contest"] / b_total) if b_total else None

    def pct(n, d): return f"{100*n/d:.1f}%" if d else "n/a"

    print("=" * 60)
    print(" Althemis oracle metrics")
    print("=" * 60)

    print("\n1) Phase A attestation distribution")
    for k in ("verified", "unverifiable", "slashed"):
        print(f"   {k:<13} {pa[k]:>3}   {pct(pa[k], pa_total)}")
    print(f"   {'total':<13} {pa_total:>3}")

    print("\n2) Phase B no-contest rate")
    print(f"   win          {settled_b['win']:>3}")
    print(f"   loss         {settled_b['loss']:>3}")
    print(f"   no_contest   {settled_b['no_contest']:>3}")
    print(f"   settled      {b_total:>3}")
    print(f"   no-contest rate = {pct(settled_b['no_contest'], b_total)}"
          + (f"   (+{len(pending)} verified pending settle)" if pending else ""))

    print("\n3) Tier transitions")
    print(f"   windows closed      {tier_closes}")
    print(f"   tier changes        {tier_changes}")
    tiers = load_json(os.path.join(args.data, "tiers.json"))
    tname = {0: "Bronze", 1: "Silver", 2: "Gold"}
    if isinstance(tiers, dict) and tiers:
        for addr, rec in tiers.items():
            w = rec.get("window", [])
            wins = w.count("win")
            print(f"   {addr[:10]}…  tier={tname.get(rec.get('tier'), rec.get('tier'))}"
                  f"  window={len(w)}/20 (wins={wins})  negStreak={rec.get('negStreak',0)}")
    else:
        print("   (no tier records yet)")

    print("\n4) Quorum-failure frequency")
    print(f"   retry / below-quorum events   {quorum_events}")

    print("\nPer-job ledger")
    for jid in sorted(jobs, key=lambda x: int(x)):
        r = jobs[jid]
        tx = (r["tx"][:12] + "…") if r["tx"] else "—"
        print(f"   #{jid:<3} A={str(r['phaseA']):<12} B={str(r['phaseB']):<10} {tx}")
    print()

if __name__ == "__main__":
    main()
