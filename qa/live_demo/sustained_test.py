import subprocess, time

qs = [
    "What is your refund policy?", "How long does shipping take?", "Can I delete my account?",
    "Do you ship to Canada?", "What is the restocking fee?", "Is 2FA required?",
    "Can I return a used item?", "How do I track my order?", "What warehouses do you use?",
    "Is express shipping available?", "What happens after 60 days?", "Can I get a partial refund?",
    "How do I update my password?", "What's the return policy for electronics?", "Do lost packages get replaced?",
    "How long until account deletion completes?", "Is shipping free over $50?", "What's the customs process?",
    "Can I use two-factor with saved cards?", "What's the tax retention period?",
]

results = []
t0 = time.perf_counter()
for i, q in enumerate(qs):
    r = subprocess.run(["python3", "live_client.py", "ws://localhost:8090", q], capture_output=True, text=True, timeout=15)
    ok = "ERROR" not in r.stdout and "first_audio=" in r.stdout
    line = [l for l in r.stdout.splitlines() if "summary" in l]
    results.append((i, q, ok, line[0] if line else "NO SUMMARY"))
total = time.perf_counter() - t0

print(f"=== {len(qs)} sequential requests in {total:.1f}s (avg {total/len(qs)*1000:.0f}ms/req) ===\n")
fails = 0
for i, q, ok, line in results:
    status = "OK" if ok else "FAIL"
    if not ok: fails += 1
    print(f"[{status}] {i+1:2d}. {q[:45]:45s} {line}")
print(f"\n{len(qs)-fails}/{len(qs)} succeeded")
