#!/usr/bin/env python3
"""Read-only 10 minute adb sampler; no device state or battery simulation changes."""
import argparse
import json
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


def fields(text):
    return {key.strip(): value.strip() for line in text.splitlines() if ':' in line
            for key, value in [line.split(':', 1)]}


def cpu_snapshot(process, system):
    # comm may contain spaces and parentheses; fields after its final ')' start
    # at Linux stat field 3. utime/stime are fields 14/15.
    values = process.rsplit(')', 1)[1].split()
    first = system.splitlines()[0].split()
    ticks = sum(int(value) for value in first[1:9])  # guest ticks already included
    cores = sum(bool(re.match(r'^cpu\d+ ', line)) for line in system.splitlines())
    return int(values[11]) + int(values[12]), ticks, cores


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=600)
    parser.add_argument('--interval', type=int, default=5)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.]+', args.package):
        parser.error('Invalid Android package name')
    if args.seconds < 600 or args.interval < 1 or args.interval > 30:
        parser.error('Measure at least 600 seconds with an interval of 1–30 seconds')
    if not shutil.which('adb'):
        parser.error('adb is unavailable; connect a real Android device first')
    if args.output.exists():
        parser.error('Output already exists; preserve previous evidence')

    def shell(*command):
        result = subprocess.run(['adb', '-s', args.serial, 'shell', *command],
                                capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'adb command failed')
        return result.stdout

    model = shell('getprop', 'ro.product.model').strip()
    os_version = shell('getprop', 'ro.build.version.release').strip()
    pid = shell('pidof', args.package).split()[0]
    if not pid.isdigit():
        raise RuntimeError('Start the selected application before measuring')
    report = {'schema_version': 1, 'started_at': datetime.now(timezone.utc).isoformat(),
              'model': model, 'android': os_version, 'package': args.package,
              'requested_duration_s': args.seconds, 'samples': [],
              'notes': 'CPU is one-core percent from /proc tick deltas when accessible. '
                       'Battery temperature is not SoC temperature; thermalservice is retained separately. '
                       'Missing metrics are null. No synthetic battery values are injected.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    start, previous = time.monotonic(), None
    try:
        while True:
            elapsed = time.monotonic() - start
            sample = {'elapsed_s': elapsed, 'cpu_percent_one_core': None, 'errors': []}
            for name, command in [('battery', ('dumpsys', 'battery')),
                                  ('thermal', ('dumpsys', 'thermalservice'))]:
                try:
                    raw = shell(*command)
                    sample[name + '_raw'] = raw
                    if name == 'battery': sample['battery_fields'] = fields(raw)
                except (RuntimeError, subprocess.TimeoutExpired) as error:
                    sample['errors'].append(f'{name}: {error}')
            try:
                current_pid = shell('pidof', args.package).split()[0]
                process, total, cores = cpu_snapshot(shell('cat', f'/proc/{current_pid}/stat'), shell('cat', '/proc/stat'))
                if previous and current_pid == previous[0] and total > previous[2]:
                    sample['cpu_percent_one_core'] = 100 * cores * (process - previous[1]) / (total - previous[2])
                previous = (current_pid, process, total)
                sample['pid'], sample['cores'] = current_pid, cores
            except (RuntimeError, subprocess.TimeoutExpired, IndexError, ValueError) as error:
                sample['errors'].append(f'cpu: {error}')
                previous = None
            report['samples'].append(sample)
            report['actual_duration_s'] = time.monotonic() - start
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            if elapsed >= args.seconds: break
            time.sleep(min(args.interval, max(0, args.seconds - (time.monotonic() - start))))
    except KeyboardInterrupt:
        report['interrupted'] = True
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        raise SystemExit(130)


if __name__ == '__main__':
    main()
