#!/usr/bin/python3
"""Read-only Linux telemetry. Emits one JSON object per second on stdout."""
import argparse
import glob
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def read(path):
    try:
        return Path(path).read_text().strip()
    except (OSError, ValueError):
        return ''


def number(path):
    try:
        return int(read(path))
    except ValueError:
        return None


def cpu_counters():
    fields = read('/proc/stat').splitlines()[0].split()[1:9]
    values = [int(v) for v in fields]
    return sum(values), values[3] + values[4]


def cpu_temperature():
    preferred = []
    fallback = []
    for hw in glob.glob('/sys/class/hwmon/hwmon*'):
        name = read(f'{hw}/name')
        if name not in ('coretemp', 'k10temp', 'zenpower', 'cpu_thermal'):
            continue
        for path in glob.glob(f'{hw}/temp*_input'):
            value = number(path)
            if value is None or not 0 < value < 150000:
                continue
            label = read(path.replace('_input', '_label'))
            (preferred if 'Package' in label or label in ('Tctl', 'Tdie') else fallback).append(value / 1000)
    values = preferred or fallback
    return max(values) if values else None


def root_disks():
    """Resolve root partitions and device-mapper layers to whole physical disks."""
    try:
        result = subprocess.run(['/usr/bin/findmnt', '-n', '-o', 'MAJ:MIN', '/'],
                                capture_output=True, text=True, timeout=2, check=True)
        root = Path('/sys/dev/block') / result.stdout.strip()
        found = set()
        visited = set()
        def resolve(device):
            device = device.resolve()
            if device in visited or not device.exists():
                return
            visited.add(device)
            slaves = list((device / 'slaves').glob('*'))
            if slaves:
                for slave in slaves:
                    resolve(slave)
            elif (device / 'partition').exists():
                resolve(device.parent)
            else:
                found.add(device.name)
        resolve(root)
        return sorted(found)
    except (OSError, subprocess.SubprocessError):
        return []


def disk_counters(disks):
    total_read = total_write = 0
    found = False
    for line in read('/proc/diskstats').splitlines():
        fields = line.split()
        if len(fields) > 9 and fields[2] in disks:
            # Linux diskstats sectors are always 512 bytes, regardless of sector size.
            total_read += int(fields[5]) * 512
            total_write += int(fields[9]) * 512
            found = True
    return (total_read, total_write) if found else None


def network_interface():
    candidates = []
    for line in read('/proc/net/route').splitlines()[1:]:
        fields = line.split()
        if len(fields) > 7 and fields[1] == '00000000' and int(fields[3], 16) & 1:
            candidates.append((int(fields[6]), fields[0]))
    if candidates:
        return min(candidates)[1]
    # IPv6-only connections may have no IPv4 default route.
    for line in read('/proc/net/ipv6_route').splitlines():
        fields = line.split()
        if len(fields) >= 10 and fields[0] == '0' * 32 and fields[1] == '00' and fields[-1] != 'lo':
            return fields[-1]
    return None


def network_counters(interface):
    if not interface:
        return None
    values = tuple(number(f'/sys/class/net/{interface}/statistics/{direction}_bytes')
                   for direction in ('rx', 'tx'))
    return values if all(v is not None for v in values) else None


def gpu_metrics():
    if shutil.which('nvidia-smi'):
        try:
            result = subprocess.run([
                'nvidia-smi', '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
                '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=1.5, check=True)
            fields = [v.strip() for v in result.stdout.splitlines()[0].split(',')]
            def numeric(value):
                try:
                    return float(value)
                except ValueError:
                    return None
            return dict(name=fields[0], usage=numeric(fields[1]),
                        used_mib=numeric(fields[2]), total_mib=numeric(fields[3]), temperature=numeric(fields[4]))
        except (OSError, subprocess.SubprocessError, IndexError):
            pass
    for device in sorted(glob.glob('/sys/class/drm/card[0-9]*/device')):
        if not Path(f'{device}/gpu_busy_percent').exists():
            continue
        temps = [number(p) for p in glob.glob(f'{device}/hwmon/hwmon*/temp1_input')]
        temp = next((t / 1000 for t in temps if t is not None), None)
        used = number(f'{device}/mem_info_vram_used')
        total = number(f'{device}/mem_info_vram_total')
        return dict(name='AMD GPU', usage=number(f'{device}/gpu_busy_percent'),
                    used_mib=used / 1048576 if used is not None else None,
                    total_mib=total / 1048576 if total is not None else None, temperature=temp)
    return dict(name='GPU', usage=None, used_mib=None, total_mib=None, temperature=None)


class Collector:
    def __init__(self):
        self.disks = root_disks()
        self.previous = None

    def sample(self):
        now = time.monotonic()
        cpu = cpu_counters()
        disk = disk_counters(self.disks)
        interface = network_interface()
        net = network_counters(interface)
        usage = disk_read = disk_write = down = up = None
        if self.previous:
            old_time, old_cpu, old_disk, old_interface, old_net = self.previous
            elapsed = max(now - old_time, 0.001)
            delta = cpu[0] - old_cpu[0]
            if delta > 0:
                usage = min(100, max(0, 100 * (1 - (cpu[1] - old_cpu[1]) / delta)))
            if disk is not None and old_disk is not None:
                disk_read, disk_write = [max(0, (a - b) / elapsed) for a, b in zip(disk, old_disk)]
            if interface == old_interface and net is not None and old_net is not None:
                down, up = [max(0, (a - b) / elapsed) for a, b in zip(net, old_net)]
        self.previous = now, cpu, disk, interface, net
        mem = {}
        for line in read('/proc/meminfo').splitlines():
            fields = line.split()
            mem[fields[0].rstrip(':')] = int(fields[1]) * 1024
        total = mem['MemTotal']
        used = total - mem.get('MemAvailable', mem.get('MemFree', 0))
        return dict(timestamp=time.time(), cpu=dict(usage=usage, temperature=cpu_temperature()),
                    memory=dict(used=used, total=total, usage=100 * used / total),
                    disk=dict(devices=self.disks, read=disk_read, write=disk_write),
                    network=dict(interface=interface, wifi=bool(interface and Path(f'/sys/class/net/{interface}/wireless').exists()),
                                 down=down, up=up), gpu=gpu_metrics())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--samples', type=int, default=0)
    args = parser.parse_args()
    collector = Collector()
    count = 0
    while True:
        start = time.monotonic()
        try:
            print(json.dumps(collector.sample(), allow_nan=False), flush=True)
        except BrokenPipeError:
            break
        count += 1
        if args.once or (args.samples and count >= args.samples):
            break
        time.sleep(max(0.05, 1 - (time.monotonic() - start)))


if __name__ == '__main__':
    main()
