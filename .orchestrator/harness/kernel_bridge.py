"""Launcher-only Python facade for the canonical Node-owned harness."""

from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="kernel_bridge.py")
    sub = parser.add_subparsers(dest="command")
    event = sub.add_parser("append-event", help="broker an event append through Node")
    event.add_argument("--request", required=True)
    contained = sub.add_parser("run-contained", help="run a request-file child under OS containment")
    contained.add_argument("--request", required=True)
    contained.add_argument("--skip-probe", action="store_true", help=argparse.SUPPRESS)
    sub.add_parser("probe-containment", help="live-probe the OS containment provider")
    sub.add_parser("run-tests", help="run the bridge Python tests")
    return parser


_DIMENSIONS = ("tokens", "toolCalls", "wallSeconds", "processes")


def _usage(line: str) -> dict[str, float] | None:
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict):
        return None
    for dimension in _DIMENSIONS:
        item = value.get(dimension)
        if not isinstance(item, (int, float)) or isinstance(item, bool) or item < 0:
            return None
    return {dimension: value[dimension] for dimension in _DIMENSIONS}


def _merged_environment(overrides: object) -> dict[str, str]:
    result = dict(os.environ)
    if overrides is None:
        return result
    if not isinstance(overrides, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in overrides.items()):
        raise ValueError("RUNNER_ENV_INVALID")
    result.update(overrides)
    result["PYTHONDONTWRITEBYTECODE"] = "1"
    return result


def _reader(stream, kind: str, messages: queue.Queue[tuple[str, bytes]]) -> None:
    try:
        for chunk in iter(lambda: stream.read(8192), b""):
            messages.put((kind, chunk))
    finally:
        stream.close()


def _posix_execute(command: str, args: list[str], cwd: str | None, env: dict[str, str], budget: dict[str, int], stdin_bytes: bytes = b"", max_capture_bytes: int = 16 * 1024 * 1024, control: dict | None = None) -> dict:
    input_stream = tempfile.TemporaryFile(mode="w+b")
    input_stream.write(stdin_bytes)
    input_stream.seek(0)
    try:
        child = subprocess.Popen(
            [command, *args], cwd=cwd, env=env, stdin=input_stream,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
        )
    except OSError as error:
        input_stream.close()
        return {"containmentAvailable": True, "launched": False, "launchError": str(error), "provider": "posix_process_group"}
    input_stream.close()
    messages: queue.Queue[tuple[str, bytes]] = queue.Queue(maxsize=16)
    assert child.stdout is not None and child.stderr is not None
    threads = [
        threading.Thread(target=_reader, args=(child.stdout, "stdout", messages), daemon=True),
        threading.Thread(target=_reader, args=(child.stderr, "stderr", messages), daemon=True),
    ]
    for thread in threads:
        thread.start()
    stdout: list[bytes] = []
    stderr: list[bytes] = []
    observed = None
    wall_exceeded = False
    output_exceeded = False
    captured = 0
    pending_stdout = ""
    def capture(kind: str, chunk: bytes) -> None:
        nonlocal captured, observed, pending_stdout
        remaining = max(0, max_capture_bytes - min(captured, max_capture_bytes))
        if remaining:
            (stdout if kind == "stdout" else stderr).append(chunk[:remaining])
        captured += len(chunk)
        if kind == "stdout":
            pending_stdout += chunk.decode("utf-8", errors="replace")
            lines = pending_stdout.splitlines(keepends=True)
            pending_stdout = ""
            for line in lines:
                if line.endswith(("\n", "\r")):
                    live = _usage(line.strip())
                    if live is not None:
                        observed = next((dimension for dimension in _DIMENSIONS if live[dimension] > budget[dimension]), None)
                else:
                    pending_stdout = line[-65536:]
    deadline = time.monotonic() + budget["wallSeconds"]
    while child.poll() is None:
        try:
            kind, line = messages.get(timeout=0.01)
            capture(kind, line)
        except queue.Empty:
            pass
        stopped = bool(control and (not _pid_is_active(control["supervisorPid"]) or _stop_requested(control)))
        output_exceeded = captured > max_capture_bytes
        if observed or output_exceeded or stopped or time.monotonic() >= deadline:
            wall_exceeded = observed is None and not output_exceeded and not stopped
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            break
    child.wait()
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    for thread in threads:
        thread.join(timeout=1)
    while True:
        try:
            kind, line = messages.get_nowait()
            capture(kind, line)
        except queue.Empty:
            break
    output_exceeded = captured > max_capture_bytes
    return {
        "containmentAvailable": True, "launched": True, "provider": "posix_process_group",
        "processGroup": True, "killEntireTree": True, "exitCode": child.returncode,
        "stdout": b"".join(stdout).decode("utf-8", errors="replace"), "stderr": b"".join(stderr).decode("utf-8", errors="replace"),
        "observedOverrun": observed, "wallExceeded": wall_exceeded, "outputExceeded": output_exceeded,
    }


def _windows_api():
    from ctypes import wintypes

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", wintypes.LPVOID), ("bInheritHandle", wintypes.BOOL)]

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR),
            ("lpTitle", wintypes.LPWSTR), ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
            ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD), ("dwXCountChars", wintypes.DWORD),
            ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
            ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD), ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
            ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE),
        ]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE), ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION), ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel32.CreateProcessW.restype = wintypes.BOOL
    kernel32.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.POINTER(SECURITY_ATTRIBUTES), ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.BOOL, wintypes.DWORD, wintypes.LPVOID, wintypes.LPCWSTR, ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION)]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.ResumeThread.restype = wintypes.DWORD
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel32, wintypes, SECURITY_ATTRIBUTES, STARTUPINFOW, PROCESS_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION


def _win_error(prefix: str) -> OSError:
    code = ctypes.get_last_error()
    return OSError(code, f"{prefix}: {ctypes.FormatError(code)}")


def _windows_execute(command: str, args: list[str], cwd: str | None, env: dict[str, str], budget: dict[str, int], stdin_bytes: bytes = b"", max_capture_bytes: int = 16 * 1024 * 1024, control: dict | None = None) -> dict:
    import msvcrt

    kernel32, wintypes, security_type, startup_type, process_type, limit_type = _windows_api()
    if control is not None:
        output = open(control["stdoutPath"], "r+b")
        errors = open(control["stderrPath"], "r+b")
        headers = [
            (json.dumps({"kind": "scaffold-supervisor-capture", "nonce": control["nonce"], "schemaVersion": 1, "stream": stream}, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
            for stream in ("stdout", "stderr")
        ]
        try:
            for stream_file, header in zip((output, errors), headers):
                if stream_file.read(len(header)) != header:
                    raise ValueError("RUNNER_CAPTURE_OWNERSHIP_INVALID")
                stream_file.seek(len(header))
        except Exception:
            output.close()
            errors.close()
            raise
    else:
        output = tempfile.NamedTemporaryFile(prefix="ecc-contained-stdout-", delete=False)
        errors = tempfile.NamedTemporaryFile(prefix="ecc-contained-stderr-", delete=False)
        headers = [b"", b""]
    null_input = tempfile.TemporaryFile(mode="w+b")
    null_input.write(stdin_bytes)
    null_input.seek(0)
    job = process_handle = thread_handle = None
    process_info = process_type()
    created = assigned = resumed = False
    try:
        for stream in (output, errors, null_input):
            os.set_handle_inheritable(msvcrt.get_osfhandle(stream.fileno()), True)
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise _win_error("CreateJobObjectW")
        limits = limit_type()
        limits.BasicLimitInformation.LimitFlags = 0x00002000 | 0x00000008
        limits.BasicLimitInformation.ActiveProcessLimit = budget["processes"]
        if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise _win_error("SetInformationJobObject")
        startup = startup_type()
        startup.cb = ctypes.sizeof(startup)
        startup.dwFlags = 0x00000100
        startup.hStdInput = msvcrt.get_osfhandle(null_input.fileno())
        startup.hStdOutput = msvcrt.get_osfhandle(output.fileno())
        startup.hStdError = msvcrt.get_osfhandle(errors.fileno())
        process_attributes = security_type(ctypes.sizeof(security_type), None, True)
        thread_attributes = security_type(ctypes.sizeof(security_type), None, True)
        command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline([command, *args]))
        environment = ctypes.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in sorted(env.items(), key=lambda pair: pair[0].upper())) + "\0\0")
        flags = 0x00000004 | 0x00000400 | 0x08000000
        if not kernel32.CreateProcessW(None, command_line, ctypes.byref(process_attributes), ctypes.byref(thread_attributes), True, flags, environment, cwd, ctypes.byref(startup), ctypes.byref(process_info)):
            raise _win_error("CreateProcessW")
        created = True
        process_handle, thread_handle = process_info.hProcess, process_info.hThread
        if not kernel32.AssignProcessToJobObject(job, process_handle):
            kernel32.TerminateProcess(process_handle, 1)
            raise _win_error("AssignProcessToJobObject")
        assigned = True
        if kernel32.ResumeThread(thread_handle) == 0xFFFFFFFF:
            kernel32.TerminateJobObject(job, 1)
            raise _win_error("ResumeThread")
        resumed = True
        output.flush()
        errors.flush()
        offset = 0
        pending = ""
        observed = None
        wall_exceeded = False
        output_exceeded = False
        deadline = time.monotonic() + budget["wallSeconds"]
        while kernel32.WaitForSingleObject(process_handle, 1) == 258:
            with open(output.name, "rb") as reader:
                reader.seek(offset)
                chunk = reader.read()
            offset += len(chunk)
            pending += chunk.decode("utf-8", errors="replace")
            lines = pending.splitlines(keepends=True)
            pending = ""
            for line in lines:
                if line.endswith(("\n", "\r")):
                    live = _usage(line.strip())
                    if live is not None:
                        observed = next((dimension for dimension in _DIMENSIONS if live[dimension] > budget[dimension]), None)
                else:
                    pending = line
            output_exceeded = max(0, os.path.getsize(output.name) - len(headers[0])) + max(0, os.path.getsize(errors.name) - len(headers[1])) > max_capture_bytes
            stopped = bool(control and (not _pid_is_active(control["supervisorPid"]) or _stop_requested(control)))
            if observed or output_exceeded or stopped or time.monotonic() >= deadline:
                wall_exceeded = observed is None and not output_exceeded and not stopped
                kernel32.TerminateJobObject(job, 1)
                break
        kernel32.WaitForSingleObject(process_handle, 5000)
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(process_handle, ctypes.byref(exit_code)):
            raise _win_error("GetExitCodeProcess")
        output_exceeded = max(0, os.path.getsize(output.name) - len(headers[0])) + max(0, os.path.getsize(errors.name) - len(headers[1])) > max_capture_bytes
        output.close()
        errors.close()
        output_bytes = Path(output.name).read_bytes()[len(headers[0]):][:max_capture_bytes]
        error_bytes = Path(errors.name).read_bytes()[len(headers[1]):][:max(0, max_capture_bytes - len(output_bytes))]
        stdout = output_bytes.decode("utf-8", errors="replace")
        stderr = error_bytes.decode("utf-8", errors="replace")
        return {
            "containmentAvailable": True, "launched": True, "provider": "windows_job_object",
            "createdSuspended": True, "assignedBeforeResume": True, "killOnClose": True,
            "activeProcessLimit": budget["processes"], "exitCode": int(exit_code.value),
            "stdout": stdout, "stderr": stderr, "observedOverrun": observed, "wallExceeded": wall_exceeded, "outputExceeded": output_exceeded,
            "childPid": int(process_info.dwProcessId),
        }
    except OSError as error:
        return {
            "containmentAvailable": False, "launched": bool(resumed), "provider": "windows_job_object",
            "createdSuspended": created, "assignedBeforeResume": assigned and not resumed,
            "reason": str(error),
        }
    finally:
        if thread_handle:
            kernel32.CloseHandle(thread_handle)
        if process_handle:
            kernel32.CloseHandle(process_handle)
        if job:
            kernel32.TerminateJobObject(job, 1)
            kernel32.WaitForSingleObject(job, 5000)
            kernel32.CloseHandle(job)  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE terminates remaining descendants.
        for stream in (output, errors, null_input):
            if not stream.closed:
                stream.close()
        for name in (output.name, errors.name):
            for attempt in range(500):
                try:
                    if control is not None:
                        index = 0 if name == output.name else 1
                        with open(name, "rb") as owner_check:
                            if owner_check.read(len(headers[index])) != headers[index]:
                                raise RuntimeError("RUNNER_CAPTURE_OWNERSHIP_INVALID")
                    os.unlink(name)
                    break
                except FileNotFoundError:
                    break
                except PermissionError:
                    if attempt == 499:
                        raise
                    time.sleep(0.01)


def _pid_is_active(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
    kernel32, wintypes, *_ = _windows_api()
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        exit_code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == 259
    finally:
        kernel32.CloseHandle(handle)


def _stop_requested(control: dict) -> bool:
    try:
        value = json.loads(Path(control["stopFile"]).read_text(encoding="utf-8"))
        return value.get("nonce") == control["nonce"]
    except (OSError, json.JSONDecodeError):
        return False


def _probe_containment() -> dict:
    if os.environ.get("ECC_CONTAINMENT_PROBE_FAIL") == "1":
        return {"available": False, "reason": "CONTAINMENT_PROBE_INJECTED_FAILURE", "platform": sys.platform}
    if os.name != "nt":
        return {"available": False, "platform": sys.platform, "provider": "none", "reason": "POSIX_PROCESS_GROUP_ESCAPE_UNCONTAINED"}
    with tempfile.TemporaryDirectory(prefix="ecc-job-probe-") as temporary:
        pid_file = Path(temporary) / "descendant.pid"
        limit_script = "import subprocess,sys;\ntry: subprocess.Popen([sys.executable,'-c','import time;time.sleep(5)'])\nexcept OSError: print('ACTIVE_LIMIT_OK');sys.exit(0)\nsys.exit(9)"
        limit = _windows_execute(sys.executable, ["-c", limit_script], None, _merged_environment(None), {"tokens": 1, "toolCalls": 1, "wallSeconds": 3, "processes": 1})
        kill_script = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);open(sys.argv[1],'w').write(str(p.pid))"
        killed = _windows_execute(sys.executable, ["-c", kill_script, str(pid_file)], None, _merged_environment(None), {"tokens": 1, "toolCalls": 1, "wallSeconds": 3, "processes": 2})
        descendant_pid = int(pid_file.read_text(encoding="utf-8")) if pid_file.exists() else 0
        for _ in range(100):
            if not descendant_pid or not _pid_is_active(descendant_pid):
                break
            time.sleep(0.01)
        active_limit_ok = limit.get("exitCode") == 0 and "ACTIVE_LIMIT_OK" in limit.get("stdout", "")
        kill_on_close_ok = descendant_pid > 0 and not _pid_is_active(descendant_pid)
        return {
            "available": bool(active_limit_ok and kill_on_close_ok), "platform": sys.platform,
            "provider": "windows_job_object", "createdSuspended": limit.get("createdSuspended") is True,
            "assignedBeforeResume": limit.get("assignedBeforeResume") is True,
            "activeProcessLimit": active_limit_ok, "killOnClose": kill_on_close_ok,
            "reason": None if active_limit_ok and kill_on_close_ok else "WINDOWS_JOB_OBJECT_LIVE_PROBE_FAILED",
            "killProbe": killed.get("containmentAvailable") is True,
        }


def _read_contained_request(request_path: str) -> tuple[dict, str, list[str], str | None, dict[str, str], dict[str, int], bytes, int, dict | None]:
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    runner = request.get("runner")
    budget = request.get("budget")
    if not isinstance(runner, dict) or not isinstance(runner.get("command"), str) or not runner["command"]:
        raise ValueError("RUNNER_INVALID")
    args = runner.get("args", [])
    if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
        raise ValueError("RUNNER_ARGS_INVALID")
    if not isinstance(budget, dict) or any(not isinstance(budget.get(item), int) or isinstance(budget.get(item), bool) or budget[item] <= 0 for item in _DIMENSIONS):
        raise ValueError("BUDGET_INVALID")
    cwd = runner.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        raise ValueError("RUNNER_CWD_INVALID")
    encoded_input = request.get("stdinBase64", "")
    if not isinstance(encoded_input, str):
        raise ValueError("RUNNER_STDIN_INVALID")
    try:
        stdin_bytes = base64.b64decode(encoded_input, validate=True)
    except ValueError as error:
        raise ValueError("RUNNER_STDIN_INVALID") from error
    max_capture_bytes = request.get("maxCaptureBytes", 16 * 1024 * 1024)
    control = request.get("control")
    if not isinstance(max_capture_bytes, int) or isinstance(max_capture_bytes, bool) or max_capture_bytes <= 0:
        raise ValueError("RUNNER_CAPTURE_INVALID")
    if control is not None:
        if not isinstance(control, dict) or not isinstance(control.get("supervisorPid"), int) or control["supervisorPid"] <= 0 or not isinstance(control.get("stopFile"), str) or not isinstance(control.get("nonce"), str):
            raise ValueError("RUNNER_CONTROL_INVALID")
        request_text = str(Path(request_path).resolve())
        lease_base = request_text[:-8] if request_text.endswith(".request") else ""
        if str(Path(control["stopFile"]).resolve()) != f"{lease_base}.stop" or str(Path(control.get("stdoutPath", "")).resolve()) != f"{lease_base}.capture-stdout" or str(Path(control.get("stderrPath", "")).resolve()) != f"{lease_base}.capture-stderr":
            raise ValueError("RUNNER_CONTROL_INVALID")
    return request, runner["command"], args, cwd, _merged_environment(runner.get("env")), budget, stdin_bytes, max_capture_bytes, control


def _run_contained(request_path: str, skip_probe: bool = False) -> int:
    capability = ({"available": True, "platform": sys.platform, "provider": "windows_job_object"} if os.name == "nt" else {"available": False, "platform": sys.platform, "provider": "none", "reason": "POSIX_PROCESS_GROUP_ESCAPE_UNCONTAINED"}) if skip_probe else _probe_containment()
    if not capability.get("available"):
        Path(request_path).unlink(missing_ok=True)
        print(json.dumps({"containmentAvailable": False, "launched": False, "capability": capability}, separators=(",", ":")))
        return 0
    try:
        try:
            _, command, args, cwd, env, budget, stdin_bytes, max_capture_bytes, control = _read_contained_request(request_path)
        finally:
            Path(request_path).unlink(missing_ok=True)
        report = _windows_execute(command, args, cwd, env, budget, stdin_bytes, max_capture_bytes, control) if os.name == "nt" else _posix_execute(command, args, cwd, env, budget, stdin_bytes, max_capture_bytes, control)
        report["capability"] = capability
        print(json.dumps(report, separators=(",", ":")))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"containmentAvailable": True, "launched": False, "launchError": str(error), "capability": capability}, separators=(",", ":")))
        return 0


def _append_event(request_path: str) -> int:
    launcher = Path(__file__).with_name("bridge-launcher.mjs")
    completed = subprocess.run(
        ["node", str(launcher), "append-event", "--request", request_path],
        check=False,
    )
    return completed.returncode


def _run_tests() -> int:
    # Imported lazily: help, probing, and event brokering do not load unittest.
    import unittest

    root = Path(__file__).parent
    suite = unittest.defaultTestLoader.discover(str(root / "tests"), pattern="test_kernel_bridge.py")
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "append-event":
        return _append_event(args.request)
    if args.command == "run-contained":
        return _run_contained(args.request, args.skip_probe)
    if args.command == "probe-containment":
        print(json.dumps(_probe_containment(), separators=(",", ":")))
        return 0
    if args.command == "run-tests":
        return _run_tests()
    _parser().print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
