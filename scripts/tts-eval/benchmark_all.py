#!/usr/bin/env python3
"""
全モデル比較ベンチマーク

各モデルの個別テストスクリプトの結果 JSON を集約し、比較表を出力する。
先に test_cosyvoice3.py と test_kokoro.py を実行しておくこと。

  python benchmark_all.py
"""
import json
from pathlib import Path

OUTPUT_BASE = Path(__file__).parent / "output"


def load_results(model_dir: str) -> dict | None:
    path = OUTPUT_BASE / model_dir / "benchmark_results.json"
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


def main():
    models = {
        "CosyVoice3-0.5B": load_results("cosyvoice3"),
        "Kokoro-82M": load_results("kokoro"),
    }

    available = {k: v for k, v in models.items() if v is not None}
    if not available:
        print("[ERROR] No benchmark results found. Run test_cosyvoice3.py / test_kokoro.py first.")
        return

    print("=" * 70)
    print("TTS Model Comparison Benchmark")
    print("=" * 70)

    header = f"{'Model':<22} {'Load(s)':<10} {'Avg RTF':<12} {'Avg Gen(ms)':<14} {'Device':<10}"
    print(f"\n{header}")
    print("-" * len(header))

    summary = {}
    for name, data in available.items():
        sentences = data.get("sentences", [])
        if not sentences:
            continue

        avg_rtf = sum(s["rtf"] for s in sentences) / len(sentences)
        avg_gen_ms = sum(s["generation_time_s"] for s in sentences) / len(sentences) * 1000
        load_s = data.get("model_load_time_s", "?")
        device = data.get("device", "?")

        print(f"{name:<22} {load_s:<10} {avg_rtf:<12.4f} {avg_gen_ms:<14.0f} {device:<10}")
        summary[name] = {
            "avg_rtf": round(avg_rtf, 4),
            "avg_generation_ms": round(avg_gen_ms),
            "model_load_s": load_s,
            "device": device,
            "num_sentences": len(sentences),
        }

    # Per-sentence breakdown
    print(f"\n{'─' * 70}")
    print("Per-sentence breakdown (generation time in ms):")
    print(f"{'─' * 70}")

    from test_sentences import JAPANESE_SENTENCES

    for i, text in enumerate(JAPANESE_SENTENCES):
        short = text[:30] + ("..." if len(text) > 30 else "")
        times = []
        for name, data in available.items():
            sentences = data.get("sentences", [])
            match = next((s for s in sentences if s.get("index") == i), None)
            if match:
                times.append(f"{name}: {match['generation_time_s']*1000:.0f}ms")
            else:
                times.append(f"{name}: N/A")
        print(f"  [{i}] {short}")
        for t in times:
            print(f"      {t}")

    # Streaming (CosyVoice only)
    cv_data = available.get("CosyVoice3-0.5B")
    if cv_data and cv_data.get("streaming"):
        s = cv_data["streaming"]
        print(f"\n{'─' * 70}")
        print("CosyVoice3 Streaming:")
        print(f"  TTFB: {s.get('ttfb_s', 'N/A')}s")
        print(f"  Total: {s.get('total_time_s', 'N/A')}s for {s.get('total_duration_s', 'N/A')}s audio")
        print(f"  RTF: {s.get('rtf', 'N/A')}")

    # Save combined results
    combined_path = OUTPUT_BASE / "comparison.json"
    with open(combined_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"\nComparison saved to: {combined_path}")


if __name__ == "__main__":
    main()
