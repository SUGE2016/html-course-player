"""Start the three-page interactive demo and its local response service."""
import argparse
import importlib.util
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='启动页内互动示例')
    parser.add_argument('--host', default='127.0.0.1', help='学生端绑定地址；局域网测试时填写本机局域网 IPv4')
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'classroom/data')
    args = parser.parse_args()
    if not shutil.which('node'):
        parser.error('请安装 Node.js 18 或更新版本')
    if importlib.util.find_spec('reportlab') is None:
        parser.error('请先运行 python -m pip install -r classroom/requirements.txt')
    probes, children = [], []
    try:
        for host, port in [('127.0.0.1', 4280), ('127.0.0.1', 4281), (args.host, 4282)]:
            probe = socket.socket()
            probes.append(probe)
            probe.bind((host, port))
    except OSError as error:
        parser.error(f'地址或端口不可用：{error}')
    finally:
        for probe in probes:
            probe.close()
    try:
        children.append(subprocess.Popen([sys.executable, '-u', str(ROOT / 'classroom/server.py'), '--host', args.host, '--data-dir', str(args.data_dir)], cwd=ROOT))
        children.append(subprocess.Popen(['node', str(ROOT / 'player/serve.cjs'), '--chapter', str(ROOT / 'examples/interactive'), '--port', '4280'], cwd=ROOT))
        print('互动课件：http://127.0.0.1:4280/\n测试学号：001（演示甲）、002（演示乙）\nCtrl+C 结束；再次启动会保留本机记录。', flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(0.2)
        failed = next(child.returncode for child in children if child.returncode is not None)
        if failed:
            raise SystemExit(f'启动程序已退出，状态码 {failed}')
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == '__main__':
    main()
