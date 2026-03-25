#!/usr/bin/env python3
"""
CosyVoice 3 日本語品質・速度テスト

使い方:
  1. setup_cosyvoice.sh を実行してモデルをダウンロード
  2. python test_cosyvoice3.py

RTX 4070 (12GB VRAM) を想定。
"""
import os
import sys
import json
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
COSYVOICE_DIR = SCRIPT_DIR / "CosyVoice"
OUTPUT_DIR = SCRIPT_DIR / "output" / "cosyvoice3"

sys.path.insert(0, str(COSYVOICE_DIR))
sys.path.insert(0, str(COSYVOICE_DIR / "third_party" / "Matcha-TTS"))

from test_sentences import JAPANESE_SENTENCES, EMOTION_TESTS


def main():
    import torch
    import torchaudio

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[INFO] Device: {device}")
    if device == "cuda":
        print(f"[INFO] GPU: {torch.cuda.get_device_name(0)}")
        print(f"[INFO] VRAM: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Load model
    from cosyvoice.cli.cosyvoice import CosyVoice3
    model_dir = str(COSYVOICE_DIR / "pretrained_models" / "Fun-CosyVoice3-0.5B")
    print(f"[INFO] Loading CosyVoice3 from {model_dir}...")
    t0 = time.time()
    cosyvoice = CosyVoice3(model_dir)
    load_time = time.time() - t0
    print(f"[INFO] Model loaded in {load_time:.1f}s")

    results = {
        "model": "CosyVoice3-0.5B",
        "device": device,
        "gpu": torch.cuda.get_device_name(0) if device == "cuda" else "CPU",
        "model_load_time_s": round(load_time, 2),
        "sentences": [],
    }

    # --- Zero-shot with reference audio ---
    # If you have a Shannon voice sample, place it as ref_audio.wav in this dir
    ref_audio_path = SCRIPT_DIR / "ref_audio.wav"
    ref_text = "こんにちは、私はシャノンです。"
    use_zero_shot = ref_audio_path.exists()

    if use_zero_shot:
        print(f"[INFO] Reference audio found: {ref_audio_path}")
        print(f"[INFO] Using zero-shot voice cloning mode")
    else:
        print(f"[INFO] No ref_audio.wav found — using default voice (zero-shot skipped)")
        print(f"[INFO] To test voice cloning, place a WAV sample as: {ref_audio_path}")

    # --- Basic Japanese TTS ---
    print("\n=== Japanese TTS Benchmark ===\n")
    for i, text in enumerate(JAPANESE_SENTENCES):
        print(f"[{i+1}/{len(JAPANESE_SENTENCES)}] \"{text[:40]}...\"")

        t0 = time.time()
        if use_zero_shot:
            gen = cosyvoice.inference_zero_shot(
                text, ref_text, str(ref_audio_path), stream=False,
            )
        else:
            gen = cosyvoice.inference_zero_shot(
                text, ref_text, str(ref_audio_path), stream=False,
            ) if use_zero_shot else cosyvoice.inference_instruct(
                text, "", stream=False,
            )

        audio_chunks = list(gen)
        elapsed = time.time() - t0

        if audio_chunks:
            audio = torch.cat([c["tts_speech"] for c in audio_chunks], dim=-1)
            sr = 24000
            duration_s = audio.shape[-1] / sr
            rtf = elapsed / duration_s if duration_s > 0 else float("inf")

            out_path = OUTPUT_DIR / f"ja_{i:02d}.wav"
            torchaudio.save(str(out_path), audio.cpu(), sr)

            result = {
                "index": i,
                "text": text,
                "duration_s": round(duration_s, 2),
                "generation_time_s": round(elapsed, 2),
                "rtf": round(rtf, 3),
                "file": str(out_path.name),
            }
            results["sentences"].append(result)
            print(f"  -> {duration_s:.2f}s audio in {elapsed:.2f}s (RTF={rtf:.3f}) -> {out_path.name}")
        else:
            print(f"  -> [WARN] No audio generated")

    # --- Emotion tests (instruct mode) ---
    print("\n=== Emotion TTS Test ===\n")
    emotion_results = []
    for i, test in enumerate(EMOTION_TESTS):
        text = test["text"]
        emotion = test["emotion"]
        instruct_text = f"<{emotion}>{text}</{emotion}>"
        print(f"[{emotion}] \"{text[:40]}...\"")

        t0 = time.time()
        gen = cosyvoice.inference_instruct(instruct_text, "", stream=False)
        audio_chunks = list(gen)
        elapsed = time.time() - t0

        if audio_chunks:
            audio = torch.cat([c["tts_speech"] for c in audio_chunks], dim=-1)
            sr = 24000
            duration_s = audio.shape[-1] / sr
            rtf = elapsed / duration_s if duration_s > 0 else float("inf")

            out_path = OUTPUT_DIR / f"emo_{emotion}_{i:02d}.wav"
            torchaudio.save(str(out_path), audio.cpu(), sr)

            result = {
                "emotion": emotion,
                "text": text,
                "duration_s": round(duration_s, 2),
                "generation_time_s": round(elapsed, 2),
                "rtf": round(rtf, 3),
                "file": str(out_path.name),
            }
            emotion_results.append(result)
            print(f"  -> {duration_s:.2f}s audio in {elapsed:.2f}s (RTF={rtf:.3f})")

    results["emotion_tests"] = emotion_results

    # --- Streaming latency test ---
    print("\n=== Streaming Latency Test ===\n")
    stream_text = "今日はマインクラフトで大きなお城を建てる計画を立てました。まず石を集めて、それから設計図を考えます。"
    print(f"Text: \"{stream_text[:50]}...\"")

    t0 = time.time()
    first_chunk_time = None
    chunk_count = 0
    total_samples = 0

    if use_zero_shot:
        gen = cosyvoice.inference_zero_shot(
            stream_text, ref_text, str(ref_audio_path), stream=True,
        )
    else:
        gen = cosyvoice.inference_instruct(stream_text, "", stream=True)

    for chunk in gen:
        if first_chunk_time is None:
            first_chunk_time = time.time() - t0
        chunk_count += 1
        total_samples += chunk["tts_speech"].shape[-1]

    total_time = time.time() - t0
    total_duration = total_samples / 24000

    stream_result = {
        "text": stream_text,
        "ttfb_s": round(first_chunk_time, 3) if first_chunk_time else None,
        "total_time_s": round(total_time, 2),
        "total_duration_s": round(total_duration, 2),
        "chunk_count": chunk_count,
        "rtf": round(total_time / total_duration, 3) if total_duration > 0 else None,
    }
    results["streaming"] = stream_result
    print(f"  TTFB: {first_chunk_time*1000:.0f}ms" if first_chunk_time else "  TTFB: N/A")
    print(f"  Chunks: {chunk_count}, Total: {total_time:.2f}s for {total_duration:.2f}s audio")
    print(f"  RTF: {stream_result['rtf']}")

    # --- Summary ---
    json_path = OUTPUT_DIR / "benchmark_results.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n=== Summary ===")
    if results["sentences"]:
        avg_rtf = sum(r["rtf"] for r in results["sentences"]) / len(results["sentences"])
        print(f"Average RTF: {avg_rtf:.3f}")
        print(f"Results saved to: {json_path}")
    print(f"Audio files in: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
