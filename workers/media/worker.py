"""Local media tasks. Inputs and outputs are JSON files; no shell commands."""
from __future__ import annotations
import argparse
import json
import math
import os
from pathlib import Path
import re
import sys
import textwrap
import wave

def save_json(filename, data):
    target = Path(filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + '.part')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(target)

def prepare(request):
    from huggingface_hub import snapshot_download
    target = Path(request['modelDir'])
    target.mkdir(parents=True, exist_ok=True)
    snapshot_download('Systran/faster-whisper-small', local_dir=str(target))
    return {'modelDir': str(target), 'ready': (target / 'model.bin').is_file()}

def synthesize(request):
    from piper import PiperVoice, SynthesisConfig
    output = Path(request['output'])
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.part.wav')
    voice = PiperVoice.load(request['model'], use_cuda=False)
    speed = min(1.4, max(0.7, float(request.get('speed', 1))))
    with wave.open(str(temporary), 'wb') as wav_file:
        voice.synthesize_wav(request['text'], wav_file, syn_config=SynthesisConfig(length_scale=1/speed, normalize_audio=True))
    with wave.open(str(temporary), 'rb') as wav_file:
        duration = wav_file.getnframes() / wav_file.getframerate()
        sample_rate = wav_file.getframerate()
    if duration < 1 or duration > 150:
        raise ValueError(f'Duracao da narracao fora do limite: {duration:.1f}s')
    temporary.replace(output)
    return {'output': str(output), 'duration': duration, 'sampleRate': sample_rate, 'voice': Path(request['model']).stem}

def ass_time(seconds):
    centiseconds = max(0, round(seconds * 100))
    return f'{centiseconds//360000}:{centiseconds//6000%60:02d}:{centiseconds//100%60:02d}.{centiseconds%100:02d}'

def ass_text(text):
    return re.sub(r'[{}\\\r\n]', '', text).strip()

def transcribe(request):
    from faster_whisper import WhisperModel
    model_path = Path(request['model'])
    if not (model_path / 'model.bin').is_file():
        raise FileNotFoundError('Modelo Whisper local nao preparado.')
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
    segments, info = model.transcribe(request['audio'], language='pt', word_timestamps=True, beam_size=3, condition_on_previous_text=False, vad_filter=False, initial_prompt=request.get('text', '')[:1500])
    words = []
    for segment in segments:
        for word in segment.words or []:
            text = ass_text(word.word)
            if text and word.end > word.start:
                words.append({'text': text, 'start': round(word.start, 3), 'end': round(word.end, 3)})
    if not words:
        raise ValueError('Whisper nao retornou timestamps para a narracao.')
    import difflib
    normalize = lambda value: re.sub(r'[^\w\s]', '', value.lower()).split()
    similarity = difflib.SequenceMatcher(None, normalize(request.get('text', '')), normalize(' '.join(word['text'] for word in words))).ratio()
    if request.get('text') and similarity < 0.55:
        raise ValueError(f'Transcricao muito diferente do roteiro ({similarity:.0%}); revise o audio.')
    style = request.get('style', {})
    size = min(92, max(38, int(style.get('size', 64))))
    color = style.get('color', '#D1F49E')
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        color = '#D1F49E'
    ass_color = '&H00' + color[5:7] + color[3:5] + color[1:3]
    margin = min(800, max(220, int(style.get('margin', 400))))
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Segoe UI,{size},{ass_color},&H00FFFFFF,&H00201510,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,85,85,{margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    lines = []
    groups = []
    current = []
    for word in words:
        if current and (len(current) >= 3 or word['start'] - current[-1]['end'] > 0.5 or len(' '.join(item['text'] for item in current) + word['text']) > 30):
            groups.append(current)
            current = []
        current.append(word)
    if current:
        groups.append(current)
    subtitle_offset = float(request.get('offset', 0))
    for index, group in enumerate(groups):
        start = group[0]['start']
        end = min(float(request.get('duration', words[-1]['end'])), max(group[-1]['end'], start + 0.12))
        if index + 1 < len(groups):
            end = min(end + 0.12, groups[index+1][0]['start'])
        text = ''
        for word_index, word in enumerate(group):
            next_start = group[word_index+1]['start'] if word_index+1 < len(group) else end
            ticks = max(1, round((next_start - word['start']) * 100))
            text += f'{{\\kf{ticks}}}{word["text"]} '
        lines.append(f'Dialogue: 0,{ass_time(start + subtitle_offset)},{ass_time(end + subtitle_offset)},Default,,0,0,0,,{{\\fad(60,60)}}{text.strip()}')
    output = Path(request['output'])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(header + '\n'.join(lines) + '\n', encoding='utf-8')
    return {'output': str(output), 'words': words, 'text': ' '.join(word['text'] for word in words), 'similarity': similarity, 'language': info.language}

def scene_card(request):
    from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter
    width, height = 1080, 1920
    template = request.get('template', 'Viral')
    palettes = {'Viral': ((10,31,45),(13,67,61),(67,224,158)), 'Notícias': ((10,31,45),(21,64,80),(67,224,158)), 'Curiosidades': ((10,31,45),(57,54,79),(67,224,158))}
    top, bottom, accent = palettes.get(template, palettes['Viral'])
    image = Image.new('RGB', (width,height))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = y/(height-1)
        color = tuple(round(top[i]*(1-t)+bottom[i]*t) for i in range(3))
        draw.line([(0,y),(width,y)],fill=color)
    draw.ellipse((500,-230,1600,900),outline=tuple(min(255,c+13) for c in bottom),width=3)
    draw.ellipse((-500,900,600,2000),outline=tuple(min(255,c+9) for c in bottom),width=3)
    font_path = request.get('font', 'C:/Windows/Fonts/segoeui.ttf')
    bold_path = request.get('boldFont', 'C:/Windows/Fonts/segoeuib.ttf')
    font = lambda size, bold=False: ImageFont.truetype(bold_path if bold else font_path, size)
    if request.get('intro'):
        draw.rounded_rectangle((130,570,950,1330),radius=72,fill=(12,44,58),outline=accent,width=4)
        draw.rounded_rectangle((425,670,655,900),radius=50,fill=accent)
        draw.text((453,712),'BG',font=font(90,True),fill=(10,31,45))
        draw.text((225,950),'BRASIL GERAIS',font=font(67,True),fill=(244,249,244))
        draw.text((405,1055),'@brasilgerais',font=font(31,True),fill=accent)
        draw.rounded_rectangle((280,1170,800,1235),radius=30,fill=(255,219,91))
        draw.text((345,1183),'O BRASIL E O MUNDO',font=font(25,True),fill=(10,31,45))
        output = Path(request['output'])
        output.parent.mkdir(parents=True,exist_ok=True)
        image.save(output,'PNG')
        return {'output':str(output),'width':width,'height':height,'kind':'original-intro'}
    draw.rounded_rectangle((85,120,995,190),radius=18,fill=tuple(c+8 for c in top))
    draw.text((110,133),'BRASIL GERAIS  /  @brasilgerais',font=font(25,True),fill=accent)
    label = f'{int(request.get("index",0))+1:02d}  /  {int(request.get("total",1)):02d}'
    draw.text((850,133),label,font=font(25),fill=accent)
    if request.get('sectionLabel'):
        draw.text((90,215),str(request['sectionLabel'])[:40],font=font(26,True),fill=accent)
    title = request.get('title', '')[:180]
    title_lines = textwrap.wrap(title, width=25)
    y = 280
    for line in title_lines[:4]:
        draw.text((88,y),line,font=font(64,True),fill=(239,245,234))
        y += 87
    visual = request.get('image')
    if visual:
        with Image.open(visual) as asset:
            asset = ImageOps.fit(asset.convert('RGB'),(900,500),method=Image.Resampling.LANCZOS)
        mask = Image.new('L',(900,500),0)
        ImageDraw.Draw(mask).rounded_rectangle((0,0,900,500),radius=28,fill=255)
        image.paste(asset,(90,690),mask)
        draw.text((92,1200),str(request.get('imageLabel') or 'IMAGEM ILUSTRATIVA')[:36],font=font(19,True),fill=accent)
        credit = str(request.get('imageCredit') or '')
        if credit:
            for line_index, line in enumerate(textwrap.wrap(f'Foto: {credit}', width=62)[:2]):
                draw.text((92,1230+line_index*27),line,font=font(20),fill=(220,232,209))
    else:
        draw.rounded_rectangle((90,730,990,1260),radius=30,fill=tuple(min(255,c+11) for c in bottom))
        draw.line((150,800,320,800),fill=accent,width=8)
        text = request.get('sceneText', '')
        wrapped = textwrap.wrap(text, width=31)
        size, spacing = 39, 57
        if len(wrapped) > 5:
            wrapped = textwrap.wrap(text, width=37)
            size, spacing = 34, 48
        if len(wrapped) > 7:
            wrapped = textwrap.wrap(text, width=44)
            size, spacing = 30, 42
        for index, line in enumerate(wrapped):
            draw.text((150,850+index*spacing),line,font=font(size,True),fill=(220,232,209))
        draw.text((150,1210),'GRAFISMO ORIGINAL',font=font(18),fill=accent)
    draw.rounded_rectangle((90,1300,815,1388),radius=25,fill=(255,219,91))
    draw.text((121,1317),'CURTE E SIGA PARA MAIS',font=font(35,True),fill=(10,31,45))
    draw.text((90,1740),'FONTES NA DESCRIÇÃO',font=font(22,True),fill=accent)
    draw.text((90,1790),'Narração gerada por IA  •  Português brasileiro',font=font(21),fill=(171,191,163))
    output = Path(request['output'])
    output.parent.mkdir(parents=True,exist_ok=True)
    image.save(output,'PNG')
    return {'output':str(output),'width':width,'height':height,'kind':'licensed-composition' if visual else 'original-graphic'}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('task',choices=['prepare','tts','subtitles','card'])
    parser.add_argument('--request',required=True)
    parser.add_argument('--response',required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf-8-sig'))
    handlers = {'prepare':prepare,'tts':synthesize,'subtitles':transcribe,'card':scene_card}
    result = handlers[args.task](request)
    save_json(args.response,result)
    print(json.dumps({'status':'ok','task':args.task},ensure_ascii=False),flush=True)

if __name__ == '__main__':
    main()
