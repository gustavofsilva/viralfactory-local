import hashlib
import json
from pathlib import Path
import urllib.request
from download import download

directory = Path('D:/ViralFactoryLocal/data/models/whisper/small')
directory.mkdir(parents=True, exist_ok=True)
base = 'https://huggingface.co/Systran/faster-whisper-small'
with urllib.request.urlopen('https://huggingface.co/api/models/Systran/faster-whisper-small?blobs=true', timeout=30) as response:
    metadata = json.load(response)
for entry in metadata['siblings']:
    name = entry['rfilename']
    if name not in ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt', 'README.md']:
        continue
    target = directory / name
    if name == 'model.bin':
        download(f'{base}/resolve/main/{name}', target, entry.get('lfs', {}).get('sha256'))
    elif not target.is_file():
        with urllib.request.urlopen(f'{base}/resolve/main/{name}', timeout=30) as response:
            target.write_bytes(response.read())
print('Whisper small preparado no disco D.', flush=True)
