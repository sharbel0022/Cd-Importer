"""Optional local Swedish MMS voice (CC-BY-NC-4.0; noncommercial use)."""
import os
from pathlib import Path

model = None
tokenizer = None


def available():
    return os.getenv('STUDIO_MMS_ENABLED') == 'true' and Path(os.getenv('MMS_MODEL', '')).joinpath('config.json').is_file()


def synthesize(text, destination):
    global model, tokenizer
    import numpy as np
    import torch
    from scipy.io.wavfile import write
    from transformers import VitsModel, AutoTokenizer
    if model is None:
        torch.set_num_threads(4)
        model = VitsModel.from_pretrained(os.environ['MMS_MODEL'], local_files_only=True, use_safetensors=True).eval()
        tokenizer = AutoTokenizer.from_pretrained(os.environ['MMS_MODEL'], local_files_only=True)
    torch.manual_seed(int(os.getenv('MMS_SEED', '555')))
    with torch.inference_mode():
        audio = model(**tokenizer(text, return_tensors='pt')).waveform[0].numpy()
    write(str(destination), model.config.sampling_rate, (np.clip(audio, -1, 1) * 32767).astype(np.int16))
