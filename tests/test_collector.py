"""Portable regression tests: counter deltas, network changes, disk sectors, memory."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parents[1] / 'resource-sidebar@randy.local' / 'collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class TelemetryTests(unittest.TestCase):
    def samples(self, interfaces):
        with patch.object(collector, 'root_disks', return_value=['nvme1n1']), \
             patch.object(collector.time, 'monotonic', side_effect=[10, 12]), \
             patch.object(collector, 'cpu_counters', side_effect=[(1000, 700), (1200, 800)]), \
             patch.object(collector, 'disk_counters', side_effect=[(5000, 2000), (6000, 4000)]), \
             patch.object(collector, 'network_interface', side_effect=interfaces), \
             patch.object(collector, 'network_counters', side_effect=[(10000, 20000), (14000, 22000)]), \
             patch.object(collector, 'cpu_temperature', return_value=None), \
             patch.object(collector, 'gpu_metrics', return_value={}), \
             patch.object(collector, 'read', return_value='MemTotal: 1000 kB\nMemAvailable: 400 kB\nMemFree: 100 kB'):
            reader = collector.Collector()
            return reader.sample(), reader.sample()

    def test_deltas_use_actual_elapsed_seconds_and_available_memory(self):
        first, second = self.samples(['wlan0', 'wlan0'])
        self.assertIsNone(first['cpu']['usage'])
        self.assertIsNone(first['disk']['read'])
        self.assertEqual(second['cpu']['usage'], 50)
        self.assertEqual(second['disk']['read'], 500)
        self.assertEqual(second['disk']['write'], 1000)
        self.assertEqual(second['network']['down'], 2000)
        self.assertEqual(second['network']['up'], 1000)
        self.assertEqual(second['memory']['used'], 600 * 1024)
        self.assertEqual(second['memory']['usage'], 60)
        self.assertIsNone(second['cpu']['temperature'])

    def test_interface_change_does_not_produce_false_speed(self):
        _, second = self.samples(['wlan0', 'eth0'])
        self.assertIsNone(second['network']['up'])
        self.assertIsNone(second['network']['down'])

    def test_disk_sectors_are_512_bytes_and_other_disks_are_excluded(self):
        stats = '259 0 nvme1n1 10 0 8 0 10 0 16 0 0 0 0\n259 1 nvme0n1 1 0 999 0 1 0 999 0 0 0 0'
        with patch.object(collector, 'read', return_value=stats):
            self.assertEqual(collector.disk_counters(['nvme1n1']), (4096, 8192))
            self.assertIsNone(collector.disk_counters(['missing']))

    def test_guest_cpu_time_not_counted_twice(self):
        with patch.object(collector, 'read', return_value='cpu 100 0 50 800 20 10 10 10 40 0\n'):
            self.assertEqual(collector.cpu_counters(), (1000, 820))


if __name__ == '__main__':
    unittest.main()
