"""Offline voice-to-text worker. Audio arrives on stdin and is never saved."""
import io
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
sys.path.insert(0, str(root / '.voice-python'))
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
# The bundled Python has VC runtime DLLs; the sibling Node runtime supplies
# msvcp140.dll needed by CTranslate2. Keep the DLL-directory handle alive.
dll_directories = []
if sys.platform == 'win32':
    runtime_bin = Path(sys.executable).resolve().parent.parent / 'node/bin'
    if runtime_bin.is_dir():
        dll_directories.append(os.add_dll_directory(str(runtime_bin)))

def decode_bounded_audio(data, max_samples=300 * 16000):
    import av
    import numpy as np
    chunks = []
    size = 0
    resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
    def append(frame):
        nonlocal size
        size += frame.samples
        if size > max_samples:
            raise ValueError('Recording exceeds sample limit')
        chunks.append(frame.to_ndarray().flatten().astype(np.float32) / 32768.0)
    with av.open(io.BytesIO(data)) as container:
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                append(converted)
        for converted in resampler.resample(None):
            append(converted)
    return np.concatenate(chunks) if chunks else np.empty(0, dtype=np.float32)

def main():
    from faster_whisper import WhisperModel
    cache = Path.home() / '.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots'
    snapshots = sorted(p for p in cache.iterdir() if (p / 'model.bin').is_file())
    if not snapshots:
        raise RuntimeError('Local speech model unavailable')
    model = WhisperModel(str(snapshots[-1]), device='cpu', compute_type='int8',
                         cpu_threads=min(4, os.cpu_count() or 2), local_files_only=True)
    if '--check' in sys.argv:
        print(json.dumps({'ready': True, 'model': 'faster-whisper-small', 'device': 'cpu'}))
        return
    data = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
    if not data or len(data) > 20 * 1024 * 1024:
        raise ValueError('Invalid audio size')
    audio = decode_bounded_audio(data)
    if not len(audio):
        raise ValueError('Empty audio')
    segments, _ = model.transcribe(audio, language=os.environ.get('CODEX_VOICE_LANGUAGE', 'vi'),
        beam_size=5, vad_filter=True, condition_on_previous_text=False)
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    print(json.dumps({'text': text}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'Local voice recognition failed'}))
        sys.exit(1)
