#!/usr/bin/env python3
"""
Kokoro TTS (82M) 日本語品質・速度テスト

Kokoro は 82M パラメータの超軽量モデルで、CPU でもリアルタイム動作可能。
GPU なら 96x〜210x リアルタイム速度。

使い方:
  pip install kokoro>=0.9.0 "misaki[ja]" soundfile onnxruntime
  python test_kokoro.py
"""
import json
import time
from pathlib import Path

import soundfile as sf

from test_sentences import JAPANESE_SENTENCES

OUTPUT_DIR = Path(__file__).parent / "output" / "kokoro"


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("[INFO] Loading Kokoro TTS...")
    t0 = time.time()

    from kokoro import KPipeline

    pipeline = KPipeline(lang_code="j")
    load_time = time.time() - t0
    print(f"[INFO] Kokoro loaded in {load_time:.1f}s")

    results = {
        "model": "Kokoro-82M",
        "device": "cpu",
        "model_load_time_s": round(load_time, 2),
        "sentences": [],
    }

    print("\n=== Japanese TTS Benchmark ===\n")

    for i, text in enumerate(JAPANESE_SENTENCES):
        print(f"[{i+1}/{len(JAPANESE_SENTENCES)}] \"{text[:40]}...\"")

        t0 = time.time()
        audio_segments = []
        for _, _, audio in pipeline(text, voice="jf_alpha"):
            audio_segments.append(audio)
        elapsed = time.time() - t0

        if audio_segments:
            import numpy as np
            full_audio = np.concatenate(audio_segments)
            sr = 24000
            duration_s = len(full_audio) / sr
            rtf = elapsed / duration_s if duration_s > 0 else float("inf")

            out_path = OUTPUT_DIR / f"ja_{i:02d}.wav"
            sf.write(str(out_path), full_audio, sr)

            result = {
                "index": i,
                "text": text,
                "duration_s": round(duration_s, 2),
                "generation_time_s": round(elapsed, 4),
                "rtf": round(rtf, 4),
                "file": str(out_path.name),
            }
            results["sentences"].append(result)
            print(f"  -> {duration_s:.2f}s audio in {elapsed*1000:.0f}ms (RTF={rtf:.4f}) -> {out_path.name}")
        else:
            print(f"  -> [WARN] No audio generated")

    # --- Voice variations ---
    print("\n=== Voice Variation Test ===\n")
    test_text = "こんにちは、今日はいい天気ですね。"
    voices = ["jf_alpha", "jf_gongitsune", "jf_nezumi", "jm_kumo"]
    voice_results = []
    for voice in voices:
        try:
            t0 = time.time()
            segments = []
            for _, _, audio in pipeline(test_text, voice=voice):
                segments.append(audio)
            elapsed = time.time() - t0

            if segments:
                import numpy as np
                full_audio = np.concatenate(segments)
                sr = 24000
                out_path = OUTPUT_DIR / f"voice_{voice}.wav"
                sf.write(str(out_path), full_audio, sr)
                voice_results.append({"voice": voice, "time_ms": round(elapsed * 1000), "file": out_path.name})
                print(f"  {voice}: {elapsed*1000:.0f}ms -> {out_path.name}")
        except Exception as e:
            print(f"  {voice}: FAILED ({e})")

    results["voice_variations"] = voice_results

    json_path = OUTPUT_DIR / "benchmark_results.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n=== Summary ===")
    if results["sentences"]:
        avg_rtf = sum(r["rtf"] for r in results["sentences"]) / len(results["sentences"])
        print(f"Average RTF: {avg_rtf:.4f}")
    print(f"Results saved to: {json_path}")
    print(f"Audio files in: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
