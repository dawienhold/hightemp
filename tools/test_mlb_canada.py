#!/usr/bin/env python3
"""Offline synthetic XML fixtures; not verification of the live ECCC feed."""
import unittest, importlib.util, pathlib, json, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('mlb_canada', ROOT/'scripts/mlb_canada.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
XML='''<siteData><location><name>Toronto</name></location><hourlyForecastGroup>
<dateTime zone="UTC"><timeStamp>20260922140000</timeStamp></dateTime>
<hourlyForecast dateTimeUTC="202609221700"><condition>Chance of rain</condition><temperature units="C">20</temperature><lop units="%">40</lop><wind><speed units="km/h">16.09344</speed><gust units="km/h">32.18688</gust><direction>W</direction></wind></hourlyForecast>
</hourlyForecastGroup></siteData>'''
class TestCanada(unittest.TestCase):
 def test_units_and_time(self):
  f=m.parse(XML);r=f['rows'][0];self.assertEqual(r['temperatureF'],68);self.assertEqual(r['pop'],40);self.assertAlmostEqual(r['windMph'],10);self.assertAlmostEqual(r['gustMph'],20);self.assertEqual(r['end']-r['start'],3600000)
 def test_wrong_city_rejected(self):
  with self.assertRaisesRegex(ValueError,'not Toronto'):m.parse(XML.replace('Toronto','Ottawa'))
 def test_entities_rejected(self):
  with self.assertRaisesRegex(ValueError,'entity'):m.parse('<!DOCTYPE siteData []>'+XML)
 def test_missing_gust_unknown(self):
  f=m.parse(XML.replace('<gust units="km/h">32.18688</gust>',''));self.assertIsNone(f['rows'][0]['gustMph'])
 def test_unknown_units_not_guessed(self):
  f=m.parse(XML.replace('units="km/h"','units="mystery"'));self.assertIsNone(f['rows'][0]['windMph'])
 def test_missing_hourly_group_fails(self):
  with self.assertRaises(ValueError):m.parse('<siteData><location><name>Toronto</name></location></siteData>')
 def test_command_reads_stdin_no_network(self):
  r=subprocess.run([sys.executable,str(ROOT/'scripts/mlb_canada.py')],input=XML,text=True,capture_output=True,check=True);self.assertEqual(json.loads(r.stdout)['rows'][0]['pop'],40)
if __name__=='__main__':unittest.main()
