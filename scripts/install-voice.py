import hashlib
import json
from pathlib import Path
import urllib.request
from download import download
from datetime import datetime, timezone

directory = Path('D:/ViralFactoryLocal/data/models/piper')
directory.mkdir(parents=True, exist_ok=True)
base = 'https://huggingface.co/rhasspy/piper-voices'
folder = 'pt/pt_BR/faber/medium'
with urllib.request.urlopen(f'{base}/raw/main/{folder}/MODEL_CARD', timeout=30) as response:
    card = response.read()
if b'License: CC0' not in card:
    raise ValueError('Model card sem licenca de dataset CC0 esperada.')
(directory / 'MODEL_CARD').write_bytes(card)
name = 'pt_BR-faber-medium.onnx'
with urllib.request.urlopen('https://huggingface.co/api/models/rhasspy/piper-voices/tree/main/pt/pt_BR/faber/medium?expand=false', timeout=30) as response:
    entries = json.load(response)
entry = next(entry for entry in entries if entry['path'].endswith('/' + name))
download(f'{base}/resolve/main/{folder}/{name}', directory/name, entry.get('lfs', {}).get('oid'))
if not (directory/(name+'.json')).is_file():
    with urllib.request.urlopen(f'{base}/resolve/main/{folder}/{name}.json',timeout=30) as response:
        (directory/(name+'.json')).write_bytes(response.read())
manifest = {'id':'pt_BR-faber-medium','source':f'{base}/resolve/main/{folder}/','modelCard':f'{base}/blob/main/{folder}/MODEL_CARD','datasetLicense':'CC0','engineLicense':'GPL-3.0','acquiredAt':datetime.now(timezone.utc).isoformat(),'sha256':hashlib.file_digest((directory/name).open('rb'),'sha256').hexdigest()}
(directory/'license.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print('Voz pt_BR-faber-medium preparada no disco D.',flush=True)
