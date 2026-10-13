import argparse
import hashlib
from pathlib import Path
import zipfile
import zlib
import json
from datetime import datetime, timezone

parser=argparse.ArgumentParser()
parser.add_argument('archive')
parser.add_argument('directory')
parser.add_argument('--sha256',required=True)
args=parser.parse_args()
archive_path=Path(args.archive)
with archive_path.open('rb') as source:
    digest=hashlib.file_digest(source,'sha256').hexdigest()
if digest!=args.sha256:raise ValueError('SHA256 do arquivo completo invalido.')
directory=Path(args.directory).resolve()
if directory.drive.upper()!='D:':raise ValueError('Destino de instalacao precisa ficar no D.')
with zipfile.ZipFile(archive_path) as archive:
    for entry in archive.infolist():
        if entry.is_dir():continue
        target=(directory/entry.filename).resolve()
        if not target.is_relative_to(directory):raise ValueError('Entrada ZIP fora do diretorio de ferramentas.')
        if target.is_file() and target.stat().st_size==entry.file_size:
            with target.open('rb') as existing:
                crc=0
                while chunk:=existing.read(1024*1024):crc=zlib.crc32(chunk,crc)
            if crc&0xffffffff==entry.CRC:continue
        target.parent.mkdir(parents=True,exist_ok=True)
        with archive.open(entry) as source, target.open('wb') as output:
            while chunk:=source.read(1024*1024):output.write(chunk)
        print('Instalado:',entry.filename,flush=True)
(directory/'installation.json').write_text(json.dumps({'version':'v0.40.3','source':'https://github.com/ollama/ollama/releases/tag/v0.40.3','sha256':digest,'installedAt':datetime.now(timezone.utc).isoformat()},indent=2),encoding='utf-8')
print('Pacote Ollama completo verificado e extraido no disco D.',flush=True)
