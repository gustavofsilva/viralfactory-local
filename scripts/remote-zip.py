"""Extract selected runtime files from the official ZIP using byte ranges.

ZIP CRC is checked per entry. Full archive SHA256 is verified separately.
"""
import argparse
import io
from pathlib import Path
import struct
import urllib.request
import zipfile
import zlib

class RemoteFile(io.RawIOBase):
    def __init__(self,url):
        head=urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=30)
        self.url=head.url
        self.size=int(head.headers['Content-Length'])
        self.position=0
    def seek(self,offset,whence=0):
        self.position=offset if whence==0 else self.position+offset if whence==1 else self.size+offset
        return self.position
    def tell(self):return self.position
    def seekable(self):return True
    def read(self,size=-1):
        if size<0:size=self.size-self.position
        if not size:return b''
        start=self.position
        end=min(self.size-1,start+size-1)
        request=urllib.request.Request(self.url,headers={'Range':f'bytes={start}-{end}'})
        with urllib.request.urlopen(request,timeout=120) as response:
            if response.status!=206:raise ValueError('Range nao aceito.')
            content_range=response.headers.get('Content-Range','')
            if not content_range.startswith(f'bytes {start}-{end}/'):raise ValueError('Range inesperado.')
            data=response.read()
        self.position+=len(data)
        return data

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--target')
    parser.add_argument('--cpu',action='store_true')
    parser.add_argument('--vulkan',action='store_true')
    args=parser.parse_args()
    remote=RemoteFile(args.url)
    archive=zipfile.ZipFile(remote)
    entries=archive.infolist()
    if not args.target:
        for entry in entries:
            print(f'{entry.filename}\t{entry.compress_size/1024/1024:.1f} MB',flush=True)
        return
    target=Path(args.target).resolve()
    target.mkdir(parents=True,exist_ok=True)
    for entry in entries:
        name=entry.filename.replace('\\','/')
        if entry.is_dir():continue
        if not (name=='ollama.exe' or (args.cpu and ('/cpu' in name or name.startswith('lib/ollama/') and name.count('/')==2)) or (args.vulkan and name.startswith('lib/ollama/vulkan/'))):continue
        destination=(target/name).resolve()
        if not destination.is_relative_to(target):raise ValueError('Destino fora da pasta de ferramentas.')
        if destination.is_file() and destination.stat().st_size==entry.file_size:continue
        print('Obtendo runtime:',name,flush=True)
        remote.seek(entry.header_offset)
        header=remote.read(30)
        fields=struct.unpack('<4s5H3I2H',header)
        filename_len,extra_len=fields[-2:]
        remote.seek(entry.header_offset+30+filename_len+extra_len)
        data=remote.read(entry.compress_size)
        if entry.compress_type==zipfile.ZIP_DEFLATED:data=zlib.decompress(data,-15)
        elif entry.compress_type!=zipfile.ZIP_STORED:raise ValueError('Compressao nao suportada.')
        if len(data)!=entry.file_size or zlib.crc32(data)&0xffffffff!=entry.CRC:raise ValueError('CRC do arquivo invalido.')
        destination.parent.mkdir(parents=True,exist_ok=True)
        temporary=destination.with_suffix(destination.suffix+'.part')
        temporary.write_bytes(data)
        temporary.replace(destination)
        print('Runtime salvo:',name,flush=True)
if __name__=='__main__':main()
