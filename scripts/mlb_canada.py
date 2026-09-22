#!/usr/bin/env python3
"""Convert official ECCC citypage XML from stdin. Standard library only; no network.
No icon copying. No uncertain schema field is substituted with a guessed value.
"""
import sys, json, re, datetime as dt, xml.etree.ElementTree as ET

def stamp(s):
    if not s or not re.fullmatch(r'\d{12}(?:\d{2})?', s): return None
    try:return dt.datetime.strptime(s,'%Y%m%d%H%M%S' if len(s)==14 else '%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc).timestamp()*1000
    except ValueError:return None

def number(node, allowed_units=None):
    if node is None or (allowed_units is not None and node.get('units') not in allowed_units): return None
    try:v=float(node.text)
    except (ValueError,TypeError):return None
    return v if -200<v<500 else None

def parse(xml):
    if '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper():raise ValueError('DTD/entity XML not accepted')
    root=ET.fromstring(xml)
    for e in root.iter():e.tag=e.tag.rsplit('}',1)[-1]
    name=root.find('location/name')
    if name is None or 'toronto' not in (name.text or '').lower():raise ValueError('ECCC record is not Toronto')
    group=root.find('hourlyForecastGroup')
    if group is None:raise ValueError('ECCC hourlyForecastGroup unavailable')
    issued=None
    for d in group.findall('dateTime'):
        if d.get('zone')=='UTC':
            t=stamp(d.findtext('timeStamp'))
            if t is not None:issued=dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).isoformat().replace('+00:00','Z')
    rows=[]
    for e in group.findall('hourlyForecast'):
        t=stamp(e.get('dateTimeUTC'))
        if t is None:continue
        c=number(e.find('temperature'),{'C'});pop=number(e.find('lop'),{'%'})
        w=number(e.find('wind/speed'),{'km/h'});g=number(e.find('wind/gust'),{'km/h'})
        direction=e.findtext('wind/direction')
        rows.append({'start':t,'end':t+3600000,'temperatureF':None if c is None else c*1.8+32,
            'pop':pop if pop is not None and 0<=pop<=100 else None,
            'windMph':None if w is None or w<0 else w/1.609344,
            'gustMph':None if g is None or g<0 else g/1.609344,
            'direction':direction,'condition':e.findtext('condition') or ''})
    if not rows:raise ValueError('No parseable Toronto hourly forecasts')
    return {'provider':'ECCC Toronto city forecast','issuedAt':issued,'rows':sorted(rows,key=lambda r:r['start']),
            'note':'City-level outdoor forecast, not a sensor inside Rogers Centre; hourly horizon may be shorter than five days.'}

if __name__=='__main__':
    try:print(json.dumps(parse(sys.stdin.read())))
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
