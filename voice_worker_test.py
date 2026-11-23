import io
import wave
import unittest
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('voice-transcribe.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

def silence(samples):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b'\x00\x00' * samples)
    return buffer.getvalue()

class BoundedDecodeTests(unittest.TestCase):
    def test_rejects_decoding_past_sample_budget(self):
        with self.assertRaises(ValueError):
            worker.decode_bounded_audio(silence(32000), max_samples=16000)

    def test_short_audio_preserves_sample_count(self):
        audio = worker.decode_bounded_audio(silence(1600), max_samples=16000)
        self.assertEqual(len(audio), 1600)
        self.assertEqual(float(abs(audio).max()), 0)

if __name__ == '__main__':
    unittest.main()
