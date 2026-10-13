"""Resumable range download, with bounded requests and optional SHA256."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
from pathlib import Path
import time
import urllib.request

def download(url, target, sha256=None):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file():
        if not sha256 or hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == sha256:
            return
        raise ValueError('O arquivo existente nao corresponde ao SHA256 esperado.')
    head = urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=30)
    size = int(head.headers['Content-Length'])
    direct_url = head.url
    chunk_size = 4 * 1024 * 1024
    chunks = (size + chunk_size - 1) // chunk_size
    directory = target.parent / (target.name + '.chunks')
    directory.mkdir(exist_ok=True)
    started = time.monotonic()
    def part(index):
        start = index * chunk_size
        end = min(size-1, start+chunk_size-1)
        filename = directory / str(index)
        if filename.is_file() and filename.stat().st_size == end-start+1:
            return index
        error = None
        for attempt in range(4):
            try:
                request = urllib.request.Request(direct_url, headers={'Range': f'bytes={start}-{end}'})
                with urllib.request.urlopen(request, timeout=90) as response:
                    if response.status != 206:
                        raise ValueError('Servidor nao aceitou download por intervalo.')
                    content_range = response.headers.get('Content-Range', '')
                    if not content_range.startswith(f'bytes {start}-{end}/'):
                        raise ValueError('Intervalo recebido diferente do solicitado.')
                    with filename.with_suffix('.part').open('wb') as output:
                        while True:
                            data = response.read(256*1024)
                            if not data: break
                            output.write(data)
                filename.with_suffix('.part').replace(filename)
                if filename.stat().st_size != end-start+1:
                    raise ValueError('Parte incompleta no download.')
                return index
            except Exception as exc:
                error = exc
        raise error
    done = 0
    with ThreadPoolExecutor(max_workers=6) as executor:
        pending = [executor.submit(part,index) for index in range(chunks)]
        for result in as_completed(pending):
            result.result()
            done += 1
            if done % 10 == 0 or done == chunks:
                print(f'{target.name}: {done}/{chunks} partes, {time.monotonic()-started:.0f}s', flush=True)
    temporary = target.with_suffix(target.suffix+'.part')
    with temporary.open('wb') as output:
        for index in range(chunks):
            with (directory / str(index)).open('rb') as source:
                while data := source.read(1024*1024): output.write(data)
    if sha256 and hashlib.file_digest(temporary.open('rb'),'sha256').hexdigest() != sha256:
        raise ValueError('SHA256 do download nao corresponde ao publicado.')
    temporary.replace(target)
    # Individual files only; no recursive filesystem operations.
    for index in range(chunks): (directory / str(index)).unlink()
    directory.rmdir()
    print(f'{target.name}: download verificado e salvo.',flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('target')
    parser.add_argument('--sha256')
    args = parser.parse_args()
    download(args.url,args.target,args.sha256)
