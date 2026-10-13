import argparse
import hashlib
import json
from pathlib import Path
import urllib.request
from download import download

parser = argparse.ArgumentParser()
parser.add_argument('--model', default='qwen3:4b')
parser.add_argument('--directory', default='D:/ViralFactoryLocal/data/models/ollama')
args = parser.parse_args()
name, tag = args.model.split(':', 1)
directory = Path(args.directory)
blobs = directory / 'blobs'
blobs.mkdir(parents=True, exist_ok=True)
base = f'https://registry.ollama.ai/v2/library/{name}'
with urllib.request.urlopen(f'{base}/manifests/{tag}', timeout=30) as response:
    manifest_data = response.read()
manifest = json.loads(manifest_data)
for entry in [manifest['config'], *manifest['layers']]:
    digest = entry['digest']
    sha = digest.split(':')[1]
    target = blobs / digest.replace(':', '-')
    if entry['size'] > 5_000_000:
        download(f'{base}/blobs/{digest}', target, sha)
    elif not target.is_file():
        with urllib.request.urlopen(f'{base}/blobs/{digest}', timeout=30) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != sha:
            raise ValueError('SHA256 do blob nao corresponde ao registro oficial.')
        target.write_bytes(data)
target_manifest = directory / 'manifests/registry.ollama.ai/library' / name / tag
target_manifest.parent.mkdir(parents=True, exist_ok=True)
target_manifest.write_bytes(manifest_data)
print(f'Modelo {args.model} salvo e verificado no disco D.', flush=True)
